// Mapper write planning. PURE — no React, no Supabase, no network.
//
// Why this module exists
// ──────────────────────
// The same planner runs in two places:
//   1. the browser, against loaded state, to render the preview the admin approves
//   2. the API route, against FRESHLY fetched state, immediately before writing
//
// The route compares its `planHash` to the one the client approved. If they differ,
// the world changed while the admin was reading the preview, and the write is
// refused (409) rather than applied to data nobody looked at.
//
// That check — not the mere fact of routing writes through one place — is what
// actually stops the two tables drifting. A shared client-side repository would
// still issue N independent statements against state it read minutes ago.

import { buildRows, diffIssues, isBlocking, norm, type Row, type Issue, type SkuMasterRow, type MapperDbRow } from "./model";
import { flattenOne, type NestRow } from "./nesting";

export type LiveState = { skuMaster: SkuMasterRow[]; mapperRows: MapperDbRow[] };

/** A single physical write. The route executes these verbatim; it never re-derives. */
export type Write =
  | { op: "insert_sku_master"; row: { new_master_sku: string; new_fg_code: string | null; product_name: string | null; mrp: number | null; is_active: boolean } }
  | { op: "insert_mapper"; row: { mapper_set_id: string; master_sku: string; is_combo: boolean; products: string[]; fg_code: string | null; product_name: string | null } }
  | { op: "update_sku_master"; id: string; masterSku: string; patch: { new_fg_code?: string | null; product_name?: string | null; mrp?: number | null } }
  | { op: "update_mapper"; masterSku: string; mapperSetId: string; patch: { fg_code?: string | null; product_name?: string | null; products?: string[]; is_combo?: boolean } }
  | { op: "delete_mapper"; masterSku: string; mapperSetId: string }
  | { op: "delete_sku_master"; id: string; masterSku: string }
  | { op: "retire_sku_master"; id: string; masterSku: string; retire: boolean };

export type Change = {
  sku: string;
  action: "add" | "update" | "delete" | "retire" | "skip" | "no_change";
  target: "sku_master" | "mapper" | "both";
  details: string;
};

export type Plan = {
  changes: Change[];
  skipped: string[];
  writes: Write[];
  /** Health delta across the WHOLE mapper, including rows the change never touches. */
  impact: ReturnType<typeof diffIssues>;
  /** Blocking issues the plan would introduce. Non-empty = the UI should warn hard. */
  newBlocking: Array<{ masterSku: string; issues: Issue[] }>;
  planHash: string;
  mapperSetIds: string[];
};

// ── draft input ──────────────────────────────────────────────────────────────

export type DraftSku = {
  tempId: string;
  kind: "single" | "combo";
  masterSku: string;
  fgCode: string;
  productName: string;
  mrp: string; // raw text from the input; parsed here so the UI never has to
  components: Array<{ sku: string; qty: number }>;
};

export const parseMrp = (raw: string): { ok: true; value: number | null } | { ok: false; reason: string } => {
  const t = (raw || "").trim();
  if (t === "") return { ok: true, value: null };
  const n = Number(t.replace(/[, ]/g, ""));
  if (!isFinite(n) || n < 0) return { ok: false, reason: `"${raw}" is not a valid MRP` };
  return { ok: true, value: n };
};

/** Component quantity is stored as repetition: ["A","A"] means 2×A. */
export const expandComponents = (components: Array<{ sku: string; qty: number }>): string[] => {
  const out: string[] = [];
  for (const c of components) {
    const s = (c.sku || "").trim();
    if (!s) continue;
    for (let i = 0; i < Math.max(1, c.qty); i++) out.push(s);
  }
  return out;
};

// ── hashing ──────────────────────────────────────────────────────────────────

/** FNV-1a. Not cryptographic — this detects concurrent edits, not tampering
 *  (the route re-plans from scratch, so a forged hash buys nothing). */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Hash only the rows this plan actually depends on — never the whole DB.
 * Hashing everything would 409 on an unrelated edit to an unrelated SKU, and
 * admins would quickly learn to ignore the warning.
 *
 * Absence is hashed explicitly (`∅`). Filtering live rows by the touched keys and
 * hashing whatever came back would give every all-new batch the hash of the empty
 * string — identical for every launch, so the staleness check would silently do
 * nothing in precisely the case it exists for. A SKU going absent → present must
 * move the hash.
 */
