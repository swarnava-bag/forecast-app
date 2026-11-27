"use client";
// FY Trend — month-by-month performance across every uploaded month.
// Each month is recomputed from its stored orders with the CURRENT Settings,
// so a holiday added in Settings is reflected after "Recalculate".
import { useEffect, useState, useSyncExternalStore } from "react";
import { ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from "recharts";
import { computeAll, reportWindow, MARKETPLACE_3PM, type FulfillmentConfig } from "@/lib/fulfillment/engine";
import { inMonth } from "@/lib/fulfillment/months";
import { kpis, byChannel, type Kpis, type ChannelRow } from "@/lib/fulfillment/analytics";
import { loadMonth } from "@/lib/fulfillment/store";
import { monthLabel } from "@/lib/fulfillment/snapshot";
import { surface, muted, faint, fmtInt, fmtDay, rateTone, Btn, Notice } from "./ui";

type MonthSummary = { monthKey: string; start: number; end: number; k: Kpis; channels: ChannelRow[] };

const subscribeTheme = (cb: () => void) => {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => mo.disconnect();
};
const useThemeMode = () => useSyncExternalStore(subscribeTheme,
  () => (document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light") as "light" | "dark",
  () => "light" as const);
// dataviz reference palette: categorical slots 1–3 (validated all-pairs), chart chrome
const PAL = {
  light: { surface: "#ffffff", grid: "#e1e0d9", axis: "#c3c2b7", muted: "#898781", s: ["#2a78d6", "#eb6834", "#1baf7a"] },
  dark: { surface: "#1a1a19", grid: "#2c2c2a", axis: "#383835", muted: "#898781", s: ["#3987e5", "#d95926", "#199e70"] },
};
const pct = (v: number | null) => (v === null ? "–" : `${(v * 100).toFixed(1)}%`);
const hr = (v: number | null) => (v === null ? "–" : `${v.toFixed(1)} h`);
const shortMonth = (k: string) => monthLabel(k).replace(/ (\d{2})(\d{2})$/, " ’$2");

function Tip({ active, payload, label, unit }: { active?: boolean; payload?: { name: string; value: number | null; color: string }[]; label?: string; unit: "pct" | "count" | "hrs" }) {
  if (!active || !payload?.length) return null;
  const f = (v: number | null) => (v === null || v === undefined ? "–" : unit === "pct" ? `${v.toFixed(1)}%` : unit === "hrs" ? `${v.toFixed(1)} h` : fmtInt(v));
  return (
    <div className="rounded-lg px-3 py-2" style={{ ...surface, fontSize: 12, boxShadow: "0 4px 14px rgba(0,0,0,.15)" }}>
      <div style={{ fontWeight: 700, marginBottom: 2 }}>{label}</div>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2">
          <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color }} /><span style={muted}>{p.name}</span>
          <span className="ml-auto pl-3" style={{ fontWeight: 600 }}>{f(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

export default function TrendTab({ months, config, onOpenMonth }: { months: string[]; config: FulfillmentConfig; onOpenMonth: (k: string) => void }) {
  const C = PAL[useThemeMode()];
  const [data, setData] = useState<MonthSummary[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [run, setRun] = useState(0);
  const [cfgUsed, setCfgUsed] = useState<FulfillmentConfig | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const keys = [...months].sort();
      const out: MonthSummary[] = [];
      setErr(null);
      for (const [i, key] of keys.entries()) {
        if (!live) return;
        setProgress(`Loading ${monthLabel(key)} (${i + 1} of ${keys.length})…`);
        try {
          const s = await loadMonth(key);
          const win = reportWindow(s.orders, Number.POSITIVE_INFINITY, key); // data's own latest day, not the PC date
          const g = { start: win.startDay, end: win.endDay };
          const rows = computeAll(s.orders, config).filter((r) => inMonth(r.orderDay, r.dueDay, g));
          out.push({ monthKey: key, start: g.start, end: g.end, k: kpis(rows, g), channels: byChannel(rows, g) });
          if (live) setData([...out]);
        } catch (e) { if (live) setErr(`${monthLabel(key)}: ${e instanceof Error ? e.message : String(e)}`); }
      }
      if (live) { setProgress(null); setCfgUsed(config); }
    })();
    return () => { live = false; };
    // re-run on explicit Recalculate (run) or when the month list changes — not on every settings edit
  }, [months, run]); // eslint-disable-line react-hooks/exhaustive-deps

  const stale = cfgUsed !== null && cfgUsed !== config;
  const series = data.map((m) => ({
    label: shortMonth(m.monthKey), monthKey: m.monthKey,
    onTime: m.k.onTimeRate === null ? null : +(m.k.onTimeRate * 100).toFixed(2),
    sla: m.k.slaRate === null ? null : +(m.k.slaRate * 100).toFixed(2),
    dispatched: m.k.dispatchRate === null ? null : +(m.k.dispatchRate * 100).toFixed(2),
    orders: m.k.orders, median: m.k.medianO2D, p90: m.k.p90O2D,
  }));
  const axis = { tick: { fontSize: 11, fill: C.muted }, axisLine: { stroke: C.axis }, tickLine: false };
  const mpChannels = MARKETPLACE_3PM.filter((c) => data.some((m) => m.channels.some((r) => r.channel === c && r.due3pm > 0)));

  if (months.length === 0) return <Notice tone="info">No months uploaded yet. Use <b>Upload</b> — older months (back to April) can be backfilled.</Notice>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div style={{ fontSize: 12.5, ...muted }}>
          {data.length ? <>{monthLabel(data[0].monthKey)} → {monthLabel(data[data.length - 1].monthKey)} · {data.length} month{data.length === 1 ? "" : "s"} · calculated with the current Settings · partial months run to their latest data day</> : "Loading…"}
        </div>
        <div className="flex items-center gap-2">
          {progress && <span style={{ fontSize: 12, ...muted }}>{progress}</span>}
          <Btn small disabled={!!progress} onClick={() => setRun((n) => n + 1)}>↻ Recalculate</Btn>
        </div>
      </div>
      {stale && <Notice tone="info">Settings changed since this was calculated — click <b>Recalculate</b> to apply them to every month.</Notice>}
      {err && <Notice tone="error">{err}</Notice>}

      {data.length > 0 && (
        <>
          <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))" }}>
            <section className="rounded-xl p-4" style={surface}>
              <h3 style={{ fontSize: 14, fontWeight: 700 }}>Service levels by month</h3>
              <div style={{ fontSize: 11.5, ...faint }} className="mb-2">3 PM on-time (marketplaces) · Amazon + Flipkart SLA met · orders dispatched</div>
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={series} margin={{ top: 4, right: 12, left: -12, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke={C.grid} />
                  <XAxis dataKey="label" {...axis} />
                  <YAxis {...axis} width={44} domain={[(min: number) => Math.max(0, Math.floor(min / 5) * 5 - 5), 100]} tickFormatter={(v: number) => `${v}%`} />
                  <Tooltip content={<Tip unit="pct" />} />
                  <Legend iconType="plainline" wrapperStyle={{ fontSize: 12, color: C.muted }} />
                  {([["onTime", "3 PM on-time"], ["sla", "AZ/FK SLA met"], ["dispatched", "Dispatched"]] as const).map(([k, n], i) => (
                    <Line key={k} type="monotone" dataKey={k} name={n} stroke={C.s[i]} strokeWidth={2} connectNulls
                      dot={{ r: 4, fill: C.s[i], stroke: C.surface, strokeWidth: 2 }} activeDot={{ r: 6 }} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </section>

            <section className="rounded-xl p-4" style={surface}>
              <h3 style={{ fontSize: 14, fontWeight: 700 }}>Orders by month</h3>
              <div style={{ fontSize: 11.5, ...faint }} className="mb-2">Active orders placed in the month · click a bar to open that month</div>
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={series} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} barCategoryGap={6}>
                  <CartesianGrid vertical={false} stroke={C.grid} />
                  <XAxis dataKey="label" {...axis} />
                  <YAxis {...axis} width={52} tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))} />
                  <Tooltip cursor={{ fill: C.grid, opacity: 0.5 }} content={<Tip unit="count" />} />
                  <Bar dataKey="orders" name="Orders" fill={C.s[0]} radius={[4, 4, 0, 0]} maxBarSize={36} cursor="pointer"
                    onClick={(d: { payload?: { monthKey: string } }) => d.payload && onOpenMonth(d.payload.monthKey)} />
                </BarChart>
              </ResponsiveContainer>
            </section>

            <section className="rounded-xl p-4" style={surface}>
              <h3 style={{ fontSize: 14, fontWeight: 700 }}>Order → dispatch time by month</h3>
              <div style={{ fontSize: 11.5, ...faint }} className="mb-2">Hours from order to dispatch, dispatched orders, all channels</div>
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={series} margin={{ top: 4, right: 12, left: -12, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke={C.grid} />
                  <XAxis dataKey="label" {...axis} />
                  <YAxis {...axis} width={44} tickFormatter={(v: number) => `${v}h`} />
                  <Tooltip content={<Tip unit="hrs" />} />
                  <Legend iconType="plainline" wrapperStyle={{ fontSize: 12, color: C.muted }} />
                  {([["median", "Median"], ["p90", "90% within"]] as const).map(([k, n], i) => (
                    <Line key={k} type="monotone" dataKey={k} name={n} stroke={C.s[i]} strokeWidth={2} connectNulls
                      dot={{ r: 4, fill: C.s[i], stroke: C.surface, strokeWidth: 2 }} activeDot={{ r: 6 }} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </section>
          </div>

          {/* month table — the table view of the charts above */}
          <section className="rounded-xl overflow-hidden" style={surface}>
            <div className="px-4 py-2.5" style={{ borderBottom: "1px solid var(--atlas-line)" }}>
              <h3 style={{ fontSize: 14, fontWeight: 700 }}>Month by month</h3>
              <div style={{ fontSize: 11.5, ...faint }}>Click a month to open its Overview</div>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className="w-full" style={{ fontSize: 12.5, fontVariantNumeric: "tabular-nums", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={muted}>
                    {["Month", "Data to", "Orders", "Dispatched %", "3 PM due", "On-time %", "Late", "Pending", "AZ/FK SLA %", "Breached", "Median O→D", "90% within"].map((h, i) => (
                      <th key={h} className="px-3 py-2 font-medium" style={{ textAlign: i ? "right" : "left", whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...data].reverse().map((m) => {
                    const t = rateTone(m.k.onTimeRate), s = rateTone(m.k.slaRate);
                    const td = { borderTop: "1px solid var(--atlas-line)" };
                    return (
                      <tr key={m.monthKey} onClick={() => onOpenMonth(m.monthKey)} style={{ cursor: "pointer" }} title="Open this month">
                        <td className="px-3 py-1.5" style={{ ...td, fontWeight: 700, color: "var(--atlas-accent)" }}>{monthLabel(m.monthKey)}</td>
                        <td className="px-3 py-1.5 text-right" style={{ ...td, ...muted }}>{fmtDay(m.end)}</td>
                        <td className="px-3 py-1.5 text-right" style={td}>{fmtInt(m.k.orders)}</td>
                        <td className="px-3 py-1.5 text-right" style={td}>{pct(m.k.dispatchRate)}</td>
                        <td className="px-3 py-1.5 text-right" style={td}>{fmtInt(m.k.due3pm)}</td>
                        <td className="px-3 py-1.5 text-right" style={{ ...td, background: t?.bg }} title={t?.label}>{pct(m.k.onTimeRate)}</td>
                        <td className="px-3 py-1.5 text-right" style={td}>{fmtInt(m.k.late)}</td>
                        <td className="px-3 py-1.5 text-right" style={td}>{fmtInt(m.k.pending3pm)}</td>
                        <td className="px-3 py-1.5 text-right" style={{ ...td, background: s?.bg }} title={s?.label}>{pct(m.k.slaRate)}</td>
                        <td className="px-3 py-1.5 text-right" style={td}>{fmtInt(m.k.slaBreached)}</td>
                        <td className="px-3 py-1.5 text-right" style={td}>{hr(m.k.medianO2D)}</td>
                        <td className="px-3 py-1.5 text-right" style={td}>{hr(m.k.p90O2D)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* channel × month */}
          {mpChannels.length > 0 && (
            <section className="rounded-xl overflow-hidden" style={surface}>
              <div className="px-4 py-2.5" style={{ borderBottom: "1px solid var(--atlas-line)" }}>
                <h3 style={{ fontSize: 14, fontWeight: 700 }}>3 PM on-time % — channel × month</h3>
                <div style={{ fontSize: 11.5, ...faint }}>Marketplaces, by due day · small number = orders due · green ≥ 95% · amber 85–95% · red &lt; 85%</div>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ fontSize: 12.5, fontVariantNumeric: "tabular-nums", borderCollapse: "collapse", minWidth: "100%" }}>
                  <thead>
                    <tr style={muted}>
                      <th className="px-3 py-2 text-left font-medium">Channel</th>
                      {data.map((m) => <th key={m.monthKey} className="px-3 py-2 text-right font-medium" style={{ whiteSpace: "nowrap" }}>{shortMonth(m.monthKey)}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {mpChannels.map((ch) => (
                      <tr key={ch}>
                        <td className="px-3 py-1.5" style={{ fontWeight: 600, borderTop: "1px solid var(--atlas-line)" }}>{ch}</td>
                        {data.map((m) => {
                          const c = m.channels.find((r) => r.channel === ch);
                          const t = c && c.due3pm ? rateTone(c.onTimeRate) : null;
                          return (
                            <td key={m.monthKey} className="px-3 py-1.5 text-right" title={t?.label}
                              style={{ background: t?.bg, borderTop: "1px solid var(--atlas-line)", borderLeft: "2px solid var(--atlas-surface)" }}>
                              {c && c.due3pm ? <>{pct(c.onTimeRate)} <span style={{ fontSize: 10.5, ...faint }}>{fmtInt(c.due3pm)}</span></> : <span style={faint}>–</span>}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
