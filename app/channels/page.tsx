"use client";
import { useEffect, useState, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";

type Profile = { id: string; email: string; full_name: string; role: string };
type Channel = { id: string; name: string; cluster_id: string; display_order: number };
type Cluster = { id: string; name: string; display_order: number };
type Cycle = { id: string; forecast_month: string; version: number; status: string; deadline: string | null };
type SKU = { id: string; new_master_sku: string; product_name: string; category: string; product_category: string };
type ForecastRow = { id: string; sku_id: string; channel_id: string; quantity: number; status: string; uploaded_by: string; forecast_month: string; uploader_email?: string };
type PendingEdit = { skuId: string; channelId: string; month: string; oldValue: number; newValue: number; forecastId: string | null };
type ViewLevel = "cluster" | "channel" | "sku";
type ViewMode = "original" | "channel" | "cluster" | "sku" | "skuXChannel" | "skuXCluster";

function addMonths(dateStr: string, n: number): string {
  const d = new Date(dateStr); d.setMonth(d.getMonth() + n); return d.toISOString().slice(0, 10);
}
function fmtMonth(d: string): string { return d ? new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "short" }) : ""; }
function fmtShort(d: string): string { return d ? new Date(d).toLocaleDateString("en-US", { month: "short" }) : ""; }

const VIEW_TABS: { key: ViewMode; label: string }[] = [
  { key: "original", label: "Original" },
  { key: "channel", label: "Channel View" },
  { key: "cluster", label: "Cluster View" },
  { key: "sku", label: "SKU View" },
  { key: "skuXChannel", label: "SKU × Channel" },
  { key: "skuXCluster", label: "SKU × Cluster" },
];

