// ============================================================================
// Movement compute engine (Phase 2) — pure, no React / no Supabase, so it can
// be unit-tested directly. Takes the 3 raw daily sheets + a Forecast sheet +
// resolved mappers, and produces the dashboard snapshot.
//
// Mappers are INJECTED (not hard-wired), so the same engine runs against:
//   • production  — sku_master + combo_mapper_rows + editable channel maps
//   • tests       — fixtures extracted from a workbook
//
// Resolution rules (no unsaid normalisation — a SKU is whatever the mapper
// says; No-MRP ≠ regular MRP):
//   raw FG code → new_master_sku    via sku_master.new_fg_code, matched by the
//                                    leading digits (N/G suffix differs by file)
//   combo       → components        via combo_mapper_rows.products (a repetition
//                                    array; ["A","A"] = 2×A), flattened for nests
//   SO channel  ← customer → channel/platform      (editable movement mapper)
//   STN channel ← from/to warehouse → channel      (editable movement mapper)
// Only ex-mother-node movement counts (Warehouse / From Warehouse = the node);
// STN is Closed only. Anything whose FG does not resolve to a tracked FG SKU is
// ignored (this is how SFG / intermediates drop out).
// ============================================================================
import * as XLSX from "xlsx";
import type { Snapshot, OverallRow, ChannelRow, QcomRow, DailyRow } from "./lib";

export const NODE = "YB FG Warehouse";
// STN leaves the business two ways: from the mother node, or directly from the
// Central FG warehouse (a major CFA dispatch point). Both are "ex-node" sources.
// The Central Production *lines* are factory and never count. Inter-node hops
// (Central→YB FG) don't reach a channel, so they drop out naturally — no double count.
export const STN_SOURCES = new Set([NODE, "Central"]);
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ── injected mapper surface ──────────────────────────────────────────────────
export type SkuInfo = { productName: string; category: string; fgCode: string; productCategory?: string };
export type Mappers = {
  /** raw FG code (e.g. "YB/10PrB/14154G" or "14154G") → new_master_sku, or null */
  fgToSku: (rawFg: string) => string | null;
  /** explode one unit-line of a sku into leaf components with quantities;
   *  returns [{sku, qty}] already flattened through nested combos. A non-combo
   *  returns [{sku, qty:1}]. */
  explode: (sku: string) => { sku: string; qty: number }[];
  /** SO customer (Party Name) → channel (MT/Qcom/B2B/…) or null to drop */
  customerToChannel: (party: string) => string | null;
  /** SO customer → q-commerce platform (Blinkit/Zepto/…) or null */
  customerToPlatform: (party: string) => string | null;
  /** STN destination (To Warehouse) → channel or null to drop */
  warehouseToChannel: (toWarehouse: string) => string | null;
  /** display attributes for a new_master_sku (from sku_master) */
  skuInfo: (sku: string) => SkuInfo;
};

// ── helpers ──────────────────────────────────────────────────────────────────
export function num(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v).trim().replace(/,/g, "");
  if (["", "-", "#N/A", "#VALUE!", "N/A"].includes(s)) return 0;
  const n = parseFloat(s); return Number.isFinite(n) ? n : 0;
}
export function txt(v: unknown): string {
  if (v == null) return "";
  const s = String(v).trim(); return s === "#N/A" || s === "#VALUE!" ? "" : s;
}
/** leading digits of an FG code — the file-independent key (N vs G suffix). */
export function fgBase(rawFg: string): string | null {
  const last = String(rawFg).split("/").pop() ?? "";
  const m = last.match(/^\s*0*(\d+)/); return m ? m[1] : null;
}
export function ymd(v: unknown): { y: number; m: number; d: number } | null {
  if (typeof v === "number") { const p = XLSX.SSF.parse_date_code(v); return p ? { y: p.y, m: p.m, d: p.d } : null; }
  if (v instanceof Date) return { y: v.getUTCFullYear(), m: v.getUTCMonth() + 1, d: v.getUTCDate() };
  const s = txt(v);
  let mm = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (mm) return { y: +mm[1], m: +mm[2], d: +mm[3] };
  mm = s.match(/^(\d{2})-(\d{2})-(\d{4})/); if (mm) return { y: +mm[3], m: +mm[2], d: +mm[1] };   // DD-MM-YYYY (STN)
  return null;
}

/** Does a row's date belong to the target month? Rows dated to another month are
 *  dropped (so a 2-month export only counts the selected month); undated rows are
 *  kept, so a clean single-month file is unaffected. */
const inMonth = (v: unknown, mi: MonthInfo) => { const p = ymd(v); return !p || (p.y === mi.actY && p.m === mi.actM); };

