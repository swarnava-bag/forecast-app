"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type SKU = { id: string; new_master_sku: string; product_name: string; category: string; is_active: boolean; discontinued_at: string | null };
type Channel = { id: string; name: string; cluster_id: string };
type Cluster = { id: string; name: string };
type Mapping = { channel_id: string; sku_id: string };

// CRITICAL: Use "::" as separator, NOT "-", because UUIDs contain dashes
function makeKey(skuId: string, channelId: string) { return `${skuId}::${channelId}`; }
function parseKey(key: string): [string, string] { const parts = key.split("::"); return [parts[0], parts[1]]; }

export default function SKUChannelMappingPage() {
  const [skus, setSkus] = useState<SKU[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [clusterFilter, setClusterFilter] = useState("");
  const [pendingChanges, setPendingChanges] = useState<Map<string, boolean>>(new Map());
  const supabase = createClient();

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);

    const { data: skuData } = await supabase
      .from("sku_master").select("*").eq("is_active", true).is("discontinued_at", null)
      .order("category").order("product_name");

    const { data: channelData } = await supabase
      .from("channels").select("*").eq("is_active", true).order("display_order");

    const { data: clusterData } = await supabase
      .from("clusters").select("*").order("display_order");

    // Paginate mappings - Supabase default limit is 1000
    let allMappings: Mapping[] = [];
    let from = 0;
    const PAGE = 1000;
    while (true) {
      const { data, error } = await supabase
        .from("channel_sku_mapping")
        .select("channel_id, sku_id")
        .eq("is_active", true)
        .range(from, from + PAGE - 1);
      if (error || !data || data.length === 0) break;
      allMappings = allMappings.concat(data);
      if (data.length < PAGE) break;
      from += PAGE;
    }

    if (skuData) setSkus(skuData);
    if (channelData) setChannels(channelData);
    if (clusterData) setClusters(clusterData);
    setMappings(allMappings);
    setLoading(false);
  }

  const categories = [...new Set(skus.map((s) => s.category).filter(Boolean))];

  const filteredSkus = skus.filter((sku) => {
    const matchesSearch = !searchTerm || sku.product_name.toLowerCase().includes(searchTerm.toLowerCase()) || sku.new_master_sku.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = !categoryFilter || sku.category === categoryFilter;
    return matchesSearch && matchesCategory;
  });

  const filteredChannels = clusterFilter ? channels.filter((ch) => ch.cluster_id === clusterFilter) : channels;

  // Build a Set for O(1) lookup instead of array.some() on every cell
  const mappingSet = new Set(mappings.map((m) => makeKey(m.sku_id, m.channel_id)));

  function isMapped(skuId: string, channelId: string): boolean {
    const key = makeKey(skuId, channelId);
    if (pendingChanges.has(key)) return pendingChanges.get(key)!;
    return mappingSet.has(key);
  }

  function toggleMapping(skuId: string, channelId: string) {
    const key = makeKey(skuId, channelId);
    const currentState = isMapped(skuId, channelId);
    setPendingChanges((prev) => {
      const next = new Map(prev);
      const originalState = mappingSet.has(key);
      if (!currentState === originalState) { next.delete(key); } else { next.set(key, !currentState); }
      return next;
    });
  }

  function toggleAllChannelsForSku(skuId: string) {
    const allMapped = filteredChannels.every((ch) => isMapped(skuId, ch.id));
    setPendingChanges((prev) => {
      const next = new Map(prev);
      filteredChannels.forEach((ch) => {
        const key = makeKey(skuId, ch.id);
        const originalState = mappingSet.has(key);
        const targetState = !allMapped;
        if (targetState === originalState) { next.delete(key); } else { next.set(key, targetState); }
      });
      return next;
    });
  }

  function toggleAllSkusForChannel(channelId: string) {
    const allMapped = filteredSkus.every((sku) => isMapped(sku.id, channelId));
    setPendingChanges((prev) => {
      const next = new Map(prev);
      filteredSkus.forEach((sku) => {
        const key = makeKey(sku.id, channelId);
        const originalState = mappingSet.has(key);
        const targetState = !allMapped;
        if (targetState === originalState) { next.delete(key); } else { next.set(key, targetState); }
      });
      return next;
    });
  }

  async function handleSave() {
    if (pendingChanges.size === 0) return;
    setSaving(true); setError(null);
    const { data: { user } } = await supabase.auth.getUser();
    let addCount = 0, removeCount = 0;

    // Batch adds and removes
    const toAdd: { channel_id: string; sku_id: string; is_active: boolean; created_by: string | undefined }[] = [];
    const toRemove: [string, string][] = []; // [skuId, channelId]

    for (const [key, shouldBeActive] of pendingChanges) {
      const [skuId, channelId] = parseKey(key);
      if (shouldBeActive) {
        toAdd.push({ channel_id: channelId, sku_id: skuId, is_active: true, created_by: user?.id });
      } else {
        toRemove.push([skuId, channelId]);
      }
    }

    // Batch upsert adds in chunks of 500
    for (let i = 0; i < toAdd.length; i += 500) {
      const chunk = toAdd.slice(i, i + 500);
      const { error } = await supabase.from("channel_sku_mapping").upsert(chunk, { onConflict: "channel_id,sku_id" });
      if (error) { setError(`Failed to add mappings: ${error.message}`); setSaving(false); return; }
      addCount += chunk.length;
    }

    // Process removes
    for (const [skuId, channelId] of toRemove) {
      await supabase.from("channel_sku_mapping").update({ is_active: false }).eq("channel_id", channelId).eq("sku_id", skuId);
      removeCount++;
    }

    await supabase.from("audit_log").insert({
      user_id: user?.id, user_email: user?.email, action: "update_sku_channel_mapping",
      table_name: "channel_sku_mapping", record_id: "batch",
      new_values: { added: addCount, removed: removeCount, total_changes: pendingChanges.size },
    });

    setSuccessMsg(`Saved! ${addCount} mappings added, ${removeCount} removed.`);
    setPendingChanges(new Map());
    loadData();
    setSaving(false);
    setTimeout(() => setSuccessMsg(null), 3000);
  }

  async function enableAllForAllChannels() {
    if (!window.confirm(`Enable ALL ${skus.length} SKUs for ALL ${channels.length} channels? This will create ${skus.length * channels.length} mappings.`)) return;
    setSaving(true); setError(null);
    const { data: { user } } = await supabase.auth.getUser();

    const inserts = [];
    for (const sku of skus) {
      for (const ch of channels) {
        inserts.push({ channel_id: ch.id, sku_id: sku.id, is_active: true, created_by: user?.id });
      }
    }

    for (let i = 0; i < inserts.length; i += 500) {
      const chunk = inserts.slice(i, i + 500);
      const { error } = await supabase.from("channel_sku_mapping").upsert(chunk, { onConflict: "channel_id,sku_id" });
      if (error) { setError(`Failed at batch ${Math.floor(i / 500) + 1}: ${error.message}`); setSaving(false); return; }
    }

    await supabase.from("audit_log").insert({
      user_id: user?.id, user_email: user?.email, action: "bulk_enable_all_sku_channels",
      table_name: "channel_sku_mapping", record_id: "all", new_values: { total: inserts.length },
    });

    setSuccessMsg(`All ${inserts.length} mappings enabled!`);
    setPendingChanges(new Map());
    loadData();
    setSaving(false);
    setTimeout(() => setSuccessMsg(null), 3000);
  }

  if (loading) {
    return <div className="flex items-center justify-center h-64"><p className="text-atlas-ink-muted">Loading mappings...</p></div>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">SKU-Channel Mapping</h2>
          <p className="text-sm text-atlas-ink-muted mt-1">
            Define which SKUs are available for each channel. {mappings.length} active mappings.
          </p>
        </div>
        <div className="flex gap-3">
          <button onClick={enableAllForAllChannels} disabled={saving}
            className="px-4 py-2 text-sm bg-atlas-surface-soft text-atlas-ink rounded-lg hover:bg-atlas-surface-soft disabled:opacity-50 transition">
            Enable All SKUs × All Channels
          </button>
          {pendingChanges.size > 0 && (
            <button onClick={handleSave} disabled={saving}
              className="px-4 py-2 text-sm bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-500 disabled:opacity-50 transition">
              {saving ? "Saving..." : `Save ${pendingChanges.size} Changes`}
            </button>
          )}
        </div>
      </div>

      {successMsg && <div className="mb-4 p-3 bg-green-900/50 border border-green-500 rounded-lg"><p className="text-green-300 text-sm">{successMsg}</p></div>}
      {error && <div className="mb-4 p-3 bg-red-900/50 border border-red-500 rounded-lg"><p className="text-red-300 text-sm">{error}</p></div>}

      {pendingChanges.size > 0 && (
        <div className="mb-4 p-3 bg-amber-900/30 border border-amber-500/50 rounded-lg flex items-center justify-between">
          <p className="text-amber-300 text-sm">{pendingChanges.size} unsaved changes. Click &quot;Save&quot; to apply.</p>
          <button onClick={() => setPendingChanges(new Map())} className="text-xs text-atlas-ink-muted hover:text-atlas-ink transition">Discard All</button>
        </div>
      )}

      <div className="flex gap-4 mb-4">
        <input type="text" placeholder="Search SKU name or code..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
          className="flex-1 px-4 py-2 bg-atlas-surface border border-atlas-line rounded-lg text-atlas-ink text-sm placeholder-atlas-ink-faint focus:outline-none focus:ring-2 focus:ring-blue-500" />
        <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}
          className="px-4 py-2 bg-atlas-surface border border-atlas-line rounded-lg text-atlas-ink text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="">All Categories</option>
          {categories.map((cat) => (<option key={cat} value={cat}>{cat}</option>))}
        </select>
        <select value={clusterFilter} onChange={(e) => setClusterFilter(e.target.value)}
          className="px-4 py-2 bg-atlas-surface border border-atlas-line rounded-lg text-atlas-ink text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="">All Clusters</option>
          {clusters.map((cl) => (<option key={cl.id} value={cl.id}>{cl.name}</option>))}
        </select>
      </div>

      <div className="bg-atlas-surface border border-atlas-line rounded-xl overflow-hidden">
        <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
          <table className="text-xs">
            <thead className="sticky top-0 bg-atlas-surface z-20">
              <tr className="border-b border-atlas-line">
                <th className="text-left py-2 px-3 text-atlas-ink-muted font-medium sticky left-0 bg-atlas-surface z-30 min-w-[200px]">SKU</th>
                <th className="text-center py-2 px-1 text-atlas-ink-muted font-medium min-w-[30px]">All</th>
                {filteredChannels.map((ch) => (
                  <th key={ch.id} className="text-center py-2 px-1 text-atlas-ink-muted font-medium min-w-[30px]">
                    <button onClick={() => toggleAllSkusForChannel(ch.id)} className="hover:text-blue-400 transition cursor-pointer" title={`Toggle all SKUs for ${ch.name}`}>
                      <div className="text-[10px] whitespace-nowrap" style={{ writingMode: "vertical-lr", transform: "rotate(180deg)", height: "80px" }}>{ch.name}</div>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredSkus.map((sku) => {
                const mappedCount = filteredChannels.filter((ch) => isMapped(sku.id, ch.id)).length;
                return (
                  <tr key={sku.id} className="border-b border-atlas-line/30 hover:bg-atlas-surface-soft/20">
                    <td className="py-1.5 px-3 sticky left-0 bg-atlas-surface z-10 border-r border-atlas-line">
                      <div className="flex items-center gap-2">
                        <div>
                          <p className="font-mono text-[10px] text-atlas-ink-faint">{sku.new_master_sku}</p>
                          <p className="text-xs text-atlas-ink truncate max-w-[180px]" title={sku.product_name}>{sku.product_name}</p>
                        </div>
                        <span className="text-[10px] text-atlas-ink-muted whitespace-nowrap">{mappedCount}/{filteredChannels.length}</span>
                      </div>
                    </td>
                    <td className="text-center py-1.5 px-1">
                      <button onClick={() => toggleAllChannelsForSku(sku.id)}
                        className="w-5 h-5 rounded border border-atlas-line flex items-center justify-center hover:border-blue-500 transition mx-auto text-[10px]"
                        title="Toggle all channels">
                        {mappedCount === filteredChannels.length ? "\u2713" : mappedCount > 0 ? "\u2014" : ""}
                      </button>
                    </td>
                    {filteredChannels.map((ch) => {
                      const mapped = isMapped(sku.id, ch.id);
                      const key = makeKey(sku.id, ch.id);
                      const hasChange = pendingChanges.has(key);
                      return (
                        <td key={ch.id} className="text-center py-1.5 px-1">
                          <button onClick={() => toggleMapping(sku.id, ch.id)}
                            className={`w-5 h-5 rounded transition mx-auto flex items-center justify-center text-[10px] ${
                              mapped
                                ? hasChange ? "bg-green-500 border border-green-400 text-black" : "bg-blue-500/80 border border-blue-500 text-white"
                                : hasChange ? "bg-red-500/30 border border-red-500" : "border border-atlas-line hover:border-atlas-ink-muted"
                            }`}>
                            {mapped ? "\u2713" : ""}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-6 text-xs text-atlas-ink-faint">
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-blue-500/80 border border-blue-500 inline-block"></span>Active mapping</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-green-500 border border-green-400 inline-block"></span>Newly added (unsaved)</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-red-500/30 border border-red-500 inline-block"></span>Being removed (unsaved)</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded border border-atlas-line inline-block"></span>Not mapped</span>
      </div>
    </div>
  );
}
