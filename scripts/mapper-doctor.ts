/**
 * Mapper Doctor — read-only health report for the two SKU tables.
 *
 * The mapper is backed by two tables that drift apart because three pages write
 * them independently. This script is the ground truth: run it before and after
 * every change and diff the output.
 *
 *   npm run doctor                 full report
 *   npm run doctor -- --sku=FOO    + reference counts for one SKU across every
 *                                    SKU-bearing table (run this before deleting)
 *   npm run doctor -- --json       machine-readable, for diffing in CI
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local
 * (same loader as scripts/import-historical-forecasts.js).
 *
 * WRITES NOTHING. Safe to run against production at any time.
 */

import path from "path";
import fs from "fs";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { buildRows, isBlocking, norm, ISSUE_META, type SkuMasterRow, type MapperDbRow, type IssueCode } from "../lib/mapper/model";
import { findNestedCombos, findCycles } from "../lib/mapper/nesting";

// ── env ──────────────────────────────────────────────────────────────────────
const envPath = path.join(__dirname, "..", ".env.local");
const env: Record<string, string> = {};
for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
  const [key, ...rest] = line.split("=");
  if (key && rest.length) env[key.trim()] = rest.join("=").trim();
}
const supabase: SupabaseClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const skuArg = argv.find((a) => a.startsWith("--sku="))?.slice(6);

