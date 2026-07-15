// Pure row model for Mapper Studio — no React, no Supabase, so it can be tested directly.
//
// Two tables back a Master SKU and neither is a superset of the other:
//   sku_master        — attributes (FG code, MRP, name) for a subset of SKUs
//   combo_mapper_rows — existence + decomposition; this is what the converter reads
//
// A SKU present in sku_master but absent from combo_mapper_rows is invisible to the
// converter (an ORPHAN). Detecting that is this module's main job.

export type MapperSet = { id: string; name: string; is_default: boolean };

export type SkuMasterRow = {
  id: string;
  new_master_sku: string;
  new_fg_code: string | null;
  product_name: string | null;
  category?: string | null;
  product_category?: string | null;
  mrp: number | null;
  is_active: boolean;
  discontinued_at: string | null;
};

export type MapperDbRow = {
  id: string;
  mapper_set_id: string;
  master_sku: string;
  is_combo: boolean;
  products: string[] | null;
  fg_code: string | null;
  product_name: string | null;
};

export type IssueCode =
  | "ORPHAN"
  | "GHOST"
  | "CRITICAL"
  | "UNENRICHED"
  | "NO_FG"
  | "NO_MRP"
  | "DISCONTINUED_IN_COMBO"
  | "UNKNOWN_COMPONENT";

export type Issue = { code: IssueCode; detail: string };

export type Row = {
  masterSku: string;
  inMapper: boolean;
  inSkuMaster: boolean;
  mapperId: string | null;
  skuMasterId: string | null;
  isCombo: boolean;
  products: string[];
  fgCode: string;
  productName: string;
  mrp: number | null;
  isActive: boolean;
  discontinued: boolean;
  usedIn: Array<{ sku: string; qty: number }>;
  issues: Issue[];
};

export const ISSUE_META: Record<IssueCode, { label: string; tone: "red" | "amber" | "blue"; blocking: boolean }> = {
  ORPHAN:                { label: "Orphan",       tone: "red",   blocking: true },
  GHOST:                 { label: "Ghost",        tone: "red",   blocking: true },
  CRITICAL:              { label: "Critical",     tone: "red",   blocking: true },
  UNKNOWN_COMPONENT:     { label: "Bad part",     tone: "red",   blocking: true },
  DISCONTINUED_IN_COMBO: { label: "Disc. in use", tone: "amber", blocking: false },
  NO_FG:                 { label: "No FG",        tone: "amber", blocking: false },
  NO_MRP:                { label: "No MRP",       tone: "amber", blocking: false },
  // Informational, not a defect: a legacy mapper row that was never enriched with
  // SKU Master attributes. ~484 exist and they convert correctly.
  UNENRICHED:            { label: "Unenriched",   tone: "blue",  blocking: false },
};

export const norm = (s: string) => (s || "").trim().toLowerCase();

export function isBlocking(r: Row): boolean {
  return r.issues.some((i) => ISSUE_META[i.code].blocking);
}

