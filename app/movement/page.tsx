"use client";
// ============================================================================
// FORECAST vs MOVEMENT — daily FG-movement tracker
//
//   A file teams open every day to see how much of the monthly forecast has
//   physically moved out of the mother node (YB FG Warehouse), and when the
//   pickup happened. Movement leaves two ways: STN (transfer to CFA/3PL) and
//   SO (direct dispatch). Shipsheet = last-day POs not yet closed into SO.
//
//   Views:  Overall (Ops) · Daily (day-on-day pickup) · Channel · Qcom.
//
//   Data: JSON snapshot at /data/movement-latest.json (uploaded) → falls back
//   to the bundled /data/movement-jun26.json. Regenerate via the Upload page.
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from "react";
import AppShell from "@/app/components/AppShell";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer,
  CartesianGrid, Cell, LabelList, ComposedChart, Line,
} from "recharts";
import Link from "next/link";
import {
  Snapshot, OverallRow, ChannelRow, QcomRow, DailyRow,
  fmtQty, fmtInt, fmtPct, pctOf, achColor, achLabel, covColor, actionFor,
  serviceBucket, Bucket, BUCKET_META, CH_ORDER, PLAT_ORDER, palette, useTheme, downloadCsv,
} from "./lib";
import {
  surface, mono, chartTip, axisTick, Kpi, Panel, Badge, PctBar, Th, Sort,
  TableScroll, Td, NumTd, sortRows,
} from "./ui";
import { ReadmeView } from "./readme";

type View = "overall" | "daily" | "channel" | "qcom" | "readme";
type Pal = ReturnType<typeof palette>;