// ── helpers ──────────────────────────────────────────────────────────────────
async function fetchAll<T>(table: string, select: string): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const { data, error } = await supabase.from(table).select(select).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...(data as unknown as T[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

async function countWhere(table: string, column: string, value: string): Promise<number | string> {
  const { count, error } = await supabase.from(table).select("*", { count: "exact", head: true }).eq(column, value);
  if (error) return `ERR(${error.message.slice(0, 40)})`;
  return count ?? 0;
}

/** Shape combo_mapper_rows for the nesting module (which is deliberately agnostic
 *  about where its rows come from). */
const toNestRows = (rows: MapperDbRow[]) =>
  rows.map((r) => ({ master_sku: r.master_sku, is_combo: r.is_combo, products: r.products || [] }));

// ── main ─────────────────────────────────────────────────────────────────────
type SetRow = { id: string; name: string; is_default: boolean; row_count: number | null; product_column_count: number | null };

(async () => {
  const sets = await fetchAll<SetRow>("combo_mapper_sets", "id, name, is_default, row_count, product_column_count");
  const skuMaster = await fetchAll<SkuMasterRow>(
    "sku_master",
    "id, new_master_sku, new_fg_code, product_name, mrp, is_active, discontinued_at"
  );
  const allMapper = await fetchAll<MapperDbRow>(
    "combo_mapper_rows",
    "id, mapper_set_id, master_sku, is_combo, products, fg_code, product_name"
  );

  // No timestamp in the report: --json exists to be diffed against a committed
  // baseline, and a clock reading would make every diff dirty.
  const report: Record<string, unknown> = {};
  const L: string[] = [];
  const say = (s = "") => L.push(s);

  say("═".repeat(78));
  say("  MAPPER DOCTOR");
  say(`  ${new Date().toISOString()}`);
  say("═".repeat(78));
  say();
  say(`sku_master rows          : ${skuMaster.length}  (active ${skuMaster.filter((s) => s.is_active !== false && !s.discontinued_at).length})`);
  say(`combo_mapper_rows (all)  : ${allMapper.length}`);
  say(`combo_mapper_sets        : ${sets.length}`);
  say();

  const defaults = sets.filter((s) => s.is_default);
  if (defaults.length !== 1) {
    say(`!! ${defaults.length} sets marked is_default (expected exactly 1). Consumers do`);
    say(`   \`find(is_default) || sets[0]\` — with ${defaults.length}, which set you get is arbitrary.`);
    say();
  }

  report.sets = [];
  for (const set of sets) {
    const mapper = allMapper.filter((r) => r.mapper_set_id === set.id);
    const rows = buildRows(skuMaster, mapper);

    const issueCounts: Record<string, number> = {};
    for (const r of rows) for (const i of r.issues) issueCounts[i.code] = (issueCounts[i.code] || 0) + 1;

    // row_count drift (landmine: only 3 of 10 write paths maintain it)
    const stored = set.row_count;
    const actual = mapper.length;
    const drift = stored !== actual;

    // product_column_count drift — converter derives the real max from data
    const actualMaxP = mapper.reduce((m, r) => Math.max(m, (r.products || []).length), 0);
    const pDrift = set.product_column_count !== actualMaxP;

    // duplicates, and whether they agree
    const byS = new Map<string, MapperDbRow[]>();
    for (const r of mapper) {
      const k = norm(r.master_sku);
      if (!byS.has(k)) byS.set(k, []);
      byS.get(k)!.push(r);
    }
    const dupes = [...byS.entries()].filter(([, v]) => v.length > 1);
    const disagreeing = dupes.filter(([, v]) => new Set(v.map((r) => `${r.is_combo}|${JSON.stringify([...(r.products || [])].sort())}`)).size > 1);

    const nested = findNestedCombos(toNestRows(mapper));
    const cycles = findCycles(toNestRows(mapper));

    say("─".repeat(78));
    say(`SET  "${set.name}"${set.is_default ? "  [DEFAULT]" : ""}`);
    say("─".repeat(78));
    say(`  mapper rows        : ${mapper.length}   (singles ${mapper.filter((r) => !r.is_combo).length} / combos ${mapper.filter((r) => r.is_combo).length})`);
    say(`  unified rows       : ${rows.length}`);
    say(`  row_count          : stored=${stored} actual=${actual}   ${drift ? `<<< DRIFT (${(stored ?? 0) - actual > 0 ? "+" : ""}${(stored ?? 0) - actual}) — shown in 3 mapper dropdowns` : "OK"}`);
    say(`  product_col_count  : stored=${set.product_column_count} actual=${actualMaxP}   ${pDrift ? "<<< DRIFT" : "OK"}`);
    say(`  duplicate SKUs     : ${dupes.length}   ${disagreeing.length ? `<<< ${disagreeing.length} DISAGREE with each other` : dupes.length ? "(all agree)" : ""}`);
    say(`  nested combos      : ${nested.length}   ${nested.length ? "<<< runConversion expands ONE level — these lose units" : "OK"}`);
    say(`  reference cycles   : ${cycles.length}   ${cycles.length ? "<<< CYCLE — would hang a naive resolver" : "OK"}`);
    say(`  blocking rows      : ${rows.filter(isBlocking).length}`);
    say();
    // Driven off ISSUE_META so a new code can never be silently missing from the report.
    say(`  issues:`);
    const ordered = (Object.keys(ISSUE_META) as IssueCode[])
      .sort((a, b) => Number(ISSUE_META[b].blocking) - Number(ISSUE_META[a].blocking) || a.localeCompare(b));
    for (const code of ordered) {
      const n = issueCounts[code] || 0;
      say(`    ${code.padEnd(24)} ${String(n).padStart(5)}${n > 0 && ISSUE_META[code].blocking ? "  <<< blocking" : ""}`);
    }
    say();

    const blocking = rows.filter(isBlocking);
    if (blocking.length) {
      say(`  blocking detail (first 15):`);
      for (const r of blocking.slice(0, 15)) say(`    ${r.masterSku.padEnd(34)} ${r.issues.map((i) => i.code).join(", ")}`);
      if (blocking.length > 15) say(`    … +${blocking.length - 15} more`);
      say();
    }
    if (disagreeing.length) {
      say(`  DISAGREEING duplicates (these are ambiguous — buildRows silently picks the one with most components):`);
      for (const [k, v] of disagreeing.slice(0, 10)) {
        say(`    ${k}`);
        for (const r of v) say(`      is_combo=${r.is_combo} products=[${(r.products || []).join(", ")}]`);
      }
      say();
    }
    if (nested.length) {
      say(`  nested combos (first 10) — stored products vs fully-flattened:`);
      for (const n of nested.slice(0, 10)) {
        say(`    ${n.master_sku.padEnd(34)} expands: ${n.expanded.join(", ")}`);
        say(`    ${"".padEnd(34)} -> [${n.resolved.join(", ")}]`);
      }
      say();
    }
    if (cycles.length) {
      say(`  CYCLES:`);
      for (const c of cycles.slice(0, 5)) say(`    ${c.join(" -> ")}`);
      say();
    }

    (report.sets as unknown[]).push({
      name: set.name, isDefault: set.is_default,
      mapperRows: mapper.length, unifiedRows: rows.length,
      rowCountStored: stored, rowCountActual: actual, rowCountDrift: drift,
      productColStored: set.product_column_count, productColActual: actualMaxP,
      duplicates: dupes.length, duplicatesDisagreeing: disagreeing.length,
      nested: nested.length, cycles: cycles.length,
      blocking: blocking.length, issues: issueCounts,
    });
  }

  // ── cross-table reference probe for one SKU (pre-delete safety check) ──────
  if (skuArg) {
    say("═".repeat(78));
    say(`  REFERENCES TO "${skuArg}"  — check this before any delete`);
    say("═".repeat(78));

    const sm = skuMaster.find((s) => norm(s.new_master_sku) === norm(skuArg));
    const mapperHits = allMapper.filter((r) => norm(r.master_sku) === norm(skuArg));
    const asComponent = allMapper.filter((r) => (r.products || []).some((p) => norm(p) === norm(skuArg)));

    say(`  sku_master row           : ${sm ? `YES  id=${sm.id}  fg=${sm.new_fg_code || "-"}  active=${sm.is_active !== false}` : "no"}`);
    say(`  combo_mapper_rows        : ${mapperHits.length} row(s)${mapperHits.length > 1 ? "  <<< DUPLICATES — delete by master_sku, not id" : ""}`);
    say(`  used as a component by   : ${asComponent.length} combo(s)${asComponent.length ? "  <<< BLOCKS hard delete" : ""}`);
    for (const c of asComponent.slice(0, 12)) say(`      ${c.master_sku}`);
    say();
    say(`  text-referencing tables (these DANGLE silently — no FK will stop you):`);
    say(`    forecast_data_combos   : ${await countWhere("forecast_data_combos", "master_sku", skuArg)}`);
    say(`    historical_forecast_data: ${await countWhere("historical_forecast_data", "master_sku", skuArg)}`);
    say(`    supply_plan            : ${await countWhere("supply_plan", "master_sku", skuArg)}`);
    say(`    mapper_suggestions     : ${await countWhere("mapper_suggestions", "master_sku", skuArg)}`);
    say();
    say(`  uuid-FK tables — BOTH ARE "ON DELETE CASCADE" (verified against the live DB):`);
    say(`    deleting this SKU's sku_master row DESTROYS these rows silently, with no error.`);
    if (sm) {
      say(`    forecast_data          : ${await countWhere("forecast_data", "sku_id", sm.id)}`);
      say(`    channel_sku_mapping    : ${await countWhere("channel_sku_mapping", "sku_id", sm.id)}`);
    } else {
      say(`    (no sku_master row — nothing to reference by uuid)`);
    }
    say();
  }

  // ── Is the launch batch actually atomic? ──────────────────────────────────
  // The route falls back to sequential writes when the function is absent, so this
  // is the difference between "all-or-nothing" and "may half-apply" — and it is
  // invisible from the app.
  {
    const { error } = await supabase.rpc("apply_mapper_batch", { payload: { writes: [], mapperSetIds: [] } });
    const missing = error && (error.code === "PGRST202" || error.code === "42883" || /Could not find the function/i.test(error.message));
    say("═".repeat(78));
    say("  ATOMICITY");
    say("═".repeat(78));
    if (missing) {
      say("  apply_mapper_batch : NOT INSTALLED");
      say("  New Launch writes 2N+M rows across two tables SEQUENTIALLY — a failure");
      say("  part-way leaves the mapper half-written (the orphan shape).");
      say("  Fix: paste supabase/sql/apply_mapper_batch.sql into the Supabase SQL editor.");
    } else if (error) {
      say(`  apply_mapper_batch : INSTALLED but errored on an empty payload — ${error.message}`);
    } else {
      say("  apply_mapper_batch : installed — launch batches are all-or-nothing");
    }
    say();
    (report as Record<string, unknown>).atomicBatch = !missing;
  }

  say("═".repeat(78));
  say("  SCHEMA FACTS  (probed 2026-07-15; re-check with the SQL below if in doubt)");
  say("═".repeat(78));
  say(`
  DELETING A sku_master ROW CASCADES. Both children are ON DELETE CASCADE:
      forecast_data.sku_id       -> sku_master(id)  ON DELETE CASCADE
      channel_sku_mapping.sku_id -> sku_master(id)  ON DELETE CASCADE
  Postgres will not stop you and will not warn you: the forecast history for that
  SKU is simply gone. Every delete path must count references FIRST — which is why
  planHardDelete and planPurgeGhost both refuse rather than rely on the database.

  RLS is ENABLED on all three tables, and INSERT/UPDATE/DELETE are gated on
  profiles.role = 'admin'. SELECT is open. The API route holds the service key,
  which bypasses RLS by design, and performs its own admin check.

  NOTE: sku_master carries an extra SELECT policy for role {public} ("Allow public
  read on sku_master"), so the anon key can read the whole catalogue — FG codes,
  MRPs, names. The other two tables are {authenticated} only. Probably a leftover;
  sku_master_read already covers logged-in users.

  -- Re-probe:
  select conrelid::regclass as child, conname, confdeltype, pg_get_constraintdef(oid)
  from pg_constraint where confrelid = 'sku_master'::regclass;

  select tablename, policyname, cmd, roles, qual, with_check
  from pg_policies
  where tablename in ('sku_master','combo_mapper_rows','combo_mapper_sets');

  select relname, relrowsecurity from pg_class
  where relname in ('sku_master','combo_mapper_rows','combo_mapper_sets');

  -- confdeltype:  a = NO ACTION   c = CASCADE   n = SET NULL
`);

  if (asJson) console.log(JSON.stringify(report, null, 2));
  else console.log(L.join("\n"));
})().catch((e) => {
  console.error("DOCTOR FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
