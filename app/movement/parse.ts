// ============================================================================
// Parse the refreshed "Forecast vs Movement" workbook in the browser and build
// the same snapshot that scripts/extract-movement.py produces on the server.
// Keep the two in sync — both read: Overall, Channelwise Final, Qcom (computed)
// + raw SO / STN / Shipsheet Today (mother node = 'YB FG Warehouse').
// ============================================================================
import * as XLSX from "xlsx";
import type { Snapshot } from "./lib";

const NODE = "YB FG Warehouse";
const CH_SET = new Set(["MT", "GT", "Qcom", "B2B", "B2C", "Growth", "CSD"]);

function num(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v).trim().replace(/,/g, "");
  if (["", "-", "#N/A", "#VALUE!", "N/A"].includes(s)) return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}
function txt(v: unknown): string {
  if (v == null) return "";
  const s = String(v).trim();
  return s === "#N/A" || s === "#VALUE!" ? "" : s;
}
// Decode any date cell to {y, m, d} (1-based month). Excel stores dates as
// serial numbers; decode with SSF (timezone-free) so the result matches the
// sheet exactly — Date objects can drift a day across time zones.
function ymd(v: unknown): { y: number; m: number; d: number } | null {
  if (typeof v === "number") { const p = XLSX.SSF.parse_date_code(v); return p ? { y: p.y, m: p.m, d: p.d } : null; }
  if (v instanceof Date) return { y: v.getUTCFullYear(), m: v.getUTCMonth() + 1, d: v.getUTCDate() };
  const s = txt(v);
  const mm = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (mm) return { y: +mm[1], m: +mm[2], d: +mm[3] };
  return null;
}
// day-of-month if the cell falls in the given active month, else null
function dayOf(v: unknown, y: number, m: number): number | null {
  const p = ymd(v); return p && p.y === y && p.m === m ? p.d : null;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function daysIn(y: number, m: number) { return new Date(y, m, 0).getDate(); }

type Grid = unknown[][];
function grid(wb: XLSX.WorkBook, name: string): Grid | null {
  const ws = wb.Sheets[name];
  if (!ws || !ws["!ref"]) return ws ? [] : null;
  // Anchor to A1 so column indices are absolute — SheetJS otherwise trims
  // leading blank rows/columns, which shifts positions vs. the sheet layout.
  const r = XLSX.utils.decode_range(ws["!ref"]); r.s.r = 0; r.s.c = 0;
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true, range: XLSX.utils.encode_range(r) }) as Grid;
}
function headerMap(row: unknown[]): Record<string, number> {
  const m: Record<string, number> = {};
  (row || []).forEach((h, i) => { if (h != null && String(h).trim() !== "") m[String(h).trim()] = i; });
  return m;
}
// Locate the header row by content, so we never depend on a fixed row number.
function findHeader(g: Grid, required: string[]): { row: number; H: Record<string, number> } {
  for (let i = 0; i < Math.min(g.length, 15); i++) {
    const H = headerMap(g[i] || []);
    if (required.every((k) => k in H)) return { row: i, H };
  }
  throw new Error(`Could not find a header row containing: ${required.join(", ")}. Is this the right workbook?`);
}

export type ParseResult = { snapshot: Snapshot; warnings: string[]; missing: string[] };

