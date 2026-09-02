// Sales — shared types, workbook parsing, and formatting.
//   Source: the "reconciled Sales workbook" workbook (Singles + Combos sheets).
//   nto / gto are in ₹ Crore; qty is units.
import type * as XLSXNS from "xlsx";

export type Kind = "single" | "combo";
export type AopRow = { month: string; channel: string; masterSku: string; kind: Kind; qty: number; nto: number; gto: number };
export type SalesRow = AopRow & { category: string | null };

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Excel date serial / Date / text → "YYYY-MM-01"
function toMonth(v: unknown): string | null {
  if (v == null) return null;
  // SheetJS (cellDates) builds dates at LOCAL midnight — read them with local
  // getters, else IST (UTC+5:30) rolls the 1st back to the previous month.
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-01`;
  if (typeof v === "number") { const d = new Date(Date.UTC(1899, 11, 30)); d.setUTCDate(d.getUTCDate() + Math.round(v)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`; }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-01`;
  m = s.match(/^([A-Za-z]{3})[-\s](\d{2,4})$/);            // "Apr-25"
  if (m) { const mi = MON.findIndex((x) => x.toLowerCase() === m![1].toLowerCase()); if (mi >= 0) { const y = m[2].length === 2 ? 2000 + +m[2] : +m[2]; return `${y}-${String(mi + 1).padStart(2, "0")}-01`; } }
  return null;
}

const numOf = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** Parse the reconciled workbook → rows (Singles → kind 'single', Combos → 'combo'). */
export function extractAopRows(wb: XLSXNS.WorkBook, XLSX: typeof XLSXNS): AopRow[] {
  const out: AopRow[] = [];
  const read = (name: string, kind: Kind) => {
    const ws = wb.Sheets[name]; if (!ws) return;
    const g = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }) as unknown[][];
    let hr = -1; const H: Record<string, number> = {};
    for (let i = 0; i < Math.min(g.length, 10); i++) {
      const m: Record<string, number> = {};
      (g[i] || []).forEach((h, j) => { if (h != null && String(h).trim() !== "") m[String(h).trim()] = j; });
      if (("Master SKU" in m || "Master SKU (combo)" in m) && "NTO" in m) { hr = i; Object.assign(H, m); break; }
    }
    if (hr < 0) return;
    const cM = H["Month"], cCh = H["Channel 2"] ?? H["Channel"], cSku = H["Master SKU"] ?? H["Master SKU (combo)"], cQ = H["Qty"], cN = H["NTO"], cG = H["GTO"];
    for (let i = hr + 1; i < g.length; i++) {
      const r = g[i]; if (!r) continue;
      const month = toMonth(r[cM]); const sku = r[cSku] != null ? String(r[cSku]).trim() : "";
      if (!month || !sku) continue;
      out.push({ month, channel: String(r[cCh] ?? "").trim(), masterSku: sku, kind, qty: numOf(r[cQ]), nto: numOf(r[cN]), gto: cG != null ? numOf(r[cG]) : 0 });
    }
  };
  read("Singles", "single");
  read("Combos", "combo");
  return out;
}

// ── formatting ────────────────────────────────────────────────────────────────
export const monthLabel = (m: string) => { const [y, mo] = m.split("-").map(Number); return `${MON[mo - 1]}-${String(y).slice(2)}`; };
export const fmtCr = (n: number) => `₹${n.toFixed(2)} Cr`;
export const fmtCrShort = (n: number) => `${n.toFixed(1)}`;
export function fmtQty(n: number) {
  const a = Math.abs(n);
  if (a >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${(n / 1e5).toFixed(2)}L`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return Math.round(n).toLocaleString("en-IN");
}

export type Metric = "nto" | "gto" | "qty";
export const METRICS: { k: Metric; label: string; unit: string }[] = [
  { k: "nto", label: "NTO", unit: "₹ Cr" },
  { k: "gto", label: "GTO", unit: "₹ Cr" },
  { k: "qty", label: "Qty", unit: "units" },
];
export const fmtMetric = (m: Metric, v: number) => (m === "qty" ? fmtQty(v) : fmtCr(v));
