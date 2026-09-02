"use client";
// Sales dashboard — NTO / GTO / Qty across ~1.5 yrs, sliced by month · channel ·
// category · SKU, for Singles (canonical sales-by-SKU) or Combos. Channel-first:
// every view honours the global month-range + channel filters.
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BarChart, Bar, LineChart, Line, AreaChart, Area, PieChart, Pie, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid, Cell } from "recharts";
import AppShell from "@/app/components/AppShell";
import { createClient } from "@/lib/supabase/client";
import { monthLabel, fmtMetric, fmtCr, fmtQty, METRICS, type Metric, type Kind } from "./lib";

const NTO_ROLES = new Set(["admin", "head_kam", "channel_kam"]);   // Sales & Admin

type Row = { month: string; channel: string; category: string; kind: Kind; masterSku: string; qty: number; nto: number; gto: number };
type Data = { rows: Row[]; months: string[]; channels: string[]; categories: string[]; rowCount: number };

const PALETTE = ["#2563EB", "#0E9F6E", "#E8850C", "#8B5CF6", "#0EA5E9", "#DC5B2B", "#D6409F", "#0891B2", "#65A30D", "#DB2777", "#7C3AED", "#0D9488"];
const surface: React.CSSProperties = { background: "var(--atlas-surface)", border: "1px solid var(--atlas-line)" };
const tip = { background: "var(--atlas-surface)", border: "1px solid var(--atlas-line)", borderRadius: 8, fontSize: 12, color: "var(--atlas-ink)" } as React.CSSProperties;
const axis = { fontSize: 11, fill: "var(--atlas-ink-muted)" };
const MONNUM = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const shortMonth = (m: string) => monthLabel(m + "-01");

