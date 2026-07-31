// Shared presentational pieces for the Forecast vs Movement dashboard.
import React from "react";
import { fmtInt, fmtPct } from "./lib";

export const surface: React.CSSProperties = { background: "var(--atlas-surface)", border: "1px solid var(--atlas-line)" };
export const mono = "font-mono uppercase";
export const chartTip = { background: "var(--atlas-surface)", border: "1px solid var(--atlas-line)", borderRadius: 8, fontSize: 12, color: "var(--atlas-ink)" } as React.CSSProperties;
export const axisTick = { fontSize: 11, fill: "var(--atlas-ink-muted)" };

export function Kpi({ label, value, sub, color, accent }: { label: string; value: string; sub?: string; color?: string; accent?: string }) {
  return (
    <div className="p-4 rounded-xl relative overflow-hidden" style={surface}>
      {accent && <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: accent }} />}
      <div className={`${mono} mb-1`} style={{ fontSize: "9.5px", letterSpacing: "0.1em", color: "var(--atlas-ink-muted)" }}>{label}</div>
      <div className="font-display" style={{ fontSize: "25px", fontWeight: 400, lineHeight: 1.1, color: color || "var(--atlas-ink)" }}>{value}</div>
      {sub && <div style={{ fontSize: "11px", color: "var(--atlas-ink-muted)", marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

export function Panel({ title, right, children, note }: { title: string; right?: React.ReactNode; children: React.ReactNode; note?: string }) {
  return (
    <div className="p-4 rounded-xl" style={surface}>
      <div className="flex items-center justify-between mb-1 gap-2 flex-wrap">
        <div className={mono} style={{ fontSize: "10px", letterSpacing: "0.1em", color: "var(--atlas-ink-muted)" }}>{title}</div>
        {right}
      </div>
      {note && <div style={{ fontSize: 11, color: "var(--atlas-ink-faint)", marginBottom: 8 }}>{note}</div>}
      <div className={note ? "" : "mt-3"}>{children}</div>
    </div>
  );
}

export function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span style={{ display: "inline-block", fontSize: 10.5, fontWeight: 600, color, background: "color-mix(in srgb, currentColor 12%, transparent)", border: "1px solid color-mix(in srgb, currentColor 30%, transparent)", padding: "2px 8px", borderRadius: 999, whiteSpace: "nowrap" }}>{label}</span>
  );
}

// Inline achievement bar for a table cell.
export function PctBar({ p, color }: { p: number | null; color: string }) {
  const w = p === null ? 0 : Math.max(2, Math.min(100, p * 100));
  return (
    <div className="flex items-center gap-2 justify-end">
      <div style={{ width: 52, height: 6, borderRadius: 3, background: "var(--atlas-line-soft)", overflow: "hidden" }}>
        <div style={{ width: `${w}%`, height: "100%", background: color, borderRadius: 3 }} />
      </div>
      <span style={{ minWidth: 38, textAlign: "right", fontVariantNumeric: "tabular-nums", color, fontWeight: 600, fontSize: 12.5 }}>{fmtPct(p)}</span>
    </div>
  );
}

export type Sort = { k: string; dir: 1 | -1 };
export function Th({ label, k, sort, setSort, align = "right", w }: {
  label: string; k: string; sort: Sort; setSort: (s: Sort) => void; align?: "left" | "right"; w?: number;
}) {
  const active = sort.k === k;
  return (
    <th onClick={() => setSort({ k, dir: active ? (sort.dir === 1 ? -1 : 1) : -1 })}
      className={`${mono} select-none cursor-pointer`}
      style={{ fontSize: "9.5px", letterSpacing: "0.07em", color: active ? "var(--atlas-accent)" : "var(--atlas-ink-muted)", textAlign: align, padding: "9px 12px", whiteSpace: "nowrap", width: w, borderBottom: "1px solid var(--atlas-line)", position: "sticky", top: 0, background: "var(--atlas-surface)", zIndex: 1 }}>
      {label}{active ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
    </th>
  );
}

export function TableScroll({ children, max = "62vh" }: { children: React.ReactNode; max?: string }) {
  return <div style={{ overflowX: "auto", maxHeight: max, overflowY: "auto" }}>{children}</div>;
}
export function Td({ children, left, muted }: { children: React.ReactNode; left?: boolean; muted?: boolean }) {
  return <td style={{ padding: "7px 12px", textAlign: left ? "left" : "right", color: muted ? "var(--atlas-ink-muted)" : "var(--atlas-ink-soft)" }}>{children}</td>;
}
export function NumTd({ v, strong, color }: { v: number; strong?: boolean; color?: string }) {
  return <td style={{ padding: "7px 12px", textAlign: "right", fontVariantNumeric: "tabular-nums", color: color || (strong ? "var(--atlas-ink)" : "var(--atlas-ink-soft)"), fontWeight: strong ? 600 : 400 }}>{v ? fmtInt(v) : <span style={{ color: "var(--atlas-ink-faint)" }}>0</span>}</td>;
}

// Generic sort comparator over object keys.
export function sortRows<T extends Record<string, unknown>>(rows: T[], sort: Sort): T[] {
  return [...rows].sort((a, b) => {
    const av = a[sort.k], bv = b[sort.k];
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * sort.dir;
    return String(av ?? "").localeCompare(String(bv ?? "")) * sort.dir;
  });
}

// A stat callout row (label + big number + sub) used in narrative strips.
export function InsightCallout({ tone, children }: { tone: "info" | "warn" | "bad"; children: React.ReactNode }) {
  const bg = tone === "bad" ? "var(--atlas-red-bg)" : tone === "warn" ? "var(--atlas-amber-bg)" : "var(--atlas-accent-bg)";
  return (
    <div className="p-3 rounded-lg" style={{ background: bg, border: "1px solid var(--atlas-line)" }}>
      <div style={{ fontSize: 12.5, color: "var(--atlas-ink-soft)", lineHeight: 1.55 }}>{children}</div>
    </div>
  );
}