export type Grid = unknown[][];
const gridCache = new WeakMap<object, Grid>();   // parse each worksheet once
export function sheetGrid(wb: XLSX.WorkBook, name?: string): Grid {
  const ws = name ? wb.Sheets[name] : wb.Sheets[wb.SheetNames[0]];
  if (!ws || !ws["!ref"]) return [];
  const hit = gridCache.get(ws as object); if (hit) return hit;
  // Some sheets carry a bloated !ref (e.g. A1:CW1048576) that would allocate a
  // million empty rows. Derive the real used range from the actual cell keys.
  let maxR = 0, maxC = 0;
  for (const k in ws) {
    if (k.charCodeAt(0) === 33) continue;                 // '!' meta keys
    const cell = XLSX.utils.decode_cell(k);
    if (cell.r > maxR) maxR = cell.r; if (cell.c > maxC) maxC = cell.c;
  }
  const g = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true, range: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } }) }) as Grid;
  gridCache.set(ws as object, g);
  return g;
}
export function findHeader(g: Grid, required: string[]): { row: number; H: Record<string, number> } {
  for (let i = 0; i < Math.min(g.length, 15); i++) {
    const H: Record<string, number> = {};
    (g[i] || []).forEach((h, j) => { if (h != null && String(h).trim() !== "") H[String(h).trim()] = j; });
    if (required.every((k) => k in H)) return { row: i, H };
  }
  throw new Error(`Could not find a header row with: ${required.join(", ")}`);
}
/** Find the first sheet whose grid contains a header row with all `required`. */
export function findSheet(wb: XLSX.WorkBook, required: string[]): { g: Grid; row: number; H: Record<string, number> } {
  for (const name of wb.SheetNames) {
    const g = sheetGrid(wb, name);
    try { const { row, H } = findHeader(g, required); return { g, row, H }; } catch { /* next sheet */ }
  }
  throw new Error(`No sheet has a header row with: ${required.join(", ")}`);
}

// ── aggregation primitives ───────────────────────────────────────────────────
export type SkuAgg = Map<string, number>;                    // sku → qty
export type SkuChanAgg = Map<string, Map<string, number>>;   // sku → channel → qty
function add(m: SkuAgg, k: string, q: number) { m.set(k, (m.get(k) ?? 0) + q); }
function add2(m: SkuChanAgg, sku: string, ch: string, q: number) {
  let r = m.get(sku); if (!r) { r = new Map(); m.set(sku, r); } r.set(ch, (r.get(ch) ?? 0) + q);
}

/** Resolve a raw FG + line qty to exploded leaf {sku, qty} contributions. */
export function resolveLine(rawFg: string, lineQty: number, mp: Mappers): { sku: string; qty: number }[] {
  const sku = mp.fgToSku(rawFg);
  if (!sku) return [];                                  // SFG / untracked → ignored
  return mp.explode(sku).map((c) => ({ sku: c.sku, qty: c.qty * lineQty }));
}

// ── SO: Overall SO (by sku) + Channelwise SO (by sku×channel) ────────────────
export type SoResult = { bySku: SkuAgg; bySkuChan: SkuChanAgg; rawExNodeDispatch: number; unmappedDispatch: number };
export function computeSO(wb: XLSX.WorkBook | undefined, mp: Mappers, mi: MonthInfo): SoResult {
  if (!wb) return { bySku: new Map(), bySkuChan: new Map(), rawExNodeDispatch: 0, unmappedDispatch: 0 };
  const g = sheetGrid(wb);
  const { row, H } = findHeader(g, ["Warehouse", "Dispatch Qty", "Product SKU", "Party Name"]);
  const bySku: SkuAgg = new Map(); const bySkuChan: SkuChanAgg = new Map();
  let rawExNodeDispatch = 0, unmappedDispatch = 0;
  for (let i = row + 1; i < g.length; i++) {
    const r = g[i]; if (!r) continue;
    if (r[H["Warehouse"]] !== NODE) continue;
    if (!inMonth(r[H["Last Dispatch Date"]], mi)) continue;   // scope to the selected month
    const dq = num(r[H["Dispatch Qty"]]); if (dq === 0) continue;
    rawExNodeDispatch += dq;
    // Only dispatch to a channel-mapped customer counts (sample/gifting/unmapped
    // customer types drop out) — the source workbook's Overall SO = sum of its
    // channel SO.
    const channel = mp.customerToChannel(txt(r[H["Party Name"]]));
    if (!channel) continue;
    const parts = resolveLine(txt(r[H["Product SKU"]]), dq, mp);
    if (parts.length === 0) { unmappedDispatch += dq; continue; }
    for (const p of parts) {
      add(bySku, p.sku, p.qty);
      add2(bySkuChan, p.sku, channel, p.qty);
    }
  }
  return { bySku, bySkuChan, rawExNodeDispatch, unmappedDispatch };
}

