"use client";
// Shared styling + small helpers for the Fulfillment section.
import type React from "react";
import { DAY } from "@/lib/fulfillment/engine";

export const surface: React.CSSProperties = { background: "var(--atlas-surface)", border: "1px solid var(--atlas-line)" };
export const soft: React.CSSProperties = { background: "var(--atlas-surface-soft)", border: "1px solid var(--atlas-line)" };
export const muted = { color: "var(--atlas-ink-muted)" } as const;
export const faint = { color: "var(--atlas-ink-faint)" } as const;

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");
export const fmtDay = (day: number) => { const t = new Date(day * DAY * 1000); return `${t.getUTCDate()} ${MON[t.getUTCMonth()]}`; };
export const fmtDayLong = (day: number) => { const t = new Date(day * DAY * 1000); return `${t.getUTCDate()} ${MON[t.getUTCMonth()]} ${t.getUTCFullYear()}`; };
export const fmtDT = (sec: number | null) => {
  if (sec === null) return "—";
  const t = new Date(sec * 1000);
  return `${t.getUTCDate()} ${MON[t.getUTCMonth()]} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
};
export const fmtInt = (n: number) => n.toLocaleString("en-IN");

/** Today's date as a day number on the same naive clock as the data (browser local date). */
export const todayDay = () => { const n = new Date(); return Math.floor(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()) / 1000 / DAY); };

/** Status tint for a 0..1 rate: good ≥ 95%, watch 85–95%, poor < 85%. Ink stays neutral. */
export function rateTone(v: number | null): { bg: string; label: string } | null {
  if (v === null) return null;
  if (v >= 0.95) return { bg: "var(--atlas-green-bg)", label: "Good" };
  if (v >= 0.85) return { bg: "var(--atlas-amber-bg)", label: "Watch" };
  return { bg: "var(--atlas-red-bg)", label: "Poor" };
}

export function Btn({ children, onClick, primary, disabled, title, small }: { children: React.ReactNode; onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void; primary?: boolean; disabled?: boolean; title?: string; small?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} title={title}
      className={`${small ? "px-2.5 py-1" : "px-3.5 py-1.5"} rounded-lg font-semibold`}
      style={{
        fontSize: small ? 12 : 13, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1,
        ...(primary ? { background: "var(--atlas-accent)", color: "#fff", border: "1px solid var(--atlas-accent)" } : { ...soft, color: "var(--atlas-ink-soft)" }),
      }}>
      {children}
    </button>
  );
}

export function Notice({ tone, children }: { tone: "info" | "warn" | "error" | "ok"; children: React.ReactNode }) {
  const map = {
    info: ["var(--atlas-blue-bg)", "ℹ"], warn: ["var(--atlas-amber-bg)", "⚠"], error: ["var(--atlas-red-bg)", "✕"], ok: ["var(--atlas-green-bg)", "✓"],
  } as const;
  const [bg, icon] = map[tone];
  return (
    <div className="p-3 rounded-lg flex gap-2" style={{ background: bg, border: "1px solid var(--atlas-line)", fontSize: 13, color: "var(--atlas-ink)" }}>
      <span aria-hidden style={{ fontWeight: 700 }}>{icon}</span><div className="min-w-0">{children}</div>
    </div>
  );
}

export const inputStyle: React.CSSProperties = {
  ...soft, color: "var(--atlas-ink)", fontSize: 12.5, borderRadius: 6, padding: "4px 8px", width: "100%",
};