function hashTouched(live: LiveState, skus: string[]): string {
  const keys = [...new Set(skus.map(norm))].sort();
  const parts: string[] = [];
  for (const k of keys) {
    const s = live.skuMaster.find((x) => norm(x.new_master_sku) === k);
    parts.push(s
      ? `S|${k}|${s.new_fg_code || ""}|${s.mrp ?? ""}|${s.product_name || ""}|${s.is_active !== false}|${s.discontinued_at || ""}`
      : `S|${k}|∅`);
    const ms = live.mapperRows
      .filter((x) => norm(x.master_sku) === k)
      .map((m) => `${m.mapper_set_id}:${m.is_combo}:${[...(m.products || [])].sort().join(",")}:${m.fg_code || ""}`)
      .sort();
    parts.push(ms.length ? `M|${k}|${ms.join(";")}` : `M|${k}|∅`);
  }
  return hash(parts.join("\n"));
}

const toNestRows = (rows: MapperDbRow[]): NestRow[] =>
  rows.map((r) => ({ master_sku: r.master_sku, is_combo: r.is_combo, products: r.products || [] }));

function buildPlan(live: LiveState, after: LiveState, writes: Write[], changes: Change[], skipped: string[], touched: string[], mapperSetIds: string[]): Plan {
  const before = buildRows(live.skuMaster, live.mapperRows);
  const afterRows = buildRows(after.skuMaster, after.mapperRows);
  const beforeBlocking = new Set(before.filter(isBlocking).map((r) => norm(r.masterSku)));
  const newBlocking = afterRows
    .filter((r) => isBlocking(r) && !beforeBlocking.has(norm(r.masterSku)))
    .map((r) => ({ masterSku: r.masterSku, issues: r.issues }));

  return {
    changes,
    skipped,
    writes,
    impact: diffIssues(before, afterRows),
    newBlocking,
    planHash: hashTouched(live, touched),
    mapperSetIds,
  };
}

// ── existing-SKU description ─────────────────────────────────────────────────

/** What already exists under this Master SKU, and how the draft differs from it. */
export type Existing = {
  masterSku: string;
  inMapper: boolean;
  inSkuMaster: boolean;
  isCombo: boolean;
  products: string[];
  fgCode: string;
  productName: string;
  mrp: number | null;
  /** Field-level differences between the existing row and the draft. */
  diffs: Array<{ field: string; current: string; proposed: string }>;
  /** True when the draft's components match what is already stored. */
  sameComponents: boolean;
};

export function describeExistingSku(live: LiveState, sku: string, d?: DraftSku): Existing | null {
  const rows = buildRows(live.skuMaster, live.mapperRows);
  const row = rows.find((r) => norm(r.masterSku) === norm(sku));
  if (!row) return null;

  const diffs: Existing["diffs"] = [];
  let sameComponents = true;

  if (d) {
    const fg = (d.fgCode || "").trim();
    if (fg && norm(fg) !== norm(row.fgCode)) diffs.push({ field: "FG code", current: row.fgCode || "(none)", proposed: fg });
    const name = (d.productName || "").trim();
    if (name && name !== row.productName) diffs.push({ field: "Product name", current: row.productName || "(none)", proposed: name });
    const mrpRes = parseMrp(d.mrp);
    if (mrpRes.ok && mrpRes.value != null && mrpRes.value !== row.mrp)
      diffs.push({ field: "MRP", current: row.mrp == null ? "(none)" : String(row.mrp), proposed: String(mrpRes.value) });
    if (d.kind === "combo") {
      const want = expandComponents(d.components);
      sameComponents = want.length === row.products.length &&
        [...want].map(norm).sort().join(",") === [...row.products].map(norm).sort().join(",");
      if (!sameComponents) diffs.push({ field: "Components", current: row.products.join(", ") || "(none)", proposed: want.join(", ") });
    }
  }

  return {
    masterSku: row.masterSku, inMapper: row.inMapper, inSkuMaster: row.inSkuMaster,
    isCombo: row.isCombo, products: row.products, fgCode: row.fgCode,
    productName: row.productName, mrp: row.mrp, diffs, sameComponents,
  };
}