// ── Qcom: orders (Order Qty) + sales (Dispatch Qty) by sku × platform ────────
//   Only SO lines whose customer maps to the Qcom channel; platform from the
//   customer→platform map; combo-exploded. Forecast per platform is joined
//   later from the Forecast file (Qcom is clubbed in the channel view).
export type QcomAgg = Map<string, Map<string, { orders: number; sales: number }>>; // sku → platform → {}
export function computeQcom(wb: XLSX.WorkBook | undefined, mp: Mappers, mi: MonthInfo): QcomAgg {
  if (!wb) return new Map();
  const g = sheetGrid(wb);
  const { row, H } = findHeader(g, ["Warehouse", "Order Qty", "Dispatch Qty", "Product SKU", "Party Name"]);
  const out: QcomAgg = new Map();
  for (let i = row + 1; i < g.length; i++) {
    const r = g[i]; if (!r) continue;
    if (r[H["Warehouse"]] !== NODE) continue;
    if (!inMonth(r[H["Last Dispatch Date"]], mi)) continue;   // scope to the selected month
    const party = txt(r[H["Party Name"]]);
    if (mp.customerToChannel(party) !== "Qcom") continue;
    const platform = mp.customerToPlatform(party); if (!platform) continue;
    const oq = num(r[H["Order Qty"]]), dq = num(r[H["Dispatch Qty"]]);
    if (oq === 0 && dq === 0) continue;
    for (const p of resolveLine(txt(r[H["Product SKU"]]), 1, mp)) {   // qty=1 → per-unit weights
      let byP = out.get(p.sku); if (!byP) { byP = new Map(); out.set(p.sku, byP); }
      const cell = byP.get(platform) ?? { orders: 0, sales: 0 };
      cell.orders += oq * p.qty; cell.sales += dq * p.qty; byP.set(platform, cell);
    }
  }
  return out;
}

// ── Shipsheet add-back: POs shipped but not yet closed in SO ──────────────────
//   The shipsheet is a list of POs shipped (previous day). Match to SO by PO;
//   for ex-node SO lines under those POs with an OPEN qty (Order − Dispatch),
//   add that open qty as in-flight movement (combo-exploded). SKU + channel come
//   from the matched SO line. Reverses next month when the SO closes.
const normPO = (v: unknown) => txt(v).toUpperCase().replace(/\(.*?\)/g, "").replace(/[^A-Z0-9]/g, "");
export type ShipResult = { bySku: SkuAgg; bySkuChan: SkuChanAgg; addedBack: number; matchedPOs: number; sheetPOs: number };
// The shipsheet is only mined for the set of shipped PO / reference numbers; the
// column is named differently across export formats (Consolidate vs Clickpost/
// pivot). Find the first sheet+column that looks like a PO reference.
const SHIP_PO_COLS = ["PO Number", "Reference Order Number", "PO No", "Reference No", "Reference", "PO"];
function findShipPoColumn(wb: XLSX.WorkBook): { g: Grid; row: number; col: number } | null {
  for (const name of wb.SheetNames) {
    const g = sheetGrid(wb, name);
    for (let i = 0; i < Math.min(g.length, 15); i++) {
      const H: Record<string, number> = {};
      (g[i] || []).forEach((h, j) => { if (h != null && String(h).trim() !== "") H[String(h).trim()] = j; });
      for (const c of SHIP_PO_COLS) if (c in H) return { g, row: i, col: H[c] };
    }
  }
  return null;
}
export function computeShipsheet(soWb: XLSX.WorkBook | undefined, shipWb: XLSX.WorkBook | undefined, mp: Mappers): ShipResult {
  if (!soWb || !shipWb) return { bySku: new Map(), bySkuChan: new Map(), addedBack: 0, matchedPOs: 0, sheetPOs: 0 };
  // 1) PO set from the shipsheet. If the format is unrecognised, skip the add-back
  //    (return empty) rather than blocking the whole compute.
  const SH = findShipPoColumn(shipWb);
  if (!SH) return { bySku: new Map(), bySkuChan: new Map(), addedBack: 0, matchedPOs: 0, sheetPOs: 0 };
  const shipPOs = new Set<string>();
  for (let i = SH.row + 1; i < SH.g.length; i++) { const po = normPO(SH.g[i]?.[SH.col]); if (po) shipPOs.add(po); }
  // 2) SO lines under those POs, ex-node, with open qty
  const g = sheetGrid(soWb);
  const { row, H } = findHeader(g, ["Warehouse", "PO No", "Order Qty", "Dispatch Qty", "Product SKU", "Party Name"]);
  const bySku: SkuAgg = new Map(); const bySkuChan: SkuChanAgg = new Map();
  let addedBack = 0; const matched = new Set<string>();
  for (let i = row + 1; i < g.length; i++) {
    const r = g[i]; if (!r) continue;
    if (r[H["Warehouse"]] !== NODE) continue;
    const po = normPO(r[H["PO No"]]); if (!po || !shipPOs.has(po)) continue;
    const open = num(r[H["Order Qty"]]) - num(r[H["Dispatch Qty"]]);
    if (open <= 0) continue;
    matched.add(po);
    const channel = mp.customerToChannel(txt(r[H["Party Name"]]));
    for (const p of resolveLine(txt(r[H["Product SKU"]]), open, mp)) {
      add(bySku, p.sku, p.qty); addedBack += p.qty;
      if (channel) add2(bySkuChan, p.sku, channel, p.qty);
    }
  }
  return { bySku, bySkuChan, addedBack, matchedPOs: matched.size, sheetPOs: shipPOs.size };
}