export default function ChannelsPage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [skus, setSkus] = useState<SKU[]>([]);
  const [forecastData, setForecastData] = useState<ForecastRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCycle, setSelectedCycle] = useState("");

  // Original view state
  const [viewLevel, setViewLevel] = useState<ViewLevel>("cluster");
  const [selectedCluster, setSelectedCluster] = useState<string | null>(null);
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [userClusterIds, setUserClusterIds] = useState<string[]>([]);
  const [userChannelIds, setUserChannelIds] = useState<string[]>([]);
  const [pendingEdits, setPendingEdits] = useState<Map<string, PendingEdit>>(new Map());
  const [saving, setSaving] = useState(false);
  const [showDiff, setShowDiff] = useState(false);

  // View mode + global filter state
  const [viewMode, setViewMode] = useState<ViewMode>("original");
  const [pivotMonth, setPivotMonth] = useState<"m1" | "m2" | "m3">("m1");
  const [globalCategoryFilter, setGlobalCategoryFilter] = useState("");
  const [globalSearchTerm, setGlobalSearchTerm] = useState("");
  const [clusterFilter, setClusterFilter] = useState("");

  // Sort state
  const [sortCol, setSortCol] = useState<string>("total");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const supabase = createClient();

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data: profileData } = await supabase.from("profiles").select("*").eq("id", user.id).single();
    setProfile(profileData);
    const { data: chData } = await supabase.from("channels").select("*").eq("is_active", true).order("display_order");
    if (chData) setChannels(chData);
    const { data: clData } = await supabase.from("clusters").select("*").order("display_order");
    if (clData) setClusters(clData);
    const { data: cyData } = await supabase.from("forecast_cycles").select("*").order("forecast_month", { ascending: false }).order("version", { ascending: false });
    if (cyData) { setCycles(cyData); if (cyData.length > 0) setSelectedCycle(cyData[0].id); }
    const { data: skuData } = await supabase.from("sku_master").select("id, new_master_sku, product_name, category, product_category").eq("is_active", true).is("discontinued_at", null).order("product_name");
    if (skuData) setSkus(skuData);
    if (profileData?.role === "head_kam") {
      const { data: uc } = await supabase.from("user_clusters").select("cluster_id").eq("user_id", user.id);
      if (uc) setUserClusterIds(uc.map((x: any) => x.cluster_id));
    }
    if (profileData?.role === "channel_kam") {
      const { data: uc } = await supabase.from("user_channels").select("channel_id").eq("user_id", user.id);
      if (uc) setUserChannelIds(uc.map((x: any) => x.channel_id));
    }
    setLoading(false);
  }

  useEffect(() => { if (selectedCycle) loadForecast(); }, [selectedCycle]);

  async function loadForecast() {
    if (!selectedCycle) return;
    const { data, error: fetchError } = await supabase.from("forecast_data")
      .select("id, sku_id, channel_id, quantity, status, uploaded_by, forecast_month")
      .eq("cycle_id", selectedCycle);
    if (fetchError || !data) { setForecastData([]); setPendingEdits(new Map()); return; }
    if (data.length > 0) {
      const uploaderIds = [...new Set(data.map((r: any) => r.uploaded_by).filter(Boolean))];
      const { data: uploaders } = await supabase.from("profiles").select("id, email").in("id", uploaderIds);
      const emailMap: Record<string, string> = {};
      if (uploaders) uploaders.forEach((u: any) => { emailMap[u.id] = u.email; });
      setForecastData(data.map((row: any) => ({ ...row, uploader_email: emailMap[row.uploaded_by] || null })));
    } else { setForecastData([]); }
    setPendingEdits(new Map());
  }

  const selectedCycleData = cycles.find((c) => c.id === selectedCycle);
  const m1 = selectedCycleData?.forecast_month || "";
  const m2 = m1 ? addMonths(m1, 1) : "";
  const m3 = m1 ? addMonths(m1, 2) : "";
  const m1Label = fmtMonth(m1); const m2Label = fmtMonth(m2); const m3Label = fmtMonth(m3);
  const m1Short = fmtShort(m1); const m2Short = fmtShort(m2); const m3Short = fmtShort(m3);
  const pivotMonthDate = pivotMonth === "m1" ? m1 : pivotMonth === "m2" ? m2 : m3;
  const pivotMonthShort = pivotMonth === "m1" ? m1Short : pivotMonth === "m2" ? m2Short : m3Short;

  const canEdit = useMemo(() => {
    if (!profile || !selectedCycleData) return false;
    if (selectedCycleData.status === "published") return false;
    if (selectedCycleData.status === "locked" && profile.role !== "admin") return false;
    if (selectedCycleData.deadline && new Date(selectedCycleData.deadline) < new Date() && profile.role !== "admin") return false;
    return ["admin", "head_kam", "channel_kam"].includes(profile.role);
  }, [profile, selectedCycleData]);

  function canEditChannel(channelId: string): boolean {
    if (!canEdit || !profile) return false;
    if (profile.role === "admin") return true;
    if (profile.role === "head_kam") { const ch = channels.find((c) => c.id === channelId); return ch ? userClusterIds.includes(ch.cluster_id) : false; }
    if (profile.role === "channel_kam") return userChannelIds.includes(channelId);
    return false;
  }

  function eKey(skuId: string, chId: string, month: string) { return `${skuId}-${chId}-${month}`; }

  function getQty(skuId: string, chId: string, month: string): number {
    const k = eKey(skuId, chId, month);
    if (pendingEdits.has(k)) return pendingEdits.get(k)!.newValue;
    const row = forecastData.find((r) => r.sku_id === skuId && r.channel_id === chId && r.forecast_month === month);
    return row?.quantity ?? 0;
  }

  function stageEdit(skuId: string, chId: string, month: string, newValue: number) {
    const k = eKey(skuId, chId, month);
    const row = forecastData.find((r) => r.sku_id === skuId && r.channel_id === chId && r.forecast_month === month);
    const oldValue = row?.quantity ?? 0;
    setPendingEdits((prev) => {
      const next = new Map(prev);
      if (newValue === oldValue) next.delete(k); else next.set(k, { skuId, channelId: chId, month, oldValue, newValue, forecastId: row?.id || null });
      return next;
    });
  }

  // === CLUSTER TOTALS ===
  const clusterAgg = useMemo(() => {
    const d: Record<string, { m1: number; m2: number; m3: number; drafts: number; pubs: number }> = {};
    clusters.forEach((cl) => { d[cl.id] = { m1: 0, m2: 0, m3: 0, drafts: 0, pubs: 0 }; });
    forecastData.forEach((row) => {
      const ch = channels.find((c) => c.id === row.channel_id);
      if (!ch || !d[ch.cluster_id]) return;
      const t = d[ch.cluster_id];
      if (row.forecast_month === m1) t.m1 += row.quantity;
      else if (row.forecast_month === m2) t.m2 += row.quantity;
      else if (row.forecast_month === m3) t.m3 += row.quantity;
      if (row.status === "draft") t.drafts++; else t.pubs++;
    });
    return d;
  }, [forecastData, clusters, channels, m1, m2, m3]);

  // === CHANNEL TOTALS (original view — selected cluster only) ===
  const channelAgg = useMemo(() => {
    if (!selectedCluster) return {};
    const d: Record<string, { m1: number; m2: number; m3: number; drafts: number; pubs: number }> = {};
    channels.filter((ch) => ch.cluster_id === selectedCluster).forEach((ch) => { d[ch.id] = { m1: 0, m2: 0, m3: 0, drafts: 0, pubs: 0 }; });
    forecastData.forEach((row) => {
      if (!d[row.channel_id]) return;
      const t = d[row.channel_id];
      if (row.forecast_month === m1) t.m1 += row.quantity;
      else if (row.forecast_month === m2) t.m2 += row.quantity;
      else if (row.forecast_month === m3) t.m3 += row.quantity;
      if (row.status === "draft") t.drafts++; else t.pubs++;
    });
    return d;
  }, [forecastData, selectedCluster, channels, m1, m2, m3]);

  // === ALL CHANNEL TOTALS (Channel View) ===
  const allChannelTotals = useMemo(() => {
    const d: Record<string, { m1: number; m2: number; m3: number }> = {};
    channels.forEach((ch) => { d[ch.id] = { m1: 0, m2: 0, m3: 0 }; });
    forecastData.forEach((row) => {
      if (!d[row.channel_id]) return;
      const t = d[row.channel_id];
      if (row.forecast_month === m1) t.m1 += row.quantity;
      else if (row.forecast_month === m2) t.m2 += row.quantity;
      else if (row.forecast_month === m3) t.m3 += row.quantity;
    });
    return d;
  }, [forecastData, channels, m1, m2, m3]);

  // === SKU ROWS (original view — selected channel) ===
  const skuRows = useMemo(() => {
    if (!selectedChannel) return [];
    const chRows = forecastData.filter((r) => r.channel_id === selectedChannel);
    return skus.map((sku) => {
      const q1 = getQty(sku.id, selectedChannel, m1);
      const q2 = getQty(sku.id, selectedChannel, m2);
      const q3 = getQty(sku.id, selectedChannel, m3);
      const row1 = chRows.find((r) => r.sku_id === sku.id && r.forecast_month === m1);
      const row2 = chRows.find((r) => r.sku_id === sku.id && r.forecast_month === m2);
      const row3 = chRows.find((r) => r.sku_id === sku.id && r.forecast_month === m3);
      const hasData = !!(row1 || row2 || row3);
      const hasEdit = pendingEdits.has(eKey(sku.id, selectedChannel, m1)) || pendingEdits.has(eKey(sku.id, selectedChannel, m2)) || pendingEdits.has(eKey(sku.id, selectedChannel, m3));
      const status = row1?.status || row2?.status || row3?.status || null;
      const uploader = row1?.uploader_email || row2?.uploader_email || row3?.uploader_email || null;
      return { ...sku, q1, q2, q3, hasData, hasEdit, status, uploader };
    }).filter((s) => {
      const ms = !searchTerm || s.product_name.toLowerCase().includes(searchTerm.toLowerCase()) || s.new_master_sku.toLowerCase().includes(searchTerm.toLowerCase());
      // FIX: use product_category first, fall back to category
      const mc = !categoryFilter || (s.product_category || s.category) === categoryFilter;
      return ms && mc && (s.hasData || s.hasEdit || searchTerm || categoryFilter);
    }).sort((a, b) => {
      if ((a.hasData || a.hasEdit) && !b.hasData && !b.hasEdit) return -1;
      if (!a.hasData && !a.hasEdit && (b.hasData || b.hasEdit)) return 1;
      return 0;
    });
  }, [forecastData, selectedChannel, skus, searchTerm, categoryFilter, pendingEdits, m1, m2, m3]);

  // === SKU LIST VIEW (all channels, aggregated) ===
  const skuListRows = useMemo(() => {
    const totals: Record<string, { m1: number; m2: number; m3: number }> = {};
    forecastData.forEach((row) => {
      if (!totals[row.sku_id]) totals[row.sku_id] = { m1: 0, m2: 0, m3: 0 };
      if (row.forecast_month === m1) totals[row.sku_id].m1 += row.quantity;
      else if (row.forecast_month === m2) totals[row.sku_id].m2 += row.quantity;
      else if (row.forecast_month === m3) totals[row.sku_id].m3 += row.quantity;
    });
    return skus
      .map((s) => ({ ...s, ...(totals[s.id] || { m1: 0, m2: 0, m3: 0 }) }))
      .filter((s) => {
        const hasData = s.m1 > 0 || s.m2 > 0 || s.m3 > 0;
        const mc = !globalCategoryFilter || (s.product_category || s.category) === globalCategoryFilter;
        const ms = !globalSearchTerm || s.product_name.toLowerCase().includes(globalSearchTerm.toLowerCase()) || s.new_master_sku.toLowerCase().includes(globalSearchTerm.toLowerCase());
        return hasData && mc && ms;
      })
      .sort((a, b) => (b.m1 + b.m2 + b.m3) - (a.m1 + a.m2 + a.m3));
  }, [forecastData, skus, globalCategoryFilter, globalSearchTerm, m1, m2, m3]);

  // === PIVOT CHANNELS (filtered by clusterFilter) ===
  const pivotChannels = useMemo(() => {
    if (!clusterFilter) return channels;
    return channels.filter((ch) => ch.cluster_id === clusterFilter);
  }, [channels, clusterFilter]);

  // === SKU × CHANNEL PIVOT DATA ===
  const skuXChannelData = useMemo(() => {
    const d: Record<string, Record<string, number>> = {};
    forecastData
      .filter((row) => row.forecast_month === pivotMonthDate)
      .forEach((row) => {
        if (!d[row.sku_id]) d[row.sku_id] = {};
        d[row.sku_id][row.channel_id] = (d[row.sku_id][row.channel_id] || 0) + row.quantity;
      });
    return d;
  }, [forecastData, pivotMonthDate]);

  // === SKU × CLUSTER PIVOT DATA ===
  const skuXClusterData = useMemo(() => {
    const d: Record<string, Record<string, number>> = {};
    forecastData
      .filter((row) => row.forecast_month === pivotMonthDate)
      .forEach((row) => {
        const ch = channels.find((c) => c.id === row.channel_id);
        if (!ch) return;
        if (!d[row.sku_id]) d[row.sku_id] = {};
        d[row.sku_id][ch.cluster_id] = (d[row.sku_id][ch.cluster_id] || 0) + row.quantity;
      });
    return d;
  }, [forecastData, channels, pivotMonthDate]);

  // === PIVOT SKU ROWS (shared filter for both pivot views) ===
  const pivotSkuRows = useMemo(() => {
    const skuIdsWithData = new Set(
      forecastData.filter((r) => r.forecast_month === pivotMonthDate && r.quantity > 0).map((r) => r.sku_id)
    );
    return skus.filter((s) => {
      if (!skuIdsWithData.has(s.id)) return false;
      const mc = !globalCategoryFilter || (s.product_category || s.category) === globalCategoryFilter;
      const ms = !globalSearchTerm || s.product_name.toLowerCase().includes(globalSearchTerm.toLowerCase()) || s.new_master_sku.toLowerCase().includes(globalSearchTerm.toLowerCase());
      return mc && ms;
    });
  }, [forecastData, skus, pivotMonthDate, globalCategoryFilter, globalSearchTerm]);

  // Grand totals
  const grandM1 = useMemo(() => forecastData.filter((r) => r.forecast_month === m1).reduce((s, r) => s + r.quantity, 0), [forecastData, m1]);
  const grandM2 = useMemo(() => forecastData.filter((r) => r.forecast_month === m2).reduce((s, r) => s + r.quantity, 0), [forecastData, m2]);
  const grandM3 = useMemo(() => forecastData.filter((r) => r.forecast_month === m3).reduce((s, r) => s + r.quantity, 0), [forecastData, m3]);
  const grandTotal = grandM1 + grandM2 + grandM3;

  // FIX: categories now use product_category with category fallback
  const categories = useMemo(() =>
    [...new Set(skus.map((s) => s.product_category || s.category).filter(Boolean))].sort()
  , [skus]);

  function toggleSort(col: string) {
    if (sortCol === col) setSortDir((d) => d === "asc" ? "desc" : "asc");
    else { setSortCol(col); setSortDir("desc"); }
  }
  function sortIcon(col: string) {
    if (sortCol !== col) return <span className="text-gray-700 ml-1">↕</span>;
    return <span className="text-amber-400 ml-1">{sortDir === "asc" ? "↑" : "↓"}</span>;
  }

  // === SKU counts per channel ===
  const channelSkuCounts = useMemo(() => {
    const d: Record<string, number> = {};
    const seen = new Set<string>();
    forecastData.forEach((row) => {
      const key = `${row.channel_id}-${row.sku_id}`;
      if (row.quantity > 0 && !seen.has(key)) { seen.add(key); d[row.channel_id] = (d[row.channel_id] || 0) + 1; }
    });
    return d;
  }, [forecastData]);

  // === SAVE ===
  async function handleSaveAll() {
    if (pendingEdits.size === 0) return;
    setSaving(true); setError(null);
    const { data: { user } } = await supabase.auth.getUser();
    let upd = 0, ins = 0;
    for (const [, edit] of pendingEdits) {
      if (edit.forecastId) {
        if (edit.newValue === 0) { await supabase.from("forecast_data").delete().eq("id", edit.forecastId); upd++; }
        else { const { error: e } = await supabase.from("forecast_data").update({ quantity: edit.newValue, updated_at: new Date().toISOString() }).eq("id", edit.forecastId); if (e) { setError(e.message); setSaving(false); return; } upd++; }
      } else if (edit.newValue > 0) {
        const { error: e } = await supabase.from("forecast_data").insert({
          sku_id: edit.skuId, channel_id: edit.channelId, forecast_month: edit.month,
          quantity: edit.newValue, version: selectedCycleData?.version || 1, status: "draft",
          cycle_id: selectedCycle, uploaded_by: user?.id, uploaded_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        });
        if (e) { setError(e.message); setSaving(false); return; }
        ins++;
      }
    }
    await supabase.from("audit_log").insert({ user_id: user?.id, user_email: user?.email, action: "inline_edit", table_name: "forecast_data", record_id: selectedCycle, new_values: { updated: upd, inserted: ins } });
    setSuccessMsg(`Saved! ${upd} updated, ${ins} new.`);
    setPendingEdits(new Map()); setShowDiff(false); loadForecast(); setSaving(false);
    setTimeout(() => setSuccessMsg(null), 3000);
  }

  function drillToCluster(id: string) { setSelectedCluster(id); setViewLevel("channel"); }
  function drillToChannel(id: string) { setSelectedChannel(id); setViewLevel("sku"); }
  function goBack() {
    if (viewLevel === "sku") { setSelectedChannel(null); setViewLevel("channel"); setSearchTerm(""); setCategoryFilter(""); }
    else if (viewLevel === "channel") { setSelectedCluster(null); setViewLevel("cluster"); }
  }

  const canDownload = profile?.role === "admin" || profile?.role === "supply_chain" || profile?.role === "head_kam";
  const selectedClusterData = clusters.find((cl) => cl.id === selectedCluster);
  const selectedChannelData = channels.find((ch) => ch.id === selectedChannel);

  async function downloadExcel() {
    if (!selectedCycle) return; setError(null);
    try {
      const response = await fetch(`/api/download-forecast?cycle_id=${selectedCycle}`);
      if (!response.ok) { const err = await response.json(); setError(`Download failed: ${err.error}`); return; }
      const blob = await response.blob(); const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url;
      const disp = response.headers.get("Content-Disposition"); const match = disp?.match(/filename="(.+)"/);
      a.download = match ? match[1] : `Forecast_${m1Label.replace(" ", "_")}_V${selectedCycleData?.version || 1}.xlsx`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    } catch (err: any) { setError(`Download failed: ${err.message}`); }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 text-white">
        <nav className="border-b border-gray-800 bg-gray-900"><div className="max-w-7xl mx-auto px-6 py-4"><Link href="/dashboard" className="text-lg font-bold text-white">Demand Planning Module - Yogabars</Link></div></nav>
        <div className="flex items-center justify-center h-64"><p className="text-gray-400">Loading...</p></div>
      </div>
    );
  }

  // ==================== RENDER ====================
  return (
    <div className="min-h-screen bg-gray-950 text-white pb-24">
      <nav className="border-b border-gray-800 bg-gray-900">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/dashboard" className="text-lg font-bold text-white">Demand Planning Module - Yogabars</Link>
            <div className="hidden md:flex items-center gap-4">
              <Link href="/dashboard" className="text-sm text-gray-400 hover:text-white transition">Dashboard</Link>
              <Link href="/upload" className="text-sm text-gray-400 hover:text-white transition">Upload</Link>
              <span className="text-sm text-amber-400 font-medium">Forecast View</span>
              <Link href="/combo-converter" className="text-sm text-gray-400 hover:text-white transition">Combo → Singles</Link>
              {profile?.role === "admin" && <Link href="/admin" className="text-sm text-gray-400 hover:text-white transition">Admin</Link>}
            </div>
          </div>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-6 py-8">

        {/* VIEW MODE TABS */}
        <div className="mb-6 overflow-x-auto">
          <div className="inline-flex bg-gray-900 border border-gray-800 rounded-xl p-1 gap-1 min-w-max">
            {VIEW_TABS.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setViewMode(key)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition whitespace-nowrap ${
                  viewMode === key
                    ? "bg-amber-500 text-black"
                    : "text-gray-400 hover:text-white hover:bg-gray-800"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Header */}
        <div className="flex items-start justify-between mb-6">
          <div>
            <h2 className="text-2xl font-bold">Forecast View</h2>
            <p className="text-sm text-gray-400 mt-1">
              {viewMode === "original" && viewLevel === "cluster" && "Consolidated view by cluster"}
              {viewMode === "original" && viewLevel === "channel" && `${selectedClusterData?.name} - Channel breakdown`}
              {viewMode === "original" && viewLevel === "sku" && `${selectedChannelData?.name} - SKU detail`}
              {viewMode === "channel" && "All channels with monthly totals"}
              {viewMode === "cluster" && "All clusters with monthly totals"}
              {viewMode === "sku" && "All SKUs aggregated across all channels"}
              {viewMode === "skuXChannel" && `SKU × Channel pivot — ${pivotMonthShort}`}
              {viewMode === "skuXCluster" && `SKU × Cluster pivot — ${pivotMonthShort}`}
              {viewMode === "original" && canEdit && viewLevel !== "cluster" && (
                <span className="text-amber-400 ml-2">· Editing enabled</span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <select value={selectedCycle} onChange={(e) => setSelectedCycle(e.target.value)}
              className="px-4 py-2 bg-gray-900 border border-gray-800 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-500">
              {cycles.length === 0 && <option value="">No cycles created</option>}
              {cycles.map((c) => (
                <option key={c.id} value={c.id}>
                  {fmtMonth(c.forecast_month)} - V{c.version} {c.status === "published" ? "✓" : c.status === "locked" ? "🔒" : "(open)"}
                </option>
              ))}
            </select>
            {canDownload && <button onClick={downloadExcel} className="px-4 py-2 text-sm bg-amber-500 text-black font-semibold rounded-lg hover:bg-amber-400 transition">Download Excel</button>}
          </div>
        </div>

        {successMsg && <div className="mb-4 p-3 bg-green-900/50 border border-green-500 rounded-lg"><p className="text-green-300 text-sm">{successMsg}</p></div>}
        {error && <div className="mb-4 p-3 bg-red-900/50 border border-red-500 rounded-lg"><p className="text-red-300 text-sm">{error}</p></div>}

        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className="text-xs text-gray-400">Total (3M)</p>
            <p className="text-2xl font-bold">{grandTotal.toLocaleString()}</p>
          </div>
          <div className="bg-gray-900 border border-amber-800/30 rounded-xl p-4">
            <p className="text-xs text-amber-400">{m1Label}</p>
            <p className="text-xl font-bold text-amber-400">{grandM1.toLocaleString()}</p>
          </div>
          <div className="bg-gray-900 border border-blue-800/30 rounded-xl p-4">
            <p className="text-xs text-blue-400">{m2Label}</p>
            <p className="text-xl font-bold text-blue-400">{grandM2.toLocaleString()}</p>
          </div>
          <div className="bg-gray-900 border border-purple-800/30 rounded-xl p-4">
            <p className="text-xs text-purple-400">{m3Label}</p>
            <p className="text-xl font-bold text-purple-400">{grandM3.toLocaleString()}</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className="text-xs text-gray-400">{pendingEdits.size > 0 ? "Pending" : "Status"}</p>
            {pendingEdits.size > 0 ? (
              <p className="text-xl font-bold text-amber-400">{pendingEdits.size} edits</p>
            ) : (
              <span className={`inline-block mt-1 px-2.5 py-1 rounded-full text-xs font-medium ${selectedCycleData?.status === "published" ? "bg-blue-500/20 text-blue-400" : selectedCycleData?.status === "locked" ? "bg-amber-500/20 text-amber-400" : "bg-green-500/20 text-green-400"}`}>
                {selectedCycleData?.status ? selectedCycleData.status.charAt(0).toUpperCase() + selectedCycleData.status.slice(1) : "None"}
              </span>
            )}
          </div>
        </div>

        {/* ====== ORIGINAL VIEW ====== */}
        {viewMode === "original" && (
          <>
            {/* Breadcrumb */}
            {viewLevel !== "cluster" && (
              <div className="flex items-center gap-2 mb-4 text-sm">
                <button onClick={() => { setViewLevel("cluster"); setSelectedCluster(null); setSelectedChannel(null); }} className="text-amber-400 hover:text-amber-300">All Clusters</button>
                <span className="text-gray-600">→</span>
                {viewLevel === "channel" && <span className="text-white font-medium">{selectedClusterData?.name}</span>}
                {viewLevel === "sku" && (
                  <>
                    <button onClick={goBack} className="text-amber-400 hover:text-amber-300">{selectedClusterData?.name}</button>
                    <span className="text-gray-600">→</span>
                    <span className="text-white font-medium">{selectedChannelData?.name}</span>
                  </>
                )}
              </div>
            )}

            {/* CLUSTER LEVEL */}
            {viewLevel === "cluster" && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-800 bg-gray-900/80">
                      <th className="text-left py-3 px-4 text-gray-400 font-medium">Cluster</th>
                      <th className="text-right py-3 px-4 text-amber-400 font-medium">{m1Short}</th>
                      <th className="text-right py-3 px-4 text-blue-400 font-medium">{m2Short}</th>
                      <th className="text-right py-3 px-4 text-purple-400 font-medium">{m3Short}</th>
                      <th className="text-right py-3 px-4 text-gray-400 font-medium">Total</th>
                      <th className="text-right py-3 px-4 text-gray-400 font-medium">Channels</th>
                      <th className="text-right py-3 px-4 text-gray-400 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {clusters.length === 0 ? (
                      <tr><td colSpan={7} className="py-8 text-center text-gray-500">No clusters found.</td></tr>
                    ) : clusters.map((cl) => {
                      const d = clusterAgg[cl.id] || { m1: 0, m2: 0, m3: 0, drafts: 0, pubs: 0 };
                      const tot = d.m1 + d.m2 + d.m3;
                      return (
                        <tr key={cl.id} onClick={() => drillToCluster(cl.id)} className="border-b border-gray-800/50 hover:bg-gray-800/30 cursor-pointer transition">
                          <td className="py-4 px-4 font-medium text-white">{cl.name}</td>
                          <td className="py-4 px-4 text-right font-mono text-amber-400/80">{d.m1 > 0 ? d.m1.toLocaleString() : <span className="text-gray-700">-</span>}</td>
                          <td className="py-4 px-4 text-right font-mono text-blue-400/80">{d.m2 > 0 ? d.m2.toLocaleString() : <span className="text-gray-700">-</span>}</td>
                          <td className="py-4 px-4 text-right font-mono text-purple-400/80">{d.m3 > 0 ? d.m3.toLocaleString() : <span className="text-gray-700">-</span>}</td>
                          <td className="py-4 px-4 text-right font-mono font-medium">{tot > 0 ? tot.toLocaleString() : <span className="text-gray-700">-</span>}</td>
                          <td className="py-4 px-4 text-right text-gray-400">{channels.filter((ch) => ch.cluster_id === cl.id).length}</td>
                          <td className="py-4 px-4 text-right">
                            {d.drafts > 0 && <span className="px-2 py-0.5 rounded text-xs bg-amber-500/20 text-amber-400 mr-1">{d.drafts} draft</span>}
                            {d.pubs > 0 && <span className="px-2 py-0.5 rounded text-xs bg-blue-500/20 text-blue-400">{d.pubs} pub</span>}
                            {d.drafts === 0 && d.pubs === 0 && <span className="text-gray-600 text-xs">No data</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-gray-800/50">
                      <td className="py-3 px-4 font-semibold">Grand Total</td>
                      <td className="py-3 px-4 text-right font-mono font-bold text-amber-400">{grandM1.toLocaleString()}</td>
                      <td className="py-3 px-4 text-right font-mono font-bold text-blue-400">{grandM2.toLocaleString()}</td>
                      <td className="py-3 px-4 text-right font-mono font-bold text-purple-400">{grandM3.toLocaleString()}</td>
                      <td className="py-3 px-4 text-right font-mono font-bold text-white">{grandTotal.toLocaleString()}</td>
                      <td className="py-3 px-4 text-right text-gray-400">{channels.length}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}

            {/* CHANNEL LEVEL */}
            {viewLevel === "channel" && selectedCluster && (() => {
              const clChans = channels.filter((ch) => ch.cluster_id === selectedCluster);
              const clM1 = clChans.reduce((s, ch) => s + (channelAgg[ch.id]?.m1 || 0), 0);
              const clM2 = clChans.reduce((s, ch) => s + (channelAgg[ch.id]?.m2 || 0), 0);
              const clM3 = clChans.reduce((s, ch) => s + (channelAgg[ch.id]?.m3 || 0), 0);
              return (
                <div>
                  <button onClick={goBack} className="mb-4 text-sm text-gray-400 hover:text-white transition">← Back to Clusters</button>
                  <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-800 bg-gray-900/80">
                          <th className="text-left py-3 px-4 text-gray-400 font-medium">Channel</th>
                          <th className="text-right py-3 px-4 text-amber-400 font-medium">{m1Short}</th>
                          <th className="text-right py-3 px-4 text-blue-400 font-medium">{m2Short}</th>
                          <th className="text-right py-3 px-4 text-purple-400 font-medium">{m3Short}</th>
                          <th className="text-right py-3 px-4 text-gray-400 font-medium">Total</th>
                          <th className="text-right py-3 px-4 text-gray-400 font-medium">Status</th>
                          <th className="text-center py-3 px-4 text-gray-400 font-medium w-20">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {clChans.map((ch) => {
                          const d = channelAgg[ch.id] || { m1: 0, m2: 0, m3: 0, drafts: 0, pubs: 0 };
                          const tot = d.m1 + d.m2 + d.m3;
                          return (
                            <tr key={ch.id} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition">
                              <td className="py-4 px-4 font-medium text-white cursor-pointer" onClick={() => drillToChannel(ch.id)}>{ch.name}</td>
                              <td className="py-4 px-4 text-right font-mono text-amber-400/80">{d.m1 > 0 ? d.m1.toLocaleString() : <span className="text-gray-700">-</span>}</td>
                              <td className="py-4 px-4 text-right font-mono text-blue-400/80">{d.m2 > 0 ? d.m2.toLocaleString() : <span className="text-gray-700">-</span>}</td>
                              <td className="py-4 px-4 text-right font-mono text-purple-400/80">{d.m3 > 0 ? d.m3.toLocaleString() : <span className="text-gray-700">-</span>}</td>
                              <td className="py-4 px-4 text-right font-mono font-medium">{tot > 0 ? tot.toLocaleString() : <span className="text-gray-700">-</span>}</td>
                              <td className="py-4 px-4 text-right">
                                {d.drafts > 0 && <span className="px-2 py-0.5 rounded text-xs bg-amber-500/20 text-amber-400 mr-1">{d.drafts} draft</span>}
                                {d.pubs > 0 && <span className="px-2 py-0.5 rounded text-xs bg-blue-500/20 text-blue-400">{d.pubs} pub</span>}
                                {d.drafts === 0 && d.pubs === 0 && <span className="text-gray-600 text-xs">No data</span>}
                              </td>
                              <td className="py-4 px-4 text-center">
                                <button onClick={() => drillToChannel(ch.id)} className="text-xs text-amber-400 hover:text-amber-300">View →</button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr className="bg-gray-800/50">
                          <td className="py-3 px-4 font-semibold">{selectedClusterData?.name} Total</td>
                          <td className="py-3 px-4 text-right font-mono font-bold text-amber-400">{clM1.toLocaleString()}</td>
                          <td className="py-3 px-4 text-right font-mono font-bold text-blue-400">{clM2.toLocaleString()}</td>
                          <td className="py-3 px-4 text-right font-mono font-bold text-purple-400">{clM3.toLocaleString()}</td>
                          <td className="py-3 px-4 text-right font-mono font-bold text-white">{(clM1 + clM2 + clM3).toLocaleString()}</td>
                          <td></td><td></td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              );
            })()}

            {/* SKU LEVEL */}
            {viewLevel === "sku" && selectedChannel && (
              <div>
                <button onClick={goBack} className="mb-4 text-sm text-gray-400 hover:text-white transition">← Back to {selectedClusterData?.name}</button>
                <div className="flex gap-4 mb-4">
                  <input type="text" placeholder="Search SKU..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
                    className="flex-1 px-4 py-2 bg-gray-900 border border-gray-800 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-amber-500" />
                  <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}
                    className="px-4 py-2 bg-gray-900 border border-gray-800 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-500">
                    <option value="">All Categories</option>
                    {categories.map((cat) => (<option key={cat} value={cat}>{cat}</option>))}
                  </select>
                </div>

                {/* Diff Panel */}
                {showDiff && pendingEdits.size > 0 && (
                  <div className="mb-4 bg-gray-900 border border-amber-500/30 rounded-xl p-4">
                    <h4 className="text-sm font-medium text-amber-400 mb-3">Pending Changes ({pendingEdits.size})</h4>
                    <div className="space-y-1 max-h-[200px] overflow-y-auto">
                      {Array.from(pendingEdits.values()).filter((e) => e.channelId === selectedChannel).map((edit, i) => {
                        const sku = skus.find((s) => s.id === edit.skuId);
                        return (
                          <div key={i} className="flex items-center justify-between text-xs py-1 px-2 rounded hover:bg-gray-800/50">
                            <span className="text-gray-300">{sku?.new_master_sku} - {sku?.product_name} <span className="text-gray-500">({fmtShort(edit.month)})</span></span>
                            <span>
                              <span className="text-red-400 line-through mr-2">{edit.oldValue.toLocaleString()}</span>
                              <span className="text-green-400">{edit.newValue.toLocaleString()}</span>
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                  <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-gray-900 z-10">
                        <tr className="border-b border-gray-800">
                          <th className="text-left py-3 px-3 text-gray-400 font-medium">New Master SKU</th>
                          <th className="text-left py-3 px-3 text-gray-400 font-medium">Product Name</th>
                          <th className="text-left py-3 px-3 text-gray-400 font-medium">Category</th>
                          <th className="text-right py-3 px-3 text-amber-400 font-medium">{m1Short}</th>
                          <th className="text-right py-3 px-3 text-blue-400 font-medium">{m2Short}</th>
                          <th className="text-right py-3 px-3 text-purple-400 font-medium">{m3Short}</th>
                          <th className="text-left py-3 px-3 text-gray-400 font-medium">Status</th>
                          <th className="text-left py-3 px-3 text-gray-400 font-medium">Uploaded By</th>
                        </tr>
                      </thead>
                      <tbody>
                        {skuRows.length === 0 ? (
                          <tr><td colSpan={8} className="py-8 text-center text-gray-500">No forecast data for this channel.</td></tr>
                        ) : skuRows.map((sku) => {
                          const editable = canEditChannel(selectedChannel);
                          const isEdited = sku.hasEdit;
                          return (
                            <tr key={sku.id} className={`border-b border-gray-800/50 transition ${isEdited ? "bg-amber-500/5" : "hover:bg-gray-800/20"}`}>
                              <td className="py-2.5 px-3 font-mono text-xs">{sku.new_master_sku}</td>
                              <td className="py-2.5 px-3 text-gray-300 text-sm">{sku.product_name}</td>
                              {/* FIX: show product_category, fall back to category */}
                              <td className="py-2.5 px-3 text-gray-400 text-xs">{sku.product_category || sku.category}</td>
                              {[{ val: sku.q1, month: m1, color: "amber" }, { val: sku.q2, month: m2, color: "blue" }, { val: sku.q3, month: m3, color: "purple" }].map(({ val, month, color }) => {
                                const k = eKey(sku.id, selectedChannel, month);
                                const edited = pendingEdits.has(k);
                                return (
                                  <td key={month} className="py-2.5 px-3 text-right">
                                    {editable ? (
                                      <input type="number" value={val}
                                        onChange={(e) => { const v = e.target.value === "" ? 0 : Number(e.target.value); if (!isNaN(v) && v >= 0) stageEdit(sku.id, selectedChannel, month, v); }}
                                        className={`w-20 px-2 py-1 bg-transparent border rounded text-right font-mono text-sm focus:outline-none focus:ring-1 focus:ring-${color}-500 ${edited ? `border-${color}-500 text-${color}-400` : "border-gray-700 text-white"}`} />
                                    ) : (
                                      <span className="font-mono text-sm">{val > 0 ? val.toLocaleString() : <span className="text-gray-700">-</span>}</span>
                                    )}
                                  </td>
                                );
                              })}
                              <td className="py-2.5 px-3">
                                {isEdited && <span className="px-2 py-0.5 rounded text-xs bg-amber-500/20 text-amber-400">Edited</span>}
                                {!isEdited && sku.status === "published" && <span className="px-2 py-0.5 rounded text-xs bg-blue-500/20 text-blue-400">Published</span>}
                                {!isEdited && sku.status === "draft" && <span className="px-2 py-0.5 rounded text-xs bg-gray-700 text-gray-300">Draft</span>}
                                {!isEdited && !sku.status && <span className="text-gray-600 text-xs">-</span>}
                              </td>
                              <td className="py-2.5 px-3 text-xs text-gray-500">{sku.uploader ? sku.uploader.split("@")[0] : "-"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                      {skuRows.length > 0 && (
                        <tfoot>
                          <tr className="bg-gray-800/50">
                            <td colSpan={3} className="py-3 px-3 font-semibold">{selectedChannelData?.name} Total</td>
                            <td className="py-3 px-3 text-right font-mono font-bold text-amber-400">{skuRows.reduce((s, r) => s + r.q1, 0).toLocaleString()}</td>
                            <td className="py-3 px-3 text-right font-mono font-bold text-blue-400">{skuRows.reduce((s, r) => s + r.q2, 0).toLocaleString()}</td>
                            <td className="py-3 px-3 text-right font-mono font-bold text-purple-400">{skuRows.reduce((s, r) => s + r.q3, 0).toLocaleString()}</td>
                            <td></td><td></td>
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {/* ====== CHANNEL VIEW ====== */}
        {viewMode === "channel" && (() => {
          const filteredCh = clusterFilter ? channels.filter((ch) => ch.cluster_id === clusterFilter) : channels;
          const rows = filteredCh.map((ch) => {
            const cl = clusters.find((c) => c.id === ch.cluster_id);
            const d = allChannelTotals[ch.id] || { m1: 0, m2: 0, m3: 0 };
            const tot = d.m1 + d.m2 + d.m3;
            const pct = grandTotal > 0 ? (tot / grandTotal) * 100 : 0;
            return { ch, cl, ...d, tot, pct, skuCount: channelSkuCounts[ch.id] || 0 };
          }).sort((a, b) => {
            const v = (x: typeof a) => sortCol === "m1" ? x.m1 : sortCol === "m2" ? x.m2 : sortCol === "m3" ? x.m3 : sortCol === "name" ? 0 : x.tot;
            if (sortCol === "name") return sortDir === "asc" ? a.ch.name.localeCompare(b.ch.name) : b.ch.name.localeCompare(a.ch.name);
            return sortDir === "asc" ? v(a) - v(b) : v(b) - v(a);
          });
          const filtTotal = rows.reduce((s, r) => s + r.tot, 0);
          return (
          <div>
            <div className="flex gap-3 mb-4">
              <select value={clusterFilter} onChange={(e) => setClusterFilter(e.target.value)}
                className="px-4 py-2 bg-gray-900 border border-gray-800 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-500">
                <option value="">All Clusters</option>
                {clusters.map((cl) => (<option key={cl.id} value={cl.id}>{cl.name}</option>))}
              </select>
              <span className="px-3 py-2 text-xs text-gray-500 self-center">{rows.length} channels</span>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800 bg-gray-900/80">
                    <th className="text-left py-3 px-4 text-gray-400 font-medium">Cluster</th>
                    <th className="text-left py-3 px-4 text-gray-400 font-medium cursor-pointer select-none" onClick={() => toggleSort("name")}>Channel{sortIcon("name")}</th>
                    <th className="text-right py-3 px-4 text-amber-400 font-medium cursor-pointer select-none" onClick={() => toggleSort("m1")}>{m1Short}{sortIcon("m1")}</th>
                    <th className="text-right py-3 px-4 text-blue-400 font-medium cursor-pointer select-none" onClick={() => toggleSort("m2")}>{m2Short}{sortIcon("m2")}</th>
                    <th className="text-right py-3 px-4 text-purple-400 font-medium cursor-pointer select-none" onClick={() => toggleSort("m3")}>{m3Short}{sortIcon("m3")}</th>
                    <th className="text-right py-3 px-4 text-gray-400 font-medium cursor-pointer select-none" onClick={() => toggleSort("total")}>Total{sortIcon("total")}</th>
                    <th className="text-right py-3 px-4 text-gray-400 font-medium">% Share</th>
                    <th className="text-right py-3 px-4 text-gray-400 font-medium">SKUs</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ ch, cl, m1: v1, m2: v2, m3: v3, tot, pct, skuCount }) => (
                    <tr key={ch.id} className="border-b border-gray-800/50 hover:bg-gray-800/20 transition">
                      <td className="py-3 px-4 text-gray-400 text-xs">{cl?.name}</td>
                      <td className="py-3 px-4 font-medium text-white">{ch.name}</td>
                      <td className="py-3 px-4 text-right font-mono text-amber-400/80">{v1 > 0 ? v1.toLocaleString() : <span className="text-gray-700">-</span>}</td>
                      <td className="py-3 px-4 text-right font-mono text-blue-400/80">{v2 > 0 ? v2.toLocaleString() : <span className="text-gray-700">-</span>}</td>
                      <td className="py-3 px-4 text-right font-mono text-purple-400/80">{v3 > 0 ? v3.toLocaleString() : <span className="text-gray-700">-</span>}</td>
                      <td className="py-3 px-4 text-right font-mono font-medium">{tot > 0 ? tot.toLocaleString() : <span className="text-gray-700">-</span>}</td>
                      <td className="py-3 px-4 text-right">
                        {pct > 0 ? (
                          <div className="flex items-center justify-end gap-2">
                            <div className="w-16 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                              <div className="h-full bg-amber-500/60 rounded-full" style={{ width: `${Math.min(pct, 100)}%` }} />
                            </div>
                            <span className="text-xs text-gray-400 w-10 text-right">{pct.toFixed(1)}%</span>
                          </div>
                        ) : <span className="text-gray-700 text-xs">-</span>}
                      </td>
                      <td className="py-3 px-4 text-right text-xs text-gray-500">{skuCount || "-"}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-gray-800/50">
                    <td colSpan={2} className="py-3 px-4 font-semibold">Total ({rows.length} channels)</td>
                    <td className="py-3 px-4 text-right font-mono font-bold text-amber-400">{rows.reduce((s, r) => s + r.m1, 0).toLocaleString()}</td>
                    <td className="py-3 px-4 text-right font-mono font-bold text-blue-400">{rows.reduce((s, r) => s + r.m2, 0).toLocaleString()}</td>
                    <td className="py-3 px-4 text-right font-mono font-bold text-purple-400">{rows.reduce((s, r) => s + r.m3, 0).toLocaleString()}</td>
                    <td className="py-3 px-4 text-right font-mono font-bold text-white">{filtTotal.toLocaleString()}</td>
                    <td className="py-3 px-4 text-right text-xs text-gray-400">{grandTotal > 0 ? ((filtTotal / grandTotal) * 100).toFixed(1) + "%" : ""}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
          );
        })()}

        {/* ====== CLUSTER VIEW ====== */}
        {viewMode === "cluster" && (() => {
          const rows = clusters.map((cl) => {
            const d = clusterAgg[cl.id] || { m1: 0, m2: 0, m3: 0, drafts: 0, pubs: 0 };
            const tot = d.m1 + d.m2 + d.m3;
            const pct = grandTotal > 0 ? (tot / grandTotal) * 100 : 0;
            const chCount = channels.filter((ch) => ch.cluster_id === cl.id).length;
            return { cl, ...d, tot, pct, chCount };
          }).sort((a, b) => {
            const v = (x: typeof a) => sortCol === "m1" ? x.m1 : sortCol === "m2" ? x.m2 : sortCol === "m3" ? x.m3 : sortCol === "name" ? 0 : x.tot;
            if (sortCol === "name") return sortDir === "asc" ? a.cl.name.localeCompare(b.cl.name) : b.cl.name.localeCompare(a.cl.name);
            return sortDir === "asc" ? v(a) - v(b) : v(b) - v(a);
          });
          return (
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 bg-gray-900/80">
                  <th className="text-left py-3 px-4 text-gray-400 font-medium cursor-pointer select-none" onClick={() => toggleSort("name")}>Cluster{sortIcon("name")}</th>
                  <th className="text-right py-3 px-4 text-amber-400 font-medium cursor-pointer select-none" onClick={() => toggleSort("m1")}>{m1Short}{sortIcon("m1")}</th>
                  <th className="text-right py-3 px-4 text-blue-400 font-medium cursor-pointer select-none" onClick={() => toggleSort("m2")}>{m2Short}{sortIcon("m2")}</th>
                  <th className="text-right py-3 px-4 text-purple-400 font-medium cursor-pointer select-none" onClick={() => toggleSort("m3")}>{m3Short}{sortIcon("m3")}</th>
                  <th className="text-right py-3 px-4 text-gray-400 font-medium cursor-pointer select-none" onClick={() => toggleSort("total")}>Total{sortIcon("total")}</th>
                  <th className="text-right py-3 px-4 text-gray-400 font-medium">% Share</th>
                  <th className="text-right py-3 px-4 text-gray-400 font-medium">Channels</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ cl, m1: v1, m2: v2, m3: v3, tot, pct, chCount }) => (
                  <tr key={cl.id} className="border-b border-gray-800/50 hover:bg-gray-800/20 transition">
                    <td className="py-4 px-4 font-medium text-white">{cl.name}</td>
                    <td className="py-4 px-4 text-right font-mono text-amber-400/80">{v1 > 0 ? v1.toLocaleString() : <span className="text-gray-700">-</span>}</td>
                    <td className="py-4 px-4 text-right font-mono text-blue-400/80">{v2 > 0 ? v2.toLocaleString() : <span className="text-gray-700">-</span>}</td>
                    <td className="py-4 px-4 text-right font-mono text-purple-400/80">{v3 > 0 ? v3.toLocaleString() : <span className="text-gray-700">-</span>}</td>
                    <td className="py-4 px-4 text-right font-mono font-medium">{tot > 0 ? tot.toLocaleString() : <span className="text-gray-700">-</span>}</td>
                    <td className="py-4 px-4 text-right">
                      {pct > 0 ? (
                        <div className="flex items-center justify-end gap-2">
                          <div className="w-20 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                            <div className="h-full bg-amber-500/60 rounded-full" style={{ width: `${Math.min(pct, 100)}%` }} />
                          </div>
                          <span className="text-xs text-gray-400 w-10 text-right">{pct.toFixed(1)}%</span>
                        </div>
                      ) : <span className="text-gray-700 text-xs">-</span>}
                    </td>
                    <td className="py-4 px-4 text-right text-gray-400">{chCount}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-gray-800/50">
                  <td className="py-3 px-4 font-semibold">Grand Total</td>
                  <td className="py-3 px-4 text-right font-mono font-bold text-amber-400">{grandM1.toLocaleString()}</td>
                  <td className="py-3 px-4 text-right font-mono font-bold text-blue-400">{grandM2.toLocaleString()}</td>
                  <td className="py-3 px-4 text-right font-mono font-bold text-purple-400">{grandM3.toLocaleString()}</td>
                  <td className="py-3 px-4 text-right font-mono font-bold text-white">{grandTotal.toLocaleString()}</td>
                  <td className="py-3 px-4 text-right text-xs text-gray-400">100%</td>
                  <td className="py-3 px-4 text-right text-gray-400">{channels.length}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          );
        })()}

        {/* ====== SKU VIEW ====== */}
        {viewMode === "sku" && (() => {
          const sorted = [...skuListRows].sort((a, b) => {
            const tot = (x: typeof a) => x.m1 + x.m2 + x.m3;
            const v = (x: typeof a) => sortCol === "m1" ? x.m1 : sortCol === "m2" ? x.m2 : sortCol === "m3" ? x.m3 : sortCol === "name" ? 0 : tot(x);
            if (sortCol === "name") return sortDir === "asc" ? a.product_name.localeCompare(b.product_name) : b.product_name.localeCompare(a.product_name);
            return sortDir === "asc" ? v(a) - v(b) : v(b) - v(a);
          });
          const skuGrandTotal = sorted.reduce((s, r) => s + r.m1 + r.m2 + r.m3, 0);
          return (
          <div>
            <div className="flex gap-3 mb-4">
              <input type="text" placeholder="Search SKU or product name..." value={globalSearchTerm} onChange={(e) => setGlobalSearchTerm(e.target.value)}
                className="flex-1 px-4 py-2 bg-gray-900 border border-gray-800 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-amber-500" />
              <select value={globalCategoryFilter} onChange={(e) => setGlobalCategoryFilter(e.target.value)}
                className="px-4 py-2 bg-gray-900 border border-gray-800 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-500">
                <option value="">All Categories</option>
                {categories.map((cat) => (<option key={cat} value={cat}>{cat}</option>))}
              </select>
              <span className="px-3 py-2 text-xs text-gray-500 self-center">{sorted.length} SKUs</span>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <div className="overflow-y-auto max-h-[600px]">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-gray-900 z-10">
                    <tr className="border-b border-gray-800">
                      <th className="text-left py-3 px-3 text-gray-400 font-medium">SKU Code</th>
                      <th className="text-left py-3 px-3 text-gray-400 font-medium cursor-pointer select-none" onClick={() => toggleSort("name")}>Product Name{sortIcon("name")}</th>
                      <th className="text-left py-3 px-3 text-gray-400 font-medium">Category</th>
                      <th className="text-right py-3 px-3 text-amber-400 font-medium cursor-pointer select-none" onClick={() => toggleSort("m1")}>{m1Short}{sortIcon("m1")}</th>
                      <th className="text-right py-3 px-3 text-blue-400 font-medium cursor-pointer select-none" onClick={() => toggleSort("m2")}>{m2Short}{sortIcon("m2")}</th>
                      <th className="text-right py-3 px-3 text-purple-400 font-medium cursor-pointer select-none" onClick={() => toggleSort("m3")}>{m3Short}{sortIcon("m3")}</th>
                      <th className="text-right py-3 px-3 text-gray-400 font-medium cursor-pointer select-none" onClick={() => toggleSort("total")}>Total{sortIcon("total")}</th>
                      <th className="text-right py-3 px-3 text-gray-400 font-medium">% Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.length === 0 ? (
                      <tr><td colSpan={8} className="py-8 text-center text-gray-500">No forecast data found.</td></tr>
                    ) : sorted.map((s) => {
                      const tot = s.m1 + s.m2 + s.m3;
                      const pct = skuGrandTotal > 0 ? (tot / skuGrandTotal) * 100 : 0;
                      return (
                        <tr key={s.id} className="border-b border-gray-800/50 hover:bg-gray-800/20 transition">
                          <td className="py-2.5 px-3 font-mono text-xs">{s.new_master_sku}</td>
                          <td className="py-2.5 px-3 text-gray-300">{s.product_name}</td>
                          <td className="py-2.5 px-3 text-gray-400 text-xs">{s.product_category || s.category}</td>
                          <td className="py-2.5 px-3 text-right font-mono text-amber-400/80">{s.m1 > 0 ? s.m1.toLocaleString() : <span className="text-gray-700">-</span>}</td>
                          <td className="py-2.5 px-3 text-right font-mono text-blue-400/80">{s.m2 > 0 ? s.m2.toLocaleString() : <span className="text-gray-700">-</span>}</td>
                          <td className="py-2.5 px-3 text-right font-mono text-purple-400/80">{s.m3 > 0 ? s.m3.toLocaleString() : <span className="text-gray-700">-</span>}</td>
                          <td className="py-2.5 px-3 text-right font-mono font-medium">{tot > 0 ? tot.toLocaleString() : <span className="text-gray-700">-</span>}</td>
                          <td className="py-2.5 px-3 text-right text-xs text-gray-500">{pct > 0 ? pct.toFixed(1) + "%" : "-"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  {sorted.length > 0 && (
                    <tfoot>
                      <tr className="bg-gray-800/50">
                        <td colSpan={3} className="py-3 px-3 font-semibold">Total ({sorted.length} SKUs)</td>
                        <td className="py-3 px-3 text-right font-mono font-bold text-amber-400">{sorted.reduce((s, r) => s + r.m1, 0).toLocaleString()}</td>
                        <td className="py-3 px-3 text-right font-mono font-bold text-blue-400">{sorted.reduce((s, r) => s + r.m2, 0).toLocaleString()}</td>
                        <td className="py-3 px-3 text-right font-mono font-bold text-purple-400">{sorted.reduce((s, r) => s + r.m3, 0).toLocaleString()}</td>
                        <td className="py-3 px-3 text-right font-mono font-bold text-white">{skuGrandTotal.toLocaleString()}</td>
                        <td className="py-3 px-3 text-right text-xs text-gray-400">100%</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </div>
          </div>
          );
        })()}

        {/* ====== SKU × CHANNEL PIVOT ====== */}
        {viewMode === "skuXChannel" && (
          <div>
            <div className="flex flex-wrap gap-3 mb-4">
              {/* Month selector */}
              <div className="flex rounded-lg overflow-hidden border border-gray-800">
                {(["m1", "m2", "m3"] as const).map((m) => (
                  <button key={m} onClick={() => setPivotMonth(m)}
                    className={`px-4 py-2 text-sm font-medium transition ${pivotMonth === m ? "bg-amber-500 text-black" : "bg-gray-900 text-gray-400 hover:text-white"}`}>
                    {m === "m1" ? m1Short : m === "m2" ? m2Short : m3Short}
                  </button>
                ))}
              </div>
              {/* Cluster filter to limit columns */}
              <select value={clusterFilter} onChange={(e) => setClusterFilter(e.target.value)}
                className="px-4 py-2 bg-gray-900 border border-gray-800 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-500">
                <option value="">All Clusters</option>
                {clusters.map((cl) => (<option key={cl.id} value={cl.id}>{cl.name}</option>))}
              </select>
              <input type="text" placeholder="Search SKU..." value={globalSearchTerm} onChange={(e) => setGlobalSearchTerm(e.target.value)}
                className="flex-1 min-w-[160px] px-4 py-2 bg-gray-900 border border-gray-800 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-amber-500" />
              <select value={globalCategoryFilter} onChange={(e) => setGlobalCategoryFilter(e.target.value)}
                className="px-4 py-2 bg-gray-900 border border-gray-800 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-500">
                <option value="">All Categories</option>
                {categories.map((cat) => (<option key={cat} value={cat}>{cat}</option>))}
              </select>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-x-auto">
              <div className="max-h-[600px] overflow-y-auto">
                <table className="text-sm">
                  <thead className="sticky top-0 bg-gray-900 z-10">
                    <tr className="border-b border-gray-800">
                      <th className="text-left py-3 px-3 text-gray-400 font-medium whitespace-nowrap sticky left-0 bg-gray-900 z-20 min-w-[110px]">SKU Code</th>
                      <th className="text-left py-3 px-3 text-gray-400 font-medium whitespace-nowrap min-w-[180px]">Product Name</th>
                      {pivotChannels.map((ch) => (
                        <th key={ch.id} className="text-right py-3 px-3 text-gray-400 font-medium whitespace-nowrap min-w-[90px]">{ch.name}</th>
                      ))}
                      <th className="text-right py-3 px-3 text-gray-300 font-semibold whitespace-nowrap">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pivotSkuRows.length === 0 ? (
                      <tr><td colSpan={pivotChannels.length + 3} className="py-8 text-center text-gray-500">No data for selected filters.</td></tr>
                    ) : pivotSkuRows.map((s) => {
                      const rowData = skuXChannelData[s.id] || {};
                      const rowTotal = pivotChannels.reduce((sum, ch) => sum + (rowData[ch.id] || 0), 0);
                      return (
                        <tr key={s.id} className="border-b border-gray-800/50 hover:bg-gray-800/20 transition">
                          <td className="py-2 px-3 font-mono text-xs sticky left-0 bg-gray-900 whitespace-nowrap">{s.new_master_sku}</td>
                          <td className="py-2 px-3 text-gray-300 text-xs whitespace-nowrap max-w-[200px] truncate">{s.product_name}</td>
                          {pivotChannels.map((ch) => {
                            const qty = rowData[ch.id] || 0;
                            return (
                              <td key={ch.id} className="py-2 px-3 text-right font-mono text-xs">
                                {qty > 0 ? qty.toLocaleString() : <span className="text-gray-700">-</span>}
                              </td>
                            );
                          })}
                          <td className="py-2 px-3 text-right font-mono text-xs font-semibold">{rowTotal > 0 ? rowTotal.toLocaleString() : <span className="text-gray-700">-</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  {pivotSkuRows.length > 0 && (
                    <tfoot>
                      <tr className="bg-gray-800/50">
                        <td colSpan={2} className="py-3 px-3 font-semibold sticky left-0 bg-gray-800">Channel Total</td>
                        {pivotChannels.map((ch) => {
                          const colTotal = pivotSkuRows.reduce((sum, s) => sum + ((skuXChannelData[s.id] || {})[ch.id] || 0), 0);
                          return <td key={ch.id} className="py-3 px-3 text-right font-mono font-bold">{colTotal > 0 ? colTotal.toLocaleString() : <span className="text-gray-700">-</span>}</td>;
                        })}
                        <td className="py-3 px-3 text-right font-mono font-bold text-white">
                          {pivotSkuRows.reduce((sum, s) => sum + pivotChannels.reduce((s2, ch) => s2 + ((skuXChannelData[s.id] || {})[ch.id] || 0), 0), 0).toLocaleString()}
                        </td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ====== SKU × CLUSTER PIVOT ====== */}
        {viewMode === "skuXCluster" && (
          <div>
            <div className="flex flex-wrap gap-3 mb-4">
              {/* Month selector */}
              <div className="flex rounded-lg overflow-hidden border border-gray-800">
                {(["m1", "m2", "m3"] as const).map((m) => (
                  <button key={m} onClick={() => setPivotMonth(m)}
                    className={`px-4 py-2 text-sm font-medium transition ${pivotMonth === m ? "bg-amber-500 text-black" : "bg-gray-900 text-gray-400 hover:text-white"}`}>
                    {m === "m1" ? m1Short : m === "m2" ? m2Short : m3Short}
                  </button>
                ))}
              </div>
              <input type="text" placeholder="Search SKU..." value={globalSearchTerm} onChange={(e) => setGlobalSearchTerm(e.target.value)}
                className="flex-1 min-w-[160px] px-4 py-2 bg-gray-900 border border-gray-800 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-amber-500" />
              <select value={globalCategoryFilter} onChange={(e) => setGlobalCategoryFilter(e.target.value)}
                className="px-4 py-2 bg-gray-900 border border-gray-800 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-500">
                <option value="">All Categories</option>
                {categories.map((cat) => (<option key={cat} value={cat}>{cat}</option>))}
              </select>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-x-auto">
              <div className="max-h-[600px] overflow-y-auto">
                <table className="text-sm">
                  <thead className="sticky top-0 bg-gray-900 z-10">
                    <tr className="border-b border-gray-800">
                      <th className="text-left py-3 px-3 text-gray-400 font-medium whitespace-nowrap sticky left-0 bg-gray-900 z-20 min-w-[110px]">SKU Code</th>
                      <th className="text-left py-3 px-3 text-gray-400 font-medium whitespace-nowrap min-w-[180px]">Product Name</th>
                      {clusters.map((cl) => (
                        <th key={cl.id} className="text-right py-3 px-3 text-gray-400 font-medium whitespace-nowrap min-w-[100px]">{cl.name}</th>
                      ))}
                      <th className="text-right py-3 px-3 text-gray-300 font-semibold whitespace-nowrap">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pivotSkuRows.length === 0 ? (
                      <tr><td colSpan={clusters.length + 3} className="py-8 text-center text-gray-500">No data for selected filters.</td></tr>
                    ) : pivotSkuRows.map((s) => {
                      const rowData = skuXClusterData[s.id] || {};
                      const rowTotal = clusters.reduce((sum, cl) => sum + (rowData[cl.id] || 0), 0);
                      return (
                        <tr key={s.id} className="border-b border-gray-800/50 hover:bg-gray-800/20 transition">
                          <td className="py-2 px-3 font-mono text-xs sticky left-0 bg-gray-900 whitespace-nowrap">{s.new_master_sku}</td>
                          <td className="py-2 px-3 text-gray-300 text-xs whitespace-nowrap max-w-[200px] truncate">{s.product_name}</td>
                          {clusters.map((cl) => {
                            const qty = rowData[cl.id] || 0;
                            return (
                              <td key={cl.id} className="py-2 px-3 text-right font-mono text-xs">
                                {qty > 0 ? qty.toLocaleString() : <span className="text-gray-700">-</span>}
                              </td>
                            );
                          })}
                          <td className="py-2 px-3 text-right font-mono text-xs font-semibold">{rowTotal > 0 ? rowTotal.toLocaleString() : <span className="text-gray-700">-</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  {pivotSkuRows.length > 0 && (
                    <tfoot>
                      <tr className="bg-gray-800/50">
                        <td colSpan={2} className="py-3 px-3 font-semibold sticky left-0 bg-gray-800">Cluster Total</td>
                        {clusters.map((cl) => {
                          const colTotal = pivotSkuRows.reduce((sum, s) => sum + ((skuXClusterData[s.id] || {})[cl.id] || 0), 0);
                          return <td key={cl.id} className="py-3 px-3 text-right font-mono font-bold">{colTotal > 0 ? colTotal.toLocaleString() : <span className="text-gray-700">-</span>}</td>;
                        })}
                        <td className="py-3 px-3 text-right font-mono font-bold text-white">
                          {pivotSkuRows.reduce((sum, s) => sum + clusters.reduce((s2, cl) => s2 + ((skuXClusterData[s.id] || {})[cl.id] || 0), 0), 0).toLocaleString()}
                        </td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </div>
          </div>
        )}

      </div>

      {/* Floating Save Bar (original view only) */}
      {pendingEdits.size > 0 && (
        <div className="fixed bottom-0 left-0 right-0 bg-gray-900 border-t border-amber-500/30 px-6 py-4 z-50">
          <div className="max-w-7xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-4">
              <span className="text-amber-400 font-semibold">{pendingEdits.size} unsaved changes</span>
              <button onClick={() => setShowDiff(!showDiff)} className="text-xs text-gray-400 hover:text-white transition">{showDiff ? "Hide diff" : "View diff"}</button>
            </div>
            <div className="flex items-center gap-3">
              <button onClick={() => setPendingEdits(new Map())} className="px-4 py-2 text-sm bg-gray-800 text-gray-300 rounded-lg hover:bg-gray-700 transition">Discard</button>
              <button onClick={handleSaveAll} disabled={saving} className="px-6 py-2 text-sm bg-amber-500 text-black font-semibold rounded-lg hover:bg-amber-400 disabled:opacity-50 transition">
                {saving ? "Saving..." : "Save All Changes"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
