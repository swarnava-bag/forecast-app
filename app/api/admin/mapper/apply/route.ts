import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient, SupabaseClient } from "@supabase/supabase-js";
import type { SkuMasterRow, MapperDbRow } from "@/lib/mapper/model";
import {
  planAddBatch, planFix, planCellEdit, planPurgeGhost, planRetire, planHardDelete,
  type LiveState, type Plan, type Write, type DraftSku, type CellField, type RefCounts,
} from "@/lib/mapper/ops";

// POST /api/admin/mapper/apply
//
// The single write path for sku_master + combo_mapper_rows.
//
// The client sends an INTENT (never a list of writes) plus the planHash it showed
// the admin. This route re-fetches live state, re-runs the same pure planner, and
// refuses with 409 if the hash moved — i.e. if someone changed the underlying rows
// while the preview was on screen. The client cannot smuggle writes past validation
// because the writes it sent are never executed; only the ones re-derived here are.
//
// Body: { intent, planHash?, dryRun?, ...args }
//   { intent: "add_batch",   mapperSetId, draft: DraftSku[] }
//   { intent: "fix",         mapperSetId, sku }
//   { intent: "cell_edit",   mapperSetId, sku, field, value }
//   { intent: "purge_ghost", sku }
//   { intent: "retire",      sku, retire?: boolean }
//   { intent: "hard_delete", sku }
//
// dryRun: true returns the freshly-computed plan and writes nothing — this is how
// the client gets a planHash bound to server-side state.

export const dynamic = "force-dynamic";

type Body = {
  intent: "add_batch" | "fix" | "cell_edit" | "purge_ghost" | "retire" | "hard_delete";
  planHash?: string;
  dryRun?: boolean;
  mapperSetId?: string;
  sku?: string;
  field?: CellField;
  value?: string;
  retire?: boolean;
  draft?: DraftSku[];
};