function describeExisting(live: LiveState, sku: string, d: DraftSku): string {
  const e = describeExistingSku(live, sku, d);
  if (!e) return "already exists";
  const what = `already exists as a ${e.isCombo ? `combo of [${e.products.join(", ")}]` : "single"}`;
  if (e.diffs.length === 0) return `${what} — identical to what you entered. Nothing to change.`;
  const how = e.diffs.map((x) => `${x.field}: ${x.current} → ${x.proposed}`).join("; ");
  return `${what}. You are proposing an EDIT, not a new SKU — ${how}. Remove it from this launch and edit the row in the grid.`;
}

// ── planAddBatch — the New Launch path ───────────────────────────────────────

/**
 * Plan N singles + M combos as one batch.
 *
 * Combos may reference singles created in the same batch: the draft is synthesised
 * into rows and unioned onto live state before validation, so buildRows resolves
 * them exactly as if they already existed. No special-casing.
 */
export function planAddBatch(live: LiveState, draft: DraftSku[], mapperSetId: string): Plan {
  const changes: Change[] = [];
  const skipped: string[] = [];
  const writes: Write[] = [];
  const touched: string[] = [];

  const liveSkus = new Set([
    ...live.skuMaster.map((s) => norm(s.new_master_sku)),
    ...live.mapperRows.map((m) => norm(m.master_sku)),
  ]);
  const liveFg = new Map<string, string>();
  for (const s of live.skuMaster) if (s.new_fg_code) liveFg.set(norm(s.new_fg_code), s.new_master_sku);
  for (const m of live.mapperRows) if (m.fg_code && !liveFg.has(norm(m.fg_code))) liveFg.set(norm(m.fg_code), m.master_sku);

  // Accepted drafts, so later rows can validate against earlier ones in the SAME batch.
  const draftSkus = new Set<string>();
  const draftFg = new Map<string, string>();
  const accepted: Array<{ d: DraftSku; products: string[]; mrp: number | null }> = [];

  for (const d of draft) {
    const sku = (d.masterSku || "").trim();
    if (!sku) continue; // an untouched blank row is not an error

    if (liveSkus.has(norm(sku))) {
      // "already exists" alone is a dead end. Say what exists and how it differs
      // from the draft, so the admin can see whether they meant to edit it.
      skipped.push(`${sku}: ${describeExisting(live, sku, d)}`);
      continue;
    }
    if (draftSkus.has(norm(sku))) { skipped.push(`${sku}: listed twice in this batch`); continue; }

    const fg = (d.fgCode || "").trim();
    if (fg) {
      // Both directions matter: against the DB, and against the rest of the batch.
      // The old per-row validateFg only checked the DB, so two new rows could claim
      // the same FG code and both pass.
      const clashLive = liveFg.get(norm(fg));
      if (clashLive) { skipped.push(`${sku}: FG code "${fg}" already belongs to "${clashLive}"`); continue; }
      const clashDraft = draftFg.get(norm(fg));
      if (clashDraft) { skipped.push(`${sku}: FG code "${fg}" is also claimed by "${clashDraft}" in this batch`); continue; }
    }

    const mrpRes = parseMrp(d.mrp);
    if (!mrpRes.ok) { skipped.push(`${sku}: ${mrpRes.reason}`); continue; }

    let products: string[] = [];
    if (d.kind === "combo") {
      products = expandComponents(d.components);
      if (products.length === 0) { skipped.push(`${sku}: a combo needs at least one component`); continue; }
      if (products.some((p) => norm(p) === norm(sku))) { skipped.push(`${sku}: a combo cannot contain itself`); continue; }
    }

    draftSkus.add(norm(sku));
    if (fg) draftFg.set(norm(fg), sku);
    accepted.push({ d: { ...d, masterSku: sku, fgCode: fg }, products, mrp: mrpRes.value });
    touched.push(sku);
    for (const p of products) touched.push(p);
  }

  // Synthesise the accepted drafts as rows, then flatten nesting against live+draft.
  const draftSm: SkuMasterRow[] = accepted.map(({ d, mrp }) => ({
    id: `draft-${d.tempId}`, new_master_sku: d.masterSku, new_fg_code: d.fgCode || null,
    product_name: d.productName.trim() || null, mrp, is_active: true, discontinued_at: null,
  }));
  const draftMr: MapperDbRow[] = accepted.map(({ d, products }) => ({
    id: `draft-${d.tempId}`, mapper_set_id: mapperSetId, master_sku: d.masterSku,
    is_combo: d.kind === "combo", products, fg_code: d.fgCode || null,
    product_name: d.productName.trim() || null,
  }));

  const universe = toNestRows([...live.mapperRows, ...draftMr]);
  for (const row of draftMr) {
    if (!row.is_combo) continue;
    const { resolved, expanded } = flattenOne(row.products || [], universe, row.master_sku);
    if (expanded.length > 0) {
      // Never flatten silently — runConversion expands one level only, so a nested
      // reference that survives loses units with no warning.
      changes.push({
        sku: row.master_sku, action: "update", target: "mapper",
        details: `references combo(s) ${expanded.join(", ")} → flattened to [${resolved.join(", ")}]`,
      });
      row.products = resolved;
    }
  }

  for (let i = 0; i < accepted.length; i++) {
    const { d } = accepted[i];
    const smRow = draftSm[i];
    const mrRow = draftMr[i];
    writes.push({ op: "insert_sku_master", row: {
      new_master_sku: smRow.new_master_sku, new_fg_code: smRow.new_fg_code,
      product_name: smRow.product_name, mrp: smRow.mrp, is_active: true,
    } });
    writes.push({ op: "insert_mapper", row: {
      mapper_set_id: mapperSetId, master_sku: mrRow.master_sku, is_combo: mrRow.is_combo,
      products: mrRow.products || [], fg_code: mrRow.fg_code, product_name: mrRow.product_name,
    } });
    changes.push({
      sku: d.masterSku, action: "add", target: "both",
      details: d.kind === "combo"
        ? `new combo, ${(mrRow.products || []).length} component(s)${d.fgCode ? `, FG ${d.fgCode}` : " — no FG code"}`
        : `new single${d.fgCode ? `, FG ${d.fgCode}` : " — no FG code"}${smRow.mrp == null ? ", no MRP" : `, MRP ${smRow.mrp}`}`,
    });
  }

  const after: LiveState = {
    skuMaster: [...live.skuMaster, ...draftSm],
    mapperRows: [...live.mapperRows, ...draftMr],
  };
  return buildPlan(live, after, writes, changes, skipped, touched, [mapperSetId]);
}