export default function MovementPage() {
  const theme = useTheme();
  const pal = useMemo(() => palette(theme), [theme]);

  const [data, setData] = useState<Snapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [months, setMonths] = useState<{ monthKey: string; month: string; publishedAt: string | null }[]>([]);
  const [monthKey, setMonthKey] = useState<string>("");
  const [view, setView] = useState<View>("overall");
  const [category, setCategory] = useState("");
  const [search, setSearch] = useState("");
  const [channel, setChannel] = useState("MT");
  const [platform, setPlatform] = useState("");
  const [sort, setSort] = useState<Sort>({ k: "forecast", dir: -1 });
  const [exMode, setExMode] = useState<"over" | "under">("under");
  const [rca, setRca] = useState<string | null>(null);

  // available months
  useEffect(() => {
    fetch("/api/movement-snapshot?list=1").then((r) => r.json())
      .then((d: { months?: typeof months; latest?: string }) => {
        if (d.months?.length) { setMonths(d.months); setMonthKey((mk) => mk || d.latest || d.months![0].monthKey); }
        else setMonthKey("2026-06");
      }).catch(() => setMonthKey("2026-06"));
  }, []);

  // load the selected month (fall back to the bundled June file)
  useEffect(() => {
    if (!monthKey) return;
    let live = true;
    (async () => {
      setData(null); setErr(null);
      try { const r = await fetch(`/api/movement-snapshot?month=${monthKey}`, { cache: "no-store" }); if (r.ok && live) { setData(await r.json()); return; } } catch { /* fall through */ }
      try { const r = await fetch("/data/movement-jun26.json", { cache: "no-store" }); if (r.ok && live) { setData(await r.json()); return; } } catch { /* fall through */ }
      if (live) setErr("Could not load this month's snapshot. Upload the workbook on the Upload page.");
    })();
    return () => { live = false; };
  }, [monthKey]);

  const matches = useCallback(
    (r: { category: string; masterSku: string; fgCode: string; productName: string }) => {
      if (category && r.category !== category) return false;
      if (!search) return true;
      const q = search.toLowerCase();
      return r.masterSku.toLowerCase().includes(q) || r.fgCode.toLowerCase().includes(q) || r.productName.toLowerCase().includes(q);
    },
    [category, search]
  );

  // ── Overall ────────────────────────────────────────────────────────────────
  const overall = useMemo(() => (data?.overall ?? []).filter(matches), [data, matches]);
  const oKpi = useMemo(() => {
    const s = overall.reduce((a, r) => ({ f: a.f + r.forecast, stn: a.stn + r.stn, so: a.so + r.so, sup: a.sup + r.totalSupplied }), { f: 0, stn: 0, so: 0, sup: 0 });
    return { ...s, moved: s.stn + s.so, remaining: s.f - s.sup, attn: pctOf(s.sup, s.f) };
  }, [overall]);

  const catRollup = useMemo(() => {
    const m = new Map<string, { category: string; skus: number; forecast: number; supplied: number }>();
    for (const r of overall) {
      const e = m.get(r.category) ?? { category: r.category, skus: 0, forecast: 0, supplied: 0 };
      e.skus += 1; e.forecast += r.forecast; e.supplied += r.totalSupplied; m.set(r.category, e);
    }
    return [...m.values()].map((e) => ({ ...e, fill: pctOf(e.supplied, e.forecast), gap: e.supplied - e.forecast })).sort((a, b) => b.forecast - a.forecast);
  }, [overall]);

  const spread = useMemo(() => {
    const m = new Map<Bucket, { skus: number; forecast: number; supplied: number }>();
    (["zero", "under", "ontarget", "over", "unforecast"] as Bucket[]).forEach((b) => m.set(b, { skus: 0, forecast: 0, supplied: 0 }));
    for (const r of overall) { const e = m.get(serviceBucket(r.forecast, r.totalSupplied))!; e.skus += 1; e.forecast += r.forecast; e.supplied += r.totalSupplied; }
    return m;
  }, [overall]);

  const overallRows = useMemo(() => overall.map((r) => ({
    ...r, fill: pctOf(r.totalSupplied, r.forecast), gap: r.totalSupplied - r.forecast, action: actionFor(r.forecast, r.totalSupplied, r.shipsheet),
  })), [overall]);
  const sortedOverall = useMemo(() => sortRows(overallRows as unknown as Record<string, unknown>[], sort) as unknown as typeof overallRows, [overallRows, sort]);

  const exceptions = useMemo(() => {
    const scored = overallRows.filter((r) => r.forecast > 0);
    return { over: [...scored].filter((r) => r.gap > 0).sort((a, b) => b.gap - a.gap).slice(0, 10),
             under: [...scored].filter((r) => r.gap < 0).sort((a, b) => a.gap - b.gap).slice(0, 10) };
  }, [overallRows]);
  const exList = exMode === "over" ? exceptions.over : exceptions.under;

  // ── Channel ──────────────────────────────────────────────────────────────────
  const channelAll = useMemo(() => (data?.channelwise ?? []).filter(matches), [data, matches]);
  const chRollup = useMemo(() => {
    const m = new Map<string, { channel: string; forecast: number; stn: number; so: number; ship: number; supplied: number }>();
    for (const r of channelAll) {
      const e = m.get(r.channel) ?? { channel: r.channel, forecast: 0, stn: 0, so: 0, ship: 0, supplied: 0 };
      e.forecast += r.forecast; e.stn += r.stn; e.so += r.so; e.ship += r.shipsheet; e.supplied += r.totalSupplied; m.set(r.channel, e);
    }
    return CH_ORDER.filter((c) => m.has(c)).map((c) => {
      const e = m.get(c)!; return { ...e, closed: e.stn + e.so, fill: pctOf(e.supplied, e.forecast), remaining: e.forecast - e.supplied, action: actionFor(e.forecast, e.supplied, e.ship) };
    });
  }, [channelAll]);

  const chanCat = useMemo(() => {
    const cats = new Map<string, Map<string, { f: number; s: number }>>();
    for (const r of channelAll) {
      if (!cats.has(r.category)) cats.set(r.category, new Map());
      const row = cats.get(r.category)!; const cell = row.get(r.channel) ?? { f: 0, s: 0 };
      cell.f += r.forecast; cell.s += r.totalSupplied; row.set(r.channel, cell);
    }
    return [...cats.entries()].map(([category, row]) => {
      let tf = 0, ts = 0; const cells: Record<string, { f: number; s: number; fill: number | null }> = {};
      for (const ch of CH_ORDER) { const c = row.get(ch) ?? { f: 0, s: 0 }; cells[ch] = { ...c, fill: pctOf(c.s, c.f) }; tf += c.f; ts += c.s; }
      return { category, cells, tf, ts, fill: pctOf(ts, tf) };
    }).filter((r) => r.tf > 0).sort((a, b) => b.tf - a.tf);
  }, [channelAll]);

  const channelRows = useMemo(() => {
    const rows = channelAll.filter((r) => r.channel === channel).map((r) => ({ ...r, fill: pctOf(r.totalSupplied, r.forecast), gap: r.totalSupplied - r.forecast, action: actionFor(r.forecast, r.totalSupplied, r.shipsheet) }));
    return sortRows(rows as unknown as Record<string, unknown>[], sort) as unknown as typeof rows;
  }, [channelAll, channel, sort]);

  // ── Qcom ─────────────────────────────────────────────────────────────────────
  const qcomAll = useMemo(() => (data?.qcom ?? []).filter(matches), [data, matches]);
  const platRollup = useMemo(() => {
    const m = new Map<string, { platform: string; forecast: number; orders: number; sales: number }>();
    for (const r of qcomAll) { const e = m.get(r.platform) ?? { platform: r.platform, forecast: 0, orders: 0, sales: 0 }; e.forecast += r.forecast; e.orders += r.mtdOrders; e.sales += r.mtdSales; m.set(r.platform, e); }
    return PLAT_ORDER.filter((p) => m.has(p)).map((p) => {
      const e = m.get(p)!; const orderPct = pctOf(e.orders, e.forecast), salesPct = pctOf(e.sales, e.forecast), conv = pctOf(e.sales, e.orders); const stock = e.orders - e.sales;
      let action = { label: "On plan", color: "var(--atlas-green)" };
      if ((orderPct ?? 0) >= 1.1) action = { label: "Hold / review", color: "var(--atlas-blue)" };
      else if ((conv ?? 1) < 0.85) action = { label: "Sell-through", color: "var(--atlas-amber-warn, #D97706)" };
      else if ((orderPct ?? 1) < 0.95) action = { label: "Close order gap", color: "var(--atlas-red)" };
      return { ...e, orderPct, salesPct, conv, stock, action };
    });
  }, [qcomAll]);
  const qKpi = useMemo(() => {
    const s = qcomAll.reduce((a, r) => ({ f: a.f + r.forecast, o: a.o + r.mtdOrders, sa: a.sa + r.mtdSales }), { f: 0, o: 0, sa: 0 });
    return { ...s, orderPct: pctOf(s.o, s.f), salesPct: pctOf(s.sa, s.f), conv: pctOf(s.sa, s.o), stock: s.o - s.sa };
  }, [qcomAll]);
  const qcomRows = useMemo(() => {
    const rows = qcomAll.filter((r) => !platform || r.platform === platform).map((r) => ({ ...r, orderPct: pctOf(r.mtdOrders, r.forecast), salesPct: pctOf(r.mtdSales, r.forecast), conv: pctOf(r.mtdSales, r.mtdOrders), stock: r.mtdOrders - r.mtdSales, gap: r.mtdSales - r.forecast }));
    return sortRows(rows as unknown as Record<string, unknown>[], sort) as unknown as typeof rows;
  }, [qcomAll, platform, sort]);
  const qWidest = useMemo(() => {
    const scored = qcomAll.filter((r) => r.forecast > 0).map((r) => ({ ...r, gap: r.mtdSales - r.forecast, salesPct: pctOf(r.mtdSales, r.forecast) }));
    return [...scored].sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap)).slice(0, 12);
  }, [qcomAll]);

  // RCA — channel breakdown for a drilled SKU.
  const rcaData = useMemo(() => {
    if (!rca || !data) return null;
    const rows = data.channelwise.filter((r) => r.masterSku === rca);
    if (!rows.length) return null;
    const head = data.overall.find((r) => r.masterSku === rca);
    const forecast = rows.reduce((a, r) => a + r.forecast, 0);
    const supplied = rows.reduce((a, r) => a + r.totalSupplied, 0);
    const byChannel = CH_ORDER.map((ch) => rows.find((r) => r.channel === ch)).filter((r): r is ChannelRow => !!r)
      .map((r) => ({ ...r, fill: pctOf(r.totalSupplied, r.forecast), gap: r.totalSupplied - r.forecast })).sort((a, b) => b.gap - a.gap);
    const gap = supplied - forecast;
    const drivers = byChannel.filter((r) => (gap >= 0 ? r.gap > 0 : r.gap < 0)).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap)).slice(0, 3);
    return { sku: rca, productName: head?.productName || rows[0].productName || rca, category: head?.category || rows[0].category, forecast, supplied, gap, fill: pctOf(supplied, forecast), byChannel, drivers, toCentral: head?.toCentral ?? 0, toQuarantine: head?.toQuarantine ?? 0 };
  }, [rca, data]);

  if (err) return <AppShell><div className="p-8 space-y-3"><div className="font-mono text-sm" style={{ color: "var(--atlas-red)" }}>{err}</div><Link href="/movement/upload" className="text-sm" style={{ color: "var(--atlas-accent)" }}>→ Go to Upload</Link></div></AppShell>;
  if (!data) return <AppShell><div className="flex items-center justify-center min-h-[60vh]"><p className="text-atlas-ink-muted font-mono text-sm">Loading movement data…</p></div></AppShell>;

  const TABS: { k: View; label: string; note: string }[] = [
    { k: "overall", label: "Overall", note: "Ops" },
    { k: "daily", label: "Daily Movement", note: "day-on-day pickup" },
    { k: "channel", label: "Channel", note: "channel owners" },
    { k: "qcom", label: "Qcom", note: "orders vs sell-out" },
    { k: "readme", label: "Readme", note: "how it works" },
  ];

  return (
    <AppShell>
      <div className="space-y-5">
        {/* Title — month selector prominent, top-left */}
        <div className="flex flex-wrap items-end justify-between gap-3" style={{ maxWidth: "100%" }}>
          <div style={{ minWidth: 0 }}>
            <div className="flex items-center gap-2 flex-wrap" style={{ marginBottom: 4 }}>
              {months.length > 1 ? (
                <select value={monthKey} onChange={(e) => setMonthKey(e.target.value)} title="Select month"
                  style={{ ...surface, fontSize: 15, fontWeight: 700, color: "var(--atlas-accent)", cursor: "pointer", padding: "6px 12px", borderRadius: 10 }}>
                  {months.map((m) => <option key={m.monthKey} value={m.monthKey}>{m.month}</option>)}
                </select>
              ) : (
                <span className="px-3 py-1.5 rounded-lg" style={{ ...surface, fontSize: 14, fontWeight: 700, color: "var(--atlas-accent)" }}>{data.meta.month}</span>
              )}
              <span className={mono} style={{ fontSize: "10px", letterSpacing: "0.14em", color: "var(--atlas-ink-muted)" }}>Sproutlife Foods · Yogabars · Supply Chain</span>
            </div>
            <h1 className="font-display" style={{ fontSize: "28px", fontWeight: 400, color: "var(--atlas-ink)" }}>Forecast <span style={{ color: "var(--atlas-accent)" }}>vs Movement</span></h1>
            <div style={{ fontSize: 12, color: "var(--atlas-ink-muted)", marginTop: 2 }}>{data.meta.node} · how much of the monthly forecast has moved out</div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="px-2.5 py-1 rounded-full" style={{ ...surface, fontSize: 11, color: "var(--atlas-ink-soft)" }}>Basis {data.meta.forecastBasis}</span>
            {data.meta.updatedOnDay != null && <span className="px-2.5 py-1 rounded-full" style={{ background: "var(--atlas-green-bg)", border: "1px solid var(--atlas-line)", fontSize: 11, color: "var(--atlas-green)" }}>● day {data.meta.updatedOnDay}/{data.meta.daysInMonth}</span>}
            <Link href="/movement/compute" className="px-3 py-1 rounded-full" style={{ background: "var(--atlas-accent)", fontSize: 11, color: "#fff", textDecoration: "none", whiteSpace: "nowrap" }}>↑ Upload &amp; compute</Link>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 flex-wrap" style={{ borderBottom: "1px solid var(--atlas-line)" }}>
          {TABS.map((t) => (
            <button key={t.k} onClick={() => { setView(t.k); setSort({ k: "forecast", dir: -1 }); }} className={`${mono} px-4 py-2`}
              style={{ fontSize: "10.5px", letterSpacing: "0.08em", border: "none", background: "transparent", cursor: "pointer", borderBottom: view === t.k ? "2px solid var(--atlas-accent)" : "2px solid transparent", color: view === t.k ? "var(--atlas-accent)" : "var(--atlas-ink-muted)" }}>
              {t.label} <span style={{ opacity: 0.6, fontSize: 9 }}>· {t.note}</span>
            </button>
          ))}
        </div>

        {/* Filter bar (not on Daily or Readme — they have their own scope) */}
        {view !== "daily" && view !== "readme" && (
          <div className="flex flex-wrap items-center gap-3 p-3 rounded-xl" style={surface}>
            <select value={category} onChange={(e) => setCategory(e.target.value)} className="px-3 py-1.5 rounded-lg text-sm" style={{ background: "var(--atlas-surface-soft)", border: "1px solid var(--atlas-line)", color: "var(--atlas-ink)" }}>
              <option value="">All categories</option>
              {data.meta.categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            {view === "channel" && (
              <div className="flex items-center rounded-full overflow-hidden flex-wrap" style={{ border: "1px solid var(--atlas-line)" }}>
                {chRollup.map((c) => <button key={c.channel} onClick={() => setChannel(c.channel)} style={{ padding: "5px 12px", border: "none", cursor: "pointer", fontSize: 11, fontWeight: 600, background: channel === c.channel ? pal.chColor(c.channel) : "var(--atlas-surface)", color: channel === c.channel ? "#fff" : "var(--atlas-ink-muted)" }}>{c.channel}</button>)}
              </div>
            )}
            {view === "qcom" && (
              <div className="flex items-center rounded-full overflow-hidden flex-wrap" style={{ border: "1px solid var(--atlas-line)" }}>
                {["", ...data.meta.platforms].map((p) => <button key={p || "all"} onClick={() => setPlatform(p)} style={{ padding: "5px 12px", border: "none", cursor: "pointer", fontSize: 11, fontWeight: 600, background: platform === p ? (p ? pal.platColor(p) : "var(--atlas-accent)") : "var(--atlas-surface)", color: platform === p ? "#fff" : "var(--atlas-ink-muted)" }}>{p || "All"}</button>)}
              </div>
            )}
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search Master SKU, FG code or product…" className="px-3 py-1.5 rounded-lg text-sm flex-1 min-w-[160px]" style={{ background: "var(--atlas-surface-soft)", border: "1px solid var(--atlas-line)", color: "var(--atlas-ink)", maxWidth: 300 }} />
            <div className="flex-1" />
            <ExportButton view={view} channel={channel} overall={sortedOverall} channelRows={channelRows} qcomRows={qcomRows} />
          </div>
        )}

        {view === "overall" && <OverallView {...{ overall, oKpi, meta: data.meta, catRollup, spread, sortedOverall, exList, exMode, setExMode, sort, setSort, pal, setRca }} />}
        {view === "daily" && <DailyView rawDaily={data.daily} dailyChannel={data.dailyChannel} dailyInternal={data.dailyInternal} dailySkuChannel={data.dailySkuChannel} overallList={data.overall}
          channels={data.meta.channels.filter((c) => CH_ORDER.includes(c))} forecastTotal={data.meta.forecastV7Total}
          authMoved={oKpi.sup} authRemaining={oKpi.remaining} daysElapsed={data.meta.daysElapsed} pal={pal} />}
        {view === "channel" && <ChannelView {...{ chRollup, chanCat, channel, setChannel, channelRows, sort, setSort, pal, setRca }} />}
        {view === "qcom" && <QcomView {...{ qKpi, platRollup, qcomRows, qWidest, sort, setSort, pal }} />}
        {view === "readme" && <ReadmeView />}

        {view !== "readme" && <div style={{ fontSize: 11, color: "var(--atlas-ink-faint)", lineHeight: 1.6 }}>
          <b style={{ color: "var(--atlas-ink-muted)" }}>How to read this.</b> Moved = STN (transfers to CFA/3PL) + SO (direct dispatch), ex mother node, against Forecast {data.meta.forecastBasis}. Shipsheet is last-day POs not yet closed into SO (kept separate as open pipeline). Bands: <span style={{ color: "var(--atlas-red)" }}>Urgent &lt;70%</span>, <span style={{ color: "var(--atlas-amber-warn, #D97706)" }}>Pick up 70–90%</span>, <span style={{ color: "var(--atlas-green)" }}>On plan 90–100%</span>, <span style={{ color: "var(--atlas-red)" }}>Alert · over &gt;100%</span> (over-supply burns downstream working capital). Source: {data.meta.source}.
        </div>}
      </div>

      {rcaData && <RcaModal d={rcaData} pal={pal} onClose={() => setRca(null)} />}
    </AppShell>
  );
}