async function fetchAll<T>(client: SupabaseClient, table: string, select: string): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const { data, error } = await client.from(table).select(select).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...(data as unknown as T[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

async function loadLive(client: SupabaseClient): Promise<LiveState> {
  const [skuMaster, mapperRows] = await Promise.all([
    fetchAll<SkuMasterRow>(client, "sku_master", "id, new_master_sku, new_fg_code, product_name, mrp, is_active, discontinued_at"),
    fetchAll<MapperDbRow>(client, "combo_mapper_rows", "id, mapper_set_id, master_sku, is_combo, products, fg_code, product_name"),
  ]);
  return { skuMaster, mapperRows };
}

/** Reference counts for a hard delete. Five of these join by TEXT, so no foreign
 *  key will stop a bad delete — the rows just dangle. Counted here, never trusted
 *  from the client. */
async function countRefs(client: SupabaseClient, sku: string, skuId: string | null): Promise<RefCounts> {
  const one = async (table: string, col: string, val: string): Promise<number> => {
    const { count, error } = await client.from(table).select("*", { count: "exact", head: true }).eq(col, val);
    // A missing table must not read as "zero references" — that would green-light a delete.
    if (error) throw new Error(`Could not count ${table}: ${error.message}`);
    return count ?? 0;
  };
  return {
    forecast_data_combos: await one("forecast_data_combos", "master_sku", sku),
    historical_forecast_data: await one("historical_forecast_data", "master_sku", sku),
    supply_plan: await one("supply_plan", "master_sku", sku),
    mapper_suggestions: await one("mapper_suggestions", "master_sku", sku),
    forecast_data: skuId ? await one("forecast_data", "sku_id", skuId) : 0,
    channel_sku_mapping: skuId ? await one("channel_sku_mapping", "sku_id", skuId) : 0,
  };
}

function makePlan(body: Body, live: LiveState, refs: RefCounts | null, parentRefs: Map<string, RefCounts> | null): Plan {
  const setId = body.mapperSetId || "";
  switch (body.intent) {
    case "add_batch":   return planAddBatch(live, body.draft || [], setId);
    case "fix":         return planFix(live, body.sku || "", setId);
    case "cell_edit":   return planCellEdit(live, body.sku || "", body.field || "fgCode", body.value ?? "", setId);
    case "purge_ghost": return planPurgeGhost(live, body.sku || "", parentRefs ?? undefined);
    case "retire":      return planRetire(live, body.sku || "", body.retire !== false);
    case "hard_delete": return planHardDelete(live, body.sku || "", refs!);
  }
}

/**
 * Reference counts for every combo that consumes a ghost.
 *
 * A purge deletes those parents, and forecast_data.sku_id / channel_sku_mapping.sku_id
 * are ON DELETE CASCADE against sku_master(id) — so deleting a parent that has
 * history would destroy it silently. Counted server-side, per parent, before the
 * planner decides.
 */
async function countParentRefs(client: SupabaseClient, live: LiveState, ghostSku: string): Promise<Map<string, RefCounts>> {
  const g = (ghostSku || "").trim().toLowerCase();
  const parents = [...new Set(
    live.mapperRows
      .filter((m) => (m.products || []).some((p) => (p || "").trim().toLowerCase() === g))
      .map((m) => m.master_sku)
  )];
  const out = new Map<string, RefCounts>();
  for (const p of parents) {
    const sm = live.skuMaster.find((s) => (s.new_master_sku || "").trim().toLowerCase() === p.trim().toLowerCase());
    out.set(p.trim().toLowerCase(), await countRefs(client, p, sm?.id ?? null));
  }
  return out;
}

/**
 * Atomic path: one plpgsql call = one transaction = all-or-nothing.
 *
 * Returns null if the function isn't installed (see supabase/sql/apply_mapper_batch.sql
 * — it's applied by hand because this repo has no migration tooling), so the caller
 * can fall back rather than the whole feature breaking on a fresh database.
 */
async function executeAtomic(client: SupabaseClient, writes: Write[], mapperSetIds: string[]): Promise<{ ok: true } | { ok: false; error: string } | null> {
  const { error } = await client.rpc("apply_mapper_batch", { payload: { writes, mapperSetIds } });
  if (!error) return { ok: true };
  // PGRST202 = no such function; 42883 = undefined_function. Anything else is a
  // real failure and must NOT be retried non-atomically.
  const missing = error.code === "PGRST202" || error.code === "42883" || /Could not find the function/i.test(error.message);
  if (missing) return null;
  return { ok: false, error: error.message };
}

async function execute(client: SupabaseClient, writes: Write[]): Promise<string[]> {
  const failures: string[] = [];
  for (const w of writes) {
    let err: { message: string } | null = null;
    if (w.op === "insert_sku_master") {
      ({ error: err } = await client.from("sku_master").insert(w.row));
    } else if (w.op === "insert_mapper") {
      ({ error: err } = await client.from("combo_mapper_rows").insert(w.row));
    } else if (w.op === "update_sku_master") {
      ({ error: err } = await client.from("sku_master").update(w.patch).eq("id", w.id));
    } else if (w.op === "update_mapper") {
      ({ error: err } = await client.from("combo_mapper_rows").update(w.patch)
        .eq("master_sku", w.masterSku).eq("mapper_set_id", w.mapperSetId));
    } else if (w.op === "delete_mapper") {
      ({ error: err } = await client.from("combo_mapper_rows").delete()
        .eq("master_sku", w.masterSku).eq("mapper_set_id", w.mapperSetId));
    } else if (w.op === "delete_sku_master") {
      ({ error: err } = await client.from("sku_master").delete().eq("id", w.id));
    } else if (w.op === "retire_sku_master") {
      ({ error: err } = await client.from("sku_master").update(
        w.retire
          ? { is_active: false, discontinued_at: new Date().toISOString() }
          : { is_active: true, discontinued_at: null }
      ).eq("id", w.id));
    }
    if (err) failures.push(`${w.op} ${"masterSku" in w ? w.masterSku : ""}: ${err.message}`);
  }
  return failures;
}

/** row_count is stored on combo_mapper_sets and shown in three mapper dropdowns,
 *  yet almost no write path maintains it. Recount once per touched set, never per row. */
async function recount(client: SupabaseClient, setIds: string[]): Promise<void> {
  for (const id of setIds) {
    if (!id) continue;
    const { count } = await client.from("combo_mapper_rows").select("id", { count: "exact", head: true }).eq("mapper_set_id", id);
    if (count !== null) await client.from("combo_mapper_sets").update({ row_count: count }).eq("id", id);
  }
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: Body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  if (!body?.intent) return NextResponse.json({ error: "intent required" }, { status: 400 });

  const admin = createAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  try {
    const live = await loadLive(admin);

    let refs: RefCounts | null = null;
    let parentRefs: Map<string, RefCounts> | null = null;
    if (body.intent === "hard_delete") {
      const sm = live.skuMaster.find((s) => (s.new_master_sku || "").trim().toLowerCase() === (body.sku || "").trim().toLowerCase());
      refs = await countRefs(admin, body.sku || "", sm?.id ?? null);
    } else if (body.intent === "purge_ghost") {
      parentRefs = await countParentRefs(admin, live, body.sku || "");
    }

    const plan = makePlan(body, live, refs, parentRefs);

    // Dry run: hand back a plan whose hash is bound to state the SERVER just read.
    if (body.dryRun) return NextResponse.json({ plan, refs });

    // Optimistic concurrency. The admin approved a preview computed from a snapshot;
    // if the underlying rows moved since, applying it would write to data nobody saw.
    if (body.planHash && body.planHash !== plan.planHash) {
      return NextResponse.json({
        error: "The mapper changed while you were reviewing. Re-check the preview.",
        code: "STALE_PLAN", plan, refs,
      }, { status: 409 });
    }

    if (plan.writes.length === 0) {
      return NextResponse.json({ applied: 0, plan, message: plan.skipped[0] || "Nothing to do." });
    }

    const before = plan.changes.map((c) => `${c.action} ${c.sku} (${c.target}): ${c.details}`);

    // Prefer the transaction. Fall back only when the function is genuinely absent —
    // never after a real error, or a rolled-back batch would be re-applied piecemeal.
    let failures: string[] = [];
    let atomic = true;
    const rpc = await executeAtomic(admin, plan.writes, plan.mapperSetIds);
    if (rpc === null) {
      atomic = false;
      failures = await execute(admin, plan.writes);
      await recount(admin, plan.mapperSetIds); // the RPC recounts inside its own transaction
    } else if (!rpc.ok) {
      // Rolled back: nothing was written, so report rather than half-apply.
      await admin.from("audit_log").insert({
        user_id: user.id, user_email: user.email,
        action: `mapper_${body.intent}_rolled_back`,
        table_name: "combo_mapper_rows",
        new_values: { intent: body.intent, error: rpc.error, changes: before },
      });
      return NextResponse.json({
        error: `Nothing was written — the batch was rolled back: ${rpc.error}`,
        code: "ROLLED_BACK",
      }, { status: 500 });
    }

    const batchId = crypto.randomUUID();
    await admin.from("audit_log").insert({
      user_id: user.id,
      user_email: user.email,
      action: `mapper_${body.intent}`,
      table_name: "combo_mapper_rows",
      // old_values carries the pre-write snapshot of every touched row — for a
      // delete this is the only undo that exists.
      old_values: {
        batch_id: batchId,
        sku_master: live.skuMaster.filter((s) => plan.changes.some((c) => c.sku.toLowerCase() === (s.new_master_sku || "").toLowerCase())),
        mapper_rows: live.mapperRows.filter((m) => plan.changes.some((c) => c.sku.toLowerCase() === (m.master_sku || "").toLowerCase())),
      },
      new_values: { batch_id: batchId, intent: body.intent, atomic, changes: before, failures, skipped: plan.skipped },
    });

    if (failures.length > 0) {
      return NextResponse.json({
        error: `Applied with ${failures.length} failure(s). Writes were NOT atomic (apply_mapper_batch is not installed), so the mapper may be half-written — run \`npm run doctor\`.`,
        code: "PARTIAL", failures, applied: plan.writes.length - failures.length, batchId,
      }, { status: 500 });
    }

    return NextResponse.json({ applied: plan.writes.length, changes: before, skipped: plan.skipped, batchId, atomic });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
