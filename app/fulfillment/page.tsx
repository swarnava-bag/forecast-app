"use client";
// Fulfillment TAT — replaces the "Fulfillment Dashboard" workbook (and the
// Metabase look-ups around it). Upload the daily month-to-date Unicommerce SO
// export → Overview, Sheet View, Orders explorer, Pending Orders, editable
// Settings, and an Excel download. Supply Chain / admin only.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AppShell from "@/app/components/AppShell";
import { createClient } from "@/lib/supabase/client";
import { computeAll, buildDashboard, buildPending, prepareConfig, reportWindow, dayToIso, type FulfillmentConfig } from "@/lib/fulfillment/engine";
import { DEFAULT_CONFIG } from "@/lib/fulfillment/defaults";
import { inMonth } from "@/lib/fulfillment/months";
import TrendTab from "./TrendTab";
import { hasAccess, monthLabel, type Snapshot } from "@/lib/fulfillment/snapshot";
import {
  loadSettings, listMonths, loadMonth, publishMonth, deleteMonth,
  saveChannelMap, saveClosedDays, saveCredSla, saveReasons, saveSettings, type SectionMeta,
} from "@/lib/fulfillment/store";
import { buildWorkbook, saveFile } from "@/lib/fulfillment/download";
import type { Filters } from "./DataGrid";
import OverviewTab, { type DrillTarget } from "./OverviewTab";
import DashboardTab from "./DashboardTab";
import OrdersTab from "./OrdersTab";
import PendingTab from "./PendingTab";
import SettingsTab from "./SettingsTab";
import UploadTab from "./UploadTab";
import { surface, muted, faint, fmtDayLong, fmtDT, Btn, Notice } from "./ui";

type Tab = "overview" | "trend" | "sheet" | "orders" | "pending" | "settings" | "upload";
type Me = { id: string; role: string | null; name: string };

