"use client";
import { useState } from "react";
import type { Dashboard, MetricRow } from "@/lib/fulfillment/engine";
import { surface, muted, faint, fmtDay, fmtInt, rateTone, Notice } from "./ui";

const fmtCell = (r: MetricRow, v: number | null) =>
  v === null ? "–" : r.kind === "pct" ? `${(v * 100).toFixed(1)}%` : r.kind === "hrs" ? v.toFixed(1) : fmtInt(v);

/** Sheet View — the workbook's Dashboard sheet, section for section (MTD + daily). */
export default function DashboardTab({ dash }: { dash: Dashboard }) {
  const [daily, setDaily] = useState(true);

  return (
    <div className="space-y-4">
      {dash.unmapped.length > 0 && (
        <Notice tone="warn">
          <b>{dash.unmapped.reduce((s, u) => s + u.orders, 0).toLocaleString()} orders</b> have a Channel Name that is not in the Channel Mapper and are left out of every section:{" "}
          {dash.unmapped.slice(0, 6).map((u) => `${u.channelName} (${u.orders})`).join(", ")}{dash.unmapped.length > 6 ? "…" : ""}. Add them under <b>Settings → Channel Mapper</b>.
        </Notice>
      )}
      {dash.missingOrderDate > 0 && <Notice tone="warn">{dash.missingOrderDate} orders have no Order Date and cannot be placed on a day.</Notice>}

      <div className="flex flex-wrap items-center justify-between gap-2" style={{ fontSize: 12, ...muted }}>
        <span className="flex items-center gap-3">
          % cells:
          {[["var(--atlas-green-bg)", "≥ 95% good"], ["var(--atlas-amber-bg)", "85–95% watch"], ["var(--atlas-red-bg)", "< 85% poor"]].map(([bg, l]) => (
            <span key={l} className="flex items-center gap-1"><span style={{ width: 12, height: 12, borderRadius: 3, background: bg, border: "1px solid var(--atlas-line)" }} />{l}</span>
          ))}
        </span>
        <label className="flex items-center gap-2" style={{ cursor: "pointer" }}>
          <input type="checkbox" checked={daily} onChange={(e) => setDaily(e.target.checked)} /> Show daily columns
        </label>
      </div>

      {dash.sections.map((s) => (
        <section key={s.key} className="rounded-xl overflow-hidden" style={surface}>
          <div className="px-4 py-2.5" style={{ borderBottom: "1px solid var(--atlas-line)" }}>
            <h3 style={{ fontSize: 14, fontWeight: 700 }}>{s.title}</h3>
            <div style={{ fontSize: 11.5, ...faint }}>{s.note}</div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "separate", borderSpacing: 0, fontSize: 12.5, fontVariantNumeric: "tabular-nums", minWidth: "100%" }}>
              <thead>
                <tr style={{ ...muted, textAlign: "right" }}>
                  <th className="px-3 py-2 text-left font-medium" style={{ position: "sticky", left: 0, background: "var(--atlas-surface)", minWidth: 96 }}>Channel</th>
                  <th className="px-3 py-2 text-left font-medium" style={{ position: "sticky", left: 96, background: "var(--atlas-surface)", minWidth: 220, borderRight: "1px solid var(--atlas-line)" }}>Metric</th>
                  <th className="px-3 py-2 font-semibold" style={{ color: "var(--atlas-ink)", minWidth: 78 }}>MTD</th>
                  {daily && dash.days.map((d) => <th key={d} className="px-2 py-2 font-medium" style={{ minWidth: 58, whiteSpace: "nowrap" }}>{fmtDay(d)}</th>)}
                </tr>
              </thead>
              <tbody>
                {s.rows.map((r, i) => {
                  const total = r.channel === "Total";
                  const cell = (v: number | null, key: string | number, strong?: boolean) => {
                    const tone = r.kind === "pct" ? rateTone(v) : null;
                    return (
                      <td key={key} className="px-2 py-1.5 text-right" title={tone ? `${tone.label}` : undefined}
                        style={{ background: tone?.bg, fontWeight: strong || total ? 600 : 400, color: v === null || v === 0 ? "var(--atlas-ink-faint)" : "var(--atlas-ink)", borderTop: "1px solid var(--atlas-line-soft, var(--atlas-line))" }}>
                        {fmtCell(r, v)}
                      </td>
                    );
                  };
                  return (
                    <tr key={i}>
                      <td className="px-3 py-1.5" style={{ position: "sticky", left: 0, background: "var(--atlas-surface)", fontWeight: total ? 700 : 500, borderTop: "1px solid var(--atlas-line-soft, var(--atlas-line))" }}>{r.channel}</td>
                      <td className="px-3 py-1.5" style={{ position: "sticky", left: 96, background: "var(--atlas-surface)", ...muted, borderRight: "1px solid var(--atlas-line)", borderTop: "1px solid var(--atlas-line-soft, var(--atlas-line))", whiteSpace: "nowrap" }}>{r.metric}</td>
                      {cell(r.mtd, "mtd", true)}
                      {daily && r.days.map((v, j) => cell(v, j))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