// ── planFix — one-click repair of a half-registered SKU ──────────────────────

/**
 * Create whichever side is missing so a SKU exists in both tables.
 * This is the compensation for the two inserts not being atomic: if a batch dies
 * between them, Fix finishes the job.
 */
export function planFix(live: LiveState, sku: string, mapperSetId: string): Plan {
  const changes: Change[] = [];
  const skipped: string[] = [];
  const writes: Write[] = [];

  const rows = buildRows(live.skuMaster, live.mapperRows);
  const row = rows.find((r) => norm(r.masterSku) === norm(sku));
  if (!row) { skipped.push(`${sku}: not found`); return buildPlan(live, live, writes, changes, skipped, [sku], [mapperSetId]); }

  const draftSm: SkuMasterRow[] = [];
  const draftMr: MapperDbRow[] = [];

  if (!row.inMapper) {
    writes.push({ op: "insert_mapper", row: {
      mapper_set_id: mapperSetId, master_sku: row.masterSku, is_combo: false, products: [],
      fg_code: row.fgCode || null, product_name: row.productName || null,
    } });
    draftMr.push({ id: "fix", mapper_set_id: mapperSetId, master_sku: row.masterSku, is_combo: false, products: [], fg_code: row.fgCode || null, product_name: row.productName || null });
    changes.push({ sku: row.masterSku, action: "add", target: "mapper", details: "mapper row created as a single — the converter can now resolve it" });
  }
  if (!row.inSkuMaster) {
    writes.push({ op: "insert_sku_master", row: {
      new_master_sku: row.masterSku, new_fg_code: row.fgCode || null,
      product_name: row.productName || null, mrp: null, is_active: true,
    } });
    draftSm.push({ id: "fix", new_master_sku: row.masterSku, new_fg_code: row.fgCode || null, product_name: row.productName || null, mrp: null, is_active: true, discontinued_at: null });
    changes.push({ sku: row.masterSku, action: "add", target: "sku_master", details: "SKU Master row created — fill in FG code and MRP" });
  }
  if (writes.length === 0) skipped.push(`${sku}: already present in both tables`);

  const after: LiveState = { skuMaster: [...live.skuMaster, ...draftSm], mapperRows: [...live.mapperRows, ...draftMr] };
  return buildPlan(live, after, writes, changes, skipped, [sku], [mapperSetId]);
}