type OverRow = OverallRow & { fill: number | null; gap: number; action: { label: string; color: string } };

// ════════════════════════ OVERALL ════════════════════════
function OverallView({ overall, oKpi, meta, catRollup, spread, sortedOverall, exList, exMode, setExMode, sort, setSort, pal, setRca }: {
  overall: OverallRow[]; oKpi: { f: number; stn: number; so: number; sup: number; moved: number; remaining: number; attn: number | null };
  meta: Snapshot["meta"]; catRollup: { category: string; skus: number; forecast: number; supplied: number; fill: number | null; gap: number }[];
  spread: Map<Bucket, { skus: number; forecast: number; supplied: number }>;
  sortedOverall: OverRow[]; exList: OverRow[]; exMode: "over" | "under"; setExMode: (m: "over" | "under") => void; sort: Sort; setSort: (s: Sort) => void; pal: Pal; setRca: (s: string) => void;
}) {
  const maxF = Math.max(1, ...[...spread.values()].map((v) => v.forecast));
  const perDay = meta.daysElapsed ? oKpi.moved / meta.daysElapsed : 0;
  // internal transfers respect the current filter (summed from the visible SKUs)
  const oInternal = { central: overall.reduce((a, r) => a + (r.toCentral ?? 0), 0), quarantine: overall.reduce((a, r) => a + (r.toQuarantine ?? 0), 0) };
  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        <Kpi label="Forecast" value={fmtQty(oKpi.f)} sub={`${overall.length} SKUs · V7`} />
        <Kpi label="Moved (MTD)" value={fmtQty(oKpi.moved)} sub={`STN ${fmtQty(oKpi.stn)} · SO ${fmtQty(oKpi.so)}`} accent={pal.sup.so} />
        <Kpi label="% of forecast moved" value={fmtPct(oKpi.attn, 1)} sub={achLabel(oKpi.attn)} color={achColor(oKpi.attn)} accent={achColor(oKpi.attn)} />
        <Kpi label="Remaining" value={fmtQty(oKpi.remaining)} sub={oKpi.remaining > 0 ? "still to pick up" : "over plan"} color={oKpi.remaining > 0 ? "var(--atlas-red)" : "var(--atlas-green)"} />
        <Kpi label="Open pipeline" value={fmtQty(meta.pipelineUnits)} sub="shipsheet not yet closed" accent={pal.sup.ship} />
        <Kpi label="Avg / day" value={fmtQty(perDay)} sub={`over ${meta.daysElapsed} days`} />
      </div>


      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="The two ways stock leaves the node" note="Scaled to forecast. The grey tail is demand not covered.">
          <PathBar stn={oKpi.stn} so={oKpi.so} forecast={oKpi.f} pal={pal} />
          {(oInternal.central > 0 || oInternal.quarantine > 0) && (
            <div className="mt-3 pt-3" style={{ borderTop: "1px dashed var(--atlas-line)" }}>
              <div className={mono} style={{ fontSize: 9.5, letterSpacing: "0.08em", color: "var(--atlas-ink-muted)", marginBottom: 6 }}>Internal transfers (not counted as movement)</div>
              <div className="flex items-center justify-between" style={{ fontSize: 12.5, marginBottom: 4 }}>
                <span style={{ color: "var(--atlas-ink-soft)" }}>↻ To Central / factory (repacking)</span>
                <span style={{ fontWeight: 600, color: "var(--atlas-ink)", fontVariantNumeric: "tabular-nums" }}>{fmtInt(oInternal.central)}</span>
              </div>
              <div className="flex items-center justify-between" style={{ fontSize: 12.5 }}>
                <span style={{ color: "var(--atlas-ink-soft)" }}>⚠ To Quarantine</span>
                <span style={{ fontWeight: 600, color: "var(--atlas-amber-warn, #D97706)", fontVariantNumeric: "tabular-nums" }}>{fmtInt(oInternal.quarantine)}</span>
              </div>
            </div>
          )}
        </Panel>
        <Panel title="Service-level spread" note={`${overall.length} SKUs by supply against forecast`}>
          <div className="space-y-2">
            {(["zero", "under", "ontarget", "over", "unforecast"] as Bucket[]).map((b) => {
              const v = spread.get(b)!; if (v.skus === 0) return null; const meta2 = BUCKET_META[b];
              return (
                <div key={b}>
                  <div className="flex items-center justify-between" style={{ fontSize: 12, marginBottom: 2 }}>
                    <span style={{ color: "var(--atlas-ink)", fontWeight: 600 }}>{meta2.label}</span>
                    <span style={{ color: "var(--atlas-ink-muted)" }}>{v.skus} SKUs · F {fmtQty(v.forecast)} · moved {fmtQty(v.supplied)}</span>
                  </div>
                  <div style={{ height: 8, borderRadius: 4, background: "var(--atlas-line-soft)", overflow: "hidden" }}><div style={{ width: `${Math.max(1, (v.supplied / maxF) * 100)}%`, height: "100%", background: meta2.color, borderRadius: 4 }} /></div>
                </div>
              );
            })}
          </div>
        </Panel>
      </div>

      {/* Exceptions */}
      <div className="p-4 rounded-xl" style={surface}>
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div className={mono} style={{ fontSize: "10px", letterSpacing: "0.1em", color: "var(--atlas-ink-muted)" }}>{exMode === "over" ? "Moved MORE than forecast" : "Moved LESS than forecast"} — top {exList.length} · click for channel RCA</div>
          <div className="flex items-center rounded-full overflow-hidden" style={{ border: "1px solid var(--atlas-line)" }}>
            {(["under", "over"] as const).map((m) => <button key={m} onClick={() => setExMode(m)} style={{ padding: "5px 14px", border: "none", cursor: "pointer", fontSize: 11, fontWeight: 600, background: exMode === m ? (m === "over" ? "var(--atlas-blue)" : "var(--atlas-red)") : "var(--atlas-surface)", color: exMode === m ? "#fff" : "var(--atlas-ink-muted)" }}>{m === "over" ? "Over" : "Under"}</button>)}
          </div>
        </div>
        {exList.length === 0 ? <div style={{ fontSize: 12, color: "var(--atlas-ink-muted)" }}>None in this filter.</div> : (
          <div className="flex gap-2.5" style={{ overflowX: "auto", paddingBottom: 4 }}>
            {exList.map((r) => (
              <button key={r.masterSku} onClick={() => setRca(r.masterSku)} className="text-left rounded-lg shrink-0" style={{ width: 178, padding: "11px 12px", background: "var(--atlas-surface-soft)", border: "1px solid var(--atlas-line)", cursor: "pointer" }}>
                <div style={{ fontSize: 12, color: "var(--atlas-ink)", lineHeight: 1.25, height: 30, overflow: "hidden" }}>{r.productName || r.masterSku}</div>
                <div className="flex items-baseline justify-between mt-1.5"><span className="font-display" style={{ fontSize: 20, color: achColor(r.fill) }}>{fmtPct(r.fill)}</span><span style={{ fontSize: 11.5, fontWeight: 600, color: r.gap >= 0 ? "var(--atlas-blue)" : "var(--atlas-red)" }}>{r.gap >= 0 ? "+" : ""}{fmtQty(r.gap)}</span></div>
                <div style={{ fontSize: 10, color: "var(--atlas-ink-faint)", marginTop: 3 }}>{r.category} · RCA ›</div>
              </button>
            ))}
          </div>
        )}
      </div>

      <Panel title="Where the month was won and lost" note="Categories ranked by forecast size">
        <TableScroll max="42vh">
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead><tr>{["Category", "SKUs", "Forecast", "Moved", "Gap", "% Moved"].map((h, i) => <th key={h} className={mono} style={{ fontSize: 9.5, letterSpacing: "0.07em", color: "var(--atlas-ink-muted)", textAlign: i === 0 ? "left" : "right", padding: "9px 12px", borderBottom: "1px solid var(--atlas-line)" }}>{h}</th>)}</tr></thead>
            <tbody>
              {catRollup.map((c) => (
                <tr key={c.category} style={{ borderBottom: "1px solid var(--atlas-line-soft)" }}>
                  <Td left><span style={{ color: "var(--atlas-ink)" }}>{c.category}</span></Td><Td muted>{c.skus}</Td><NumTd v={c.forecast} /><NumTd v={c.supplied} />
                  <td style={{ padding: "7px 12px", textAlign: "right", fontVariantNumeric: "tabular-nums", color: c.gap >= 0 ? "var(--atlas-blue)" : "var(--atlas-red)" }}>{c.gap >= 0 ? "+" : ""}{fmtInt(c.gap)}</td>
                  <td style={{ padding: "7px 12px" }}><PctBar p={c.fill} color={achColor(c.fill)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </Panel>

      <div className="rounded-xl overflow-hidden" style={surface}>
        <TableScroll>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead><tr>
              <Th label="Product" k="productName" sort={sort} setSort={setSort} align="left" />
              <Th label="Category" k="category" sort={sort} setSort={setSort} align="left" />
              <Th label="Forecast" k="forecast" sort={sort} setSort={setSort} />
              <Th label="STN" k="stn" sort={sort} setSort={setSort} />
              <Th label="SO" k="so" sort={sort} setSort={setSort} />
              <Th label="Moved" k="totalSupplied" sort={sort} setSort={setSort} />
              <Th label="Gap" k="gap" sort={sort} setSort={setSort} />
              <Th label="% Moved" k="fill" sort={sort} setSort={setSort} w={120} />
              <Th label="Action" k="fill" sort={sort} setSort={setSort} align="left" />
            </tr></thead>
            <tbody>
              {sortedOverall.map((r, i) => (
                <tr key={r.masterSku + i} onClick={() => setRca(r.masterSku)} className="movement-row" style={{ borderBottom: "1px solid var(--atlas-line-soft)", cursor: "pointer" }}>
                  <Td left><span style={{ color: "var(--atlas-ink)" }}>{r.productName || r.masterSku}</span><div style={{ fontSize: 10.5, color: "var(--atlas-ink-faint)" }}>{r.masterSku} · RCA ›</div></Td>
                  <Td left muted>{r.category}</Td>
                  <NumTd v={r.forecast} /><NumTd v={r.stn} color={pal.sup.stn} /><NumTd v={r.so} color={pal.sup.so} /><NumTd v={r.totalSupplied} strong />
                  <td style={{ padding: "7px 12px", textAlign: "right", fontVariantNumeric: "tabular-nums", color: r.gap >= 0 ? "var(--atlas-blue)" : "var(--atlas-red)" }}>{r.gap >= 0 ? "+" : ""}{fmtInt(r.gap)}</td>
                  <td style={{ padding: "7px 12px" }}><PctBar p={r.fill} color={achColor(r.fill)} /></td>
                  <td style={{ padding: "7px 12px" }}><Badge label={r.action.label} color={r.action.color} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </div>
    </>
  );
}

function PathBar({ stn, so, forecast, pal }: { stn: number; so: number; forecast: number; pal: Pal }) {
  const supplied = stn + so; const notCovered = Math.max(0, forecast - supplied); const scale = Math.max(forecast, supplied);
  const seg = (v: number, color: string, label: string, dark = false) => v <= 0 ? null : (
    <div style={{ width: `${(v / scale) * 100}%`, background: color, display: "flex", flexDirection: "column", justifyContent: "center", padding: "10px 12px" }}>
      {v / scale > 0.1 && <><span style={{ color: dark ? "var(--atlas-ink)" : "#fff", fontWeight: 700, fontSize: 16 }}>{fmtQty(v)}</span><span style={{ color: dark ? "var(--atlas-ink-muted)" : "rgba(255,255,255,0.85)", fontSize: 9.5, letterSpacing: "0.05em", textTransform: "uppercase" }}>{label}</span></>}
    </div>
  );
  return (
    <div>
      <div className="flex rounded-lg overflow-hidden" style={{ height: 62, border: "1px solid var(--atlas-line)" }}>
        {seg(stn, pal.sup.stn, "STN · to CFA/3PL")}{seg(so, pal.sup.so, "SO · direct dispatch")}{seg(notCovered, "var(--atlas-line-soft)", "Not covered", true)}
      </div>
      <div className="flex justify-between mt-1.5" style={{ fontSize: 11, color: "var(--atlas-ink-muted)" }}><span>0</span><span>Shortfall of {fmtQty(notCovered)} vs forecast of {fmtQty(forecast)}</span><span>{fmtInt(forecast)} units</span></div>
    </div>
  );
}

// ════════════════════════ DAILY ════════════════════════
type SeriesPt = { day: number; value: number };
function DailyView({ rawDaily, dailyChannel, dailyInternal, dailySkuChannel, overallList, channels, forecastTotal, authMoved, authRemaining, daysElapsed, pal }: {
  rawDaily: DailyRow[]; dailyChannel: Record<string, SeriesPt[]>; dailyInternal?: { central: SeriesPt[]; quarantine: SeriesPt[] };
  dailySkuChannel?: Record<string, Record<string, SeriesPt[]>>; overallList: OverallRow[]; channels: string[]; forecastTotal: number; authMoved: number; authRemaining: number;
  daysElapsed: number; pal: Pal;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(["__all"]));
  const [sku, setSku] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [selDay, setSelDay] = useState<number | null>(null);
  const days = rawDaily.map((d) => d.day);

  const SERIES: { k: string; label: string; color: string }[] = [
    { k: "__all", label: "Overall", color: pal.sup.so },
    ...channels.map((c) => ({ k: c, label: c, color: pal.chColor(c) })),
    { k: "__central", label: "To Factory", color: "var(--atlas-ink-muted)" },
    { k: "__quarantine", label: "Quarantine", color: "var(--atlas-amber-warn, #D97706)" },
  ];
  const toggle = (k: string) => setSelected((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); if (n.size === 0) n.add("__all"); return n; });
  const sel = SERIES.filter((s) => selected.has(s.k));

  const hits = q.trim().length < 2 ? [] : overallList.filter((r) => { const t = q.toLowerCase(); return r.masterSku.toLowerCase().includes(t) || r.fgCode.toLowerCase().includes(t) || (r.productName || "").toLowerCase().includes(t); }).slice(0, 8);
  const skuRow = sku ? overallList.find((r) => r.masterSku === sku) : null;

  // per-series day→value, in the current mode (whole node, or the picked SKU)
  const rawIdx = new Map(rawDaily.map((d) => [d.day, d]));
  const idxCache: Record<string, Map<number, number>> = {};
  const seriesIdx = (key: string): Map<number, number> => {
    if (idxCache[key]) return idxCache[key];
    const m = new Map<number, number>();
    if (sku) {
      const ss = dailySkuChannel?.[sku] ?? {};
      if (key === "__all") { for (const k of Object.keys(ss)) for (const p of ss[k]) m.set(p.day, (m.get(p.day) ?? 0) + p.value); }
      else for (const p of ss[key] ?? []) m.set(p.day, p.value);
    } else {
      if (key === "__all") for (const d of rawDaily) m.set(d.day, d.total);
      else if (key === "__central") for (const p of dailyInternal?.central ?? []) m.set(p.day, p.value);
      else if (key === "__quarantine") for (const p of dailyInternal?.quarantine ?? []) m.set(p.day, p.value);
      else for (const p of dailyChannel[key] ?? []) m.set(p.day, p.value);
    }
    idxCache[key] = m; return m;
  };
  const chart = days.map((d) => {
    const rd = rawIdx.get(d)!;
    const row: Record<string, number> = { day: d, STN: rd.stn, SO: rd.so };
    for (const s of SERIES) row[s.k] = seriesIdx(s.k).get(d) ?? 0;
    return row;
  });
  const maxDay = chart.reduce((m, d) => (d.__all > (m?.__all ?? -1) ? d : m), chart[0]);

  const kForecast = sku ? (skuRow?.forecast ?? 0) : forecastTotal;
  const kMoved = sku ? (skuRow?.totalSupplied ?? 0) : authMoved;
  const kRemaining = sku ? kForecast - kMoved : authRemaining;

  const dayTeam = selDay == null || sku ? null : {
    day: selDay, channels: channels.map((c) => ({ channel: c, value: seriesIdx(c).get(selDay) ?? 0 })).filter((c) => c.value > 0).sort((a, b) => b.value - a.value),
  };

  return (
    <>
      <div className="p-3 rounded-xl space-y-2.5" style={surface}>
        <div className="flex flex-wrap items-center gap-2">
          <span className={mono} style={{ fontSize: 10, letterSpacing: "0.08em", color: "var(--atlas-ink-muted)", minWidth: 42 }}>SKU</span>
          <div style={{ position: "relative", flex: 1, maxWidth: 360 }}>
            <input value={sku ?? q} onChange={(e) => { setSku(null); setQ(e.target.value); }} placeholder="Search a Master SKU / FG code for its day-on-day movement…" className="px-3 py-1.5 rounded-lg text-sm w-full" style={{ background: "var(--atlas-surface-soft)", border: "1px solid var(--atlas-line)", color: "var(--atlas-ink)" }} />
            {!sku && hits.length > 0 && (
              <div className="rounded-lg" style={{ position: "absolute", zIndex: 20, top: "110%", left: 0, right: 0, background: "var(--atlas-surface)", border: "1px solid var(--atlas-line)", boxShadow: "0 12px 30px rgba(0,0,0,0.2)", overflow: "hidden" }}>
                {hits.map((r) => (
                  <button key={r.masterSku} onClick={() => { setSku(r.masterSku); setQ(""); setSelDay(null); }} className="w-full text-left movement-row" style={{ padding: "8px 12px", border: "none", background: "transparent", cursor: "pointer", display: "block" }}>
                    <span style={{ color: "var(--atlas-ink)", fontSize: 12.5 }}>{r.productName || r.masterSku}</span><span style={{ color: "var(--atlas-ink-faint)", fontSize: 10.5, marginLeft: 6 }}>{r.masterSku} · {r.fgCode}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {sku && <button onClick={() => { setSku(null); setQ(""); }} className="px-2.5 py-1 rounded-full" style={{ background: "var(--atlas-accent-bg)", border: "1px solid var(--atlas-line)", fontSize: 11, color: "var(--atlas-ink)", cursor: "pointer" }}>{sku} ×</button>}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={mono} style={{ fontSize: 10, letterSpacing: "0.08em", color: "var(--atlas-ink-muted)", minWidth: 42 }}>Show</span>
          {SERIES.map((s) => { const on = selected.has(s.k); return (
            <button key={s.k} onClick={() => toggle(s.k)} className="flex items-center gap-1.5 px-2.5 py-1 rounded-full" style={{ border: "1px solid " + (on ? s.color : "var(--atlas-line)"), background: on ? "color-mix(in srgb, " + s.color + " 14%, transparent)" : "var(--atlas-surface)", cursor: "pointer", fontSize: 11 }}>
              <span style={{ width: 11, height: 11, borderRadius: 3, border: "1.5px solid " + s.color, background: on ? s.color : "transparent", display: "inline-block" }} />
              <span style={{ color: on ? "var(--atlas-ink)" : "var(--atlas-ink-muted)", fontWeight: on ? 600 : 400 }}>{s.label}</span>
            </button>
          ); })}
          {sku && <span style={{ fontSize: 11, color: "var(--atlas-ink-faint)" }}>· {sku} split by the checked series</span>}
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Kpi label={sku ? "SKU forecast" : "Forecast"} value={fmtQty(kForecast)} sub={sku ? sku : "monthly plan"} />
        <Kpi label="Moved (MTD)" value={fmtQty(kMoved)} sub={fmtPct(pctOf(kMoved, kForecast), 1) + " of forecast"} color={achColor(pctOf(kMoved, kForecast))} accent={achColor(pctOf(kMoved, kForecast))} />
        <Kpi label="Remaining" value={fmtQty(kRemaining)} sub={kRemaining > 0 ? "still to pick up" : "over plan"} color={kRemaining > 0 ? "var(--atlas-red)" : "var(--atlas-green)"} />
        <Kpi label="Peak day" value={maxDay ? "Day " + maxDay.day : "—"} sub={maxDay ? fmtQty(maxDay.__all) : ""} accent="var(--atlas-accent)" />
        {sku ? <Kpi label="Internal (this SKU)" value={fmtQty((skuRow?.toCentral ?? 0) + (skuRow?.toQuarantine ?? 0))} sub={"factory " + fmtQty(skuRow?.toCentral ?? 0) + " · quar " + fmtQty(skuRow?.toQuarantine ?? 0)} />
          : <Kpi label="Avg / day" value={fmtQty(daysElapsed ? authMoved / daysElapsed : 0)} sub={"over " + daysElapsed + " days"} />}
      </div>

      <Panel title={sku ? "Day-on-day movement — " + sku : "Day-on-day movement"} note={sku ? "This SKU by day. Overall = its total; check channels / To Factory / Quarantine to split it." : "Overall = STN/SO bars; each checked channel / internal series is a line. Click a bar for that day's team split."}>
        <ResponsiveContainer width="100%" height={360}>
          <ComposedChart data={chart} margin={{ left: 4, right: 8, top: 10, bottom: 4 }} onClick={(e) => { if (sku) return; const d = Number((e as { activeLabel?: unknown })?.activeLabel); if (Number.isFinite(d)) setSelDay(d); }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--atlas-line-soft)" vertical={false} />
            <XAxis dataKey="day" tick={axisTick} label={{ value: "Day of month", position: "insideBottom", offset: -2, fontSize: 10, fill: "var(--atlas-ink-faint)" }} />
            <YAxis tick={axisTick} tickFormatter={fmtQty} />
            <Tooltip contentStyle={chartTip} formatter={(v, n) => [fmtInt(Number(v)), n]} labelFormatter={(l) => "Day " + l} cursor={{ fill: "var(--atlas-accent-bg)" }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {!sku && selected.has("__all") && <Bar key="stn" dataKey="STN" stackId="o" fill={pal.sup.stn} name="STN" cursor="pointer" />}
            {!sku && selected.has("__all") && <Bar key="so" dataKey="SO" stackId="o" fill={pal.sup.so} name="SO" radius={[2, 2, 0, 0]} cursor="pointer" />}
            {sku && selected.has("__all") && <Bar key="all" dataKey="__all" name={sku} radius={[2, 2, 0, 0]}>{chart.map((d, i) => <Cell key={i} fill={maxDay && d.day === maxDay.day ? "var(--atlas-accent)" : pal.sup.so} />)}</Bar>}
            {channels.filter((c) => selected.has(c)).map((c) => <Line key={c} type="monotone" dataKey={c} name={c} stroke={pal.chColor(c)} strokeWidth={2} dot={false} />)}
            {selected.has("__central") && <Line key="central" type="monotone" dataKey="__central" name="To Factory" stroke="var(--atlas-ink-muted)" strokeWidth={2} strokeDasharray="5 3" dot={false} />}
            {selected.has("__quarantine") && <Line key="quar" type="monotone" dataKey="__quarantine" name="Quarantine" stroke="var(--atlas-amber-warn, #D97706)" strokeWidth={2} strokeDasharray="5 3" dot={false} />}
          </ComposedChart>
        </ResponsiveContainer>
      </Panel>

      {dayTeam && (
        <Panel title={"Team-wise movement — Day " + dayTeam.day} note="Movement split by team on this day." right={<button onClick={() => setSelDay(null)} style={{ border: "1px solid var(--atlas-line)", background: "var(--atlas-surface-soft)", color: "var(--atlas-ink-muted)", borderRadius: 8, padding: "2px 10px", cursor: "pointer", fontSize: 11 }}>Close ×</button>}>
          {dayTeam.channels.length === 0 ? <div style={{ fontSize: 12, color: "var(--atlas-ink-muted)" }}>No channel movement recorded on this day.</div> : (
            <div className="space-y-1.5">
              {dayTeam.channels.map((c) => { const max = Math.max(...dayTeam.channels.map((x) => x.value), 1); return (
                <div key={c.channel} className="flex items-center gap-3" style={{ fontSize: 12.5 }}>
                  <span className="flex items-center gap-1.5" style={{ width: 90, color: "var(--atlas-ink)" }}><span style={{ width: 8, height: 8, borderRadius: 2, background: pal.chColor(c.channel) }} />{c.channel}</span>
                  <div style={{ flex: 1, height: 12, background: "var(--atlas-line-soft)", borderRadius: 3, overflow: "hidden" }}><div style={{ width: (c.value / max) * 100 + "%", height: "100%", background: pal.chColor(c.channel), borderRadius: 3 }} /></div>
                  <span style={{ width: 70, textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--atlas-ink)" }}>{fmtInt(c.value)}</span>
                </div>
              ); })}
            </div>
          )}
        </Panel>
      )}

      <Panel title="Daily detail" note="One column per checked series.">
        <TableScroll max="40vh">
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead><tr>
              <th className={mono} style={{ fontSize: 9.5, color: "var(--atlas-ink-muted)", textAlign: "left", padding: "8px 12px", borderBottom: "1px solid var(--atlas-line)" }}>Day</th>
              {sel.map((s) => <th key={s.k} className={mono} style={{ fontSize: 9.5, color: s.color, textAlign: "right", padding: "8px 12px", borderBottom: "1px solid var(--atlas-line)" }}>{s.label}</th>)}
            </tr></thead>
            <tbody>
              {chart.map((d) => (
                <tr key={d.day} onClick={() => !sku && setSelDay(d.day)} className={sku ? "" : "movement-row"} style={{ borderBottom: "1px solid var(--atlas-line-soft)", cursor: sku ? "default" : "pointer", background: maxDay && d.day === maxDay.day ? "var(--atlas-accent-bg)" : undefined }}>
                  <Td left><span style={{ color: "var(--atlas-ink)", fontWeight: maxDay && d.day === maxDay.day ? 700 : 400 }}>Day {d.day}{maxDay && d.day === maxDay.day ? " ◆" : ""}</span></Td>
                  {sel.map((s) => <NumTd key={s.k} v={d[s.k]} strong={s.k === "__all"} />)}
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </Panel>
    </>
  );
}

// ════════════════════════ CHANNEL ════════════════════════
type ChRollup = { channel: string; forecast: number; stn: number; so: number; ship: number; supplied: number; closed: number; fill: number | null; remaining: number; action: { label: string; color: string } };
type ChRow = ChannelRow & { fill: number | null; gap: number; action: { label: string; color: string } };

function ChannelView({ chRollup, chanCat, channel, setChannel, channelRows, sort, setSort, pal, setRca }: {
  chRollup: ChRollup[]; chanCat: { category: string; cells: Record<string, { f: number; s: number; fill: number | null }>; tf: number; ts: number; fill: number | null }[];
  channel: string; setChannel: (c: string) => void; channelRows: ChRow[]; sort: Sort; setSort: (s: Sort) => void; pal: Pal; setRca: (s: string) => void;
}) {
  const teamScore = [...chRollup].sort((a, b) => b.remaining - a.remaining);
  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2.5">
        {chRollup.map((c) => (
          <button key={c.channel} onClick={() => setChannel(c.channel)} className="p-3 rounded-xl text-left" style={{ ...surface, outline: channel === c.channel ? `2px solid ${pal.chColor(c.channel)}` : "none", cursor: "pointer" }}>
            <div className="flex items-center gap-1.5 mb-1"><span style={{ width: 8, height: 8, borderRadius: 2, background: pal.chColor(c.channel) }} /><span className={mono} style={{ fontSize: 10, letterSpacing: "0.06em", color: "var(--atlas-ink-soft)" }}>{c.channel}</span></div>
            <div className="font-display" style={{ fontSize: 19, color: achColor(c.fill) }}>{fmtPct(c.fill)}</div>
            <div style={{ fontSize: 10.5, color: "var(--atlas-ink-muted)" }}>{fmtQty(c.supplied)} / {fmtQty(c.forecast)}</div>
            <div className="mt-1.5"><Badge label={c.action.label} color={c.action.color} /></div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Forecast vs moved by channel">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={chRollup} margin={{ left: 4, right: 8, top: 8, bottom: 4 }} barGap={2}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--atlas-line-soft)" vertical={false} /><XAxis dataKey="channel" tick={axisTick} /><YAxis tick={axisTick} tickFormatter={fmtQty} />
              <Tooltip contentStyle={chartTip} formatter={(v) => fmtInt(Number(v))} cursor={{ fill: "var(--atlas-line-soft)", opacity: 0.4 }} /><Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="forecast" name="Forecast" fill="var(--atlas-ink-faint)" radius={[3, 3, 0, 0]} barSize={16} />
              <Bar dataKey="supplied" name="Moved" radius={[3, 3, 0, 0]} barSize={16}>{chRollup.map((c, i) => <Cell key={i} fill={pal.chColor(c.channel)} />)}</Bar>
            </BarChart>
          </ResponsiveContainer>
        </Panel>
        <Panel title="Movement mix by channel — STN · SO · Shipsheet">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={chRollup} margin={{ left: 4, right: 8, top: 8, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--atlas-line-soft)" vertical={false} /><XAxis dataKey="channel" tick={axisTick} /><YAxis tick={axisTick} tickFormatter={fmtQty} />
              <Tooltip contentStyle={chartTip} formatter={(v) => fmtInt(Number(v))} cursor={{ fill: "var(--atlas-line-soft)", opacity: 0.4 }} /><Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="stn" stackId="m" name="STN" fill={pal.sup.stn} barSize={22} /><Bar dataKey="so" stackId="m" name="SO" fill={pal.sup.so} barSize={22} /><Bar dataKey="ship" stackId="m" name="Shipsheet" fill={pal.sup.ship} barSize={22} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Panel>
      </div>

      <Panel title="Team pickup action scorecard" note="Sorted by quantity still required after open pipeline">
        <TableScroll max="40vh">
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead><tr>{["Channel", "Forecast", "Moved", "Pipeline", "Remaining", "% Moved", "Action"].map((h, i) => <th key={h} className={mono} style={{ fontSize: 9.5, letterSpacing: "0.07em", color: "var(--atlas-ink-muted)", textAlign: i === 0 || i === 6 ? "left" : "right", padding: "9px 12px", borderBottom: "1px solid var(--atlas-line)" }}>{h}</th>)}</tr></thead>
            <tbody>
              {teamScore.map((c) => (
                <tr key={c.channel} onClick={() => setChannel(c.channel)} className="movement-row" style={{ borderBottom: "1px solid var(--atlas-line-soft)", cursor: "pointer" }}>
                  <td style={{ padding: "7px 12px" }}><span className="flex items-center gap-1.5" style={{ color: "var(--atlas-ink)" }}><span style={{ width: 8, height: 8, borderRadius: 2, background: pal.chColor(c.channel) }} />{c.channel}</span></td>
                  <NumTd v={c.forecast} /><NumTd v={c.supplied} /><NumTd v={c.ship} color={pal.sup.ship} />
                  <td style={{ padding: "7px 12px", textAlign: "right", fontVariantNumeric: "tabular-nums", color: c.remaining > 0 ? "var(--atlas-red)" : "var(--atlas-green)", fontWeight: 600 }}>{c.remaining > 0 ? "" : "+"}{fmtInt(-c.remaining)}</td>
                  <td style={{ padding: "7px 12px" }}><PctBar p={c.fill} color={achColor(c.fill)} /></td>
                  <td style={{ padding: "7px 12px" }}><Badge label={c.action.label} color={c.action.color} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </Panel>

      <Panel title="Channel × category coverage" note="Cell = moved as a share of that cell's forecast. Blank = no forecast.">
        <TableScroll max="46vh">
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
            <thead><tr>
              <th className={mono} style={{ fontSize: 9, letterSpacing: "0.06em", color: "var(--atlas-ink-muted)", textAlign: "left", padding: "8px 10px", borderBottom: "1px solid var(--atlas-line)", position: "sticky", left: 0, background: "var(--atlas-surface)" }}>Category</th>
              {CH_ORDER.map((ch) => <th key={ch} className={mono} style={{ fontSize: 9, color: "var(--atlas-ink-muted)", textAlign: "right", padding: "8px 8px", borderBottom: "1px solid var(--atlas-line)" }}>{ch}</th>)}
              <th className={mono} style={{ fontSize: 9, color: "var(--atlas-ink-muted)", textAlign: "right", padding: "8px 10px", borderBottom: "1px solid var(--atlas-line)" }}>Total</th>
            </tr></thead>
            <tbody>
              {chanCat.map((row) => (
                <tr key={row.category} style={{ borderBottom: "1px solid var(--atlas-line-soft)" }}>
                  <td style={{ padding: "6px 10px", color: "var(--atlas-ink)", fontWeight: 600, position: "sticky", left: 0, background: "var(--atlas-surface)" }}>{row.category}</td>
                  {CH_ORDER.map((ch) => {
                    const c = row.cells[ch]; if (!c || c.f === 0) return <td key={ch} style={{ padding: "6px 8px", textAlign: "right", color: "var(--atlas-ink-faint)" }}>—</td>;
                    const col = achColor(c.fill);
                    return <td key={ch} style={{ padding: "6px 8px", textAlign: "right", background: `color-mix(in srgb, ${col} 14%, transparent)` }}><div style={{ color: col, fontWeight: 700 }}>{fmtPct(c.fill)}</div><div style={{ fontSize: 9, color: "var(--atlas-ink-faint)" }}>{fmtQty(c.s)}</div></td>;
                  })}
                  <td style={{ padding: "6px 10px", textAlign: "right" }}><span style={{ color: achColor(row.fill), fontWeight: 700 }}>{fmtPct(row.fill)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </Panel>

      <div className="rounded-xl overflow-hidden" style={surface}>
        <div className="px-4 py-2.5 flex items-center gap-2" style={{ borderBottom: "1px solid var(--atlas-line)" }}><span style={{ width: 9, height: 9, borderRadius: 2, background: pal.chColor(channel) }} /><span className={mono} style={{ fontSize: 11, letterSpacing: "0.08em", color: "var(--atlas-ink)" }}>{channel}</span><span style={{ fontSize: 11, color: "var(--atlas-ink-muted)" }}>· {channelRows.length} SKUs</span></div>
        <TableScroll>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead><tr>
              <Th label="Product" k="productName" sort={sort} setSort={setSort} align="left" /><Th label="Category" k="category" sort={sort} setSort={setSort} align="left" />
              <Th label="Forecast" k="forecast" sort={sort} setSort={setSort} /><Th label="STN" k="stn" sort={sort} setSort={setSort} /><Th label="SO" k="so" sort={sort} setSort={setSort} />
              <Th label="Moved" k="totalSupplied" sort={sort} setSort={setSort} /><Th label="% Moved" k="fill" sort={sort} setSort={setSort} w={120} /><Th label="Action" k="fill" sort={sort} setSort={setSort} align="left" />
            </tr></thead>
            <tbody>
              {channelRows.map((r, i) => (
                <tr key={r.masterSku + i} onClick={() => setRca(r.masterSku)} className="movement-row" style={{ borderBottom: "1px solid var(--atlas-line-soft)", cursor: "pointer" }}>
                  <Td left><span style={{ color: "var(--atlas-ink)" }}>{r.productName || r.masterSku}</span><div style={{ fontSize: 10.5, color: "var(--atlas-ink-faint)" }}>{r.masterSku} · RCA ›</div></Td><Td left muted>{r.category}</Td>
                  <NumTd v={r.forecast} /><NumTd v={r.stn} color={pal.sup.stn} /><NumTd v={r.so} color={pal.sup.so} /><NumTd v={r.totalSupplied} strong />
                  <td style={{ padding: "7px 12px" }}><PctBar p={r.fill} color={achColor(r.fill)} /></td><td style={{ padding: "7px 12px" }}><Badge label={r.action.label} color={r.action.color} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </div>
    </>
  );
}

// ════════════════════════ QCOM ════════════════════════
type PlatRollup = { platform: string; forecast: number; orders: number; sales: number; orderPct: number | null; salesPct: number | null; conv: number | null; stock: number; action: { label: string; color: string } };
type QRow = QcomRow & { orderPct: number | null; salesPct: number | null; conv: number | null; stock: number; gap: number };

function QcomView({ qKpi, platRollup, qcomRows, qWidest, sort, setSort, pal }: {
  qKpi: { f: number; o: number; sa: number; orderPct: number | null; salesPct: number | null; conv: number | null; stock: number };
  platRollup: PlatRollup[]; qcomRows: QRow[]; qWidest: (QcomRow & { gap: number; salesPct: number | null })[]; sort: Sort; setSort: (s: Sort) => void; pal: Pal;
}) {
  const funnel = [
    { k: "Forecast", v: qKpi.f, sub: "demand plan", color: "var(--atlas-ink-faint)" },
    { k: "MTD Orders", v: qKpi.o, sub: "pickup intent", color: pal.sup.stn },
    { k: "MTD Sales", v: qKpi.sa, sub: "consumer sell-out", color: pal.sup.so },
  ];
  const platData = platRollup.map((p) => ({ name: p.platform, Forecast: p.forecast, Orders: p.orders, Sales: p.sales }));
  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        <Kpi label="Qcom forecast" value={fmtQty(qKpi.f)} sub="platform-level plan" />
        <Kpi label="MTD Orders" value={fmtQty(qKpi.o)} sub={`${fmtPct(qKpi.orderPct, 1)} of forecast`} accent={pal.sup.stn} />
        <Kpi label="MTD Sales" value={fmtQty(qKpi.sa)} sub={`${fmtPct(qKpi.salesPct, 1)} of forecast`} accent={pal.sup.so} />
        <Kpi label="Order coverage" value={fmtPct(qKpi.orderPct, 1)} sub="forecast → orders" color={covColor(qKpi.orderPct)} />
        <Kpi label="Sales coverage" value={fmtPct(qKpi.salesPct, 1)} sub="forecast → sell-out" color={covColor(qKpi.salesPct)} />
        <Kpi label="Stock at platform" value={fmtQty(qKpi.stock)} sub={`ordered not sold · conv ${fmtPct(qKpi.conv, 0)}`} color="var(--atlas-amber-warn, #D97706)" />
      </div>

      <Panel title="Forecast → orders → sales" note="Each gap has a different owner: demand sizing, then pickup, then sell-through.">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {funnel.map((s, i) => (
            <div key={s.k} className="p-3 rounded-lg relative" style={{ background: "var(--atlas-surface-soft)", border: "1px solid var(--atlas-line)" }}>
              <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: s.color }} />
              <div className={mono} style={{ fontSize: 9.5, letterSpacing: "0.08em", color: "var(--atlas-ink-muted)" }}>{s.k}</div>
              <div className="font-display" style={{ fontSize: 22, color: "var(--atlas-ink)" }}>{fmtQty(s.v)}</div>
              <div style={{ fontSize: 11, color: "var(--atlas-ink-muted)" }}>{s.sub}{i > 0 && <> · {fmtQty(s.v - funnel[i - 1].v)} vs prev</>}</div>
            </div>
          ))}
        </div>
      </Panel>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Forecast · orders · sales by platform">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={platData} layout="vertical" margin={{ left: 8, right: 12, top: 4, bottom: 4 }} barGap={1} barCategoryGap="26%">
              <CartesianGrid strokeDasharray="3 3" stroke="var(--atlas-line-soft)" horizontal={false} /><XAxis type="number" tick={axisTick} tickFormatter={fmtQty} /><YAxis type="category" dataKey="name" width={96} tick={{ fontSize: 11, fill: "var(--atlas-ink)" }} />
              <Tooltip contentStyle={chartTip} formatter={(v) => fmtInt(Number(v))} cursor={{ fill: "var(--atlas-line-soft)", opacity: 0.4 }} /><Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="Forecast" fill="var(--atlas-ink-faint)" radius={[0, 2, 2, 0]} barSize={8} /><Bar dataKey="Orders" fill={pal.sup.stn} radius={[0, 2, 2, 0]} barSize={8} /><Bar dataKey="Sales" fill={pal.sup.so} radius={[0, 2, 2, 0]} barSize={8} />
            </BarChart>
          </ResponsiveContainer>
        </Panel>
        <Panel title="Platform action matrix" note="Orders answer pickup intent; sales answer consumption.">
          <TableScroll max="240px">
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead><tr>{["Platform", "Order %", "Sales %", "Sell-thru", "Stock", "Action"].map((h, i) => <th key={h} className={mono} style={{ fontSize: 9.5, color: "var(--atlas-ink-muted)", textAlign: i === 0 || i === 5 ? "left" : "right", padding: "8px 10px", borderBottom: "1px solid var(--atlas-line)" }}>{h}</th>)}</tr></thead>
              <tbody>
                {platRollup.map((p) => (
                  <tr key={p.platform} style={{ borderBottom: "1px solid var(--atlas-line-soft)" }}>
                    <td style={{ padding: "8px 10px" }}><span className="flex items-center gap-1.5" style={{ color: "var(--atlas-ink)" }}><span style={{ width: 8, height: 8, borderRadius: 2, background: pal.platColor(p.platform) }} />{p.platform}</span></td>
                    <td style={{ padding: "8px 10px", textAlign: "right", color: covColor(p.orderPct), fontWeight: 600 }}>{fmtPct(p.orderPct)}</td>
                    <td style={{ padding: "8px 10px", textAlign: "right", color: covColor(p.salesPct), fontWeight: 600 }}>{fmtPct(p.salesPct)}</td>
                    <td style={{ padding: "8px 10px", textAlign: "right", color: "var(--atlas-ink-soft)" }}>{fmtPct(p.conv)}</td>
                    <td style={{ padding: "8px 10px", textAlign: "right", color: "var(--atlas-ink-soft)", fontVariantNumeric: "tabular-nums" }}>{fmtQty(p.stock)}</td>
                    <td style={{ padding: "8px 10px" }}><Badge label={p.action.label} color={p.action.color} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </Panel>
      </div>

      <Panel title="Widest gaps — forecast vs sell-out" note="Largest absolute miss between forecast and consumer sales (over and under).">
        <TableScroll max="34vh">
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead><tr>{["Product", "Platform", "Forecast", "Sales", "Gap", "Sales %"].map((h, i) => <th key={h} className={mono} style={{ fontSize: 9.5, color: "var(--atlas-ink-muted)", textAlign: i < 2 ? "left" : "right", padding: "9px 12px", borderBottom: "1px solid var(--atlas-line)" }}>{h}</th>)}</tr></thead>
            <tbody>
              {qWidest.map((r, i) => (
                <tr key={r.masterSku + r.platform + i} style={{ borderBottom: "1px solid var(--atlas-line-soft)" }}>
                  <Td left><span style={{ color: "var(--atlas-ink)" }}>{r.productName || r.masterSku}</span><div style={{ fontSize: 10.5, color: "var(--atlas-ink-faint)" }}>{r.masterSku}</div></Td>
                  <Td left><span className="flex items-center gap-1.5"><span style={{ width: 8, height: 8, borderRadius: 2, background: pal.platColor(r.platform) }} />{r.platform}</span></Td>
                  <NumTd v={r.forecast} /><NumTd v={r.mtdSales} />
                  <td style={{ padding: "7px 12px", textAlign: "right", fontVariantNumeric: "tabular-nums", color: r.gap >= 0 ? "var(--atlas-blue)" : "var(--atlas-red)", fontWeight: 600 }}>{r.gap >= 0 ? "+" : ""}{fmtInt(r.gap)}</td>
                  <td style={{ padding: "7px 12px", textAlign: "right", color: covColor(r.salesPct), fontWeight: 600 }}>{fmtPct(r.salesPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </Panel>

      <div className="rounded-xl overflow-hidden" style={surface}>
        <TableScroll>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead><tr>
              <Th label="Product" k="productName" sort={sort} setSort={setSort} align="left" /><Th label="Platform" k="platform" sort={sort} setSort={setSort} align="left" />
              <Th label="Forecast" k="forecast" sort={sort} setSort={setSort} /><Th label="Orders" k="mtdOrders" sort={sort} setSort={setSort} /><Th label="Order %" k="orderPct" sort={sort} setSort={setSort} w={110} />
              <Th label="Sales" k="mtdSales" sort={sort} setSort={setSort} /><Th label="Sales %" k="salesPct" sort={sort} setSort={setSort} w={110} /><Th label="Stock" k="stock" sort={sort} setSort={setSort} />
            </tr></thead>
            <tbody>
              {qcomRows.map((r, i) => (
                <tr key={r.masterSku + r.platform + i} style={{ borderBottom: "1px solid var(--atlas-line-soft)" }}>
                  <Td left><span style={{ color: "var(--atlas-ink)" }}>{r.productName || r.masterSku}</span><div style={{ fontSize: 10.5, color: "var(--atlas-ink-faint)" }}>{r.masterSku}</div></Td>
                  <Td left><span className="flex items-center gap-1.5"><span style={{ width: 8, height: 8, borderRadius: 2, background: pal.platColor(r.platform) }} />{r.platform}</span></Td>
                  <NumTd v={r.forecast} /><NumTd v={r.mtdOrders} color={pal.sup.stn} /><td style={{ padding: "7px 12px" }}><PctBar p={r.orderPct} color={covColor(r.orderPct)} /></td>
                  <NumTd v={r.mtdSales} color={pal.sup.so} /><td style={{ padding: "7px 12px" }}><PctBar p={r.salesPct} color={covColor(r.salesPct)} /></td><NumTd v={r.stock} />
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </div>
    </>
  );
}

// ════════════════════════ RCA MODAL ════════════════════════
type RcaChannel = ChannelRow & { fill: number | null; gap: number };
type RcaShape = { sku: string; productName: string; category: string; forecast: number; supplied: number; gap: number; fill: number | null; byChannel: RcaChannel[]; drivers: RcaChannel[]; toCentral: number; toQuarantine: number };

function RcaModal({ d, pal, onClose }: { d: RcaShape; pal: Pal; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc); return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  const over = d.gap >= 0;
  const numCell: React.CSSProperties = { padding: "7px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--atlas-ink-soft)" };
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(7,15,27,0.55)", display: "flex", justifyContent: "flex-end" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(640px, 96vw)", height: "100%", overflowY: "auto", background: "var(--atlas-surface)", borderLeft: "1px solid var(--atlas-line)", boxShadow: "-16px 0 40px rgba(0,0,0,0.25)" }}>
        <div className="p-5" style={{ borderBottom: "1px solid var(--atlas-line)", position: "sticky", top: 0, background: "var(--atlas-surface)", zIndex: 1 }}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className={mono} style={{ fontSize: 9.5, letterSpacing: "0.12em", color: "var(--atlas-ink-muted)" }}>Channel-level RCA</div>
              <div className="font-display" style={{ fontSize: 21, color: "var(--atlas-ink)", marginTop: 3, lineHeight: 1.15 }}>{d.productName}</div>
              <div style={{ fontSize: 11.5, color: "var(--atlas-ink-faint)", marginTop: 2 }}>{d.sku} · {d.category}</div>
            </div>
            <button onClick={onClose} style={{ border: "1px solid var(--atlas-line)", background: "var(--atlas-surface-soft)", color: "var(--atlas-ink-muted)", borderRadius: 8, width: 30, height: 30, cursor: "pointer", fontSize: 16 }}>×</button>
          </div>
          <div className="grid grid-cols-4 gap-2 mt-4">
            {[{ l: "Forecast", v: fmtQty(d.forecast), c: "var(--atlas-ink)" }, { l: "Moved", v: fmtQty(d.supplied), c: "var(--atlas-ink)" }, { l: "% Moved", v: fmtPct(d.fill), c: achColor(d.fill) }, { l: over ? "Over by" : "Short by", v: `${over ? "+" : ""}${fmtQty(d.gap)}`, c: over ? "var(--atlas-blue)" : "var(--atlas-red)" }].map((x) => (
              <div key={x.l} className="p-2.5 rounded-lg" style={{ background: "var(--atlas-surface-soft)", border: "1px solid var(--atlas-line)" }}>
                <div className={mono} style={{ fontSize: 8.5, letterSpacing: "0.08em", color: "var(--atlas-ink-muted)" }}>{x.l}</div>
                <div className="font-display" style={{ fontSize: 17, color: x.c, marginTop: 1 }}>{x.v}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="p-5 space-y-4">
          {d.drivers.length > 0 && (
            <div className="p-3 rounded-lg" style={{ background: over ? "var(--atlas-blue-bg)" : "var(--atlas-red-bg)", border: "1px solid var(--atlas-line)" }}>
              <div style={{ fontSize: 12.5, color: "var(--atlas-ink-soft)", lineHeight: 1.5 }}><b style={{ color: "var(--atlas-ink)" }}>Why:</b> {over ? "over-supply" : "shortfall"} driven mainly by {d.drivers.map((r, i) => <span key={r.channel}><b style={{ color: pal.chColor(r.channel) }}>{r.channel}</b> ({r.gap >= 0 ? "+" : ""}{fmtQty(r.gap)}){i < d.drivers.length - 1 ? ", " : ""}</span>)}.</div>
            </div>
          )}
          {(d.toCentral > 0 || d.toQuarantine > 0) && (
            <div className="p-3 rounded-lg flex items-center gap-4 flex-wrap" style={{ background: "var(--atlas-surface-soft)", border: "1px solid var(--atlas-line)" }}>
              <span className={mono} style={{ fontSize: 9, letterSpacing: "0.08em", color: "var(--atlas-ink-muted)" }}>Internal (not movement)</span>
              <span style={{ fontSize: 12.5, color: "var(--atlas-ink-soft)" }}>↻ Central/repacking <b style={{ color: "var(--atlas-ink)", fontVariantNumeric: "tabular-nums" }}>{fmtInt(d.toCentral)}</b></span>
              <span style={{ fontSize: 12.5, color: "var(--atlas-ink-soft)" }}>⚠ Quarantine <b style={{ color: "var(--atlas-amber-warn, #D97706)", fontVariantNumeric: "tabular-nums" }}>{fmtInt(d.toQuarantine)}</b></span>
            </div>
          )}
          <div>
            <div className={mono} style={{ fontSize: 10, letterSpacing: "0.1em", color: "var(--atlas-ink-muted)", marginBottom: 8 }}>Moved vs forecast by channel</div>
            <ResponsiveContainer width="100%" height={Math.max(160, d.byChannel.length * 34)}>
              <BarChart data={d.byChannel} layout="vertical" margin={{ left: 6, right: 40, top: 2, bottom: 2 }} barCategoryGap="24%">
                <CartesianGrid strokeDasharray="3 3" stroke="var(--atlas-line-soft)" horizontal={false} /><XAxis type="number" tick={axisTick} tickFormatter={fmtQty} /><YAxis type="category" dataKey="channel" width={62} tick={{ fontSize: 11, fill: "var(--atlas-ink)" }} />
                <Tooltip contentStyle={chartTip} formatter={(v) => fmtInt(Number(v))} cursor={{ fill: "var(--atlas-line-soft)", opacity: 0.4 }} /><Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="forecast" name="Forecast" fill="var(--atlas-ink-faint)" radius={[0, 3, 3, 0]} barSize={8} />
                <Bar dataKey="totalSupplied" name="Moved" radius={[0, 3, 3, 0]} barSize={8}>{d.byChannel.map((r, i) => <Cell key={i} fill={pal.chColor(r.channel)} />)}<LabelList dataKey="fill" position="right" formatter={(v) => fmtPct(v == null ? null : Number(v))} style={{ fontSize: 10, fill: "var(--atlas-ink-muted)" }} /></Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead><tr>{["Channel", "Forecast", "STN", "SO", "Ship", "Moved", "Gap", "%"].map((h, i) => <th key={h} className={mono} style={{ fontSize: 9, color: "var(--atlas-ink-muted)", textAlign: i === 0 ? "left" : "right", padding: "7px 8px", borderBottom: "1px solid var(--atlas-line)" }}>{h}</th>)}</tr></thead>
            <tbody>
              {d.byChannel.map((r) => (
                <tr key={r.channel} style={{ borderBottom: "1px solid var(--atlas-line-soft)" }}>
                  <td style={{ padding: "7px 8px" }}><span className="flex items-center gap-1.5" style={{ color: "var(--atlas-ink)" }}><span style={{ width: 8, height: 8, borderRadius: 2, background: pal.chColor(r.channel) }} />{r.channel}</span></td>
                  <td style={numCell}>{fmtInt(r.forecast)}</td><td style={{ ...numCell, color: pal.sup.stn }}>{fmtInt(r.stn)}</td><td style={{ ...numCell, color: pal.sup.so }}>{fmtInt(r.so)}</td><td style={{ ...numCell, color: pal.sup.ship }}>{fmtInt(r.shipsheet)}</td>
                  <td style={{ ...numCell, color: "var(--atlas-ink)", fontWeight: 600 }}>{fmtInt(r.totalSupplied)}</td><td style={{ ...numCell, color: r.gap >= 0 ? "var(--atlas-blue)" : "var(--atlas-red)", fontWeight: 600 }}>{r.gap >= 0 ? "+" : ""}{fmtInt(r.gap)}</td><td style={{ ...numCell, color: achColor(r.fill) }}>{fmtPct(r.fill)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Export ───────────────────────────────────────────────────────────────────
function ExportButton({ view, channel, overall, channelRows, qcomRows }: { view: View; channel: string; overall: OverRow[]; channelRows: ChRow[]; qcomRows: QRow[] }) {
  const onClick = () => {
    if (view === "overall") downloadCsv("overall.csv", ["Master SKU", "FG Code", "Product", "Category", "Forecast", "STN", "SO", "Moved", "Gap", "% Moved", "Action"], overall.map((r) => [r.masterSku, r.fgCode, r.productName, r.category, r.forecast, r.stn, r.so, r.totalSupplied, r.gap, r.fill === null ? "" : (r.fill * 100).toFixed(1), r.action.label]));
    else if (view === "channel") downloadCsv(`channel-${channel}.csv`, ["Master SKU", "FG Code", "Product", "Category", "Channel", "Forecast", "STN", "SO", "Moved", "% Moved", "Action"], channelRows.map((r) => [r.masterSku, r.fgCode, r.productName, r.category, r.channel, r.forecast, r.stn, r.so, r.totalSupplied, r.fill === null ? "" : (r.fill * 100).toFixed(1), r.action.label]));
    else if (view === "qcom") downloadCsv("qcom.csv", ["Master SKU", "FG Code", "Product", "Category", "Platform", "Forecast", "Orders", "Order %", "Sales", "Sales %", "Stock at platform"], qcomRows.map((r) => [r.masterSku, r.fgCode, r.productName, r.category, r.platform, r.forecast, r.mtdOrders, r.orderPct === null ? "" : (r.orderPct * 100).toFixed(1), r.mtdSales, r.salesPct === null ? "" : (r.salesPct * 100).toFixed(1), r.stock]));
  };
  return <button onClick={onClick} className="px-3 py-1.5 rounded-lg font-mono" style={{ background: "var(--atlas-surface-soft)", border: "1px solid var(--atlas-line)", color: "var(--atlas-ink-soft)", fontSize: 11, letterSpacing: "0.04em", cursor: "pointer" }}>↓ Export CSV</button>;
}