// ── STN: Overall STN (by sku) + Channelwise STN (by sku×channel) ─────────────
//   Also tallies internal transfers OUT of the node that are not channel supply:
//   to Central / factory (repacking) and to Quarantine — shown separately.
export type StnResult = { bySku: SkuAgg; bySkuChan: SkuChanAgg; rawClosedExNode: number; unmapped: number; internalCentral: number; internalQuarantine: number; centralBySku: SkuAgg; quarantineBySku: SkuAgg };
export function computeSTN(wb: XLSX.WorkBook | undefined, mp: Mappers, mi: MonthInfo): StnResult {
  if (!wb) return { bySku: new Map(), bySkuChan: new Map(), rawClosedExNode: 0, unmapped: 0, internalCentral: 0, internalQuarantine: 0, centralBySku: new Map(), quarantineBySku: new Map() };
  const g = sheetGrid(wb);
  const { row, H } = findHeader(g, ["From Warehouse", "To Warehouse", "FG Code", "Qty", "Status"]);
  const bySku: SkuAgg = new Map(); const bySkuChan: SkuChanAgg = new Map();
  const centralBySku: SkuAgg = new Map(); const quarantineBySku: SkuAgg = new Map();
  let rawClosedExNode = 0, unmapped = 0, internalCentral = 0, internalQuarantine = 0;
  for (let i = row + 1; i < g.length; i++) {
    const r = g[i]; if (!r) continue;
    // Count all ex-node transfers except Cancelled. GT (and some MT/B2C) is
    // booked to a dummy account as 'Raised', not 'Closed', so a Closed-only
    // filter drops it — the source workbook counts everything but Cancelled.
    const from = txt(r[H["From Warehouse"]]);
    if (!STN_SOURCES.has(from) || txt(r[H["Status"]]) === "Cancelled") continue;
    if (!inMonth(r[H["Date"]], mi)) continue;   // scope to the selected month
    const q = num(r[H["Qty"]]); if (q === 0) continue;
    rawClosedExNode += q;
    const to = txt(r[H["To Warehouse"]]);
    // Internal transfers (not channel supply): stock sent to Quarantine, or back to
    // Central / factory for repacking. Tracked only for the MOTHER NODE's own outflow
    // — Central→Central / Central→node aren't channel supply and must not inflate the
    // repacking lines (they simply drop out below since they aren't channel-mapped).
    if (from === NODE) {
      const internal = /quarantine/i.test(to) ? "q" : /central/i.test(to) ? "c" : "";
      if (internal) {
        if (internal === "q") internalQuarantine += q; else internalCentral += q;
        for (const p of resolveLine(txt(r[H["FG Code"]]), q, mp)) add(internal === "q" ? quarantineBySku : centralBySku, p.sku, p.qty);
      }
    }
    // Only transfers to a channel-mapped destination are real outbound supply.
    const channel = mp.warehouseToChannel(to);
    if (!channel) continue;
    const parts = resolveLine(txt(r[H["FG Code"]]), q, mp);
    if (parts.length === 0) { unmapped += q; continue; }
    for (const p of parts) {
      add(bySku, p.sku, p.qty);
      add2(bySkuChan, p.sku, channel, p.qty);
    }
  }
  return { bySku, bySkuChan, rawClosedExNode, unmapped, internalCentral, internalQuarantine, centralBySku, quarantineBySku };
}

// ── Forecast file → per-sku / per-channel / per-platform (Qcom) ───────────────
//   Columns (detected by name): New Master SKU | Master SKU, FG Code, Channel,
//   Platform, and a qty column (Qty | Forecast). One row per sku×channel; Qcom
//   rows also carry a Platform. Overall forecast = sum of channel rows.
export type Forecast = { bySku: SkuAgg; byChannel: SkuChanAgg; byPlatform: SkuChanAgg };

// Normalise the forecast's channel labels to the movement channels.
const CH_NORM: Record<string, string> = { "Marketplace B2C": "B2C", "Marketplace B2B": "B2B", "Website": "B2C" };
const normCh = (c: string) => CH_NORM[c.trim()] ?? c.trim();
const QCOM_PLATFORMS = new Set(["Blinkit", "Zepto", "Instamart", "Flipkart Minutes"]);

