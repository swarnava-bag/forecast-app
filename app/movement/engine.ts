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
export function computeSO(wb: XLSX.WorkBook, mp: Mappers): SoResult {
  const g = sheetGrid(wb);
  const { row, H } = findHeader(g, ["Warehouse", "Dispatch Qty", "Product SKU", "Party Name"]);
  const bySku: SkuAgg = new Map(); const bySkuChan: SkuChanAgg = new Map();
  let rawExNodeDispatch = 0, unmappedDispatch = 0;
  for (let i = row + 1; i < g.length; i++) {
    const r = g[i]; if (!r) continue;
    if (r[H["Warehouse"]] !== NODE) continue;
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
export function computeQcom(wb: XLSX.WorkBook, mp: Mappers): QcomAgg {
  const g = sheetGrid(wb);
  const { row, H } = findHeader(g, ["Warehouse", "Order Qty", "Dispatch Qty", "Product SKU", "Party Name"]);
  const out: QcomAgg = new Map();
  for (let i = row + 1; i < g.length; i++) {
    const r = g[i]; if (!r) continue;
    if (r[H["Warehouse"]] !== NODE) continue;
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
export function computeShipsheet(soWb: XLSX.WorkBook, shipWb: XLSX.WorkBook, mp: Mappers): ShipResult {
  // 1) PO set from the shipsheet (the detail sheet — consolidate has pivots too)
  const SH = findSheet(shipWb, ["PO Number", "Qty"]);
  const shipPOs = new Set<string>();
  for (let i = SH.row + 1; i < SH.g.length; i++) { const po = normPO(SH.g[i]?.[SH.H["PO Number"]]); if (po) shipPOs.add(po); }
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
export type StnResult = { bySku: SkuAgg; bySkuChan: SkuChanAgg; rawClosedExNode: number; unmapped: number };
export function computeSTN(wb: XLSX.WorkBook, mp: Mappers): StnResult {
  const g = sheetGrid(wb);
  const { row, H } = findHeader(g, ["From Warehouse", "To Warehouse", "FG Code", "Qty", "Status"]);
  const bySku: SkuAgg = new Map(); const bySkuChan: SkuChanAgg = new Map();
  let rawClosedExNode = 0, unmapped = 0;
  for (let i = row + 1; i < g.length; i++) {
    const r = g[i]; if (!r) continue;
    // Count all ex-node transfers except Cancelled. GT (and some MT/B2C) is
    // booked to a dummy account as 'Raised', not 'Closed', so a Closed-only
    // filter drops it — the source workbook counts everything but Cancelled.
    if (r[H["From Warehouse"]] !== NODE || txt(r[H["Status"]]) === "Cancelled") continue;
    const q = num(r[H["Qty"]]); if (q === 0) continue;
    rawClosedExNode += q;
    // Only transfers to a channel-mapped destination are real outbound supply.
    // Internal / production warehouses (Tumkur, Central, Quarantine…) are not in
    // the warehouse→channel map and are excluded — matching the source workbook,
    // whose Overall STN equals the sum of its channel STN.
    const channel = mp.warehouseToChannel(txt(r[H["To Warehouse"]]));
    if (!channel) continue;
    const parts = resolveLine(txt(r[H["FG Code"]]), q, mp);
    if (parts.length === 0) { unmapped += q; continue; }
    for (const p of parts) {
      add(bySku, p.sku, p.qty);
      add2(bySkuChan, p.sku, channel, p.qty);
    }
  }
  return { bySku, bySkuChan, rawClosedExNode, unmapped };
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

// ── Daily movement (timing view): SO dispatch + STN by day, ex-node ──────────
export type DailyResult = { daily: DailyRow[]; dailyChannel: Record<string, { day: number; value: number }[]>; monthKey: string; month: string; daysInMonth: number; daysElapsed: number };
export function computeDaily(soWb: XLSX.WorkBook, stnWb: XLSX.WorkBook, mp: Mappers): DailyResult {
  const sg = sheetGrid(soWb); const SH = findHeader(sg, ["Warehouse", "Dispatch Qty", "Last Dispatch Date", "Party Name"]);
  const tg = sheetGrid(stnWb); const TH = findHeader(tg, ["From Warehouse", "Status", "Qty", "Date"]);
  // active month = modal YYYY-M across STN dates (fallback SO dispatch dates)
  const ymCount: Record<string, number> = {};
  const tally = (v: unknown) => { const p = ymd(v); if (p) { const k = `${p.y}-${p.m}`; ymCount[k] = (ymCount[k] ?? 0) + 1; } };
  for (let i = TH.row + 1; i < tg.length; i++) if (tg[i]?.[TH.H["From Warehouse"]] === NODE) tally(tg[i][TH.H["Date"]]);
  if (Object.keys(ymCount).length === 0) for (let i = SH.row + 1; i < sg.length; i++) if (sg[i]?.[SH.H["Warehouse"]] === NODE) tally(sg[i][SH.H["Last Dispatch Date"]]);
  const topYm = Object.entries(ymCount).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "2026-6";
  const [actY, actM] = topYm.split("-").map(Number);
  const dayOf = (v: unknown): number | null => { const p = ymd(v); return p && p.y === actY && p.m === actM ? p.d : null; };

  const dSo: Record<number, number> = {}, dStn: Record<number, number> = {}, dCh: Record<string, Record<number, number>> = {};
  const CH = new Set(["MT", "GT", "Qcom", "B2B", "B2C", "Growth", "CSD"]);
  for (let i = SH.row + 1; i < sg.length; i++) {
    const r = sg[i]; if (!r || r[SH.H["Warehouse"]] !== NODE) continue;
    const dq = num(r[SH.H["Dispatch Qty"]]); if (dq === 0) continue;
    const d = dayOf(r[SH.H["Last Dispatch Date"]]); if (d == null) continue;
    dSo[d] = (dSo[d] ?? 0) + dq;
    const ch = mp.customerToChannel(txt(r[SH.H["Party Name"]]));
    if (ch && CH.has(ch)) { (dCh[ch] ??= {})[d] = (dCh[ch][d] ?? 0) + dq; }
  }
  for (let i = TH.row + 1; i < tg.length; i++) {
    const r = tg[i]; if (!r || r[TH.H["From Warehouse"]] !== NODE || txt(r[TH.H["Status"]]) === "Cancelled") continue;
    const d = dayOf(r[TH.H["Date"]]); if (d == null) continue;
    dStn[d] = (dStn[d] ?? 0) + num(r[TH.H["Qty"]]);
  }
  const days = [...new Set([...Object.keys(dSo), ...Object.keys(dStn)].map(Number))].sort((a, b) => a - b);
  const daily: DailyRow[] = days.map((d) => ({ day: d, stn: dStn[d] ?? 0, so: dSo[d] ?? 0, total: (dStn[d] ?? 0) + (dSo[d] ?? 0) }));
  const dailyChannel: Record<string, { day: number; value: number }[]> = {};
  for (const ch of Object.keys(dCh).sort()) dailyChannel[ch] = days.map((d) => ({ day: d, value: dCh[ch][d] ?? 0 }));
  return { daily, dailyChannel, monthKey: `${actY}-${String(actM).padStart(2, "0")}`, month: `${MONTHS[actM - 1]} ${actY}`, daysInMonth: new Date(actY, actM, 0).getDate(), daysElapsed: days.length ? Math.max(...days) : new Date(actY, actM, 0).getDate() };
}

// ── Assemble the full snapshot from the 4 files + mappers ────────────────────
export type EngineFiles = { forecast: XLSX.WorkBook; so: XLSX.WorkBook; stn: XLSX.WorkBook; ship?: XLSX.WorkBook };
export function computeSnapshot(files: EngineFiles, mp: Mappers): { snapshot: Snapshot; diagnostics: Record<string, number> } {
  const so = computeSO(files.so, mp);
  const stn = computeSTN(files.stn, mp);
  const qcom = computeQcom(files.so, mp);
  const fc = parseForecast(files.forecast, mp);
  const ship = files.ship ? computeShipsheet(files.so, files.ship, mp) : null;
  const dly = computeDaily(files.so, files.stn, mp);

  const chanOf = (m: SkuChanAgg, sku: string, ch: string) => m.get(sku)?.get(ch) ?? 0;

  // Overall — union of SKUs seen anywhere
  const skus = new Set<string>([...fc.bySku.keys(), ...so.bySku.keys(), ...stn.bySku.keys(), ...(ship?.bySku.keys() ?? [])]);
  const overall: OverallRow[] = [];
  for (const sku of skus) {
    const info = mp.skuInfo(sku);
    const stnQ = stn.bySku.get(sku) ?? 0, soQ = so.bySku.get(sku) ?? 0, shQ = ship?.bySku.get(sku) ?? 0;
    overall.push({ masterSku: sku, fgCode: info.fgCode, productName: info.productName, category: info.category || "Uncategorised",
      productCategory: info.productCategory ?? "", forecastV9: 0, forecast: fc.bySku.get(sku) ?? 0,
      stn: stnQ, so: soQ, shipsheet: shQ, totalSupplied: stnQ + soQ + shQ });
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
      forecastV7Total: tot(overall), forecastV9Total: 0,
      channels: [...new Set(channelwise.map((r) => r.channel))].sort(),
      platforms: [...new Set(qrows.map((r) => r.platform))].sort(),
      categories: [...new Set(overall.map((r) => r.category))].sort(),
      counts: { overall: overall.length, channelwise: channelwise.length, qcom: qrows.length },
    },
    overall, channelwise, qcom: qrows, daily: dly.daily, dailyChannel: dly.dailyChannel,
  };
  const diagnostics = {
    soRawExNode: so.rawExNodeDispatch, soUnmapped: so.unmappedDispatch, stnRawClosed: stn.rawClosedExNode, stnUnmapped: stn.unmapped,
    shipSheetPOs: ship?.sheetPOs ?? 0, shipMatchedPOs: ship?.matchedPOs ?? 0, shipAddedBack: ship?.addedBack ?? 0,
    forecastTotal: snapshot.meta.forecastV7Total, movedTotal: overall.reduce((a, r) => a + r.totalSupplied, 0),
  };
  return { snapshot, diagnostics };
}
