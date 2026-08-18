"use client";
import { useEffect, useState, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import Link from "next/link";
import AppShell from "@/app/components/AppShell";

// ── Types ─────────────────────────────────────────────────────────────────────
type Profile = { id: string; email: string; full_name: string; role: string };
type Cycle = { id: string; forecast_month: string; version: number; status: string; deadline: string | null; notes?: string | null };
type Channel = { id: string; name: string; cluster_id: string };
type Cluster = { id: string; name: string };
type KAMProfile = { id: string; email: string; full_name: string; role: string };
type ForecastRow = { channel_id: string; sku_id: string; uploaded_by: string | null; uploaded_at: string | null; quantity: number };
type VcRaw = { channel_id: string; quantity: number };
type Sku = { id: string; name: string; category: string | null };

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtMonth(dateStr: string) {
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en-US", { year: "numeric", month: "short" });
}
function fmtQty(n: number) {
  if (n >= 10000000) return `${(n / 10000000).toFixed(2)}Cr`;
  if (n >= 100000) return `${(n / 100000).toFixed(1)}L`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return Math.round(n).toLocaleString("en-IN");
}
function fmtDateTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}
function roleLabel(role: string) {
  return ({ admin: "Admin", head_kam: "Head KAM", channel_kam: "KAM", supply_chain: "Supply Chain", viewer: "Viewer" } as Record<string, string>)[role] || role;
}
function deadlineInfo(deadline: string | null) {
  if (!deadline) return null;
  const ms = new Date(deadline).getTime() - Date.now();
  if (ms < 0) return { label: "Deadline passed", color: "text-red-400", bg: "bg-red-500/10 border-red-500/30", passed: true };
  const h = Math.floor(ms / 3600000);
  const d = Math.floor(h / 24);
  const label = d > 0 ? `${d}d ${h % 24}h left` : `${h}h left`;
  const urgent = h < 48;
  return { label, color: urgent ? "text-red-400" : h < 120 ? "text-amber-400" : "text-green-400", bg: urgent ? "bg-red-500/10 border-red-500/30" : "bg-amber-500/10 border-amber-500/30", passed: false };
}
// cluster accent palette (stable by index, atlas-friendly, light+dark)
const CLUSTER_HUES = ["#2563EB", "#0E9F6E", "#E8850C", "#8B5CF6", "#0EA5E9", "#DC5B2B", "#D6409F", "#0891B2"];
const hueFor = (i: number) => CLUSTER_HUES[((i % CLUSTER_HUES.length) + CLUSTER_HUES.length) % CLUSTER_HUES.length];