// Wide "Channels" layout: header row has 'New Master SKU' + 'Grand Total'; the
// row 2 above carries each value column's channel; value columns run from the
// first Grand Total to the next one (= the current month block). Returns null
// if the workbook is not in this shape (then the long parser is used).
function parseForecastWide(wb: XLSX.WorkBook, mp: Mappers): Forecast | null {
  const order = ["Channels", ...wb.SheetNames.filter((n) => n !== "Channels")];
  for (const name of order) {
    if (!wb.Sheets[name]) continue;
    const g = sheetGrid(wb, name);
    let hr = -1, H: Record<string, number> = {};
    for (let i = 0; i < Math.min(g.length, 30); i++) {
      const m: Record<string, number> = {};
      (g[i] || []).forEach((h, j) => { const t = h == null ? "" : String(h).trim(); if (t && !(t in m)) m[t] = j; });
      if (("New Master SKU" in m || "Master SKU" in m) && "Grand Total" in m) { hr = i; H = m; break; }
    }
    if (hr < 0) continue;
    const skuCol = H["New Master SKU"] ?? H["Master SKU"];
    const fgCol = H["New FG Code"] ?? H["FG Code"] ?? -1;
    // first Grand Total → next Grand Total marks this month's block
    const header = g[hr]; const gt: number[] = [];
    header.forEach((h, j) => { if (String(h ?? "").trim() === "Grand Total") gt.push(j); });
    const start = gt[0] + 1, end = gt[1] ?? header.length;
    // channel row = the nearest row above whose block cell is a non-numeric,
    // non-date STRING (i.e. a channel label like "Qcom" / "Marketplace B2C") —
    // skips the numeric sums row and the date row that also sit above the header.
    let chRow = -1;
    for (let r = hr - 1; r >= Math.max(0, hr - 6); r--) {
      const v = g[r]?.[start]; if (v == null || v instanceof Date) continue;
      const s = String(v).trim(); if (!s || s.toLowerCase() === "grand total" || !Number.isNaN(Number(s))) continue;
      chRow = r; break;
    }
    const cols: { c: number; channel: string; platform: string }[] = [];
    for (let c = start; c < end; c++) {
      const platform = String(header[c] ?? "").trim(); if (!platform || platform === "Grand Total") continue;
      const channel = normCh(String((chRow >= 0 ? g[chRow]?.[c] : "") ?? "").trim());
      cols.push({ c, channel, platform });
    }
    if (cols.length === 0) continue;
    const bySku: SkuAgg = new Map(), byChannel: SkuChanAgg = new Map(), byPlatform: SkuChanAgg = new Map();
    for (let i = hr + 1; i < g.length; i++) {
      const r = g[i]; if (!r) continue;
      let sku = txt(r[skuCol]); if (!sku && fgCol >= 0) sku = mp.fgToSku(txt(r[fgCol])) ?? "";
      if (!sku) continue;
      for (const col of cols) {
        const q = num(r[col.c]); if (q === 0) continue;
        add(bySku, sku, q);
        if (col.channel) add2(byChannel, sku, col.channel, q);
        if (col.channel === "Qcom" && QCOM_PLATFORMS.has(col.platform)) add2(byPlatform, sku, col.platform, q);
      }
    }
    if (bySku.size > 0) return { bySku, byChannel, byPlatform };
  }
  return null;
}

export function parseForecast(wb: XLSX.WorkBook, mp: Mappers): Forecast {
  const wide = parseForecastWide(wb, mp);
  if (wide) return wide;
  const pick = (H: Record<string, number>, ...names: string[]) => { for (const n of names) if (n in H) return H[n]; return -1; };
  let found: { g: Grid; row: number; H: Record<string, number> } | null = null;
  for (const name of wb.SheetNames) {
    const g = sheetGrid(wb, name);
    for (let i = 0; i < Math.min(g.length, 15); i++) {
      const H: Record<string, number> = {};
      (g[i] || []).forEach((h, j) => { if (h != null && String(h).trim() !== "") H[String(h).trim()] = j; });
      const hasSku = pick(H, "New Master SKU", "Master SKU") >= 0 || pick(H, "FG Code", "New FG Code") >= 0;
      const hasQty = pick(H, "Qty", "Forecast", "Forecast V7") >= 0;
      if (hasSku && hasQty) { found = { g, row: i, H }; break; }
    }
    if (found) break;
  }
  if (!found) throw new Error("Forecast file: could not find a header with a SKU/FG column and a Qty/Forecast column.");
  const { g, row, H } = found;
  const cSku = pick(H, "New Master SKU", "Master SKU"), cFg = pick(H, "FG Code", "New FG Code");
  const cCh = pick(H, "Channel"), cPl = pick(H, "Platform"), cQ = pick(H, "Qty", "Forecast", "Forecast V7");
  const bySku: SkuAgg = new Map(); const byChannel: SkuChanAgg = new Map(); const byPlatform: SkuChanAgg = new Map();
  for (let i = row + 1; i < g.length; i++) {
    const r = g[i]; if (!r) continue;
    let sku = cSku >= 0 ? txt(r[cSku]) : "";
    if (!sku && cFg >= 0) sku = mp.fgToSku(txt(r[cFg])) ?? "";
    if (!sku) continue;
    const qty = num(r[cQ]); if (qty === 0) continue;
    add(bySku, sku, qty);
    const ch = cCh >= 0 ? normCh(txt(r[cCh])) : "";
    if (ch) add2(byChannel, sku, ch, qty);
    const pl = cPl >= 0 ? txt(r[cPl]) : "";
    // Only q-commerce platforms feed the Qcom platform view.
    if (ch === "Qcom" && QCOM_PLATFORMS.has(pl)) add2(byPlatform, sku, pl, qty);
  }
  return { bySku, byChannel, byPlatform };
}

