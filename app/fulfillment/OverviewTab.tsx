"use client";
// Overview — the interactive dashboard. One filter row (date range · channel ·
// facility) scopes every tile, chart and table below it; any number drills
// into the Orders / Pending grids with matching filters.
import { useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from "recharts";
import { DAY, MARKETPLACE_3PM, type Computed, type Dashboard, type PendingRow } from "@/lib/fulfillment/engine";
import {
  applyScope, applyScopePending, kpis, daily, byChannel, onTimeMatrix, pendingAging, priorRange, AGE_BUCKETS,
  type Range, type Scope, type Kpis, type DayPoint,
} from "@/lib/fulfillment/analytics";
import type { Filters } from "./DataGrid";
import { surface, soft, muted, faint, fmtDay, fmtInt, rateTone, Notice, inputStyle } from "./ui";

export type DrillTarget = "orders" | "pending";
type Props = { rows: Computed[]; pending: PendingRow[]; dash: Dashboard; onDrill: (t: DrillTarget, f: Filters) => void };

// ── chart palette (dataviz reference: status fixed; age bands = validated blue ordinal ramp) ──
/** The app's theme toggle sets <html data-theme>; charts pick their steps from it. */
const subscribeTheme = (cb: () => void) => {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => mo.disconnect();
};
const useThemeMode = () => useSyncExternalStore(subscribeTheme,
  () => (document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light") as "light" | "dark",
  () => "light" as const);
const PAL = {
  light: { surface: "#ffffff", grid: "#e1e0d9", axis: "#c3c2b7", muted: "#898781", s1: "#2a78d6" },
  dark: { surface: "#1a1a19", grid: "#2c2c2a", axis: "#383835", muted: "#898781", s1: "#3987e5" },
};
const STATUS = { good: "#0ca30c", warning: "#fab219", critical: "#d03b3b" };
const AGE_RAMP = ["#86b6ef", "#3987e5", "#256abf", "#184f95"]; // 0–1d → 8+d

const pct = (v: number | null, d = 1) => (v === null ? "–" : `${(v * 100).toFixed(d)}%`);
const hr = (v: number | null) => (v === null ? "–" : `${v.toFixed(1)} h`);
const dayRange = (g: Range) => ({ kind: "range" as const, min: g.start * DAY, max: (g.end + 1) * DAY - 1 });

// ── small building blocks ────────────────────────────────────────────────────
function MultiSelect({ label, options, value, onChange }: { label: string; options: string[]; value: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState<DOMRect | null>(null);
  const txt = value.length === 0 ? `All ${label}` : value.length <= 2 ? value.join(", ") : `${value.length} ${label}`;
  return (
    <>
      <button onClick={(e) => setOpen(open ? null : e.currentTarget.getBoundingClientRect())} className="px-2.5 py-1.5 rounded-lg flex items-center gap-1.5"
        style={{ ...soft, fontSize: 12.5, cursor: "pointer", color: "var(--atlas-ink)", maxWidth: 260, background: value.length ? "var(--atlas-accent-bg, var(--atlas-blue-bg))" : "var(--atlas-surface-soft)" }}>
        <span className="truncate">{txt}</span><span style={faint}>▾</span>
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(null)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
          <div className="rounded-lg p-2" style={{ ...surface, position: "fixed", top: open.bottom + 4, left: Math.min(open.left, window.innerWidth - 270), width: 260, zIndex: 41, boxShadow: "0 8px 24px rgba(0,0,0,.18)" }}>
            <div className="flex gap-3 px-1 pb-1" style={{ fontSize: 12 }}>
              <button onClick={() => onChange([])} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--atlas-accent)" }}>All</button>
            </div>
            <div style={{ maxHeight: 300, overflowY: "auto" }}>
              {options.map((o) => (
                <label key={o} className="flex items-center gap-2 px-1 py-0.5" style={{ fontSize: 12.5, cursor: "pointer" }}>
                  <input type="checkbox" checked={value.includes(o)} onChange={() => onChange(value.includes(o) ? value.filter((x) => x !== o) : [...value, o])} />{o}
                </label>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
}

function Delta({ cur, prev, kind, goodUp, label }: { cur: number | null; prev: number | null; kind: "pct" | "hrs" | "count"; goodUp: boolean; label: string }) {
  if (cur === null || prev === null) return null;
  const d = cur - prev;
  if (Math.abs(d) < (kind === "pct" ? 0.0005 : 0.05)) return <span style={{ fontSize: 11.5, ...faint }}>— no change vs {label}</span>;
  const good = goodUp ? d > 0 : d < 0;
  const txt = kind === "pct" ? `${Math.abs(d * 100).toFixed(1)} pts` : kind === "hrs" ? `${Math.abs(d).toFixed(1)} h` : fmtInt(Math.abs(Math.round(d)));
  return (
    <span style={{ fontSize: 11.5, color: good ? "var(--atlas-green)" : "var(--atlas-red)", fontWeight: 600 }}>
      {d > 0 ? "▲" : "▼"} {txt} <span style={{ ...faint, fontWeight: 400 }}>vs {label}</span>
    </span>
  );
}

function Tile({ label, value, sub, delta, tone, onClick }: { label: string; value: string; sub?: ReactNode; delta?: ReactNode; tone?: { bg: string; label: string } | null; onClick?: () => void }) {
  return (
    <button onClick={onClick} className="p-3.5 rounded-xl text-left min-w-0" style={{ ...surface, cursor: onClick ? "pointer" : "default", font: "inherit", color: "inherit" }} title={onClick ? "Open the orders behind this number" : undefined}>
      <div style={{ fontSize: 11.5, ...muted }} className="truncate">{label}</div>
      <div className="flex items-baseline gap-2 mt-1">
        <span style={{ fontSize: 24, fontWeight: 700, color: "var(--atlas-ink)" }}>{value}</span>
        {tone && <span className="px-1.5 py-0.5 rounded" style={{ fontSize: 10.5, fontWeight: 600, background: tone.bg, color: "var(--atlas-ink-soft)" }}>{tone.label}</span>}
      </div>
      {sub && <div style={{ fontSize: 11.5, ...faint }} className="mt-0.5 truncate">{sub}</div>}
      {delta && <div className="mt-0.5">{delta}</div>}
    </button>
  );
}

function Card({ title, sub, children, table }: { title: string; sub?: string; children: ReactNode; table?: ReactNode }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className="rounded-xl p-4 min-w-0" style={surface}>
      <div className="flex items-start justify-between gap-2 mb-2">
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 700 }}>{title}</h3>
          {sub && <div style={{ fontSize: 11.5, ...faint }}>{sub}</div>}
        </div>
        {table && (
          <button onClick={() => setAsTable(!asTable)} className="px-2 py-0.5 rounded" style={{ ...soft, fontSize: 11.5, cursor: "pointer", color: "var(--atlas-ink-soft)" }}>
            {asTable ? "Chart" : "Table"}
          </button>
        )}
      </div>
      {asTable ? <div style={{ maxHeight: 280, overflow: "auto" }}>{table}</div> : children}
    </section>
  );
}

function MiniTable({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <table className="w-full" style={{ fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
      <thead><tr style={muted}>{head.map((h, i) => <th key={h} className="px-2 py-1 font-medium" style={{ textAlign: i ? "right" : "left" }}>{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="px-2 py-0.5" style={{ textAlign: j ? "right" : "left", borderTop: "1px solid var(--atlas-line)" }}>{c}</td>)}</tr>)}</tbody>
    </table>
  );
}

function ChartTip({ active, payload, label, fmt }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string; fmt: (v: number, name: string) => string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg px-3 py-2" style={{ ...surface, fontSize: 12, boxShadow: "0 4px 14px rgba(0,0,0,.15)" }}>
      <div style={{ fontWeight: 700, marginBottom: 2 }}>{label}</div>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2">
          <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color }} />
          <span style={muted}>{p.name}</span><span className="ml-auto pl-3" style={{ fontWeight: 600 }}>{fmt(p.value, p.name)}</span>
        </div>
      ))}
    </div>
  );
}