// ── planPurgeComponent — delete the combos built on a dead component ──────────

/**
 * Delete every combo that consumes `component`. The component's OWN rows are never
 * touched.
 *
 * Two callers, one shape:
 *   - a ghost (no row in either table) — there is nothing to delete but its parents
 *   - a retired single — the combos around it are dead, but the single must stay
 *
 * Why the single stays: deleting a sku_master row is ON DELETE CASCADE into
 * forecast_data and channel_sku_mapping, and historical_forecast_data joins by text
 * so it would dangle. PC_BC_150G alone has 8 forecast rows, 22 channel mappings and
 * 131 history rows. Retirement keeps the mapper row, so those 131 rows still
 * decompose correctly when an old forecast is re-run. Deleting is not the clean
 * end state — retiring is.
 */
export function planPurgeComponent(live: LiveState, ghostSku: string, refsByParent?: Map<string, RefCounts>): Plan {
  const changes: Change[] = [];
  const skipped: string[] = [];
  const writes: Write[] = [];
  const touched: string[] = [ghostSku];
  const setIds = new Set<string>();

  const parents = live.mapperRows.filter((m) => (m.products || []).some((p) => norm(p) === norm(ghostSku)));
  if (parents.length === 0) skipped.push(`${ghostSku}: no combo uses it — nothing to remove`);

  const deletedKeys = new Set<string>();
  for (const p of parents) {
    touched.push(p.master_sku);
    // A combo cannot be deleted as a parent of itself.
    if (norm(p.master_sku) === norm(ghostSku)) continue;
    const key = `${norm(p.master_sku)}|${p.mapper_set_id}`;
    if (deletedKeys.has(key)) continue; // duplicate rows: one delete covers them

    // forecast_data.sku_id and channel_sku_mapping.sku_id are ON DELETE CASCADE
    // against sku_master(id) — confirmed in the live database. Deleting a parent's
    // sku_master row would therefore SILENTLY destroy its forecast history, with no
    // error. Refuse the whole parent rather than delete half of it: dropping only
    // the mapper row would leave the sku_master row behind as a fresh orphan.
    const refs = refsByParent?.get(norm(p.master_sku));
    const blocking = refs ? (Object.entries(refs) as Array<[string, number]>).filter(([, n]) => n > 0) : [];
    if (blocking.length > 0) {
      skipped.push(
        `${p.master_sku}: referenced by ${blocking.map(([t, n]) => `${t} (${n})`).join(", ")}. ` +
        `Deleting it would cascade and destroy that history. Remove "${ghostSku}" from its components by hand, or retire it.`
      );
      continue;
    }

    deletedKeys.add(key);
    setIds.add(p.mapper_set_id);

    const others = (p.products || []).filter((x) => norm(x) !== norm(ghostSku));
    writes.push({ op: "delete_mapper", masterSku: p.master_sku, mapperSetId: p.mapper_set_id });
    changes.push({
      sku: p.master_sku, action: "delete", target: "mapper",
      details: `combo deleted — built around discontinued "${ghostSku}"${others.length ? `; its other component(s) ${[...new Set(others)].join(", ")} survive independently` : ""}`,
    });

    // A parent with its own sku_master row would be left an ORPHAN — the exact
    // failure this whole effort exists to close. Delete both or neither.
    const sm = live.skuMaster.find((s) => norm(s.new_master_sku) === norm(p.master_sku));
    if (sm) {
      writes.push({ op: "delete_sku_master", id: sm.id, masterSku: sm.new_master_sku });
      changes.push({ sku: p.master_sku, action: "delete", target: "sku_master", details: "SKU Master row removed too (leaving it would create an orphan)" });
    }
  }

  const after: LiveState = {
    skuMaster: live.skuMaster.filter((s) => !writes.some((w) => w.op === "delete_sku_master" && w.id === s.id)),
    mapperRows: live.mapperRows.filter((m) => !deletedKeys.has(`${norm(m.master_sku)}|${m.mapper_set_id}`)),
  };
  return buildPlan(live, after, writes, changes, skipped, touched, [...setIds]);
}