// Rebuild the Forecast object from an already-published snapshot, so a daily
// re-compute can reuse the month's forecast without re-uploading the file.
export function forecastFromSnapshot(snap: Snapshot): Forecast {
  const bySku: SkuAgg = new Map(), byChannel: SkuChanAgg = new Map(), byPlatform: SkuChanAgg = new Map();
  for (const r of snap.overall) if (r.forecast) bySku.set(r.masterSku, r.forecast);
  for (const r of snap.channelwise) if (r.forecast) add2(byChannel, r.masterSku, r.channel, r.forecast);
  for (const r of snap.qcom) if (r.forecast) add2(byPlatform, r.masterSku, r.platform, r.forecast);
  return { bySku, byChannel, byPlatform };
}

// The active month is chosen explicitly on the compute page (no auto-detect):
// every file is scoped to it by date, so uploading a multi-month export or a late
// SO for an older month only ever counts the rows for the selected month.
export type MonthInfo = { monthKey: string; month: string; actY: number; actM: number; daysInMonth: number };
export function monthInfoFromKey(monthKey: string): MonthInfo {
  const [actY, actM] = monthKey.split("-").map(Number);
  return { monthKey, month: `${MONTHS[actM - 1]} ${actY}`, actY, actM, daysInMonth: new Date(actY, actM, 0).getDate() };
}