export function buildRows(skuMaster: SkuMasterRow[], mapperRows: MapperDbRow[]): Row[] {
  const smBySku = new Map<string, SkuMasterRow>();
  for (const s of skuMaster) smBySku.set(norm(s.new_master_sku), s);

  const mapBySku = new Map<string, MapperDbRow>();
  for (const m of mapperRows) {
    const k = norm(m.master_sku);
    // The mapper contains duplicate master_sku rows; prefer the one carrying components.
    const prev = mapBySku.get(k);
    if (!prev || (m.products?.length || 0) > (prev.products?.length || 0)) mapBySku.set(k, m);
  }

  // Reverse index: component -> combos that consume it, with multiplicity.
  //
  // Built from the DEDUPLICATED rows above, not the raw list. 165 duplicate
  // master_sku rows exist; iterating raw would count each copy's components again,
  // so EB_VP_30G (two identical rows, each 3 x EB_VP_10G) reported x6 instead of x3.
  // The grid, the retire blast radius and the delete gate all read this.
  const usedIn = new Map<string, Map<string, number>>();
  for (const m of mapBySku.values()) {
    if (!m.is_combo) continue;
    for (const p of m.products || []) {
      if (!p || !p.trim()) continue;
      const k = norm(p);
      if (!usedIn.has(k)) usedIn.set(k, new Map());
      const inner = usedIn.get(k)!;
      inner.set(m.master_sku, (inner.get(m.master_sku) || 0) + 1);
    }
  }

  // Universe = mapper ∪ sku_master ∪ every referenced component.
  const keys = new Map<string, string>();
  for (const m of mapperRows) keys.set(norm(m.master_sku), m.master_sku);
  for (const s of skuMaster) if (!keys.has(norm(s.new_master_sku))) keys.set(norm(s.new_master_sku), s.new_master_sku);
  for (const k of usedIn.keys()) {
    if (keys.has(k)) continue;
    const disp = mapperRows.flatMap((m) => m.products || []).find((p) => norm(p) === k);
    keys.set(k, disp || k);
  }

  const out: Row[] = [];
  for (const [k, display] of keys) {
    const sm = smBySku.get(k);
    const mp = mapBySku.get(k);
    const products = (mp?.products || []).filter((p) => p && p.trim());
    const uses = [...(usedIn.get(k)?.entries() || [])]
      .map(([sku, qty]) => ({ sku, qty }))
      .sort((a, b) => a.sku.localeCompare(b.sku));

    out.push({
      masterSku: display,
      inMapper: !!mp,
      inSkuMaster: !!sm,
      mapperId: mp?.id || null,
      skuMasterId: sm?.id || null,
      isCombo: mp ? mp.is_combo : products.length > 0,
      products,
      fgCode: (sm?.new_fg_code || mp?.fg_code || "").trim(),
      productName: (sm?.product_name || mp?.product_name || "").trim(),
      mrp: sm?.mrp ?? null,
      isActive: sm ? sm.is_active !== false : true,
      discontinued: !!sm?.discontinued_at || sm?.is_active === false,
      usedIn: uses,
      issues: [],
    });
  }

  const byKey = new Map(out.map((r) => [norm(r.masterSku), r]));
  for (const r of out) {
    if (r.inSkuMaster && !r.inMapper)
      r.issues.push({ code: "ORPHAN", detail: "In SKU Master but has no mapper row. The converter has no decomposition for it: it will be flagged NOT IN MAPPER, and if it is meant to expand into other SKUs it silently won't. Click Fix to add the mapper row." });
    if (!r.inSkuMaster && !r.inMapper)
      r.issues.push({ code: "GHOST", detail: "Referenced as a combo component but defined in neither table." });
    if (r.isCombo && r.products.length === 0)
      r.issues.push({ code: "CRITICAL", detail: "Marked as a combo but has no components — it cannot expand." });

    // One issue per DISTINCT component. products carries multiplicity (["A","A"]
    // means 2xA), so iterating it directly would raise the same issue once per unit
    // and inflate every count that reads it.
    const seenComp = new Set<string>();
    for (const p of r.products) {
      const k = norm(p);
      if (seenComp.has(k)) continue;
      seenComp.add(k);
      const comp = byKey.get(k);
      if (!comp) r.issues.push({ code: "UNKNOWN_COMPONENT", detail: `Component "${p}" is not defined anywhere.` });
      else if (comp.discontinued)
        r.issues.push({ code: "DISCONTINUED_IN_COMBO", detail: `Component "${p}" is discontinued but this combo still uses it.` });
    }

    // Enrichment issues only make sense for a SKU that exists somewhere.
    //
    // A mapper row with no SKU Master row has no FG code and no MRP *by
    // construction* — that is one fact, not two defects. Reporting it as NO_FG +
    // NO_MRP put an amber badge on more than half the grid and buried the rows
    // that genuinely need attention. It is expected legacy state and converts fine.
    if (!r.inMapper && !r.inSkuMaster) {
      // Ghost: GHOST already says the whole story. Adding "no FG code" to a SKU
      // that has no row at all is noise.
    } else if (r.inMapper && !r.inSkuMaster) {
      r.issues.push({ code: "UNENRICHED", detail: "No SKU Master row, so no FG code or MRP. Converts correctly; enrich it when convenient. Use Fix to create the row." });
    } else {
      if (!r.fgCode && !r.discontinued)
        r.issues.push({ code: "NO_FG", detail: "No FG code — exports will have a blank FG column for this SKU." });
      // MRP only matters for a single a combo consumes: NTO splits by MRP ratio.
      // Qty conversion and export never read it.
      if (!r.isCombo && r.usedIn.length > 0 && (r.mrp == null || r.mrp <= 0) && !r.discontinued)
        r.issues.push({ code: "NO_MRP", detail: `No MRP. Only matters if a combo consuming it runs NTO conversion — ${r.usedIn.length} do: ${r.usedIn.slice(0, 3).map((u) => u.sku).join(", ")}. Qty conversion and exports are unaffected.` });
    }
  }

  return out.sort((a, b) => {
    const sev = (r: Row) => (isBlocking(r) ? 0 : r.issues.length > 0 ? 1 : 2);
    return sev(a) - sev(b) || a.masterSku.localeCompare(b.masterSku);
  });
}

export type IssueDelta = { masterSku: string; added: Issue[]; removed: Issue[] };

/**
 * What a pending change does to the health of the WHOLE mapper — not just the rows
 * being touched. Run buildRows over live data, then over live+draft, and diff.
 *
 * This is the blast radius: adding a combo that consumes an MRP-less single gives
 * that single a NO_MRP issue it didn't have before, which blocks NTO conversion for
 * every combo that uses it. The admin must see that before confirming, not after.
 */
export function diffIssues(before: Row[], after: Row[]): IssueDelta[] {
  const key = (r: Row) => norm(r.masterSku);
  const beforeBy = new Map(before.map((r) => [key(r), r]));
  const afterBy = new Map(after.map((r) => [key(r), r]));
  const deltas: IssueDelta[] = [];

  for (const [k, aft] of afterBy) {
    const bef = beforeBy.get(k);
    const befCodes = new Set((bef?.issues || []).map((i) => i.code));
    const aftCodes = new Set(aft.issues.map((i) => i.code));
    const added = aft.issues.filter((i) => !befCodes.has(i.code));
    const removed = (bef?.issues || []).filter((i) => !aftCodes.has(i.code));
    if (added.length || removed.length) deltas.push({ masterSku: aft.masterSku, added, removed });
  }
  // Rows that disappeared entirely (a delete) — their issues are all "removed".
  for (const [k, bef] of beforeBy) {
    if (afterBy.has(k)) continue;
    if (bef.issues.length) deltas.push({ masterSku: bef.masterSku, added: [], removed: bef.issues });
  }

  return deltas.sort((a, b) => b.added.length - a.added.length || a.masterSku.localeCompare(b.masterSku));
}