// ── planRetire — soft delete ─────────────────────────────────────────────────

/**
 * Retire = sku_master.is_active=false. The mapper row STAYS.
 *
 * The mapper is a decomposition dictionary, not a catalogue: a retired SKU in a
 * historical upload must still decompose correctly. Filtering it out of the mapper
 * would re-create precisely the orphan invisibility this work just closed.
 */
export function planRetire(live: LiveState, sku: string, retire = true): Plan {
  const changes: Change[] = [];
  const skipped: string[] = [];
  const writes: Write[] = [];

  const sm = live.skuMaster.find((s) => norm(s.new_master_sku) === norm(sku));
  if (!sm) {
    skipped.push(`${sku}: no SKU Master row — retirement lives there, so there is nothing to retire`);
    return buildPlan(live, live, writes, changes, skipped, [sku], []);
  }

  const rows = buildRows(live.skuMaster, live.mapperRows);
  const row = rows.find((r) => norm(r.masterSku) === norm(sku));
  const users = row?.usedIn || [];

  writes.push({ op: "retire_sku_master", id: sm.id, masterSku: sm.new_master_sku, retire });
  changes.push({
    sku: sm.new_master_sku, action: "retire", target: "sku_master",
    details: retire
      ? `marked discontinued. Mapper row kept, so it still decomposes.${users.length ? ` ${users.length} combo(s) consume it: ${users.map((u) => u.sku).join(", ")}.` : ""} Note: forecast downloads silently omit inactive SKUs.`
      : "reactivated",
  });

  const after: LiveState = {
    skuMaster: live.skuMaster.map((s) => s.id === sm.id
      ? { ...s, is_active: !retire, discontinued_at: retire ? new Date().toISOString() : null }
      : s),
    mapperRows: live.mapperRows,
  };
  return buildPlan(live, after, writes, changes, skipped, [sku], []);
}

// ── planHardDelete — gated ───────────────────────────────────────────────────

export type RefCounts = {
  forecast_data: number;
  forecast_data_combos: number;
  historical_forecast_data: number;
  supply_plan: number;
  mapper_suggestions: number;
  channel_sku_mapping: number;
};

/**
 * Hard delete, refused unless nothing anywhere references the SKU.
 *
 * `refs` MUST be counted server-side from fresh data. Five of these tables join by
 * TEXT, so no foreign key will stop a bad delete — the rows simply dangle.
 */