// ── Daily movement (timing view), all combo-exploded, ex-node ────────────────
//   daily        overall STN + SO per day
//   dailyChannel per channel per day (STN + SO combined)
//   dailyInternal Central (repacking) + Quarantine per day
//   dailySku     per New-Master-SKU per day (STN + SO), for the SKU day-on-day
export type DaySeries = { day: number; value: number }[];
export type DailyResult = {
  daily: DailyRow[]; dailyChannel: Record<string, DaySeries>;
  dailyInternal: { central: DaySeries; quarantine: DaySeries };
  dailySkuChannel: Record<string, Record<string, DaySeries>>;   // sku → series(channel|__central|__quarantine) → day series
  monthKey: string; month: string; daysInMonth: number; daysElapsed: number;
};
export function computeDaily(soWb: XLSX.WorkBook | undefined, stnWb: XLSX.WorkBook | undefined, mp: Mappers, mi: MonthInfo): DailyResult {
  const { actY, actM } = mi;
  const dayOf = (v: unknown): number | null => { const p = ymd(v); return p && p.y === actY && p.m === actM ? p.d : null; };

  const dStnTot: Record<number, number> = {}, dSoTot: Record<number, number> = {};
  const dCh: Record<string, Record<number, number>> = {};
  const dInt: Record<string, Record<number, number>> = { central: {}, quarantine: {} };
  const dSkuSer: Record<string, Record<string, Record<number, number>>> = {};   // sku → series → day → qty
  const bump = (m: Record<string, Record<number, number>>, k: string, d: number, q: number) => { (m[k] ??= {})[d] = (m[k][d] ?? 0) + q; };
  const bumpSku = (sku: string, key: string, d: number, q: number) => { const s = (dSkuSer[sku] ??= {}); (s[key] ??= {})[d] = (s[key][d] ?? 0) + q; };

  if (soWb) { const sg = sheetGrid(soWb); const SH = findHeader(sg, ["Warehouse", "Dispatch Qty", "Last Dispatch Date", "Party Name"]);
  for (let i = SH.row + 1; i < sg.length; i++) {
    const r = sg[i]; if (!r || r[SH.H["Warehouse"]] !== NODE) continue;
    const dq = num(r[SH.H["Dispatch Qty"]]); if (dq === 0) continue;
    const d = dayOf(r[SH.H["Last Dispatch Date"]]); if (d == null) continue;
    const ch = mp.customerToChannel(txt(r[SH.H["Party Name"]])); if (!ch) continue;
    for (const p of resolveLine(txt(r[SH.H["Product SKU"]]), dq, mp)) {
      dSoTot[d] = (dSoTot[d] ?? 0) + p.qty; bump(dCh, ch, d, p.qty); bumpSku(p.sku, ch, d, p.qty);
    }
  } }
  const tg = stnWb ? sheetGrid(stnWb) : []; const TH = stnWb ? findHeader(tg, ["From Warehouse", "To Warehouse", "Status", "Qty", "Date", "FG Code"]) : { row: -1, H: {} as Record<string, number> };
  for (let i = TH.row + 1; i < tg.length; i++) {
    const r = tg[i]; if (!r) continue;
    const from = txt(r[TH.H["From Warehouse"]]);
    if (!STN_SOURCES.has(from) || txt(r[TH.H["Status"]]) === "Cancelled") continue;
    const q = num(r[TH.H["Qty"]]); if (q === 0) continue;
    const d = dayOf(r[TH.H["Date"]]); if (d == null) continue;
    const to = txt(r[TH.H["To Warehouse"]]);
    if (from === NODE) {
      const internal = /quarantine/i.test(to) ? "quarantine" : /central/i.test(to) ? "central" : "";
      if (internal) {
        dInt[internal][d] = (dInt[internal][d] ?? 0) + q;
        for (const p of resolveLine(txt(r[TH.H["FG Code"]]), q, mp)) bumpSku(p.sku, internal === "quarantine" ? "__quarantine" : "__central", d, p.qty);
        continue;
      }
    }
    const ch = mp.warehouseToChannel(to); if (!ch) continue;
    for (const p of resolveLine(txt(r[TH.H["FG Code"]]), q, mp)) {
      dStnTot[d] = (dStnTot[d] ?? 0) + p.qty; bump(dCh, ch, d, p.qty); bumpSku(p.sku, ch, d, p.qty);
    }
  }
  const days = [...new Set([...Object.keys(dStnTot), ...Object.keys(dSoTot), ...Object.keys(dInt.central), ...Object.keys(dInt.quarantine)].map(Number))].sort((a, b) => a - b);
  const ser = (m: Record<number, number>): DaySeries => days.filter((d) => (m[d] ?? 0) !== 0).map((d) => ({ day: d, value: m[d] }));
  const daily: DailyRow[] = days.map((d) => ({ day: d, stn: dStnTot[d] ?? 0, so: dSoTot[d] ?? 0, total: (dStnTot[d] ?? 0) + (dSoTot[d] ?? 0) }));
  const dailyChannel: Record<string, DaySeries> = {};
  for (const ch of Object.keys(dCh).sort()) dailyChannel[ch] = days.map((d) => ({ day: d, value: dCh[ch][d] ?? 0 }));
  const dailySkuChannel: Record<string, Record<string, DaySeries>> = {};
  for (const s of Object.keys(dSkuSer)) { dailySkuChannel[s] = {}; for (const k of Object.keys(dSkuSer[s])) dailySkuChannel[s][k] = ser(dSkuSer[s][k]); }
  return { daily, dailyChannel, dailyInternal: { central: ser(dInt.central), quarantine: ser(dInt.quarantine) }, dailySkuChannel,
    monthKey: mi.monthKey, month: mi.month, daysInMonth: mi.daysInMonth, daysElapsed: days.length ? Math.max(...days) : 0 };
}

