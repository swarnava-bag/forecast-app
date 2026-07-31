// ============================================================================
// Forecast vs Movement — shared types, metrics and palette.
//
// Metric definitions (validated to reproduce the reference report):
//   Fill              = supplied / forecast V7 (uncapped)
//   Forecast accuracy = max(0, 1 − |fill − 1|)  — symmetric, penalises
//                       over-supply (120% fill → 80%; ≥200% → 0%). Rolled up
//                       weighted by forecast volume → 65.2% overall.
//   Bias              = supplied − forecast (working-capital signal)
//   Closed pickup     = STN + SO           (physically moved & closed)
//   Open pipeline     = Shipsheet in flight (last-day POs not yet closed)
//   Expected pickup   = Closed + Pipeline   (= Total Supplied)
//   Remaining         = Forecast − Expected (can be negative = over-picked)
//   Attainment        = Expected / Forecast
// ============================================================================
import { useEffect, useState } from "react";

// ── Types ────────────────────────────────────────────────────────────────────
export type OverallRow = {
  masterSku: string; fgCode: string; productName: string; category: string;
  productCategory: string; forecastV9: number; forecast: number;
  stn: number; so: number; shipsheet: number; totalSupplied: number;
  toCentral?: number; toQuarantine?: number;
};
export type ChannelRow = {
  masterSku: string; fgCode: string; productName: string; category: string;
  channel: string; forecast: number; stn: number; so: number;
  shipsheet: number; totalSupplied: number;
};
export type QcomRow = {
  masterSku: string; fgCode: string; productName: string; category: string;
  platform: string; forecast: number; mtdOrders: number; mtdSales: number;
};
export type DailyRow = { day: number; stn: number; so: number; total: number };
export type Snapshot = {
  meta: {
    month: string; monthKey: string; updatedOnDay: number | null; source: string;
    node: string; forecastBasis: string;
    daysElapsed: number; daysInMonth: number; pipelineUnits: number;
    internalMoves?: { central: number; quarantine: number };
    forecastV7Total: number; forecastV9Total: number;
    channels: string[]; platforms: string[]; categories: string[];
    counts: { overall: number; channelwise: number; qcom: number };
  };
  overall: OverallRow[]; channelwise: ChannelRow[]; qcom: QcomRow[];
  daily: DailyRow[]; dailyChannel: Record<string, { day: number; value: number }[]>;
  dailyInternal?: { central: { day: number; value: number }[]; quarantine: { day: number; value: number }[] };
  dailySkuChannel?: Record<string, Record<string, { day: number; value: number }[]>>;
};