export function planHardDelete(live: LiveState, sku: string, refs: RefCounts): Plan {
  const changes: Change[] = [];
  const skipped: string[] = [];
  const writes: Write[] = [];
  const setIds = new Set<string>();

  const rows = buildRows(live.skuMaster, live.mapperRows);
  const row = rows.find((r) => norm(r.masterSku) === norm(sku));

  if (row && row.usedIn.length > 0) {
    skipped.push(`${sku}: consumed by ${row.usedIn.length} combo(s) — ${row.usedIn.map((u) => u.sku).join(", ")}. Remove it from those first.`);
  }
  const blocking = (Object.entries(refs) as Array<[keyof RefCounts, number]>).filter(([, n]) => n > 0);
  if (blocking.length > 0) {
    skipped.push(`${sku}: referenced by ${blocking.map(([t, n]) => `${t} (${n})`).join(", ")}. Retire it instead — deleting would leave those rows dangling.`);
  }
  if (skipped.length > 0) return buildPlan(live, live, writes, changes, skipped, [sku], []);

  // Delete by master_sku across EVERY set, deliberately: buildRows hides duplicate
  // rows (it keeps the one with most components), so deleting by the id the grid
  // happens to hold would silently leave the other copies behind.
  const mapperHits = live.mapperRows.filter((m) => norm(m.master_sku) === norm(sku));
  for (const m of mapperHits) setIds.add(m.mapper_set_id);
  const bySet = new Map<string, number>();
  for (const m of mapperHits) bySet.set(m.mapper_set_id, (bySet.get(m.mapper_set_id) || 0) + 1);
  for (const [setId, n] of bySet) {
    writes.push({ op: "delete_mapper", masterSku: sku, mapperSetId: setId });
    changes.push({ sku, action: "delete", target: "mapper", details: `${n} mapper row(s) removed from set ${setId}` });
  }

  const sm = live.skuMaster.find((s) => norm(s.new_master_sku) === norm(sku));
  if (sm) {
    writes.push({ op: "delete_sku_master", id: sm.id, masterSku: sm.new_master_sku });
    changes.push({ sku, action: "delete", target: "sku_master", details: "SKU Master row removed" });
  }
  if (writes.length === 0) skipped.push(`${sku}: no rows exist to delete (it may be a ghost — purge its parents instead)`);

  const after: LiveState = {
    skuMaster: live.skuMaster.filter((s) => norm(s.new_master_sku) !== norm(sku)),
    mapperRows: live.mapperRows.filter((m) => norm(m.master_sku) !== norm(sku)),
  };
  return buildPlan(live, after, writes, changes, skipped, [sku], [...setIds]);
}

// ── planCellEdit — single-field edit from the grid ───────────────────────────

export type CellField = "fgCode" | "productName" | "mrp" | "components";