export function parseWorkbook(buf: ArrayBuffer): ParseResult {
  const wb = XLSX.read(buf, { type: "array" });   // raw serials; dayOf decodes dates via SSF
  const warnings: string[] = [];
  const missing: string[] = [];
  const need = ["Overall", "Channelwise Final", "Qcom", "SO", "STN"];
  for (const n of need) if (!wb.Sheets[n]) missing.push(n);
  if (missing.length) throw new Error(`Workbook is missing required sheet(s): ${missing.join(", ")}. Upload the refreshed base workbook (with Power Query applied).`);

  // ── Overall ──
  const og = grid(wb, "Overall")!;
  const O = findHeader(og, ["New Master SKU", "Forecast V7", "Total Supplied"]);
  const overall = [];
  for (let i = O.row + 1; i < og.length; i++) {
    const r = og[i]; const ms = txt(r[O.H["New Master SKU"]]); if (!ms) continue;
    overall.push({ masterSku: ms, fgCode: txt(r[O.H["New FG Code"]]), productName: txt(r[O.H["Product Name"]]),
      category: txt(r[O.H["Category"]]) || "Uncategorised", productCategory: txt(r[O.H["Product Category"]]),
      forecastV9: num(r[O.H["Forecast V9"]]), forecast: num(r[O.H["Forecast V7"]]),
      stn: num(r[O.H["STN"]]), so: num(r[O.H["SO"]]), shipsheet: num(r[O.H["Shipsheet Latest"]]), totalSupplied: num(r[O.H["Total Supplied"]]) });
  }

  // ── Channelwise Final ──
  const cg = grid(wb, "Channelwise Final")!;
  const C = findHeader(cg, ["New Master SKU", "Channel", "Total Supplied"]);
  const channelwise = [];
  for (let i = C.row + 1; i < cg.length; i++) {
    const r = cg[i]; const ms = txt(r[C.H["New Master SKU"]]); const ch = txt(r[C.H["Channel"]]); if (!ms || !ch) continue;
    channelwise.push({ masterSku: ms, fgCode: txt(r[C.H["New FG Code"]]), productName: txt(r[C.H["Product Name"]]),
      category: txt(r[C.H["Category"]]) || "Uncategorised", channel: ch, forecast: num(r[C.H["Forecast V7"]]),
      stn: num(r[C.H["STN"]]), so: num(r[C.H["SO"]]), shipsheet: num(r[C.H["Shipsheet Today"]]), totalSupplied: num(r[C.H["Total Supplied"]]) });
  }

  // ── Qcom ──
  const qg = grid(wb, "Qcom")!;
  const Q = findHeader(qg, ["Platform", "MTD Orders", "MTD Sales"]);
  const qcom = [];
  for (let i = Q.row + 1; i < qg.length; i++) {
    const r = qg[i]; const ms = txt(r[Q.H["New Master SKU"]]); const plat = txt(r[Q.H["Platform"]]); if (!ms || !plat) continue;
    qcom.push({ masterSku: ms, fgCode: txt(r[Q.H["New FG Code"]]), productName: txt(r[Q.H["Product Name"]]),
      category: txt(r[Q.H["Category"]]) || "Uncategorised", platform: plat, forecast: num(r[Q.H["Forecast"]]),
      mtdOrders: num(r[Q.H["MTD Orders"]]), mtdSales: num(r[Q.H["MTD Sales"]]) });
  }

  // ── Detect the active month from STN transfer dates (fallback: SO dates) ──
  const sg = grid(wb, "SO")!;
  const SH = findHeader(sg, ["Warehouse", "Dispatch Qty", "Last Dispatch Date", "Customer Type"]);
  const H = SH.H;
  const tg = grid(wb, "STN")!;
  const TH = findHeader(tg, ["From Warehouse", "Status", "Qty", "Date"]);
  const S = TH.H;
  const ymCount: Record<string, number> = {};
  const tally = (v: unknown) => { const p = ymd(v); if (p) { const k = `${p.y}-${p.m}`; ymCount[k] = (ymCount[k] ?? 0) + 1; } };
  for (let i = TH.row + 1; i < tg.length; i++) if (tg[i][S["From Warehouse"]] === NODE) tally(tg[i][S["Date"]]);
  if (Object.keys(ymCount).length === 0) for (let i = SH.row + 1; i < sg.length; i++) if (sg[i][H["Warehouse"]] === NODE) tally(sg[i][H["Last Dispatch Date"]]);
  const topYm = Object.entries(ymCount).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "2026-6";
  const [actY, actM] = topYm.split("-").map(Number);
  const monthKey = `${actY}-${String(actM).padStart(2, "0")}`;
  const monthLabel = `${MONTHS[actM - 1]} ${actY}`;
  const daysInMonth = daysIn(actY, actM);

  // ── Daily: raw SO + STN, mother node, bucketed to the active month ──
  const dailySo: Record<number, number> = {};
  const dailyStn: Record<number, number> = {};
  const dailyCh: Record<string, Record<number, number>> = {};
  for (let i = SH.row + 1; i < sg.length; i++) {
    const r = sg[i];
    if (r[H["Warehouse"]] !== NODE) continue;
    const dq = num(r[H["Dispatch Qty"]]); if (dq === 0) continue;
    const d = dayOf(r[H["Last Dispatch Date"]], actY, actM); if (d == null) continue;
    dailySo[d] = (dailySo[d] ?? 0) + dq;
    const ct = txt(r[H["Customer Type"]]);
    if (CH_SET.has(ct)) { (dailyCh[ct] ??= {})[d] = (dailyCh[ct][d] ?? 0) + dq; }
  }
  for (let i = TH.row + 1; i < tg.length; i++) {
    const r = tg[i];
    if (r[S["From Warehouse"]] !== NODE || txt(r[S["Status"]]) !== "Closed") continue;
    const d = dayOf(r[S["Date"]], actY, actM); if (d == null) continue;
    dailyStn[d] = (dailyStn[d] ?? 0) + num(r[S["Qty"]]);
  }
  const days = [...new Set([...Object.keys(dailyStn), ...Object.keys(dailySo)].map(Number))].sort((a, b) => a - b);
  const daily = days.map((d) => ({ day: d, stn: dailyStn[d] ?? 0, so: dailySo[d] ?? 0, total: (dailyStn[d] ?? 0) + (dailySo[d] ?? 0) }));
  const dailyChannel: Record<string, { day: number; value: number }[]> = {};
  for (const ch of Object.keys(dailyCh).sort()) dailyChannel[ch] = days.map((d) => ({ day: d, value: dailyCh[ch][d] ?? 0 }));
  const daysElapsed = days.length ? Math.max(...days) : daysInMonth;

  // ── Shipsheet add-back = ex-node open portion (channelwise shipsheet total) ──
  const pipelineUnits = channelwise.reduce((a, r) => a + r.shipsheet, 0);

  // sanity warnings
  const soSum = daily.reduce((a, d) => a + d.so, 0);
  const stnSum = daily.reduce((a, d) => a + d.stn, 0);
  if (stnSum === 0) warnings.push("No dated STN movement found — check the STN sheet 'Date' column.");
  if (soSum === 0) warnings.push("No dated SO dispatch found — check the SO sheet 'Last Dispatch Date' column.");
  if (overall.length === 0) warnings.push("Overall sheet produced 0 rows — check the sheet layout.");

  const updatedOnDay = (() => {
    for (let i = 0; i < Math.min(og.length, 4); i++) {
      const row = og[i] || [];
      const c = row.findIndex((x) => String(x).trim().toLowerCase() === "updated on");
      if (c >= 0) { const n = num(row[c + 1]); if (n) return Math.round(n); }
    }
    return daysElapsed;
  })();
  const tot = (rows: { forecast?: number; forecastV9?: number }[], k: "forecast" | "forecastV9") => rows.reduce((a, r) => a + (r[k] ?? 0), 0);

  const snapshot: Snapshot = {
    meta: {
      month: monthLabel, monthKey, updatedOnDay, source: "uploaded workbook",
      node: "YB FG Warehouse (Mother Node)", forecastBasis: "V7",
      daysElapsed, daysInMonth, pipelineUnits,
      forecastV7Total: tot(overall, "forecast"), forecastV9Total: tot(overall, "forecastV9"),
      channels: [...new Set(channelwise.map((r) => r.channel))].sort(),
      platforms: [...new Set(qcom.map((r) => r.platform))].sort(),
      categories: [...new Set(overall.map((r) => r.category))].sort(),
      counts: { overall: overall.length, channelwise: channelwise.length, qcom: qcom.length },
    },
    overall, channelwise, qcom, daily, dailyChannel,
  };
  return { snapshot, warnings, missing };
}