// ── Formatting ───────────────────────────────────────────────────────────────
export function fmtQty(n: number) {
  const a = Math.abs(n);
  if (a >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${(n / 1e5).toFixed(2)}L`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return Math.round(n).toLocaleString("en-IN");
}
export const fmtInt = (n: number) => Math.round(n).toLocaleString("en-IN");
export function fmtCr(n: number) { return `₹${(n / 1e7).toFixed(2)} Cr`; }
export function pctOf(a: number, b: number): number | null { return b ? a / b : null; }
export function fmtPct(p: number | null, dp = 0) { return p === null ? "—" : `${(p * 100).toFixed(dp)}%`; }

// ── Metrics ──────────────────────────────────────────────────────────────────
export function accuracy(supplied: number, forecast: number): number | null {
  if (!forecast) return null;
  return Math.max(0, 1 - Math.abs(supplied - forecast) / forecast);
}
export const closedOf = (r: { stn: number; so: number }) => r.stn + r.so;

// Movement colour (moved vs forecast). Over-supply is the ALERT (red), because
// pushing past forecast burns downstream working capital; 90–100% is on plan.
export function achColor(p: number | null) {
  if (p === null) return "var(--atlas-ink-faint)";
  if (p > 1.0) return "var(--atlas-red)";                       // over-moved → alert
  if (p >= 0.9) return "var(--atlas-green)";                    // on plan
  if (p >= 0.7) return "var(--atlas-amber-warn, #D97706)";      // pick up
  return "var(--atlas-red)";                                    // urgent (well behind)
}
export function achLabel(p: number | null) {
  if (p === null) return "No forecast";
  if (p > 1.0) return "Alert · over";
  if (p >= 0.9) return "On plan";
  if (p >= 0.7) return "Pick up";
  return "Urgent";
}
// Coverage colour (Qcom orders/sales): higher is better, nothing "too high".
export function covColor(p: number | null) {
  if (p === null) return "var(--atlas-ink-faint)";
  if (p >= 0.9) return "var(--atlas-green)";
  if (p >= 0.7) return "var(--atlas-amber-warn, #D97706)";
  return "var(--atlas-red)";
}

// Service-level bucket (reference page 3).
export type Bucket = "zero" | "under" | "ontarget" | "over" | "unforecast";
export function serviceBucket(forecast: number, supplied: number): Bucket {
  if (forecast === 0) return supplied > 0 ? "unforecast" : "zero";
  if (supplied === 0) return "zero";
  const f = supplied / forecast;
  if (f < 0.8) return "under";
  if (f <= 1.1) return "ontarget";
  return "over";
}
export const BUCKET_META: Record<Bucket, { label: string; color: string }> = {
  zero:       { label: "Zero supply",   color: "var(--atlas-red)" },
  under:      { label: "Under-served",  color: "var(--atlas-amber-warn, #D97706)" },
  ontarget:   { label: "On target",     color: "var(--atlas-green)" },
  over:       { label: "Over-served",   color: "var(--atlas-blue)" },
  unforecast: { label: "Unforecasted",  color: "var(--atlas-ink-muted)" },
};

// Recommended action for a planning row. Over-supply (>100%) is the alert.
export function actionFor(forecast: number, moved: number, pipeline: number):
  { label: string; color: string } {
  if (!forecast) return { label: "Unforecasted", color: "var(--atlas-ink-muted)" };
  const fill = moved / forecast;
  const remaining = forecast - moved;
  if (fill > 1.0) return { label: "Alert · over", color: "var(--atlas-red)" };
  if (fill >= 0.9) return { label: "On plan", color: "var(--atlas-green)" };
  if (pipeline > 0 && pipeline >= remaining) return { label: "Close pipeline", color: "var(--atlas-amber-warn, #D97706)" };
  if (fill < 0.7) return { label: "Urgent", color: "var(--atlas-red)" };
  return { label: "Pick up", color: "var(--atlas-amber-warn, #D97706)" };
}

// ── Palette (validated for both surfaces; see dataviz skill) ──────────────────
export const CH_ORDER = ["MT", "GT", "Qcom", "B2B", "B2C", "Growth", "CSD"];
export const PLAT_ORDER = ["Blinkit", "Zepto", "Instamart", "Flipkart Minutes"];
const CAT_LIGHT = ["#2563EB", "#E8850C", "#0E9F6E", "#8B5CF6", "#38BDF8", "#DC5B2B", "#D6409F"];
const CAT_DARK = ["#3B82F6", "#C2740A", "#10B981", "#8B5CF6", "#1E9BDB", "#DC5B2B", "#D6409F"];
export function palette(theme: "light" | "dark") {
  const CAT = theme === "dark" ? CAT_DARK : CAT_LIGHT;
  return {
    CAT,
    chColor: (c: string) => CAT[((CH_ORDER.indexOf(c) % CAT.length) + CAT.length) % CAT.length] ?? CAT[0],
    platColor: (p: string) => CAT[((PLAT_ORDER.indexOf(p) % CAT.length) + CAT.length) % CAT.length] ?? CAT[0],
    sup: theme === "dark"
      ? { stn: "#3B82F6", so: "#10B981", ship: "#C2740A" }
      : { stn: "#2563EB", so: "#0E9F6E", ship: "#E8850C" },
  };
}

export function useTheme(): "light" | "dark" {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  useEffect(() => {
    const read = () => setTheme((document.documentElement.getAttribute("data-theme") as "light" | "dark") || "light");
    read();
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  return theme;
}

// ── CSV export ────────────────────────────────────────────────────────────────
export function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]) {
  const esc = (v: string | number) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [headers, ...rows].map((r) => r.map(esc).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([body], { type: "text/csv;charset=utf-8;" }));
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