export function planCellEdit(live: LiveState, sku: string, field: CellField, raw: string, mapperSetId: string): Plan {
  const changes: Change[] = [];
  const skipped: string[] = [];
  const writes: Write[] = [];
  const touched = [sku];

  const sm = live.skuMaster.find((s) => norm(s.new_master_sku) === norm(sku));
  const mrRows = live.mapperRows.filter((m) => norm(m.master_sku) === norm(sku) && m.mapper_set_id === mapperSetId);
  const value = raw.trim();

  let after: LiveState = live;

  if (field === "components") {
    if (mrRows.length === 0) { skipped.push(`${sku}: no mapper row in this set`); return buildPlan(live, live, writes, changes, skipped, touched, [mapperSetId]); }
    const products = value.split(",").map((p) => p.trim()).filter(Boolean);
    if (products.some((p) => norm(p) === norm(sku))) { skipped.push(`${sku}: a combo cannot contain itself`); return buildPlan(live, live, writes, changes, skipped, touched, [mapperSetId]); }
    const universe = toNestRows(live.mapperRows);
    const { resolved, expanded } = flattenOne(products, universe, sku);
    if (expanded.length) changes.push({ sku, action: "update", target: "mapper", details: `references combo(s) ${expanded.join(", ")} → flattened to [${resolved.join(", ")}]` });
    // Components present ⇒ it is a combo. Keep the flag honest automatically; the
    // reverse (combo flag with no components) is CRITICAL and must stay visible.
    const isCombo = resolved.length > 0;
    writes.push({ op: "update_mapper", masterSku: sku, mapperSetId, patch: { products: resolved, is_combo: isCombo } });
    changes.push({ sku, action: "update", target: "mapper", details: `components → [${resolved.join(", ")}]${isCombo ? "" : " (now a single)"}` });
    for (const p of resolved) touched.push(p);
    after = { skuMaster: live.skuMaster, mapperRows: live.mapperRows.map((m) =>
      norm(m.master_sku) === norm(sku) && m.mapper_set_id === mapperSetId ? { ...m, products: resolved, is_combo: isCombo } : m) };
  } else if (field === "mrp") {
    if (!sm) { skipped.push(`${sku}: MRP lives in SKU Master and this SKU has no row there. Use Fix first.`); return buildPlan(live, live, writes, changes, skipped, touched, [mapperSetId]); }
    const res = parseMrp(value);
    if (!res.ok) { skipped.push(`${sku}: ${res.reason}`); return buildPlan(live, live, writes, changes, skipped, touched, [mapperSetId]); }
    writes.push({ op: "update_sku_master", id: sm.id, masterSku: sku, patch: { mrp: res.value } });
    changes.push({ sku, action: "update", target: "sku_master", details: `MRP → ${res.value ?? "(none)"}` });
    after = { skuMaster: live.skuMaster.map((s) => s.id === sm.id ? { ...s, mrp: res.value } : s), mapperRows: live.mapperRows };
  } else if (field === "fgCode") {
    const clash = [...live.skuMaster.map((s) => ({ sku: s.new_master_sku, fg: s.new_fg_code })),
                   ...live.mapperRows.map((m) => ({ sku: m.master_sku, fg: m.fg_code }))]
      .find((x) => x.fg && norm(x.fg) === norm(value) && norm(x.sku) !== norm(sku));
    if (value && clash) { skipped.push(`${sku}: FG code "${value}" already belongs to "${clash.sku}"`); return buildPlan(live, live, writes, changes, skipped, touched, [mapperSetId]); }
    // FG code is denormalised across both tables — write every copy that exists, or
    // the grid shows one value while the converter reads another.
    if (sm) writes.push({ op: "update_sku_master", id: sm.id, masterSku: sku, patch: { new_fg_code: value || null } });
    for (const m of mrRows) writes.push({ op: "update_mapper", masterSku: sku, mapperSetId: m.mapper_set_id, patch: { fg_code: value || null } });
    if (writes.length === 0) { skipped.push(`${sku}: exists in neither table — use Fix first`); return buildPlan(live, live, writes, changes, skipped, touched, [mapperSetId]); }
    changes.push({ sku, action: "update", target: sm && mrRows.length ? "both" : sm ? "sku_master" : "mapper", details: `FG code → ${value || "(none)"}` });
    after = {
      skuMaster: live.skuMaster.map((s) => norm(s.new_master_sku) === norm(sku) ? { ...s, new_fg_code: value || null } : s),
      mapperRows: live.mapperRows.map((m) => norm(m.master_sku) === norm(sku) ? { ...m, fg_code: value || null } : m),
    };
  } else {
    if (sm) writes.push({ op: "update_sku_master", id: sm.id, masterSku: sku, patch: { product_name: value || null } });
    for (const m of mrRows) writes.push({ op: "update_mapper", masterSku: sku, mapperSetId: m.mapper_set_id, patch: { product_name: value || null } });
    if (writes.length === 0) { skipped.push(`${sku}: exists in neither table — use Fix first`); return buildPlan(live, live, writes, changes, skipped, touched, [mapperSetId]); }
    changes.push({ sku, action: "update", target: sm && mrRows.length ? "both" : sm ? "sku_master" : "mapper", details: `Product name → ${value || "(none)"}` });
    after = {
      skuMaster: live.skuMaster.map((s) => norm(s.new_master_sku) === norm(sku) ? { ...s, product_name: value || null } : s),
      mapperRows: live.mapperRows.map((m) => norm(m.master_sku) === norm(sku) ? { ...m, product_name: value || null } : m),
    };
  }

  return buildPlan(live, after, writes, changes, skipped, touched, [mapperSetId]);
}

/** Re-export so the route and the UI agree on what "changed underneath us" means. */
export { hashTouched as _hashTouched };