// ── Assemble the full snapshot from the files + mappers ──────────────────────
//   `forecast` is optional: if omitted, pass `presetForecast` (e.g. rebuilt from
//   the month's last published snapshot) so daily re-computes need only the 3
//   movement files.
export type EngineFiles = { forecast?: XLSX.WorkBook; so?: XLSX.WorkBook; stn?: XLSX.WorkBook; ship?: XLSX.WorkBook };
export function computeSnapshot(files: EngineFiles, mp: Mappers, monthKey: string, presetForecast?: Forecast): { snapshot: Snapshot; diagnostics: Record<string, number>; forecast: Forecast } {
  const mi = monthInfoFromKey(monthKey);
  const so = computeSO(files.so, mp, mi);
  const stn = computeSTN(files.stn, mp, mi);
  const qcom = computeQcom(files.so, mp, mi);
  const fc = files.forecast ? parseForecast(files.forecast, mp) : presetForecast;
  if (!fc) throw new Error("No forecast available for this month — upload the Forecast file once, then daily updates can reuse it.");
  const ship = computeShipsheet(files.so, files.ship, mp);
  const dly = computeDaily(files.so, files.stn, mp, mi);

  const chanOf = (m: SkuChanAgg, sku: string, ch: string) => m.get(sku)?.get(ch) ?? 0;

  // Overall — union of SKUs seen anywhere (incl. internal-only movement)
  const skus = new Set<string>([...fc.bySku.keys(), ...so.bySku.keys(), ...stn.bySku.keys(), ...(ship?.bySku.keys() ?? []), ...stn.centralBySku.keys(), ...stn.quarantineBySku.keys()]);
  const overall: OverallRow[] = [];
  for (const sku of skus) {
    const info = mp.skuInfo(sku);
    const stnQ = stn.bySku.get(sku) ?? 0, soQ = so.bySku.get(sku) ?? 0, shQ = ship?.bySku.get(sku) ?? 0;
    overall.push({ masterSku: sku, fgCode: info.fgCode, productName: info.productName, category: info.category || "Uncategorised",
      productCategory: info.productCategory ?? "", forecastV9: 0, forecast: fc.bySku.get(sku) ?? 0,
      stn: stnQ, so: soQ, shipsheet: shQ, totalSupplied: stnQ + soQ + shQ,
      toCentral: stn.centralBySku.get(sku) ?? 0, toQuarantine: stn.quarantineBySku.get(sku) ?? 0 });
  }
  overall.sort((a, b) => b.forecast - a.forecast);

  // Channelwise — for every sku×channel that has a forecast or any movement
  const channelwise: ChannelRow[] = [];
  const chSkus = new Set<string>([...fc.byChannel.keys(), ...so.bySkuChan.keys(), ...stn.bySkuChan.keys(), ...(ship?.bySkuChan.keys() ?? [])]);
  for (const sku of chSkus) {
    const info = mp.skuInfo(sku);
    const chans = new Set<string>([...(fc.byChannel.get(sku)?.keys() ?? []), ...(so.bySkuChan.get(sku)?.keys() ?? []), ...(stn.bySkuChan.get(sku)?.keys() ?? []), ...(ship?.bySkuChan.get(sku)?.keys() ?? [])]);
    for (const ch of chans) {
      const stnQ = chanOf(stn.bySkuChan, sku, ch), soQ = chanOf(so.bySkuChan, sku, ch), shQ = ship ? chanOf(ship.bySkuChan, sku, ch) : 0;
      channelwise.push({ masterSku: sku, fgCode: info.fgCode, productName: info.productName, category: info.category || "Uncategorised",
        channel: ch, forecast: chanOf(fc.byChannel, sku, ch), stn: stnQ, so: soQ, shipsheet: shQ, totalSupplied: stnQ + soQ + shQ });
    }
  }

  // Qcom — sku×platform: forecast from file, orders/sales from SO
  const qrows: QcomRow[] = [];
  const qSkus = new Set<string>([...fc.byPlatform.keys(), ...qcom.keys()]);
  for (const sku of qSkus) {
    const info = mp.skuInfo(sku);
    const plats = new Set<string>([...(fc.byPlatform.get(sku)?.keys() ?? []), ...(qcom.get(sku)?.keys() ?? [])]);
    for (const pl of plats) {
      const cell = qcom.get(sku)?.get(pl);
      qrows.push({ masterSku: sku, fgCode: info.fgCode, productName: info.productName, category: info.category || "Uncategorised",
        platform: pl, forecast: chanOf(fc.byPlatform, sku, pl), mtdOrders: cell?.orders ?? 0, mtdSales: cell?.sales ?? 0 });
    }
  }

  const tot = (rows: { forecast: number }[]) => rows.reduce((a, r) => a + r.forecast, 0);
  const snapshot: Snapshot = {
    meta: {
      month: dly.month, monthKey: dly.monthKey, updatedOnDay: dly.daysElapsed, source: "computed from raw files",
      node: "YB FG Warehouse (Mother Node)", forecastBasis: "V7",
      daysElapsed: dly.daysElapsed, daysInMonth: dly.daysInMonth, pipelineUnits: ship?.addedBack ?? 0,
      internalMoves: { central: stn.internalCentral, quarantine: stn.internalQuarantine },
      forecastV7Total: tot(overall), forecastV9Total: 0,
      channels: [...new Set(channelwise.map((r) => r.channel))].sort(),
      platforms: [...new Set(qrows.map((r) => r.platform))].sort(),
      categories: [...new Set(overall.map((r) => r.category))].sort(),
      counts: { overall: overall.length, channelwise: channelwise.length, qcom: qrows.length },
    },
    overall, channelwise, qcom: qrows, daily: dly.daily, dailyChannel: dly.dailyChannel,
    dailyInternal: dly.dailyInternal, dailySkuChannel: dly.dailySkuChannel,
  };
  const diagnostics = {
    soRawExNode: so.rawExNodeDispatch, soUnmapped: so.unmappedDispatch, stnRawClosed: stn.rawClosedExNode, stnUnmapped: stn.unmapped,
    shipSheetPOs: ship?.sheetPOs ?? 0, shipMatchedPOs: ship?.matchedPOs ?? 0, shipAddedBack: ship?.addedBack ?? 0,
    toCentral: stn.internalCentral, toQuarantine: stn.internalQuarantine,
    forecastTotal: snapshot.meta.forecastV7Total, movedTotal: overall.reduce((a, r) => a + r.totalSupplied, 0),
  };
  return { snapshot, diagnostics, forecast: fc };
}