// ── main ─────────────────────────────────────────────────────────────────────
type Preset = "mtd" | "7d" | "last" | "custom";

export default function OverviewTab({ rows, pending, dash, onDrill }: Props) {
  const mode = useThemeMode();
  const C = PAL[mode];
  const win: Range = useMemo(() => ({ start: dash.startDay, end: dash.endDay }), [dash.startDay, dash.endDay]);
  const [preset, setPreset] = useState<Preset>("mtd");
  const [custom, setCustom] = useState<Range>(win);
  const [scope, setScope] = useState<Scope>({ channels: [], facilities: [] });

  const g: Range = useMemo(() => (preset === "mtd" ? win : preset === "7d" ? { start: Math.max(win.start, win.end - 6), end: win.end }
    : preset === "last" ? { start: win.end, end: win.end }
    : { start: Math.max(win.start, Math.min(custom.start, custom.end)), end: Math.min(win.end, Math.max(custom.start, custom.end)) }), [preset, custom, win]);
  const prior = useMemo(() => priorRange(g, win.start), [g, win.start]);
  const priorLabel = preset === "last" ? "previous day" : preset === "7d" ? "previous 7 days" : "previous period";

  const channels = useMemo(() => [...new Set(rows.map((r) => r.channel).filter((c): c is string => !!c))].sort(), [rows]);
  const facilities = useMemo(() => [...new Set(rows.map((r) => r.facility).filter(Boolean))].sort(), [rows]);
  const scoped = useMemo(() => applyScope(rows, scope), [rows, scope]);
  const scopedPending = useMemo(() => applyScopePending(pending, scope), [pending, scope]);

  const k: Kpis = useMemo(() => kpis(scoped, g), [scoped, g]);
  const kp: Kpis | null = useMemo(() => (prior ? kpis(scoped, prior) : null), [scoped, prior]);
  const days: DayPoint[] = useMemo(() => daily(scoped, g), [scoped, g]);
  const chRows = useMemo(() => byChannel(scoped, g), [scoped, g]);
  const matrix = useMemo(() => onTimeMatrix(scoped, g), [scoped, g]);
  const aging = useMemo(() => pendingAging(scopedPending), [scopedPending]);
  const aged3 = scopedPending.filter((p) => (p.ageDays ?? 0) >= 3).length;

  // drill helpers — carry the channel / facility scope along
  const scopeFilters = (): Filters => ({
    ...(scope.channels.length ? { channel: { kind: "enum", values: scope.channels } } : {}),
    ...(scope.facilities.length ? { facility: { kind: "enum", values: scope.facilities } } : {}),
  });
  const drillOrders = (f: Filters, by: "order" | "due" = "order", range: Range = g) =>
    onDrill("orders", { ...scopeFilters(), [by === "order" ? "orderDay" : "dueDay"]: dayRange(range), ...f });
  // 3 PM drill-downs: marketplace channels only (within the channel scope, if any)
  const MP_FILTER: Filters = { channel: { kind: "enum", values: scope.channels.length ? scope.channels.filter((c) => MARKETPLACE_3PM.includes(c)) : MARKETPLACE_3PM } };

  const dayData = days.map((d) => ({ ...d, label: fmtDay(d.day), onTimePct: d.onTimeRate === null ? null : +(d.onTimeRate * 100).toFixed(2) }));
  const axis = { tick: { fontSize: 11, fill: C.muted }, axisLine: { stroke: C.axis }, tickLine: false };
  const presetBtn = (p: Preset, l: string) => (
    <button key={p} onClick={() => setPreset(p)} className="px-2.5 py-1.5 rounded-lg"
      style={{ fontSize: 12.5, cursor: "pointer", border: "1px solid var(--atlas-line)", fontWeight: preset === p ? 700 : 500,
        background: preset === p ? "var(--atlas-accent)" : "var(--atlas-surface-soft)", color: preset === p ? "#fff" : "var(--atlas-ink-soft)" }}>{l}</button>
  );
  const isoOf = (d: number) => new Date(d * DAY * 1000).toISOString().slice(0, 10);
  const dayOfIso = (s: string) => Math.floor(Date.parse(`${s}T00:00:00Z`) / 1000 / DAY);
  const num = (n: number, f: Filters, by: "order" | "due" = "order") => (
    <button onClick={() => drillOrders(f, by)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--atlas-ink)", font: "inherit", padding: 0, textDecoration: n ? "underline dotted" : "none", textUnderlineOffset: 3 }} title="Open these orders">{fmtInt(n)}</button>
  );

  return (
    <div className="space-y-4">
      {/* one filter row scopes everything below */}
      <div className="flex flex-wrap items-center gap-2 p-3 rounded-xl" style={{ ...surface, position: "sticky", top: 0, zIndex: 5 }}>
        {presetBtn("mtd", "Month to date")}{presetBtn("7d", "Last 7 days")}{presetBtn("last", `Latest day (${fmtDay(win.end)})`)}{presetBtn("custom", "Custom")}
        {preset === "custom" && (
          <span className="flex items-center gap-1" style={{ fontSize: 12, ...muted }}>
            <input type="date" value={isoOf(custom.start)} min={isoOf(win.start)} max={isoOf(win.end)} onChange={(e) => e.target.value && setCustom({ ...custom, start: dayOfIso(e.target.value) })} style={{ ...inputStyle, width: 140 }} />
            to
            <input type="date" value={isoOf(custom.end)} min={isoOf(win.start)} max={isoOf(win.end)} onChange={(e) => e.target.value && setCustom({ ...custom, end: dayOfIso(e.target.value) })} style={{ ...inputStyle, width: 140 }} />
          </span>
        )}
        <span className="mx-1" style={{ width: 1, height: 22, background: "var(--atlas-line)" }} />
        <MultiSelect label="channels" options={channels} value={scope.channels} onChange={(v) => setScope({ ...scope, channels: v })} />
        <MultiSelect label="facilities" options={facilities} value={scope.facilities} onChange={(v) => setScope({ ...scope, facilities: v })} />
        {(scope.channels.length > 0 || scope.facilities.length > 0) && (
          <button onClick={() => setScope({ channels: [], facilities: [] })} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, color: "var(--atlas-accent)" }}>Reset</button>
        )}
        <span className="ml-auto" style={{ fontSize: 12, ...faint }}>{g.start === g.end ? fmtDay(g.start) : `${fmtDay(g.start)} – ${fmtDay(g.end)}`}</span>
      </div>

      {dash.unmapped.length > 0 && (
        <Notice tone="warn">
          <b>{fmtInt(dash.unmapped.reduce((s, u) => s + u.orders, 0))} orders</b> have a Channel Name missing from the Channel Mapper and are not counted under any channel: {dash.unmapped.slice(0, 5).map((u) => `${u.channelName} (${u.orders})`).join(", ")}. Fix under <b>Settings → Channel Mapper</b>.
        </Notice>
      )}

      {/* headline tiles */}
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(175px, 1fr))" }}>
        <Tile label="Orders" value={fmtInt(k.orders)} sub={`${pct(k.dispatchRate)} dispatched`}
          delta={kp && <Delta cur={k.orders} prev={kp.orders} kind="count" goodUp label={priorLabel} />} onClick={() => drillOrders({})} />
        <Tile label="3 PM on-time % (marketplaces)" value={pct(k.onTimeRate)} tone={rateTone(k.onTimeRate)} sub={`${fmtInt(k.late)} late · ${fmtInt(k.due3pm)} due`}
          delta={kp && <Delta cur={k.onTimeRate} prev={kp.onTimeRate} kind="pct" goodUp label={priorLabel} />}
          onClick={() => drillOrders({ ...MP_FILTER, status3pm: { kind: "enum", values: ["Late"] } }, "due")} />
        <Tile label="Amazon + Flipkart SLA met" value={pct(k.slaRate)} tone={rateTone(k.slaRate)} sub={`${fmtInt(k.slaBreached)} breached`}
          delta={kp && <Delta cur={k.slaRate} prev={kp.slaRate} kind="pct" goodUp label={priorLabel} />}
          onClick={() => drillOrders({ azfkSla: { kind: "enum", values: ["Breached"] } })} />
        <Tile label="Median order → dispatch" value={hr(k.medianO2D)} sub={`90% within ${hr(k.p90O2D)}`}
          delta={kp && <Delta cur={k.medianO2D} prev={kp.medianO2D} kind="hrs" goodUp={false} label={priorLabel} />}
          onClick={() => drillOrders({ dispatched: { kind: "enum", values: ["Yes"] } })} />
        <Tile label="Pending dispatch (now)" value={fmtInt(scopedPending.length)} sub={`${fmtInt(aged3)} aged 3+ days`}
          onClick={() => onDrill("pending", scopeFilters())} />
        <Tile label="Not yet dispatched in range" value={fmtInt(k.orders - k.dispatched)} sub="orders placed in range"
          delta={kp && <Delta cur={k.orders - k.dispatched} prev={kp.orders - kp.dispatched} kind="count" goodUp={false} label={priorLabel} />}
          onClick={() => drillOrders({ dispatched: { kind: "enum", values: ["No"] } })} />
      </div>

      {/* charts */}
      <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))" }}>
        <Card title="3 PM dispatch by due day" sub="Marketplaces · click a bar for that day's orders"
          table={<MiniTable head={["Due day", "On time", "Late", "Pending", "On-time %"]} rows={days.map((d) => [fmtDay(d.day), d.onTime, d.late, d.pending, pct(d.onTimeRate)])} />}>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={dayData} margin={{ top: 4, right: 4, left: -12, bottom: 0 }} barCategoryGap={2}>
              <CartesianGrid vertical={false} stroke={C.grid} />
              <XAxis dataKey="label" {...axis} interval="preserveStartEnd" minTickGap={14} />
              <YAxis {...axis} width={44} allowDecimals={false} />
              <Tooltip cursor={{ fill: C.grid, opacity: 0.5 }} content={<ChartTip fmt={(v) => fmtInt(v)} />} />
              <Legend iconType="square" iconSize={9} wrapperStyle={{ fontSize: 12, color: C.muted }} />
              {([["onTime", "On time", STATUS.good], ["late", "Late", STATUS.critical], ["pending", "Pending", STATUS.warning]] as const).map(([key, name, color], i) => (
                <Bar key={key} dataKey={key} name={name} stackId="a" fill={color} stroke={C.surface} strokeWidth={1} maxBarSize={22}
                  radius={i === 2 ? [4, 4, 0, 0] : 0} cursor="pointer"
                  onClick={(d: { payload?: DayPoint }) => d.payload && drillOrders(MP_FILTER, "due", { start: d.payload.day, end: d.payload.day })} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card title="3 PM on-time % by due day" sub="Marketplaces"
          table={<MiniTable head={["Due day", "Due", "On-time %"]} rows={days.map((d) => [fmtDay(d.day), d.due, pct(d.onTimeRate)])} />}>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={dayData} margin={{ top: 4, right: 12, left: -12, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke={C.grid} />
              <XAxis dataKey="label" {...axis} interval="preserveStartEnd" minTickGap={14} />
              <YAxis {...axis} width={44} domain={[(min: number) => Math.max(0, Math.floor(min / 5) * 5 - 5), 100]} tickFormatter={(v: number) => `${v}%`} />
              <Tooltip content={<ChartTip fmt={(v) => `${v.toFixed(1)}%`} />} />
              <Line type="monotone" dataKey="onTimePct" name="On-time %" stroke={C.s1} strokeWidth={2} dot={{ r: 3, fill: C.s1, stroke: C.surface, strokeWidth: 2 }} activeDot={{ r: 5 }} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Median order → dispatch (hours) by order day" sub="Dispatched orders, all channels in scope"
          table={<MiniTable head={["Order day", "Orders", "Dispatched", "Median h"]} rows={days.map((d) => [fmtDay(d.day), d.orders, d.dispatched, d.medianO2D === null ? "–" : d.medianO2D.toFixed(1)])} />}>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={dayData} margin={{ top: 4, right: 12, left: -12, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke={C.grid} />
              <XAxis dataKey="label" {...axis} interval="preserveStartEnd" minTickGap={14} />
              <YAxis {...axis} width={44} tickFormatter={(v: number) => `${v}h`} />
              <Tooltip content={<ChartTip fmt={(v) => `${v.toFixed(1)} h`} />} />
              <Line type="monotone" dataKey="medianO2D" name="Median hours" stroke={C.s1} strokeWidth={2} dot={{ r: 3, fill: C.s1, stroke: C.surface, strokeWidth: 2 }} activeDot={{ r: 5 }} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Pending dispatch by facility & age" sub="Orders not yet dispatched · age = days since order"
          table={<MiniTable head={["Facility", ...AGE_BUCKETS.map((b) => b.label), "Total"]} rows={aging.map((a) => [a.facility, ...AGE_BUCKETS.map((b) => a[b.key]), a.total])} />}>
          {aging.length === 0 ? <div className="py-16 text-center" style={muted}>Nothing pending 🎉</div> : (
            <ResponsiveContainer width="100%" height={Math.max(160, aging.length * 44 + 60)}>
              <BarChart data={aging} layout="vertical" margin={{ top: 4, right: 12, left: 8, bottom: 0 }} barCategoryGap={8}>
                <CartesianGrid horizontal={false} stroke={C.grid} />
                <XAxis type="number" {...axis} allowDecimals={false} />
                <YAxis type="category" dataKey="facility" {...axis} width={150} />
                <Tooltip cursor={{ fill: C.grid, opacity: 0.5 }} content={<ChartTip fmt={(v) => fmtInt(v)} />} />
                <Legend iconType="square" iconSize={9} wrapperStyle={{ fontSize: 12, color: C.muted }} />
                {AGE_BUCKETS.map((b, i) => (
                  <Bar key={b.key} dataKey={b.key} name={b.label} stackId="a" fill={AGE_RAMP[i]} stroke={C.surface} strokeWidth={1} maxBarSize={26}
                    radius={i === AGE_BUCKETS.length - 1 ? [0, 4, 4, 0] : 0} cursor="pointer"
                    onClick={(d: { payload?: { facility: string } }) => d.payload && onDrill("pending", {
                      ...scopeFilters(), facility: { kind: "enum", values: [d.payload.facility] }, ageDays: { kind: "range", min: b.min, max: Number.isFinite(b.max) ? b.max : null },
                    })} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>
      </div>

      {/* channel scorecard */}
      <section className="rounded-xl overflow-hidden" style={surface}>
        <div className="px-4 py-2.5" style={{ borderBottom: "1px solid var(--atlas-line)" }}>
          <h3 style={{ fontSize: 14, fontWeight: 700 }}>Channel scorecard</h3>
          <div style={{ fontSize: 11.5, ...faint }}>Orders / dispatch / median by order day · 3 PM columns by due day (marketplaces) · click a number for the orders</div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="w-full" style={{ fontSize: 12.5, fontVariantNumeric: "tabular-nums", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ ...muted, textAlign: "right" }}>
                {["Channel", "Orders", "Dispatched %", "Median O→D", "3 PM due", "On-time %", "Late", "Pending", "AZ/FK SLA %"].map((h, i) => (
                  <th key={h} className="px-3 py-2 font-medium" style={{ textAlign: i ? "right" : "left", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {chRows.map((c) => {
                const cf: Filters = { channel: { kind: "enum", values: [c.channel] } };
                const t = c.is3pm ? rateTone(c.onTimeRate) : null;
                const s = c.isAzfk ? rateTone(c.slaRate) : null;
                const td = { borderTop: "1px solid var(--atlas-line)" };
                return (
                  <tr key={c.channel}>
                    <td className="px-3 py-1.5" style={{ ...td, fontWeight: 600 }}>{c.channel}</td>
                    <td className="px-3 py-1.5 text-right" style={td}>{num(c.orders, cf)}</td>
                    <td className="px-3 py-1.5 text-right" style={td}>{pct(c.dispatchRate)}</td>
                    <td className="px-3 py-1.5 text-right" style={td}>{hr(c.medianO2D)}</td>
                    <td className="px-3 py-1.5 text-right" style={td}>{c.is3pm ? num(c.due3pm, cf, "due") : <span style={faint}>–</span>}</td>
                    <td className="px-3 py-1.5 text-right" style={{ ...td, background: t?.bg }} title={t?.label}>{c.is3pm ? pct(c.onTimeRate) : <span style={faint}>–</span>}</td>
                    <td className="px-3 py-1.5 text-right" style={td}>{c.is3pm ? num(c.late, { ...cf, status3pm: { kind: "enum", values: ["Late"] } }, "due") : <span style={faint}>–</span>}</td>
                    <td className="px-3 py-1.5 text-right" style={td}>{c.is3pm ? num(c.pending3pm, { ...cf, status3pm: { kind: "enum", values: ["Pending"] } }, "due") : <span style={faint}>–</span>}</td>
                    <td className="px-3 py-1.5 text-right" style={{ ...td, background: s?.bg }} title={s?.label}>{c.isAzfk ? pct(c.slaRate) : <span style={faint}>–</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* channel × facility on-time */}
      {matrix.channels.length > 0 && (
        <section className="rounded-xl overflow-hidden" style={surface}>
          <div className="px-4 py-2.5 flex flex-wrap items-end justify-between gap-2" style={{ borderBottom: "1px solid var(--atlas-line)" }}>
            <div>
              <h3 style={{ fontSize: 14, fontWeight: 700 }}>3 PM on-time % — channel × facility</h3>
              <div style={{ fontSize: 11.5, ...faint }}>Marketplaces, by due day · small number = orders due · click a cell for its late orders</div>
            </div>
            <span className="flex items-center gap-3" style={{ fontSize: 11.5, ...muted }}>
              {[["var(--atlas-green-bg)", "≥ 95% good"], ["var(--atlas-amber-bg)", "85–95% watch"], ["var(--atlas-red-bg)", "< 85% poor"]].map(([bg, l]) => (
                <span key={l} className="flex items-center gap-1"><span style={{ width: 11, height: 11, borderRadius: 3, background: bg, border: "1px solid var(--atlas-line)" }} />{l}</span>
              ))}
            </span>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ fontSize: 12.5, fontVariantNumeric: "tabular-nums", borderCollapse: "collapse", minWidth: "100%" }}>
              <thead>
                <tr style={muted}>
                  <th className="px-3 py-2 text-left font-medium">Channel</th>
                  {matrix.facilities.map((f) => <th key={f} className="px-3 py-2 text-right font-medium" style={{ whiteSpace: "nowrap" }}>{f}</th>)}
                  <th className="px-3 py-2 text-right font-semibold" style={{ color: "var(--atlas-ink)" }}>All</th>
                </tr>
              </thead>
              <tbody>
                {[...matrix.channels, "__total"].map((ch) => (
                  <tr key={ch}>
                    <td className="px-3 py-1.5" style={{ fontWeight: ch === "__total" ? 700 : 600, borderTop: "1px solid var(--atlas-line)" }}>{ch === "__total" ? "All" : ch}</td>
                    {[...matrix.facilities, "__all"].map((fa) => {
                      const cell = ch === "__total" ? (fa === "__all" ? { due: k.due3pm, onTime: k.onTime, late: k.late, pending: k.pending3pm, rate: k.onTimeRate } : matrix.facilityTotal(fa))
                        : fa === "__all" ? matrix.channelTotal(ch) : matrix.cell(ch, fa);
                      const t = cell && cell.due ? rateTone(cell.rate) : null;
                      return (
                        <td key={fa} className="px-3 py-1.5 text-right" style={{ background: t?.bg, borderTop: "1px solid var(--atlas-line)", borderLeft: "2px solid var(--atlas-surface)", fontWeight: ch === "__total" || fa === "__all" ? 600 : 400 }}>
                          {cell && cell.due ? (
                            <button title={`${t?.label ?? ""} · ${fmtInt(cell.late)} late, ${fmtInt(cell.pending)} pending — open late orders`} style={{ background: "none", border: "none", cursor: "pointer", font: "inherit", color: "var(--atlas-ink)", padding: 0 }}
                              onClick={() => drillOrders({
                                ...(ch === "__total" ? MP_FILTER : { channel: { kind: "enum", values: [ch] } }),
                                ...(fa === "__all" ? {} : { facility: { kind: "enum", values: [fa] } }),
                                status3pm: { kind: "enum", values: ["Late"] },
                              }, "due")}>
                              {pct(cell.rate)} <span style={{ fontSize: 10.5, ...faint }}>{fmtInt(cell.due)}</span>
                            </button>
                          ) : <span style={faint}>–</span>}
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
    </div>
  );
}
