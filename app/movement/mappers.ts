// Build the engine's Mappers object from live platform data:
//   sku_master        → FG code → new_master_sku + display info  (reused, not duplicated)
//   combo_mapper_rows → combo explosion (products[] repetition, nested-flattened)
//   movement_customer_map / movement_warehouse_map / movement_fg_alias
//                     → the editable movement-specific maps (Phase 3)
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Mappers, SkuInfo } from "./engine";
import { fgBase } from "./engine";

type SkuMasterRow = { new_master_sku: string; new_fg_code: string | null; product_name: string | null; category: string | null; product_category: string | null };
type ComboRow = { master_sku: string; is_combo: boolean; products: string[] | null; fg_code: string | null };
type CustomerMap = { customer: string; channel: string | null; platform: string | null };
type WarehouseMap = { warehouse: string; channel: string | null };
type FgAlias = { fg_code: string; new_master_sku: string };

export type MapperLoad = { mappers: Mappers; stats: Record<string, number>; warnings: string[] };

const norm = (s: string) => (s || "").trim();
const upFg = (raw: string) => (raw.split("/").pop() ?? "").trim().toUpperCase();

export async function loadMappers(sb: SupabaseClient): Promise<MapperLoad> {
  const warnings: string[] = [];
  // paged fetch (Supabase caps at 1000/req)
  async function all<T>(table: string, cols: string): Promise<T[]> {
    const out: T[] = []; let from = 0;
    for (;;) {
      const { data, error } = await sb.from(table).select(cols).range(from, from + 999);
      if (error) { warnings.push(`${table}: ${error.message}`); break; }
      const rows = (data ?? []) as T[]; out.push(...rows);
      if (rows.length < 1000) break; from += 1000;
    }
    return out;
  }

  const [skuMaster, comboRows, custMap, whMap, aliases] = await Promise.all([
    all<SkuMasterRow>("sku_master", "new_master_sku,new_fg_code,product_name,category,product_category"),
    all<ComboRow>("combo_mapper_rows", "master_sku,is_combo,products,fg_code"),
    all<CustomerMap>("movement_customer_map", "customer,channel,platform"),
    all<WarehouseMap>("movement_warehouse_map", "warehouse,channel"),
    all<FgAlias>("movement_fg_alias", "fg_code,new_master_sku"),
  ]);

  // FG → sku : exact code, then base number. Alias table wins.
  const fgExact = new Map<string, string>();
  const fgByBase = new Map<string, string>();
  const info = new Map<string, SkuInfo>();
  const put = (fg: string | null, sku: string) => {
    const f = norm(fg ?? ""); if (!f || !sku) return;
    const e = f.toUpperCase(); if (!fgExact.has(e)) fgExact.set(e, sku);
    const b = fgBase(f); if (b && !fgByBase.has(b)) fgByBase.set(b, sku);
  };
  for (const r of skuMaster) {
    const sku = norm(r.new_master_sku); if (!sku) continue;
    put(r.new_fg_code, sku);
    if (!info.has(sku)) info.set(sku, { productName: r.product_name ?? sku, category: r.category ?? "Uncategorised", fgCode: r.new_fg_code ?? "", productCategory: r.product_category ?? "" });
  }
  for (const r of comboRows) { if (r.fg_code) put(r.fg_code, norm(r.master_sku)); }
  for (const a of aliases) { const e = norm(a.fg_code).toUpperCase(); if (e) fgExact.set(e, norm(a.new_master_sku)); const b = fgBase(a.fg_code); if (b) fgByBase.set(b, norm(a.new_master_sku)); }

  // combo explosion (repetition array, nested-flattened with cycle guard)
  const combo = new Map<string, string[]>();
  for (const r of comboRows) if (r.is_combo && r.products?.length) combo.set(norm(r.master_sku), r.products.map(norm).filter(Boolean));
  const explodeCache = new Map<string, { sku: string; qty: number }[]>();
  function explode(sku: string, seen: Set<string> = new Set()): { sku: string; qty: number }[] {
    if (!combo.has(sku) || seen.has(sku)) return [{ sku, qty: 1 }];
    const cached = explodeCache.get(sku); if (cached && seen.size === 0) return cached;
    seen.add(sku); const out = new Map<string, number>();
    for (const p of combo.get(sku)!) for (const c of explode(p, seen)) out.set(c.sku, (out.get(c.sku) ?? 0) + c.qty);
    seen.delete(sku);
    const res = [...out].map(([s, q]) => ({ sku: s, qty: q }));
    if (seen.size === 0) explodeCache.set(sku, res);
    return res;
  }

  const cust2ch = new Map<string, string>(), cust2pl = new Map<string, string>();
  for (const r of custMap) { const c = norm(r.customer); if (!c) continue; if (r.channel) cust2ch.set(c, norm(r.channel)); if (r.platform) cust2pl.set(c, norm(r.platform)); }
  const wh2ch = new Map<string, string>();
  for (const r of whMap) { const w = norm(r.warehouse); if (w && r.channel) wh2ch.set(w, norm(r.channel)); }

  const mappers: Mappers = {
    fgToSku: (raw) => { const e = upFg(raw); return fgExact.get(e) ?? fgByBase.get(fgBase(raw) ?? "") ?? null; },
    explode,
    customerToChannel: (p) => cust2ch.get(norm(p)) ?? null,
    customerToPlatform: (p) => cust2pl.get(norm(p)) ?? null,
    warehouseToChannel: (w) => wh2ch.get(norm(w)) ?? null,
    skuInfo: (s) => info.get(s) ?? { productName: s, category: "Uncategorised", fgCode: "", productCategory: "" },
  };
  const stats = { skuMaster: skuMaster.length, comboRows: comboRows.length, combos: combo.size, customers: cust2ch.size, warehouses: wh2ch.size, aliases: aliases.length };
  if (cust2ch.size === 0) warnings.push("No customer→channel map found — run the movement_mappers migration + seed, then edit under Movement Mappers.");
  return { mappers, stats, warnings };
}