// simple horizontal bar
function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div className="h-2 rounded-full w-full" style={{ background: "var(--atlas-surface-soft)" }}>
      <div className="h-2 rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const router = useRouter();
  const supabase = createClient();

  // Core
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [unassignedUsers, setUnassignedUsers] = useState<Profile[]>([]);

  // Reference data
  const [allCycles, setAllCycles] = useState<Cycle[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [allowedChannelIds, setAllowedChannelIds] = useState<string[]>([]);
  const [kams, setKams] = useState<KAMProfile[]>([]);
  const [kamChannelMap, setKamChannelMap] = useState<Map<string, string[]>>(new Map());
  const [skuMap, setSkuMap] = useState<Map<string, Sku>>(new Map());

  // Cycle selection + forecast data
  const [selectedCycleId, setSelectedCycleId] = useState("");
  const [rawForecast, setRawForecast] = useState<ForecastRow[]>([]);
  const [cycleLoading, setCycleLoading] = useState(false);

  // Version comparison
  const [vcMonth, setVcMonth] = useState("");
  const [vcCycleA, setVcCycleA] = useState("");
  const [vcCycleB, setVcCycleB] = useState("");
  const [rawVcA, setRawVcA] = useState<VcRaw[]>([]);
  const [rawVcB, setRawVcB] = useState<VcRaw[]>([]);
  const [vcLoading, setVcLoading] = useState(false);
  const [vcTriggered, setVcTriggered] = useState(false);

  // Live countdown tick (every 60s)
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60000);
    return () => clearInterval(t);
  }, []);

  // ── Initial load ─────────────────────────────────────────────────────────────
  async function loadData() {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { router.push("/login"); return; }

    const { data: p } = await supabase.from("profiles").select("*").eq("id", user.id).single();
    setProfile(p);

    const [
      { data: chData },
      { data: clData },
      { data: cycleData },
      { data: skuData },
    ] = await Promise.all([
      supabase.from("channels").select("id, name, cluster_id").eq("is_active", true).order("display_order"),
      supabase.from("clusters").select("id, name").order("display_order"),
      supabase.from("forecast_cycles").select("*").order("forecast_month", { ascending: false }).order("version", { ascending: false }),
      supabase.from("sku_master").select("id, new_master_sku, product_name, category"),
    ]);

    if (chData) setChannels(chData);
    if (clData) setClusters(clData);
    if (cycleData) setAllCycles(cycleData);
    if (skuData) {
      const m = new Map<string, Sku>();
      for (const s of skuData) m.set(s.id, { id: s.id, name: s.product_name || s.new_master_sku, category: s.category ?? null });
      setSkuMap(m);
    }

    // Allowed channels for this user
    let myChannelIds: string[] = [];
    if (p?.role === "admin") {
      myChannelIds = chData?.map((c: Channel) => c.id) || [];
    } else if (p?.role === "head_kam") {
      const { data: uc } = await supabase.from("user_clusters").select("cluster_id").eq("user_id", user.id);
      if (uc && chData) {
        const clIds = new Set(uc.map((x: { cluster_id: string }) => x.cluster_id));
        myChannelIds = chData.filter((c: Channel) => clIds.has(c.cluster_id)).map((c: Channel) => c.id);
      }
    } else {
      const { data: uc } = await supabase.from("user_channels").select("channel_id").eq("user_id", user.id);
      if (uc) myChannelIds = uc.map((x: { channel_id: string }) => x.channel_id);
    }
    setAllowedChannelIds(myChannelIds);

    // Admin: unassigned users
    if (p?.role === "admin") {
      const { data: viewers } = await supabase.from("profiles").select("id, email, full_name, role").eq("role", "viewer");
      if (viewers) setUnassignedUsers(viewers);
    }

    // KAM tracker data (admin + head_kam)
    if (p?.role === "admin" || p?.role === "head_kam") {
      const { data: kamData } = await supabase
        .from("profiles").select("id, email, full_name, role")
        .in("role", ["channel_kam", "head_kam"]).order("full_name");
      if (kamData) setKams(kamData);

      const [{ data: ucData }, { data: ucsData }] = await Promise.all([
        supabase.from("user_channels").select("user_id, channel_id"),
        supabase.from("user_clusters").select("user_id, cluster_id"),
      ]);

      const kamMap = new Map<string, string[]>();
      ucData?.forEach((m: { user_id: string; channel_id: string }) => {
        const list = kamMap.get(m.user_id) || [];
        if (!list.includes(m.channel_id)) list.push(m.channel_id);
        kamMap.set(m.user_id, list);
      });
      if (ucsData && chData) {
        ucsData.forEach((m: { user_id: string; cluster_id: string }) => {
          const list = kamMap.get(m.user_id) || [];
          chData.filter((c: Channel) => c.cluster_id === m.cluster_id).forEach((c: Channel) => {
            if (!list.includes(c.id)) list.push(c.id);
          });
          kamMap.set(m.user_id, list);
        });
      }
      setKamChannelMap(kamMap);
    }

    // Default to the LATEST cycle (most recent month + version), so the newest
    // forecast — including one just pushed from Movement — shows immediately.
    if (cycleData && cycleData.length) setSelectedCycleId(cycleData[0].id);

    setLoading(false);
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadData(); }, []);

  // ── Load forecast data when cycle changes ─────────────────────────────────
  useEffect(() => {
    if (!selectedCycleId) return;
    (async () => {
      setCycleLoading(true);
      const { data } = await supabase
        .from("forecast_data")
        .select("channel_id, sku_id, uploaded_by, uploaded_at, quantity")
        .eq("cycle_id", selectedCycleId);
      setRawForecast(data || []);
      setCycleLoading(false);
    })();
  }, [selectedCycleId]);

  // ── Version comparison fetch ───────────────────────────────────────────────
  async function runVersionComparison() {
    if (!vcCycleA || !vcCycleB || vcCycleA === vcCycleB) return;
    setVcLoading(true); setVcTriggered(true);
    const [{ data: dA }, { data: dB }] = await Promise.all([
      supabase.from("forecast_data").select("channel_id, quantity").eq("cycle_id", vcCycleA),
      supabase.from("forecast_data").select("channel_id, quantity").eq("cycle_id", vcCycleB),
    ]);
    setRawVcA(dA || []);
    setRawVcB(dB || []);
    setVcLoading(false);
  }

  const allowedSet = useMemo(() => new Set(allowedChannelIds), [allowedChannelIds]);
  const chMap = useMemo(() => new Map(channels.map((c) => [c.id, c])), [channels]);
  const clMap = useMemo(() => new Map(clusters.map((c) => [c.id, c])), [clusters]);

  // ── Derived: the actual forecast, broken down ──────────────────────────────
  const forecast = useMemo(() => {
    const rows = rawForecast.filter((r) => allowedSet.has(r.channel_id));
    let total = 0;
    const bySku = new Map<string, number>();
    const byChannel = new Map<string, number>();
    const lastUpload = new Map<string, string>();
    for (const r of rows) {
      const q = r.quantity || 0; total += q;
      bySku.set(r.sku_id, (bySku.get(r.sku_id) || 0) + q);
      byChannel.set(r.channel_id, (byChannel.get(r.channel_id) || 0) + q);
      if (r.uploaded_at && (!lastUpload.has(r.channel_id) || r.uploaded_at > lastUpload.get(r.channel_id)!))
        lastUpload.set(r.channel_id, r.uploaded_at);
    }
    // clusters
    const byCluster = new Map<string, number>();
    for (const [chId, q] of byChannel) { const cl = chMap.get(chId)?.cluster_id; if (cl) byCluster.set(cl, (byCluster.get(cl) || 0) + q); }
    const clusterRows = clusters
      .map((cl, i) => ({ cluster: cl, qty: byCluster.get(cl.id) || 0, hue: hueFor(i) }))
      .filter((r) => r.qty > 0).sort((a, b) => b.qty - a.qty);
    // channels (in scope), grouped later
    const channelRows = channels
      .filter((ch) => allowedSet.has(ch.id))
      .map((ch) => ({ channel: ch, qty: byChannel.get(ch.id) || 0, submitted: byChannel.has(ch.id), lastUpload: lastUpload.get(ch.id) || null }))
      .sort((a, b) => b.qty - a.qty);
    // top SKUs
    const topSkus = [...bySku.entries()]
      .map(([id, qty]) => ({ id, qty, sku: skuMap.get(id) }))
      .sort((a, b) => b.qty - a.qty).slice(0, 15);
    const skuCount = [...bySku.values()].filter((q) => q > 0).length;
    const channelsWithForecast = [...byChannel.values()].filter((q) => q > 0).length;
    return { total, clusterRows, channelRows, topSkus, skuCount, channelsWithForecast, byCluster };
  }, [rawForecast, allowedSet, channels, clusters, chMap, skuMap]);

  // ── Derived: KAM statuses ────────────────────────────────────────────────
  const kamStatuses = useMemo(() => {
    if (!kams.length) return [];
    const submittedIds = new Set(rawForecast.map((r) => r.channel_id));
    const lastUploadByCh = new Map<string, string>();
    rawForecast.forEach((r) => {
      if (r.uploaded_at && (!lastUploadByCh.has(r.channel_id) || r.uploaded_at > lastUploadByCh.get(r.channel_id)!))
        lastUploadByCh.set(r.channel_id, r.uploaded_at);
    });
    return kams
      .map((kam) => {
        const assigned = kamChannelMap.get(kam.id) || [];
        const submitted = assigned.filter((id) => submittedIds.has(id));
        let lastUpload: string | null = null;
        assigned.forEach((chId) => { const t = lastUploadByCh.get(chId); if (t && (!lastUpload || t > lastUpload)) lastUpload = t; });
        return { kam, assigned, submitted, lastUpload };
      })
      .filter((s) => s.assigned.length > 0)
      .sort((a, b) => {
        const aDone = a.submitted.length === a.assigned.length;
        const bDone = b.submitted.length === b.assigned.length;
        if (aDone !== bDone) return aDone ? 1 : -1;
        return a.kam.full_name.localeCompare(b.kam.full_name);
      });
  }, [rawForecast, kams, kamChannelMap]);

  // ── Derived: version comparison rows ──────────────────────────────────────
  const vcRows = useMemo(() => {
    const aggA = new Map<string, number>();
    const aggB = new Map<string, number>();
    rawVcA.forEach((r) => aggA.set(r.channel_id, (aggA.get(r.channel_id) || 0) + (r.quantity || 0)));
    rawVcB.forEach((r) => aggB.set(r.channel_id, (aggB.get(r.channel_id) || 0) + (r.quantity || 0)));
    return channels
      .filter((ch) => allowedSet.has(ch.id))
      .map((ch) => {
        const qA = aggA.get(ch.id) || 0;
        const qB = aggB.get(ch.id) || 0;
        return { channel: ch, cluster: clMap.get(ch.cluster_id) || null, qA, qB, delta: qB - qA, deltaPct: qA > 0 ? ((qB - qA) / qA) * 100 : null };
      })
      .filter((r) => r.qA > 0 || r.qB > 0)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  }, [rawVcA, rawVcB, channels, clMap, allowedSet]);

  // ── Summary stats ──────────────────────────────────────────────────────────
  const selectedCycle = allCycles.find((c) => c.id === selectedCycleId);
  const dl = deadlineInfo(selectedCycle?.deadline || null);
  const totalCh = forecast.channelRows.length;
  const submittedCh = forecast.channelsWithForecast;
  const pendingKams = kamStatuses.filter((k) => k.submitted.length < k.assigned.length).length;
  const completedKams = kamStatuses.length - pendingKams;
  const isAdminOrHead = profile?.role === "admin" || profile?.role === "head_kam";
  const maxCluster = Math.max(1, ...forecast.clusterRows.map((r) => r.qty));
  const maxSku = Math.max(1, ...forecast.topSkus.map((r) => r.qty));

  const vcTotalA = vcRows.reduce((s, r) => s + r.qA, 0);
  const vcTotalB = vcRows.reduce((s, r) => s + r.qB, 0);
  const vcDelta = vcTotalB - vcTotalA;
  const vcDeltaPct = vcTotalA > 0 ? (vcDelta / vcTotalA) * 100 : null;
  const vcFidelity = vcTotalA > 0 ? Math.max(0, Math.round((1 - Math.abs(vcDelta) / vcTotalA) * 100)) : null;
  const vcMonths = [...new Set(allCycles.map((c) => c.forecast_month))].sort((a, b) => b.localeCompare(a));
  const cyclesForVcMonth = allCycles.filter((c) => c.forecast_month === vcMonth);
  const cycleA = allCycles.find((c) => c.id === vcCycleA);
  const cycleB = allCycles.find((c) => c.id === vcCycleB);

  // channels grouped by cluster for the forecast table
  const channelsByCluster = useMemo(() => {
    const groups: { cluster: Cluster; hue: string; rows: typeof forecast.channelRows; qty: number }[] = [];
    clusters.forEach((cl, i) => {
      const rows = forecast.channelRows.filter((r) => r.channel.cluster_id === cl.id);
      if (rows.length > 0) groups.push({ cluster: cl, hue: hueFor(i), rows, qty: rows.reduce((s, r) => s + r.qty, 0) });
    });
    return groups.sort((a, b) => b.qty - a.qty);
  }, [forecast.channelRows, clusters]);

  if (loading) {
    return (
      <AppShell>
        <div className="flex items-center justify-center min-h-[60vh]">
          <p style={{ color: "var(--atlas-ink-muted)" }}>Loading dashboard...</p>
        </div>
      </AppShell>
    );
  }

  const statusChip = (status: string) => status === "open" ? "bg-green-500/20 text-green-400"
    : status === "locked" ? "bg-amber-500/20 text-amber-400" : "bg-blue-500/20 text-blue-400";

  return (
    <AppShell>
      <div className="max-w-7xl mx-auto space-y-6">

        {/* ── Unassigned users banner ── */}
        {profile?.role === "admin" && unassignedUsers.length > 0 && (
          <div className="p-4 bg-red-900/30 border border-red-500/50 rounded-xl flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-red-300">{unassignedUsers.length} user{unassignedUsers.length > 1 ? "s" : ""} pending role assignment</p>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {unassignedUsers.map((u) => (<span key={u.id} className="px-2 py-0.5 bg-red-900/50 rounded text-xs text-red-200">{u.full_name || u.email}</span>))}
              </div>
            </div>
            <Link href="/admin/users" className="px-4 py-2 text-sm bg-red-500 text-white font-semibold rounded-lg hover:bg-red-400 transition whitespace-nowrap ml-4">Assign Roles →</Link>
          </div>
        )}

        {/* ── Header + cycle selector ── */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold">Operations Dashboard</h2>
            <p className="text-sm text-atlas-ink-muted mt-1">Forecast by cluster, channel &amp; SKU · submission tracking · version analysis</p>
          </div>
          <div className="flex items-center gap-3">
            <label className="text-xs text-atlas-ink-muted whitespace-nowrap">Forecast month</label>
            <select value={selectedCycleId} onChange={(e) => setSelectedCycleId(e.target.value)}
              className="px-3 py-2 bg-atlas-surface-soft border border-atlas-line rounded-lg text-sm text-atlas-ink font-medium focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[210px]">
              <option value="">— Select cycle —</option>
              {allCycles.map((c) => (<option key={c.id} value={c.id}>{fmtMonth(c.forecast_month)} · V{c.version} · {c.status}</option>))}
            </select>
          </div>
        </div>

        {/* ── Cycle info bar ── */}
        {selectedCycle && (
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 px-4 py-2 bg-atlas-surface border border-atlas-line rounded-xl">
              <span className="text-xs text-atlas-ink-muted">Cycle</span>
              <span className="text-sm font-semibold text-atlas-ink">{fmtMonth(selectedCycle.forecast_month)} · V{selectedCycle.version}</span>
              <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusChip(selectedCycle.status)}`}>{selectedCycle.status}</span>
            </div>
            {selectedCycle.notes && /movement/i.test(selectedCycle.notes) && (
              <div className="flex items-center gap-2 px-4 py-2 rounded-xl border" style={{ background: "var(--atlas-accent-bg)", borderColor: "var(--atlas-line)" }}>
                <span className="text-sm">↑</span>
                <span className="text-sm font-medium" style={{ color: "var(--atlas-accent)" }}>Pushed from Forecast vs Movement</span>
              </div>
            )}
            {dl && (
              <div className={`flex items-center gap-2 px-4 py-2 rounded-xl border ${dl.bg}`}>
                <span className="text-sm">⏰</span>
                <span className={`text-sm font-semibold ${dl.color}`}>{dl.label}</span>
                {selectedCycle.deadline && (<span className="text-xs text-atlas-ink-muted">({new Date(selectedCycle.deadline).toLocaleDateString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })})</span>)}
              </div>
            )}
            {cycleLoading && <span className="text-xs text-blue-400 animate-pulse">Loading forecast…</span>}
          </div>
        )}

        {/* ── KPI row (forecast-first) ── */}
        {selectedCycleId && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div className="bg-atlas-surface border border-atlas-line rounded-xl p-4">
              <p className="text-2xl font-bold text-atlas-ink">{fmtQty(forecast.total)}</p>
              <p className="text-xs text-atlas-ink-muted mt-1">Total forecast qty</p>
            </div>
            <div className="bg-atlas-surface border border-atlas-line rounded-xl p-4">
              <p className="text-2xl font-bold" style={{ color: "var(--atlas-accent)" }}>{forecast.skuCount}</p>
              <p className="text-xs text-atlas-ink-muted mt-1">SKUs forecasted</p>
            </div>
            <div className="bg-atlas-surface border border-atlas-line rounded-xl p-4">
              <p className="text-2xl font-bold text-atlas-ink">{submittedCh}<span className="text-atlas-ink-faint text-lg">/{totalCh}</span></p>
              <p className="text-xs text-atlas-ink-muted mt-1">Channels with forecast</p>
            </div>
            <div className="bg-atlas-surface border border-atlas-line rounded-xl p-4">
              <p className="text-2xl font-bold text-atlas-ink">{forecast.clusterRows.length}</p>
              <p className="text-xs text-atlas-ink-muted mt-1">Clusters covered</p>
            </div>
            {isAdminOrHead ? (
              <div className={`bg-atlas-surface border rounded-xl p-4 ${pendingKams > 0 ? "border-amber-800/40" : "border-green-800/40"}`}>
                <p className={`text-2xl font-bold ${pendingKams > 0 ? "text-amber-400" : "text-green-400"}`}>{pendingKams}</p>
                <p className="text-xs text-atlas-ink-muted mt-1">KAMs pending · {completedKams} done</p>
              </div>
            ) : (
              <div className="bg-atlas-surface border border-atlas-line rounded-xl p-4">
                <p className="text-2xl font-bold text-atlas-ink">{totalCh > 0 ? Math.round((submittedCh / totalCh) * 100) : 0}%</p>
                <p className="text-xs text-atlas-ink-muted mt-1">Completion</p>
              </div>
            )}
          </div>
        )}

        {/* ── Forecast by cluster + Top SKUs ── */}
        {selectedCycleId && forecast.total > 0 && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-atlas-surface border border-atlas-line rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-atlas-line">
                <h3 className="font-semibold text-atlas-ink">Forecast by cluster</h3>
                <p className="text-xs text-atlas-ink-muted mt-0.5">{fmtQty(forecast.total)} units across {forecast.clusterRows.length} clusters</p>
              </div>
              <div className="p-5 space-y-3.5">
                {forecast.clusterRows.map((r) => (
                  <div key={r.cluster.id}>
                    <div className="flex items-center justify-between mb-1.5 text-sm">
                      <span className="font-medium text-atlas-ink">{r.cluster.name}</span>
                      <span className="text-atlas-ink-muted font-mono">{fmtQty(r.qty)} <span className="text-atlas-ink-faint">· {Math.round((r.qty / forecast.total) * 100)}%</span></span>
                    </div>
                    <Bar value={r.qty} max={maxCluster} color={r.hue} />
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-atlas-surface border border-atlas-line rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-atlas-line flex items-center justify-between">
                <div>
                  <h3 className="font-semibold text-atlas-ink">Top SKUs</h3>
                  <p className="text-xs text-atlas-ink-muted mt-0.5">Largest forecast this cycle</p>
                </div>
                <Link href="/channels" className="text-xs" style={{ color: "var(--atlas-accent)" }}>All SKUs →</Link>
              </div>
              <div className="p-5 space-y-2.5">
                {forecast.topSkus.map((r) => (
                  <div key={r.id} className="flex items-center gap-3">
                    <span className="text-sm text-atlas-ink truncate flex-1 min-w-0" title={r.sku?.name}>{r.sku?.name || "Unknown SKU"}</span>
                    <div className="w-28 hidden sm:block"><Bar value={r.qty} max={maxSku} color="var(--atlas-accent)" /></div>
                    <span className="text-sm font-mono text-atlas-ink-muted w-16 text-right">{fmtQty(r.qty)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── Forecast by channel (grouped by cluster, with submission status) ── */}
        {selectedCycleId && (
          <div className="bg-atlas-surface border border-atlas-line rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-atlas-line">
              <h3 className="font-semibold text-atlas-ink">Forecast by channel</h3>
              <p className="text-xs text-atlas-ink-muted mt-0.5">{submittedCh} of {totalCh} channels have a forecast for {selectedCycle ? `${fmtMonth(selectedCycle.forecast_month)} V${selectedCycle.version}` : "this cycle"}</p>
            </div>
            <div className="p-5 space-y-5">
              {channelsByCluster.length === 0 ? (
                <p className="text-atlas-ink-muted text-sm text-center py-6">No forecast in your scope for this cycle.</p>
              ) : channelsByCluster.map(({ cluster, hue, rows, qty }) => (
                <div key={cluster.id}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs uppercase tracking-widest font-semibold" style={{ color: hue }}>{cluster.name}</span>
                    <span className="text-xs text-atlas-ink-muted font-mono">{fmtQty(qty)}</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                    {rows.map(({ channel, qty: q, submitted, lastUpload }) => (
                      <div key={channel.id} className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border ${submitted ? "border-atlas-line" : "border-atlas-line/50 bg-atlas-surface-soft/30"}`}>
                        <div className="w-1.5 h-8 rounded-full flex-shrink-0" style={{ background: submitted ? hue : "var(--atlas-ink-faint)" }} />
                        <div className="flex-1 min-w-0">
                          <p className={`text-sm font-medium truncate ${submitted ? "text-atlas-ink" : "text-atlas-ink-muted"}`}>{channel.name}</p>
                          {submitted ? (
                            <p className="text-xs text-atlas-ink-muted truncate">{fmtDateTime(lastUpload)}</p>
                          ) : (<p className="text-xs text-red-400/70">No forecast yet</p>)}
                        </div>
                        <span className="text-sm font-mono flex-shrink-0" style={{ color: submitted ? "var(--atlas-ink)" : "var(--atlas-ink-faint)" }}>{submitted ? fmtQty(q) : "—"}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── KAM Tracker (admin / head_kam) ── */}
        {isAdminOrHead && selectedCycleId && (
          <div className="bg-atlas-surface border border-atlas-line rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-atlas-line">
              <h3 className="font-semibold text-atlas-ink">KAM Submission Tracker</h3>
              <p className="text-xs text-atlas-ink-muted mt-0.5">{cycleLoading ? "Loading..." : `${pendingKams} pending · ${completedKams} done out of ${kamStatuses.length} KAMs`}</p>
            </div>
            {kamStatuses.length === 0 ? (
              <div className="px-5 py-10 text-center text-atlas-ink-muted text-sm">No KAMs with channel assignments found.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-atlas-line text-left bg-atlas-surface/50">
                      <th className="px-4 py-3 text-xs text-atlas-ink-muted font-medium">Name</th>
                      <th className="px-4 py-3 text-xs text-atlas-ink-muted font-medium">Role</th>
                      <th className="px-4 py-3 text-xs text-atlas-ink-muted font-medium text-center">Channels</th>
                      <th className="px-4 py-3 text-xs text-atlas-ink-muted font-medium">Progress</th>
                      <th className="px-4 py-3 text-xs text-atlas-ink-muted font-medium">Last Upload</th>
                      <th className="px-4 py-3 text-xs text-atlas-ink-muted font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {kamStatuses.map(({ kam, assigned, submitted, lastUpload }) => {
                      const pct = assigned.length > 0 ? Math.round((submitted.length / assigned.length) * 100) : 0;
                      const done = submitted.length === assigned.length && assigned.length > 0;
                      const partial = submitted.length > 0 && !done;
                      return (
                        <tr key={kam.id} className="border-b border-atlas-line/50 hover:bg-atlas-surface-soft/20">
                          <td className="px-4 py-3"><p className="text-sm font-medium text-atlas-ink">{kam.full_name || "—"}</p><p className="text-xs text-atlas-ink-muted">{kam.email}</p></td>
                          <td className="px-4 py-3"><span className={`px-2 py-0.5 rounded text-xs font-medium ${kam.role === "head_kam" ? "bg-purple-100 text-purple-700 ring-1 ring-purple-300" : "bg-blue-100 text-blue-700 ring-1 ring-blue-300"}`}>{roleLabel(kam.role)}</span></td>
                          <td className="px-4 py-3 text-center"><span className="text-sm font-mono text-atlas-ink">{submitted.length}<span className="text-atlas-ink-muted">/{assigned.length}</span></span></td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2 min-w-[100px]">
                              <div className="flex-1 bg-atlas-surface-soft rounded-full h-1.5"><div className={`h-1.5 rounded-full transition-all ${done ? "bg-green-500" : partial ? "bg-amber-500" : "bg-red-500/60"}`} style={{ width: `${pct}%` }} /></div>
                              <span className="text-xs text-atlas-ink-muted w-8">{pct}%</span>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-xs text-atlas-ink-muted">{fmtDateTime(lastUpload)}</td>
                          <td className="px-4 py-3">{done ? <span className="px-2 py-0.5 rounded text-xs bg-green-500/20 text-green-400 font-medium">Done ✓</span> : partial ? <span className="px-2 py-0.5 rounded text-xs bg-amber-500/20 text-amber-400 font-medium">Partial</span> : <span className="px-2 py-0.5 rounded text-xs bg-red-500/20 text-red-400 font-medium">Pending</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── Version Comparison & Forecast Fidelity ── */}
        <div className="bg-atlas-surface border border-atlas-line rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-atlas-line">
            <h3 className="font-semibold text-atlas-ink">Version Comparison &amp; Forecast Fidelity</h3>
            <p className="text-xs text-atlas-ink-muted mt-0.5">Compare any two versions for the same forecast month to measure revision rate</p>
          </div>
          <div className="p-5">
            <div className="flex flex-wrap gap-3 mb-5">
              <div>
                <label className="block text-xs text-atlas-ink-muted mb-1.5">Forecast Month</label>
                <select value={vcMonth} onChange={(e) => { setVcMonth(e.target.value); setVcCycleA(""); setVcCycleB(""); setRawVcA([]); setRawVcB([]); setVcTriggered(false); }}
                  className="px-3 py-2 bg-atlas-surface-soft border border-atlas-line rounded-lg text-sm text-atlas-ink focus:outline-none focus:ring-1 focus:ring-blue-500">
                  <option value="">Select month...</option>
                  {vcMonths.map((m) => (<option key={m} value={m}>{fmtMonth(m)}</option>))}
                </select>
              </div>
              {vcMonth && (
                <>
                  <div>
                    <label className="block text-xs text-atlas-ink-muted mb-1.5">Version A <span className="text-blue-400">(Base)</span></label>
                    <select value={vcCycleA} onChange={(e) => { setVcCycleA(e.target.value); setRawVcA([]); setRawVcB([]); setVcTriggered(false); }}
                      className="px-3 py-2 bg-atlas-surface-soft border border-blue-500/40 rounded-lg text-sm text-atlas-ink focus:outline-none focus:ring-1 focus:ring-blue-500">
                      <option value="">Select V...</option>
                      {cyclesForVcMonth.map((c) => (<option key={c.id} value={c.id} disabled={c.id === vcCycleB}>V{c.version} — {c.status}</option>))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-atlas-ink-muted mb-1.5">Version B <span className="text-purple-400">(Compare)</span></label>
                    <select value={vcCycleB} onChange={(e) => { setVcCycleB(e.target.value); setRawVcA([]); setRawVcB([]); setVcTriggered(false); }}
                      className="px-3 py-2 bg-atlas-surface-soft border border-purple-500/40 rounded-lg text-sm text-atlas-ink focus:outline-none focus:ring-1 focus:ring-purple-500">
                      <option value="">Select V...</option>
                      {cyclesForVcMonth.map((c) => (<option key={c.id} value={c.id} disabled={c.id === vcCycleA}>V{c.version} — {c.status}</option>))}
                    </select>
                  </div>
                  <div className="flex items-end">
                    <button onClick={runVersionComparison} disabled={!vcCycleA || !vcCycleB || vcCycleA === vcCycleB || vcLoading}
                      className="px-5 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition">{vcLoading ? "Loading..." : "Compare →"}</button>
                  </div>
                </>
              )}
            </div>

            {!vcMonth && (<div className="py-10 text-center text-atlas-ink-faint text-sm">Select a forecast month to begin comparing versions.</div>)}
            {vcTriggered && !vcLoading && vcRows.length === 0 && vcCycleA && vcCycleB && (<div className="py-8 text-center text-atlas-ink-muted text-sm">No forecast data found for the selected versions.</div>)}

            {vcRows.length > 0 && (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
                  <div className="bg-blue-950/30 border border-blue-500/20 rounded-xl p-4"><p className="text-xs text-atlas-ink-muted mb-1">V{cycleA?.version} Total <span className="text-atlas-ink-faint">(Base)</span></p><p className="text-xl font-bold text-blue-400">{fmtQty(vcTotalA)}</p></div>
                  <div className="bg-purple-950/30 border border-purple-500/20 rounded-xl p-4"><p className="text-xs text-atlas-ink-muted mb-1">V{cycleB?.version} Total</p><p className="text-xl font-bold text-purple-400">{fmtQty(vcTotalB)}</p></div>
                  <div className={`rounded-xl p-4 border ${vcDelta >= 0 ? "bg-green-950/30 border-green-500/20" : "bg-red-950/30 border-red-500/20"}`}>
                    <p className="text-xs text-atlas-ink-muted mb-1">Net Change</p>
                    <p className={`text-xl font-bold ${vcDelta >= 0 ? "text-green-400" : "text-red-400"}`}>{vcDelta >= 0 ? "+" : ""}{fmtQty(vcDelta)}</p>
                    {vcDeltaPct !== null && (<p className={`text-xs mt-0.5 ${vcDelta >= 0 ? "text-green-500/70" : "text-red-500/70"}`}>{vcDeltaPct >= 0 ? "+" : ""}{vcDeltaPct.toFixed(1)}%</p>)}
                  </div>
                  <div className={`rounded-xl p-4 border ${vcFidelity !== null && vcFidelity >= 90 ? "bg-green-950/30 border-green-500/20" : vcFidelity !== null && vcFidelity >= 70 ? "bg-amber-950/30 border-amber-500/20" : "bg-red-950/30 border-red-500/20"}`}>
                    <p className="text-xs text-atlas-ink-muted mb-1">Forecast Fidelity</p>
                    <p className={`text-xl font-bold ${vcFidelity !== null && vcFidelity >= 90 ? "text-green-400" : vcFidelity !== null && vcFidelity >= 70 ? "text-amber-400" : "text-red-400"}`}>{vcFidelity !== null ? `${vcFidelity}%` : "—"}</p>
                    <p className="text-xs text-atlas-ink-faint mt-0.5">Lower revision = higher fidelity</p>
                  </div>
                </div>

                <div className="overflow-x-auto rounded-xl border border-atlas-line">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-atlas-surface-soft/50 border-b border-atlas-line text-left">
                        <th className="px-4 py-3 text-xs text-atlas-ink-muted font-medium">Channel</th>
                        <th className="px-4 py-3 text-xs text-blue-400 font-medium text-right">V{cycleA?.version}</th>
                        <th className="px-4 py-3 text-xs text-purple-400 font-medium text-right">V{cycleB?.version}</th>
                        <th className="px-4 py-3 text-xs text-atlas-ink-muted font-medium text-right">Δ Qty</th>
                        <th className="px-4 py-3 text-xs text-atlas-ink-muted font-medium text-right">Δ %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {vcRows.map(({ channel, cluster, qA, qB, delta, deltaPct }) => (
                        <tr key={channel.id} className="border-b border-atlas-line/40 hover:bg-atlas-surface-soft/20">
                          <td className="px-4 py-3"><p className="text-sm text-atlas-ink">{channel.name}</p>{cluster && <p className="text-xs text-atlas-ink-muted">{cluster.name}</p>}</td>
                          <td className="px-4 py-3 text-right font-mono text-blue-300 text-sm">{fmtQty(qA)}</td>
                          <td className="px-4 py-3 text-right font-mono text-purple-300 text-sm">{fmtQty(qB)}</td>
                          <td className={`px-4 py-3 text-right font-mono font-medium text-sm ${delta > 0 ? "text-green-400" : delta < 0 ? "text-red-400" : "text-atlas-ink-faint"}`}>{delta > 0 ? "+" : ""}{fmtQty(delta)}</td>
                          <td className={`px-4 py-3 text-right text-sm ${deltaPct !== null && deltaPct > 0 ? "text-green-400" : deltaPct !== null && deltaPct < 0 ? "text-red-400" : "text-atlas-ink-faint"}`}>{deltaPct !== null ? `${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}%` : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-atlas-surface-soft/40 border-t border-atlas-line">
                        <td className="px-4 py-3 text-sm font-semibold text-atlas-ink">Total</td>
                        <td className="px-4 py-3 text-right font-mono font-bold text-blue-400">{fmtQty(vcTotalA)}</td>
                        <td className="px-4 py-3 text-right font-mono font-bold text-purple-400">{fmtQty(vcTotalB)}</td>
                        <td className={`px-4 py-3 text-right font-mono font-bold ${vcDelta >= 0 ? "text-green-400" : "text-red-400"}`}>{vcDelta >= 0 ? "+" : ""}{fmtQty(vcDelta)}</td>
                        <td className={`px-4 py-3 text-right font-medium ${vcDeltaPct !== null && vcDeltaPct >= 0 ? "text-green-400" : "text-red-400"}`}>{vcDeltaPct !== null ? `${vcDeltaPct >= 0 ? "+" : ""}${vcDeltaPct.toFixed(1)}%` : "—"}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>

        {/* ── Quick Actions ── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Link href="/movement" className="bg-atlas-surface border border-atlas-line rounded-xl p-4 hover:border-blue-500/40 transition group">
            <p className="text-sm font-semibold group-hover:text-blue-400 transition">Forecast vs Movement</p>
            <p className="text-xs text-atlas-ink-muted mt-1">Daily FG movement tracker</p>
          </Link>
          <Link href="/channels" className="bg-atlas-surface border border-atlas-line rounded-xl p-4 hover:border-blue-500/40 transition group">
            <p className="text-sm font-semibold group-hover:text-blue-400 transition">Forecast View</p>
            <p className="text-xs text-atlas-ink-muted mt-1">Analyse by channel, cluster, SKU</p>
          </Link>
          {profile?.role === "admin" && (
            <Link href="/admin/cycles" className="bg-atlas-surface border border-atlas-line rounded-xl p-4 hover:border-blue-500/40 transition group">
              <p className="text-sm font-semibold group-hover:text-blue-400 transition">Manage Cycles</p>
              <p className="text-xs text-atlas-ink-muted mt-1">Open, lock, publish cycles</p>
            </Link>
          )}
          {profile?.role === "admin" && (
            <Link href="/admin/users" className="bg-atlas-surface border border-atlas-line rounded-xl p-4 hover:border-blue-500/40 transition group">
              <p className="text-sm font-semibold group-hover:text-blue-400 transition">Manage Users</p>
              <p className="text-xs text-atlas-ink-muted mt-1">Assign roles and channels</p>
            </Link>
          )}
        </div>

      </div>
    </AppShell>
  );
}