function Btn({ on, active, children }: { on: () => void; active: boolean; children: React.ReactNode }) {
  return <button onClick={on} className="px-3 py-1.5 rounded-lg" style={{ fontSize: 12, fontWeight: 600, cursor: "pointer", border: "1px solid var(--atlas-line)", background: active ? "var(--atlas-accent)" : "var(--atlas-surface)", color: active ? "#fff" : "var(--atlas-ink-muted)" }}>{children}</button>;
}
function Card({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return <div className="p-4 rounded-xl" style={surface}><div className="text-sm font-semibold mb-2" style={{ color: "var(--atlas-ink)" }}>{title}</div>{children}</div>;
}
const sub = (t: string) => <span style={{ color: "var(--atlas-ink-muted)", fontWeight: 400 }}>{t}</span>;
function RangeDot(p: { cx?: number; cy?: number; payload?: { inR?: boolean } }) {
  return <circle cx={p.cx} cy={p.cy} r={p.payload?.inR ? 3.5 : 2} fill={p.payload?.inR ? "var(--atlas-accent)" : "var(--atlas-line)"} />;
}

export default function SalesDashboard() {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [metric, setMetric] = useState<Metric>("nto");
  const [lens, setLens] = useState<Kind>("single");
  const [fromM, setFromM] = useState<string>("");
  const [toM, setToM] = useState<string>("");
  const [chSel, setChSel] = useState<Set<string>>(new Set());   // empty = all channels
  const [skuSel, setSkuSel] = useState<string>("");             // SKU explorer focus
  const [canNto, setCanNto] = useState(false);                  // NTO/unit mapper access

  useEffect(() => {
    (async () => {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data: p } = await supabase.from("profiles").select("role").eq("id", user.id).single();
      if (p?.role && NTO_ROLES.has(p.role)) setCanNto(true);
    })();
  }, []);

  useEffect(() => {
    fetch("/api/sales/data", { cache: "no-store" }).then((r) => r.json())
      .then((d) => { if (d.error) setErr(d.error); else { setData(d); if (d.months?.length) { setFromM(d.months[0]); setToM(d.months[d.months.length - 1]); } } })
      .catch((e) => setErr(String(e)));
  }, []);

  const m = metric;
  const months = useMemo(() => data?.months ?? [], [data]);
  const base = useMemo(() => (data?.rows ?? []).filter((g) => g.kind === lens), [data, lens]);

  // channel order (by all-time metric) — stable colour assignment
  const channels = useMemo(() => {
    const t = new Map<string, number>();
    for (const r of base) t.set(r.channel, (t.get(r.channel) ?? 0) + r[m]);
    return [...t.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  }, [base, m]);
  const chColor = useMemo(() => { const map: Record<string, string> = {}; channels.forEach((c, i) => (map[c] = PALETTE[i % PALETTE.length])); return map; }, [channels]);
  const chOn = useCallback((c: string) => chSel.size === 0 || chSel.has(c), [chSel]);
  const activeChannels = useMemo(() => channels.filter(chOn), [channels, chOn]);

  const rangeMonths = useMemo(() => months.filter((mo) => (!fromM || mo >= fromM) && (!toM || mo <= toM)), [months, fromM, toM]);
  const inRange = useCallback((r: Row) => (!fromM || r.month >= fromM) && (!toM || r.month <= toM), [fromM, toM]);
  const scoped = useMemo(() => base.filter((r) => inRange(r) && chOn(r.channel)), [base, inRange, chOn]);
  const rangeLabel = fromM && toM ? (fromM === toM ? shortMonth(fromM) : `${shortMonth(fromM)} → ${shortMonth(toM)}`) : "all";

  // KPI + prior-equal-period growth
  const kpi = useMemo(() => {
    const val = scoped.reduce((a, r) => a + r[m], 0);
    const nto = scoped.reduce((a, r) => a + r.nto, 0), gto = scoped.reduce((a, r) => a + r.gto, 0);
    const n = rangeMonths.length || 1;
    const firstIdx = months.indexOf(rangeMonths[0]);
    const prevMonths = firstIdx > 0 ? months.slice(Math.max(0, firstIdx - n), firstIdx) : [];
    const prev = prevMonths.length ? base.filter((r) => prevMonths.includes(r.month) && chOn(r.channel)).reduce((a, r) => a + r[m], 0) : null;
    const growth = prev != null && prev !== 0 ? (val - prev) / prev : null;
    const chTot = new Map<string, number>();
    for (const r of scoped) chTot.set(r.channel, (chTot.get(r.channel) ?? 0) + r[m]);
    const top = [...chTot.entries()].sort((a, b) => b[1] - a[1])[0];
    return { val, nto, gto, avg: val / n, real: gto ? nto / gto : null, growth, prevLabel: prevMonths.length ? `${shortMonth(prevMonths[0])}–${shortMonth(prevMonths[prevMonths.length - 1])}` : null, topCh: top ? top[0] : "—", topShare: top && val ? top[1] / val : 0 };
  }, [scoped, base, m, rangeMonths, months, chOn]);

  // trend (all months, channel-filtered) — line
  const trend = useMemo(() => months.map((mo) => ({ mo, label: shortMonth(mo), value: base.filter((r) => r.month === mo && chOn(r.channel)).reduce((a, r) => a + r[m], 0), inR: (!fromM || mo >= fromM) && (!toM || mo <= toM) })), [base, months, m, fromM, toM, chOn]);

  // channel trend stacked area (all months)
  const chTrend = useMemo(() => months.map((mo) => {
    const o: Record<string, number | string> = { label: shortMonth(mo) };
    for (const ch of activeChannels) o[ch] = base.filter((r) => r.month === mo && r.channel === ch).reduce((a, r) => a + r[m], 0);
    return o;
  }), [base, months, activeChannels, m]);

  // channel share (range) — donut over ALL channels for context
  const chShare = useMemo(() => {
    const t = new Map<string, number>();
    for (const r of base.filter(inRange)) t.set(r.channel, (t.get(r.channel) ?? 0) + r[m]);
    return channels.map((c) => ({ name: c, value: Math.max(0, t.get(c) ?? 0) })).filter((d) => d.value > 0);
  }, [base, channels, inRange, m]);

  // channel × category matrix (range + channel scoped)
  const matrix = useMemo(() => {
    const cats = new Map<string, number>(), grid = new Map<string, Map<string, number>>();
    for (const r of scoped) {
      const cat = r.category || "Uncat.";
      cats.set(cat, (cats.get(cat) ?? 0) + r[m]);
      const row = grid.get(cat) ?? new Map<string, number>();
      row.set(r.channel, (row.get(r.channel) ?? 0) + r[m]); grid.set(cat, row);
    }
    const catList = [...cats.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
    let max = 0; for (const row of grid.values()) for (const v of row.values()) if (v > max) max = v;
    const chTot = new Map<string, number>();
    for (const c of activeChannels) chTot.set(c, catList.reduce((a, cat) => a + (grid.get(cat)?.get(c) ?? 0), 0));
    return { catList, grid, cats, max, chTot, grand: [...cats.values()].reduce((a, b) => a + b, 0) };
  }, [scoped, activeChannels, m]);

  // category + top SKUs (scoped)
  const byCategory = useMemo(() => [...matrix.cats.entries()].map(([category, value]) => ({ category, value })).sort((a, b) => b.value - a.value), [matrix]);
  const topSkus = useMemo(() => {
    const t = new Map<string, number>();
    for (const r of scoped) t.set(r.masterSku, (t.get(r.masterSku) ?? 0) + r[m]);
    return [...t.entries()].map(([sku, value]) => ({ sku, value })).sort((a, b) => b.value - a.value).slice(0, 15);
  }, [scoped, m]);

  // channel performance table
  const chPerf = useMemo(() => {
    const n = rangeMonths.length || 1, half = Math.floor(rangeMonths.length / 2);
    const firstH = new Set(rangeMonths.slice(0, half)), secondH = new Set(rangeMonths.slice(rangeMonths.length - half));
    const acc = new Map<string, { val: number; nto: number; gto: number; a: number; b: number; skus: Set<string> }>();
    for (const r of base.filter(inRange)) {
      const a = acc.get(r.channel) ?? { val: 0, nto: 0, gto: 0, a: 0, b: 0, skus: new Set<string>() };
      a.val += r[m]; a.nto += r.nto; a.gto += r.gto; if (firstH.has(r.month)) a.a += r[m]; if (secondH.has(r.month)) a.b += r[m]; if (r.qty !== 0) a.skus.add(r.masterSku); acc.set(r.channel, a);
    }
    const grand = [...acc.values()].reduce((s, x) => s + x.val, 0);
    return channels.map((c) => { const a = acc.get(c); if (!a) return null; return { channel: c, val: a.val, share: grand ? a.val / grand : 0, real: a.gto ? a.nto / a.gto : null, growth: half > 0 && a.a !== 0 ? (a.b - a.a) / a.a : null, skus: a.skus.size, avg: a.val / n }; }).filter(Boolean) as { channel: string; val: number; share: number; real: number | null; growth: number | null; skus: number; avg: number }[];
  }, [base, channels, rangeMonths, m, inRange]);

  // ── SKU explorer (independent of month-range / channel filters — full picture) ──
  const skuList = useMemo(() => {
    const t = new Map<string, number>();
    for (const r of base) t.set(r.masterSku, (t.get(r.masterSku) ?? 0) + r[m]);
    return [...t.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
  }, [base, m]);
  const sku = skuSel && skuList.includes(skuSel) ? skuSel : (skuList[0] ?? "");   // effective selection (default = top)
  const skuRows = useMemo(() => base.filter((r) => r.masterSku === sku), [base, sku]);
  const skuChannels = useMemo(() => {
    const t = new Map<string, number>();
    for (const r of skuRows) t.set(r.channel, (t.get(r.channel) ?? 0) + r[m]);
    return channels.filter((c) => (t.get(c) ?? 0) !== 0).map((c) => ({ channel: c, value: t.get(c) ?? 0 }));
  }, [skuRows, channels, m]);
  const skuTrend = useMemo(() => months.map((mo) => {
    const o: Record<string, number | string> = { label: shortMonth(mo) };
    for (const c of skuChannels) o[c.channel] = skuRows.filter((r) => r.month === mo && r.channel === c.channel).reduce((a, r) => a + r[m], 0);
    o.__total = skuChannels.reduce((a, c) => a + (o[c.channel] as number), 0);
    return o;
  }), [skuRows, months, skuChannels, m]);
  const skuKpi = useMemo(() => {
    const nto = skuRows.reduce((a, r) => a + r.nto, 0), gto = skuRows.reduce((a, r) => a + r.gto, 0), qty = skuRows.reduce((a, r) => a + r.qty, 0);
    const cat = skuRows.find((r) => r.category)?.category || "Uncat.";
    const val = skuRows.reduce((a, r) => a + r[m], 0);
    const top = [...skuChannels].sort((a, b) => b.value - a.value)[0];
    const activeMonths = new Set(skuRows.filter((r) => r.qty !== 0).map((r) => r.month)).size;
    const catTot = base.filter((r) => (r.category || "Uncat.") === cat).reduce((a, r) => a + r[m], 0);
    return { nto, gto, qty, cat, val, real: gto ? nto / gto : null, top, activeMonths, catShare: catTot ? val / catTot : 0 };
  }, [skuRows, skuChannels, base, m]);

  const yoy = useMemo(() => {
    const byNum = new Map<number, Record<number, number>>();
    const perMonth = (mo: string) => base.filter((r) => r.month === mo && chOn(r.channel)).reduce((a, r) => a + r[m], 0);
    for (const mo of months) { const [y, mm] = mo.split("-").map(Number); const rec = byNum.get(mm) ?? {}; rec[y] = perMonth(mo); byNum.set(mm, rec); }
    const years = [...new Set(months.map((mo) => Number(mo.split("-")[0])))].sort();
    const yA = years[0], yB = years[years.length - 1];
    return [...byNum.entries()].filter(([, r]) => r[yA] != null && r[yB] != null).sort((a, b) => a[0] - b[0])
      .map(([mm, r]) => ({ mon: MONNUM[mm], a: r[yA], b: r[yB], g: r[yA] ? (r[yB] - r[yA]) / r[yA] : null }));
  }, [months, base, m, chOn]);
  const fyYears = [...new Set(months.map((mo) => Number(mo.split("-")[0])))].sort();

  if (err) return <AppShell><div className="py-16 text-center"><p style={{ color: "var(--atlas-red)" }}>{err}</p><p className="mt-2 text-sm" style={{ color: "var(--atlas-ink-muted)" }}>Apply <code>the sales table</code> and upload data at <Link href="/sales/upload" style={{ color: "var(--atlas-accent)" }}>/sales/upload</Link>.</p></div></AppShell>;
  if (!data) return <AppShell><div className="py-16 text-center" style={{ color: "var(--atlas-ink-muted)" }}>Loading sales…</div></AppShell>;
  if (data.rowCount === 0) return <AppShell><div className="py-16 text-center"><p style={{ color: "var(--atlas-ink-muted)" }}>No sales data yet.</p><Link href="/sales/upload" className="inline-block mt-3 px-4 py-2 rounded-lg text-white" style={{ background: "var(--atlas-accent)", textDecoration: "none" }}>Upload data →</Link></div></AppShell>;

  const unit = METRICS.find((x) => x.k === m)!.unit;
  const fmtY = (v: number) => (m === "qty" ? fmtQty(v) : v.toFixed(0));
  const heat = (v: number) => { if (v <= 0) return { bg: "transparent", fg: "var(--atlas-ink-faint)" }; const t = matrix.max ? v / matrix.max : 0; return { bg: `color-mix(in srgb, var(--atlas-accent) ${Math.round(8 + t * 68)}%, transparent)`, fg: t > 0.55 ? "#fff" : "var(--atlas-ink)" }; };

  return (
    <AppShell>
      <div className="max-w-7xl mx-auto space-y-5">
        {/* header */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">Sales Dashboard</h1>
            <p className="text-sm mt-1" style={{ color: "var(--atlas-ink-muted)" }}>{months.length} months ({shortMonth(months[0])} → {shortMonth(months[months.length - 1])}) · {channels.length} channels · {data.categories.length} categories · NTO/GTO in ₹ Cr</p>
          </div>
          <div className="flex items-center gap-2">
            {canNto && <Link href="/sales/nto-mapper" className="px-3 py-1.5 rounded-lg" style={{ ...surface, fontSize: 12, textDecoration: "none", color: "var(--atlas-accent)", fontWeight: 600 }}>NTO / unit mapper →</Link>}
            <Link href="/sales/upload" className="px-3 py-1.5 rounded-lg" style={{ ...surface, fontSize: 12, textDecoration: "none", color: "var(--atlas-ink-soft)" }}>↑ Upload month</Link>
          </div>
        </div>

        {/* control bar */}
        <div className="rounded-xl p-3 space-y-3" style={{ ...surface, position: "sticky", top: 8, zIndex: 20, backdropFilter: "blur(6px)" }}>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <div className="flex items-center gap-2"><span className="text-xs font-semibold" style={{ color: "var(--atlas-ink-muted)" }}>Metric</span><div className="flex gap-1">{METRICS.map((x) => <Btn key={x.k} on={() => setMetric(x.k)} active={m === x.k}>{x.label}</Btn>)}</div></div>
            <div className="flex items-center gap-2"><span className="text-xs font-semibold" style={{ color: "var(--atlas-ink-muted)" }}>Lens</span><div className="flex gap-1">{(["single", "combo"] as Kind[]).map((k) => <Btn key={k} on={() => setLens(k)} active={lens === k}>{k === "single" ? "Singles" : "Combos"}</Btn>)}</div></div>
            <div className="flex items-center gap-2"><span className="text-xs font-semibold" style={{ color: "var(--atlas-ink-muted)" }}>Months</span>
              <select value={fromM} onChange={(e) => setFromM(e.target.value > toM ? toM : e.target.value)} className="px-2 py-1.5 rounded-lg text-sm" style={{ background: "var(--atlas-surface-soft)", border: "1px solid var(--atlas-line)", color: "var(--atlas-ink)" }}>{months.map((mo) => <option key={mo} value={mo}>{shortMonth(mo)}</option>)}</select>
              <span style={{ color: "var(--atlas-ink-faint)" }}>→</span>
              <select value={toM} onChange={(e) => setToM(e.target.value < fromM ? fromM : e.target.value)} className="px-2 py-1.5 rounded-lg text-sm" style={{ background: "var(--atlas-surface-soft)", border: "1px solid var(--atlas-line)", color: "var(--atlas-ink)" }}>{months.map((mo) => <option key={mo} value={mo}>{shortMonth(mo)}</option>)}</select>
              <button onClick={() => { setFromM(months[0]); setToM(months[months.length - 1]); }} className="px-2 py-1.5 rounded-lg text-xs" style={{ background: "var(--atlas-surface-soft)", border: "1px solid var(--atlas-line)", color: "var(--atlas-ink-muted)", cursor: "pointer" }}>All</button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold" style={{ color: "var(--atlas-ink-muted)" }}>Channels</span>
            <button onClick={() => setChSel(new Set())} className="px-2.5 py-1 rounded-full text-xs font-medium" style={{ border: "1px solid " + (chSel.size === 0 ? "var(--atlas-accent)" : "var(--atlas-line)"), background: chSel.size === 0 ? "var(--atlas-accent)" : "var(--atlas-surface)", color: chSel.size === 0 ? "#fff" : "var(--atlas-ink-muted)", cursor: "pointer" }}>All channels</button>
            {channels.map((c) => {
              const active = chOn(c);
              return <button key={c} title={active ? `${c} — click to toggle` : `Add ${c}`}
                onClick={() => setChSel((prev) => {
                  if (prev.size === 0) return new Set([c]);              // from "All" → focus just this channel
                  const next = new Set(prev);
                  if (next.has(c)) next.delete(c); else next.add(c);      // toggle in multi-select
                  if (next.size === 0 || next.size === channels.length) return new Set(); // empty or full ⇒ All
                  return next;
                })}
                className="px-2.5 py-1 rounded-full text-xs inline-flex items-center gap-1.5" style={{ border: "1px solid " + (active ? chColor[c] : "var(--atlas-line)"), background: active ? `color-mix(in srgb, ${chColor[c]} 16%, transparent)` : "var(--atlas-surface)", color: active ? "var(--atlas-ink)" : "var(--atlas-ink-faint)", cursor: "pointer", fontWeight: active ? 600 : 400 }}>
                <span style={{ width: 13, height: 13, borderRadius: 4, display: "inline-flex", alignItems: "center", justifyContent: "center", background: active ? chColor[c] : "transparent", border: "1.5px solid " + (active ? chColor[c] : "var(--atlas-line)"), color: "#fff", fontSize: 9, lineHeight: 1 }}>{active ? "✓" : ""}</span>{c}</button>;
            })}
            {chSel.size > 0 && <span className="text-xs" style={{ color: "var(--atlas-ink-faint)" }}>{chSel.size} selected — click more to add</span>}
          </div>
        </div>

        {/* KPIs */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { l: `Total ${METRICS.find((x) => x.k === m)!.label}`, v: fmtMetric(m, kpi.val), s: kpi.growth == null ? rangeLabel : <span style={{ color: kpi.growth >= 0 ? "var(--atlas-green)" : "var(--atlas-red)" }}>{kpi.growth >= 0 ? "▲" : "▼"} {pct(Math.abs(kpi.growth))} vs prev {kpi.prevLabel}</span> },
            { l: "Avg / month", v: fmtMetric(m, kpi.avg), s: `${rangeMonths.length} months` },
            { l: "Top channel", v: kpi.topCh, s: `${pct(kpi.topShare)} of ${METRICS.find((x) => x.k === m)!.label}` },
            { l: "NTO / GTO realization", v: kpi.real == null ? "—" : pct(kpi.real), s: `${fmtCr(kpi.nto)} / ${fmtCr(kpi.gto)}` },
          ].map((k) => <div key={k.l} className="p-4 rounded-xl" style={surface}><div className="text-2xl font-bold truncate" style={{ color: "var(--atlas-ink)" }}>{k.v}</div><div className="text-xs mt-1" style={{ color: "var(--atlas-ink-muted)" }}>{k.l}</div><div className="text-[11px] mt-1.5">{k.s}</div></div>)}
        </div>

        {/* SKU explorer */}
        <Card title={<>SKU explorer {sub(`(${unit} · all months · all channels · ${lens === "single" ? "singles" : "combos"})`)}</>}>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <input list="skuOptions" value={skuSel} onChange={(e) => setSkuSel(e.target.value)} placeholder={`Type a Master SKU… (e.g. ${skuList[0] ?? ""})`} className="px-3 py-1.5 rounded-lg text-sm" style={{ background: "var(--atlas-surface-soft)", border: "1px solid var(--atlas-line)", color: "var(--atlas-ink)", minWidth: 260 }} />
            {skuSel && !skuList.includes(skuSel) && <button onClick={() => setSkuSel("")} className="px-2 py-1.5 rounded-lg text-xs" style={{ ...surface, cursor: "pointer", color: "var(--atlas-ink-muted)" }}>clear</button>}
            <datalist id="skuOptions">{skuList.map((s) => <option key={s} value={s} />)}</datalist>
            <button onClick={() => { const i = skuList.indexOf(sku); setSkuSel(skuList[Math.max(0, i - 1)]); }} className="px-2 py-1.5 rounded-lg text-xs" style={{ ...surface, cursor: "pointer", color: "var(--atlas-ink-muted)" }}>◀ higher</button>
            <button onClick={() => { const i = skuList.indexOf(sku); setSkuSel(skuList[Math.min(skuList.length - 1, i + 1)]); }} className="px-2 py-1.5 rounded-lg text-xs" style={{ ...surface, cursor: "pointer", color: "var(--atlas-ink-muted)" }}>lower ▶</button>
            {sku && <span className="text-xs" style={{ color: "var(--atlas-ink-faint)" }}>rank #{skuList.indexOf(sku) + 1} of {skuList.length} · {skuKpi.cat}</span>}
          </div>
          {sku && skuRows.length > 0 ? (
            <>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
                {[
                  { l: "NTO", v: fmtCr(skuKpi.nto) },
                  { l: "GTO", v: fmtCr(skuKpi.gto) },
                  { l: "Qty", v: fmtQty(skuKpi.qty) },
                  { l: "Top channel", v: skuKpi.top ? `${skuKpi.top.channel}` : "—", s: skuKpi.top && skuKpi.val ? pct(skuKpi.top.value / skuKpi.val) : "" },
                  { l: `Share of ${skuKpi.cat}`, v: pct(skuKpi.catShare), s: `${skuKpi.activeMonths} active months` },
                ].map((k) => <div key={k.l} className="p-3 rounded-xl" style={{ background: "var(--atlas-surface-soft)", border: "1px solid var(--atlas-line)" }}><div className="text-lg font-bold truncate" style={{ color: "var(--atlas-ink)" }}>{k.v}</div><div className="text-[11px] mt-0.5" style={{ color: "var(--atlas-ink-muted)" }}>{k.l}</div>{k.s ? <div className="text-[11px] mt-0.5" style={{ color: "var(--atlas-ink-faint)" }}>{k.s}</div> : null}</div>)}
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <div className="lg:col-span-2">
                  <div className="text-xs font-semibold mb-1" style={{ color: "var(--atlas-ink-muted)" }}>{sku} — {METRICS.find((x) => x.k === m)!.label} by month, stacked by channel</div>
                  <ResponsiveContainer width="100%" height={240}>
                    <AreaChart data={skuTrend} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--atlas-line)" />
                      <XAxis dataKey="label" tick={axis} /><YAxis tick={axis} tickFormatter={fmtY} width={48} />
                      <Tooltip contentStyle={tip} formatter={(v) => fmtMetric(m, Number(v))} />
                      {skuChannels.map((c) => <Area key={c.channel} type="monotone" dataKey={c.channel} stackId="a" stroke={chColor[c.channel]} fill={chColor[c.channel]} fillOpacity={0.7} strokeWidth={0.5} />)}
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
                <div>
                  <div className="text-xs font-semibold mb-1" style={{ color: "var(--atlas-ink-muted)" }}>Channel split</div>
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart layout="vertical" data={[...skuChannels].sort((a, b) => b.value - a.value)} margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
                      <XAxis type="number" tick={axis} tickFormatter={fmtY} /><YAxis type="category" dataKey="channel" tick={{ ...axis, fontSize: 10 }} width={90} />
                      <Tooltip contentStyle={tip} formatter={(v) => fmtMetric(m, Number(v))} />
                      <Bar dataKey="value">{skuChannels.map((c) => <Cell key={c.channel} fill={chColor[c.channel]} />)}</Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </>
          ) : <div className="py-8 text-center text-sm" style={{ color: "var(--atlas-ink-faint)" }}>Pick a SKU to see its trend and channel split.</div>}
        </Card>

        {/* trend + channel share */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2"><Card title={<>{METRICS.find((x) => x.k === m)!.label} trend {sub(`(${unit} · ${activeChannels.length === channels.length ? "all channels" : activeChannels.join(", ")})`)}</>}>
            <ResponsiveContainer width="100%" height={250}>
              <LineChart data={trend} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--atlas-line)" />
                <XAxis dataKey="label" tick={axis} /><YAxis tick={axis} tickFormatter={fmtY} width={48} />
                <Tooltip contentStyle={tip} formatter={(v) => fmtMetric(m, Number(v))} />
                <Line type="monotone" dataKey="value" stroke="var(--atlas-accent)" strokeWidth={2} dot={<RangeDot />} />
              </LineChart>
            </ResponsiveContainer>
          </Card></div>
          <Card title={<>Channel share {sub(`(${unit} · ${rangeLabel})`)}</>}>
            <ResponsiveContainer width="100%" height={250}>
              <PieChart>
                <Pie data={chShare} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={52} outerRadius={92} paddingAngle={1.5}>
                  {chShare.map((d) => <Cell key={d.name} fill={chColor[d.name]} opacity={chOn(d.name) ? 1 : 0.25} />)}
                </Pie>
                <Tooltip contentStyle={tip} formatter={(v) => fmtMetric(m, Number(v))} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
              </PieChart>
            </ResponsiveContainer>
          </Card>
        </div>

        {/* channel trend stacked */}
        <Card title={<>Channel mix by month {sub(`(${unit} · stacked)`)}</>}>
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={chTrend} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--atlas-line)" />
              <XAxis dataKey="label" tick={axis} /><YAxis tick={axis} tickFormatter={fmtY} width={48} />
              <Tooltip contentStyle={tip} formatter={(v) => fmtMetric(m, Number(v))} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {activeChannels.map((ch) => <Area key={ch} type="monotone" dataKey={ch} stackId="a" stroke={chColor[ch]} fill={chColor[ch]} fillOpacity={0.72} strokeWidth={0.5} />)}
            </AreaChart>
          </ResponsiveContainer>
        </Card>

        {/* channel × category matrix */}
        <Card title={<>Channel × Category {sub(`(${unit} · ${rangeLabel}) — colour = intensity`)}</>}>
          <div className="overflow-x-auto">
            <table className="text-sm" style={{ borderCollapse: "separate", borderSpacing: 0, minWidth: "100%" }}>
              <thead>
                <tr style={{ color: "var(--atlas-ink-muted)" }}>
                  <th className="text-left py-2 pr-3 sticky left-0" style={{ background: "var(--atlas-surface)", fontWeight: 600 }}>Category</th>
                  {activeChannels.map((c) => <th key={c} className="px-2 py-2 text-right font-medium whitespace-nowrap"><span className="inline-flex items-center gap-1"><span style={{ width: 8, height: 8, borderRadius: 9, background: chColor[c], display: "inline-block" }} />{c}</span></th>)}
                  <th className="px-2 py-2 text-right font-semibold" style={{ color: "var(--atlas-ink)" }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {matrix.catList.map((cat) => {
                  const rowTot = matrix.cats.get(cat) ?? 0;
                  return (
                    <tr key={cat} style={{ borderTop: "1px solid var(--atlas-line)" }}>
                      <td className="py-1.5 pr-3 sticky left-0 whitespace-nowrap" style={{ background: "var(--atlas-surface)", color: "var(--atlas-ink)" }}>{cat}</td>
                      {activeChannels.map((c) => { const v = matrix.grid.get(cat)?.get(c) ?? 0; const h = heat(v); return <td key={c} className="px-2 py-1.5 text-right font-mono" style={{ background: h.bg, color: h.fg, fontVariantNumeric: "tabular-nums" }}>{v ? fmtY(v) : ""}</td>; })}
                      <td className="px-2 py-1.5 text-right font-mono font-semibold" style={{ color: "var(--atlas-ink)" }}>{fmtY(rowTot)}</td>
                    </tr>
                  );
                })}
                <tr style={{ borderTop: "2px solid var(--atlas-line)" }}>
                  <td className="py-2 pr-3 sticky left-0 font-semibold" style={{ background: "var(--atlas-surface)", color: "var(--atlas-ink)" }}>Total</td>
                  {activeChannels.map((c) => <td key={c} className="px-2 py-2 text-right font-mono font-semibold" style={{ color: "var(--atlas-ink)" }}>{fmtY(matrix.chTot.get(c) ?? 0)}</td>)}
                  <td className="px-2 py-2 text-right font-mono font-bold" style={{ color: "var(--atlas-ink)" }}>{fmtY(matrix.grand)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>

        {/* category + top SKUs */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card title={<>By category {sub(`(${unit} · ${rangeLabel})`)}</>}>
            <ResponsiveContainer width="100%" height={Math.max(200, byCategory.length * 24)}>
              <BarChart layout="vertical" data={byCategory} margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
                <XAxis type="number" tick={axis} tickFormatter={fmtY} /><YAxis type="category" dataKey="category" tick={{ ...axis, fontSize: 10 }} width={110} />
                <Tooltip contentStyle={tip} formatter={(v) => fmtMetric(m, Number(v))} />
                <Bar dataKey="value">{byCategory.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}</Bar>
              </BarChart>
            </ResponsiveContainer>
          </Card>
          <Card title={<>Top 15 {lens === "single" ? "SKUs" : "combos"} {sub(`(${unit} · ${rangeLabel} · click to explore)`)}</>}>
            <ResponsiveContainer width="100%" height={Math.max(200, topSkus.length * 24)}>
              <BarChart layout="vertical" data={topSkus} margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
                <XAxis type="number" tick={axis} tickFormatter={fmtY} /><YAxis type="category" dataKey="sku" tick={{ ...axis, fontSize: 10 }} width={150} />
                <Tooltip contentStyle={tip} formatter={(v) => fmtMetric(m, Number(v))} />
                <Bar dataKey="value" cursor="pointer" onClick={(d) => { const s = (d as unknown as { sku?: string })?.sku; if (s) setSkuSel(s); }}>{topSkus.map((s) => <Cell key={s.sku} fill={s.sku === sku ? "var(--atlas-green)" : "var(--atlas-accent)"} />)}</Bar>
              </BarChart>
            </ResponsiveContainer>
          </Card>
        </div>

        {/* channel performance table */}
        <Card title={<>Channel performance {sub(`(${unit} · ${rangeLabel})`)}</>}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr style={{ color: "var(--atlas-ink-muted)" }}>
                <th className="text-left py-2 font-medium">Channel</th>
                <th className="text-right py-2 font-medium">{METRICS.find((x) => x.k === m)!.label}</th>
                <th className="text-right py-2 font-medium">Share</th>
                <th className="text-right py-2 font-medium">Avg/mo</th>
                <th className="text-right py-2 font-medium">Realization</th>
                <th className="text-right py-2 font-medium">1st→2nd half</th>
                <th className="text-right py-2 font-medium">SKUs</th>
              </tr></thead>
              <tbody>
                {chPerf.map((r) => (
                  <tr key={r.channel} style={{ borderTop: "1px solid var(--atlas-line)", opacity: chOn(r.channel) ? 1 : 0.4 }}>
                    <td className="py-2" style={{ color: "var(--atlas-ink)" }}><span className="inline-flex items-center gap-1.5"><span style={{ width: 9, height: 9, borderRadius: 9, background: chColor[r.channel] }} />{r.channel}</span></td>
                    <td className="py-2 text-right font-mono" style={{ color: "var(--atlas-ink)" }}>{fmtMetric(m, r.val)}</td>
                    <td className="py-2 text-right font-mono" style={{ color: "var(--atlas-ink-soft)" }}>{pct(r.share)}</td>
                    <td className="py-2 text-right font-mono" style={{ color: "var(--atlas-ink-soft)" }}>{fmtMetric(m, r.avg)}</td>
                    <td className="py-2 text-right font-mono" style={{ color: "var(--atlas-ink-soft)" }}>{r.real == null ? "—" : pct(r.real)}</td>
                    <td className="py-2 text-right font-mono font-semibold" style={{ color: r.growth == null ? "var(--atlas-ink-faint)" : r.growth >= 0 ? "var(--atlas-green)" : "var(--atlas-red)" }}>{r.growth == null ? "—" : `${r.growth >= 0 ? "+" : ""}${pct(r.growth)}`}</td>
                    <td className="py-2 text-right font-mono" style={{ color: "var(--atlas-ink-soft)" }}>{r.skus}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {/* YoY */}
        {yoy.length > 0 && fyYears.length > 1 && (
          <Card title={<>Year-on-year — same month, {fyYears[0]} vs {fyYears[fyYears.length - 1]} {sub(`(${unit}${activeChannels.length === channels.length ? "" : " · " + activeChannels.length + " channels"})`)}</>}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr style={{ color: "var(--atlas-ink-muted)" }}>
                  <th className="text-left py-2 font-medium">Month</th>
                  <th className="text-right py-2 font-medium">{fyYears[0]}</th>
                  <th className="text-right py-2 font-medium">{fyYears[fyYears.length - 1]}</th>
                  <th className="text-right py-2 font-medium">Growth</th>
                </tr></thead>
                <tbody>
                  {yoy.map((r) => (
                    <tr key={r.mon} style={{ borderTop: "1px solid var(--atlas-line)" }}>
                      <td className="py-2" style={{ color: "var(--atlas-ink)" }}>{r.mon}</td>
                      <td className="py-2 text-right font-mono" style={{ color: "var(--atlas-ink-soft)" }}>{fmtMetric(m, r.a)}</td>
                      <td className="py-2 text-right font-mono" style={{ color: "var(--atlas-ink-soft)" }}>{fmtMetric(m, r.b)}</td>
                      <td className="py-2 text-right font-mono font-semibold" style={{ color: r.g == null ? "var(--atlas-ink-faint)" : r.g >= 0 ? "var(--atlas-green)" : "var(--atlas-red)" }}>{r.g == null ? "—" : `${r.g >= 0 ? "+" : ""}${pct(r.g)}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        <p style={{ fontSize: 11, color: "var(--atlas-ink-faint)", lineHeight: 1.6 }}>
          <b style={{ color: "var(--atlas-ink-muted)" }}>Lens.</b> <b>Singles</b> = every combo exploded to component SKUs + direct singles (canonical sales-by-SKU). <b>Combos</b> = the base working — direct singles + combos at the combo level. NTO totals match across lenses; Qty differs (combos expand into units). Growth KPI compares the selected window to the immediately preceding window of equal length. Source: reconciled Sales workbook.
        </p>
      </div>
    </AppShell>
  );
}