export default function FulfillmentPage() {
  const supabase = useMemo(() => createClient(), []);
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>("overview");
  const [config, setConfig] = useState<FulfillmentConfig>(DEFAULT_CONFIG);
  const [meta, setMeta] = useState<SectionMeta>({});
  const [months, setMonths] = useState<{ monthKey: string; updatedAt: string | null }[] | null>(null);
  const [monthKey, setMonthKey] = useState<string | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState<string | null>("Loading…");
  const [err, setErr] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  // drill-down: filters handed to the Orders / Pending grids (n re-keys the grid)
  const [drill, setDrill] = useState<{ orders?: Filters; pending?: Filters; n: number }>({ n: 0 });
  const [trendKey, setTrendKey] = useState(0);
  const [trendOpened, setTrendOpened] = useState(false);
  // freshness: storage version of the loaded month, and whether newer data has been published since
  const [loadedVersion, setLoadedVersion] = useState<string | null>(null);
  const [newer, setNewer] = useState<string | null>(null);
  const [verified, setVerified] = useState<string | null>(null);
  const expectRef = useRef(new Map<string, { orders: number; latest: number | null }>());
  // what the Upload tab is doing (shown on every tab so an unpublished upload is never mistaken for published data)
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const monthKeys = useMemo(() => (months ?? []).map((m) => m.monthKey), [months]);
  const sameList = (a: { monthKey: string; updatedAt: string | null }[] | null, b: { monthKey: string; updatedAt: string | null }[]) =>
    !!a && a.length === b.length && a.every((x, i) => x.monthKey === b[i].monthKey && x.updatedAt === b[i].updatedAt);

  // who am I
  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setMe(null); return; }
      const { data: p } = await supabase.from("profiles").select("role, full_name, email").eq("id", user.id).single();
      setMe({ id: user.id, role: p?.role ?? null, name: p?.full_name || p?.email || user.email || "" });
    })();
  }, [supabase]);
  const allowed = hasAccess(me?.role);

  // settings + month list
  useEffect(() => {
    if (!allowed) return;
    (async () => {
      try {
        const [s, m] = await Promise.all([loadSettings(), listMonths()]);
        setConfig(s.config); setMeta(s.meta); setMonths(m);
        if (m.length) setMonthKey((k) => k ?? m[0].monthKey);
        else { setLoading(null); setTab("upload"); }
      } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setLoading(null); }
    })();
  }, [allowed]);

  // month snapshot (reload bumps after a publish so the same month re-fetches)
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!monthKey) return;
    let live = true;
    setLoading(`Loading ${monthLabel(monthKey)}…`); setErr(null);
    (async () => {
      try {
        // record the stored version BEFORE downloading: if a publish lands in between,
        // the next freshness check reports "newer" rather than missing it
        const list = await listMonths().catch(() => null);
        const ver = list?.find((m) => m.monthKey === monthKey)?.updatedAt ?? null;
        const s = await loadMonth(monthKey);
        if (!live) return;
        setSnap(s); setLoadedVersion(ver); setNewer(null);
        if (list) setMonths((cur) => (sameList(cur, list) ? cur : list));
        // a month that was just published must load back exactly as sent
        const exp = expectRef.current.get(monthKey);
        if (exp) {
          expectRef.current.delete(monthKey);
          const latest = s.orders.reduce<number | null>((a, o) => (o.orderDate !== null && (a === null || o.orderDate > a) ? o.orderDate : a), null);
          if (s.orders.length !== exp.orders || latest !== exp.latest) {
            setErr(`${monthLabel(monthKey)} did not load back as published (expected ${exp.orders.toLocaleString()} orders to ${fmtDT(exp.latest)}, got ${s.orders.length.toLocaleString()} to ${fmtDT(latest)}). Click Reload; if it persists, publish again.`);
          } else {
            setVerified(`${monthLabel(monthKey)} now runs to ${fmtDT(latest)} — ${s.orders.length.toLocaleString()} orders, verified against what was published.`);
          }
        }
      } catch (e) { if (live) { setErr(e instanceof Error ? e.message : String(e)); setSnap(null); } }
      finally { if (live) setLoading(null); }
    })();
    return () => { live = false; };
  }, [monthKey, reload]);

  // freshness watch: every minute and whenever the tab regains focus, ask whether
  // the open month was re-published or a new month appeared since it was loaded
  useEffect(() => {
    if (!allowed || !monthKey) return;
    let stop = false;
    const check = async () => {
      if (stop || document.visibilityState !== "visible") return;
      try {
        const list = await listMonths();
        if (stop) return;
        const cur = list.find((m) => m.monthKey === monthKey);
        const known = new Set(monthKeys);
        const added = list.filter((m) => !known.has(m.monthKey)).map((m) => monthLabel(m.monthKey));
        if (cur && loadedVersion && cur.updatedAt && cur.updatedAt !== loadedVersion) {
          setNewer(`${monthLabel(monthKey)} was re-published at ${new Date(cur.updatedAt).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })} — you are looking at an older copy.`);
        } else if (added.length) {
          setNewer(`New data available: ${added.join(", ")}.`);
        }
      } catch { /* offline — try again later */ }
    };
    const id = window.setInterval(check, 60_000);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => { stop = true; window.clearInterval(id); window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", check); };
  }, [allowed, monthKey, loadedVersion, monthKeys]);

  const reloadNow = async () => {
    setNewer(null);
    try { const list = await listMonths(); setMonths((cur) => (sameList(cur, list) ? cur : list)); setTrendKey((n) => n + 1); } catch { /* keep going */ }
    setReload((n) => n + 1);
  };

  // calculations (re-run whenever data or settings change)
  const calc = useMemo(() => {
    if (!snap) return null;
    const all = computeAll(snap.orders, config);
    // window end = the data's own latest order day (clamped to the month) — not the
    // viewer's PC date, so a computer with a wrong clock cannot cut the view short
    const win = reportWindow(snap.orders, Number.POSITIVE_INFINITY, snap.monthKey);
    // the snapshot also carries last month's final days (for orders due in this
    // month); views show only orders placed or due in this month
    const rows = all.filter((r) => inMonth(r.orderDay, r.dueDay, { start: win.startDay, end: win.endDay }));
    const dash = buildDashboard(rows, win.startDay, win.endDay);
    const pending = buildPending(rows, win.startDay, win.endDay, prepareConfig(config).reasons);
    const facilities = [...new Set(rows.map((o) => o.facility).filter(Boolean))].sort();
    const latestOrder = rows.reduce<number | null>((a, r) => (r.orderDate !== null && r.orderDay !== null && r.orderDay <= win.endDay && (a === null || r.orderDate > a) ? r.orderDate : a), null);
    return { rows, dash, pending, facilities, latestOrder };
  }, [snap, config]);

  const wrapSave = useCallback(<A,>(fn: (a: A) => Promise<{ config: FulfillmentConfig; meta: SectionMeta }>) => async (a: A) => {
    const saved = await fn(a);
    setConfig(saved.config); setMeta(saved.meta);
  }, []);

  const onPublished = async (snaps: Snapshot[], progress: (m: string) => void): Promise<string> => {
    const lines: string[] = [];
    for (const [i, s] of snaps.entries()) {
      progress(`Publishing ${monthLabel(s.monthKey)} (${i + 1} of ${snaps.length})…`);
      const latest = s.orders.reduce<number | null>((a, o) => (o.orderDate !== null && (a === null || o.orderDate > a) ? o.orderDate : a), null);
      const res = await publishMonth(s);
      // the server reports what it stored — it must match what was sent
      if (res.orders !== s.orders.length || res.latestOrderDate !== latest) {
        throw new Error(`${monthLabel(s.monthKey)} was not stored as sent (sent ${s.orders.length} orders to ${fmtDT(latest)}, stored ${res.orders} to ${fmtDT(res.latestOrderDate)}). Please publish again.`);
      }
      expectRef.current.set(s.monthKey, { orders: s.orders.length, latest });
      lines.push(`${monthLabel(s.monthKey)} → ${s.orders.length.toLocaleString()} orders to ${fmtDT(latest)}`);
    }
    const list = await listMonths();
    setMonths(list);
    setTrendKey((n) => n + 1); // FY Trend reloads with the new data
    // open the latest month that was published (its reload verifies it end to end)
    setMonthKey(snaps.map((s) => s.monthKey).sort().at(-1)!);
    setReload((n) => n + 1);
    setNewer(null);
    setTab("overview");
    return `Published: ${lines.join(" · ")}.`;
  };

  const onDrill = (target: DrillTarget, f: Filters) => {
    setDrill((d) => ({ ...d, [target]: f, n: d.n + 1 }));
    setTab(target);
  };

  const fileTag = calc && snap ? `${monthLabel(snap.monthKey)} till ${dayToIso(calc.dash.endDay)}` : "";
  const download = async () => {
    if (!calc || !snap) return;
    setDownloading(true);
    await new Promise((r) => setTimeout(r, 0));
    try {
      saveFile(buildWorkbook({ dash: calc.dash, pending: calc.pending, rows: calc.rows, config, monthLabel: monthLabel(snap.monthKey), uploadedAt: new Date(snap.uploadedAt).toLocaleString("en-IN") }),
        `Fulfillment Dashboard ${fileTag}.xlsx`);
    } finally { setDownloading(false); }
  };

  // ── access gate ─────────────────────────────────────────────────────────────
  if (me === undefined) return <AppShell><div className="py-16 text-center" style={muted}>Loading…</div></AppShell>;
  if (!allowed) {
    return (
      <AppShell>
        <div className="py-16 text-center">
          <h2 className="text-2xl font-bold mb-2">Supply Chain only</h2>
          <p style={muted}>The Fulfillment dashboard is available to the Supply Chain team. Ask an admin if you need access.</p>
        </div>
      </AppShell>
    );
  }

  const TABS: { key: Tab; label: string; badge?: number }[] = [
    { key: "overview", label: "Overview" },
    { key: "trend", label: "FY Trend", badge: months?.length },
    { key: "sheet", label: "Sheet View" },
    { key: "orders", label: "Orders", badge: calc?.rows.length },
    { key: "pending", label: "Pending Orders", badge: calc?.pending.length },
    { key: "settings", label: "Settings" },
    { key: "upload", label: "Upload" },
  ];
  const dataTab = tab === "overview" || tab === "sheet" || tab === "orders" || tab === "pending";

  return (
    <AppShell>
      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">Fulfillment TAT</h1>
            <p className="text-sm mt-1" style={muted}>
              {calc && snap
                ? <>Data till <b style={{ color: "var(--atlas-ink)" }}>{fmtDayLong(calc.dash.endDay)}</b>{calc.latestOrder !== null && <> (latest order {fmtDT(calc.latestOrder)})</>} · from {fmtDayLong(calc.dash.startDay)} · {calc.rows.length.toLocaleString()} orders
                  {me?.role === "admin" && <> · uploaded {new Date(snap.uploadedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}{snap.uploadedBy ? ` by ${snap.uploadedBy}` : ""}</>}</>
                : "Order-level fulfillment, 3 PM dispatch compliance, CRED SLA and Website TAT."}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {months && months.length > 0 && (
              <select value={monthKey ?? ""} onChange={(e) => setMonthKey(e.target.value)} className="px-2.5 py-1.5 rounded-lg"
                style={{ ...surface, fontSize: 13, color: "var(--atlas-ink)" }}>
                {months.map((m) => <option key={m.monthKey} value={m.monthKey}>{monthLabel(m.monthKey)}</option>)}
              </select>
            )}
            <Btn primary disabled={!calc || downloading} onClick={download} title="Dashboard, Pending Orders, Base (one row per order) and settings — values">
              {downloading ? "Building…" : "↓ Download sheet"}
            </Btn>
          </div>
        </div>

        <div className="flex gap-1 flex-wrap" style={{ borderBottom: "1px solid var(--atlas-line)" }}>
          {TABS.map((t) => (
            <button key={t.key} onClick={() => { setTab(t.key); if (t.key === "trend") setTrendOpened(true); }} className="px-3.5 py-2"
              style={{
                fontSize: 13, fontWeight: tab === t.key ? 700 : 500, cursor: "pointer", background: "none", border: "none",
                color: tab === t.key ? "var(--atlas-ink)" : "var(--atlas-ink-muted)",
                borderBottom: `2px solid ${tab === t.key ? "var(--atlas-accent)" : "transparent"}`, marginBottom: -1,
              }}>
              {t.label}{t.badge !== undefined && <span className="ml-1.5 px-1.5 rounded-full" style={{ fontSize: 11, background: "var(--atlas-surface-soft)", ...faint }}>{t.badge.toLocaleString()}</span>}
            </button>
          ))}
        </div>

        {err && <Notice tone="error">{err}</Notice>}
        {newer && (
          <Notice tone="warn">
            <span className="flex flex-wrap items-center gap-3">{newer}<Btn small primary onClick={reloadNow}>↻ Reload now</Btn></span>
          </Notice>
        )}
        {verified && tab !== "upload" && (
          <Notice tone="ok"><span className="flex flex-wrap items-center gap-3">{verified}<button onClick={() => setVerified(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--atlas-ink-faint)" }}>✕</button></span></Notice>
        )}
        {uploadStatus && tab !== "upload" && (
          <Notice tone="info">
            <span className="flex flex-wrap items-center gap-3">{uploadStatus}<Btn small onClick={() => setTab("upload")}>Go to Upload</Btn></span>
          </Notice>
        )}
        {loading && dataTab && <div className="py-12 text-center" style={muted}>{loading}</div>}
        {!loading && dataTab && !calc && months?.length === 0 && (
          <Notice tone="info">No data yet. Go to <b>Upload</b> and drop the month-to-date Unicommerce SO export.</Notice>
        )}

        {/* Overview + Orders stay mounted so their filters survive tab switches */}
        {!loading && calc && snap && (
          <>
            <div style={{ display: tab === "overview" ? "block" : "none" }}>
              <OverviewTab key={snap.monthKey} rows={calc.rows} pending={calc.pending} dash={calc.dash} onDrill={onDrill} />
            </div>
            {tab === "sheet" && <DashboardTab dash={calc.dash} />}
            <div style={{ display: tab === "orders" ? "block" : "none" }}>
              <OrdersTab rows={calc.rows} fileTag={fileTag} preset={drill.orders} presetKey={drill.n} />
            </div>
            {tab === "pending" && <PendingTab key={drill.n} fileTag={fileTag} pending={calc.pending} preset={drill.pending} />}
          </>
        )}
        {/* FY Trend loads every month once opened, then stays mounted */}
        {trendOpened && months && (
          <div style={{ display: tab === "trend" ? "block" : "none" }}>
            <TrendTab key={trendKey} months={monthKeys} config={config}
              onOpenMonth={(k) => { setMonthKey(k); setTab("overview"); }} />
          </div>
        )}
        {tab === "settings" && (
          <SettingsTab config={config} meta={meta} facilities={calc?.facilities ?? []} unmapped={calc?.dash.unmapped ?? []}
            save={{
              channelMap: wrapSave(saveChannelMap), closedDays: wrapSave(saveClosedDays), credSla: wrapSave(saveCredSla),
              reasons: wrapSave(saveReasons), settings: wrapSave(saveSettings),
            }} />
        )}
        {/* Upload stays mounted: reading / checking / publishing survives switching tabs */}
        <div style={{ display: tab === "upload" ? "block" : "none" }}>
          <UploadTab channelMap={config.channelMap} existingMonths={monthKeys} onPublished={onPublished}
            onStatus={setUploadStatus}
            isAdmin={me?.role === "admin"}
            onDeleteMonth={async (k) => {
              await deleteMonth(k);
              const m = await listMonths();
              setMonths(m); setTrendKey((n) => n + 1);
              if (k === monthKey) { setSnap(null); setMonthKey(m[0]?.monthKey ?? null); }
            }} />
        </div>
      </div>
    </AppShell>
  );
}
