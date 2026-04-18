"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";

type Profile = { id: string; email: string; full_name: string; role: string };
type Cluster = { id: string; name: string; display_order: number; created_at: string };
type Channel = { id: string; name: string; cluster_id: string; display_order: number; is_active: boolean; created_at: string };

export default function AdminChannelsPage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Cluster form
  const [showClusterForm, setShowClusterForm] = useState(false);
  const [editingCluster, setEditingCluster] = useState<Cluster | null>(null);
  const [clusterName, setClusterName] = useState("");
  const [clusterOrder, setClusterOrder] = useState(0);
  const [savingCluster, setSavingCluster] = useState(false);

  // Channel form
  const [showChannelForm, setShowChannelForm] = useState(false);
  const [editingChannel, setEditingChannel] = useState<Channel | null>(null);
  const [channelName, setChannelName] = useState("");
  const [channelCluster, setChannelCluster] = useState("");
  const [channelOrder, setChannelOrder] = useState(0);
  const [channelActive, setChannelActive] = useState(true);
  const [savingChannel, setSavingChannel] = useState(false);

  // Expand/collapse
  const [expandedClusters, setExpandedClusters] = useState<Set<string>>(new Set());

  const supabase = createClient();

  useEffect(() => { init(); }, []);

  async function init() {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data: p } = await supabase.from("profiles").select("*").eq("id", user.id).single();
    setProfile(p);
    await loadData();
    setLoading(false);
  }

  async function loadData() {
    const { data: cl } = await supabase.from("clusters").select("*").order("display_order");
    if (cl) { setClusters(cl); setExpandedClusters(new Set(cl.map((c: Cluster) => c.id))); }
    const { data: ch } = await supabase.from("channels").select("*").order("display_order");
    if (ch) setChannels(ch);
  }

  function flash(msg: string) { setSuccessMsg(msg); setTimeout(() => setSuccessMsg(null), 3000); }

  function toggleCluster(id: string) {
    setExpandedClusters((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }

  // ====== CLUSTER CRUD ======

  function openClusterForm(cluster?: Cluster) {
    setEditingCluster(cluster || null);
    setClusterName(cluster?.name || "");
    setClusterOrder(cluster?.display_order || clusters.length + 1);
    setShowClusterForm(true);
    setShowChannelForm(false);
    setError(null);
  }

  async function saveCluster() {
    if (!clusterName.trim()) { setError("Cluster name is required."); return; }
    setSavingCluster(true); setError(null);
    if (editingCluster) {
      const { error: e } = await supabase.from("clusters").update({ name: clusterName.trim(), display_order: clusterOrder }).eq("id", editingCluster.id);
      if (e) { setError(e.message); setSavingCluster(false); return; }
      flash(`Cluster "${clusterName.trim()}" updated.`);
    } else {
      const { error: e } = await supabase.from("clusters").insert({ name: clusterName.trim(), display_order: clusterOrder });
      if (e) { setError(e.message); setSavingCluster(false); return; }
      flash(`Cluster "${clusterName.trim()}" created.`);
    }
    setShowClusterForm(false); setEditingCluster(null); await loadData(); setSavingCluster(false);
  }

  async function deleteCluster(cluster: Cluster) {
    const chCount = channels.filter((c) => c.cluster_id === cluster.id).length;
    if (chCount > 0) { setError(`Cannot delete "${cluster.name}" — has ${chCount} channel(s). Remove them first.`); return; }
    if (!confirm(`Delete cluster "${cluster.name}"?`)) return;
    const { error: e } = await supabase.from("clusters").delete().eq("id", cluster.id);
    if (e) { setError(e.message); return; }
    flash(`Cluster "${cluster.name}" deleted.`); await loadData();
  }

  // ====== CHANNEL CRUD ======

  function openChannelForm(channel?: Channel, presetClusterId?: string) {
    setEditingChannel(channel || null);
    setChannelName(channel?.name || "");
    setChannelCluster(channel?.cluster_id || presetClusterId || (clusters.length > 0 ? clusters[0].id : ""));
    setChannelOrder(channel?.display_order || channels.length + 1);
    setChannelActive(channel?.is_active ?? true);
    setShowChannelForm(true);
    setShowClusterForm(false);
    setError(null);
  }

  async function saveChannel() {
    if (!channelName.trim()) { setError("Channel name is required."); return; }
    if (!channelCluster) { setError("Select a cluster."); return; }
    setSavingChannel(true); setError(null);
    if (editingChannel) {
      const { error: e } = await supabase.from("channels").update({ name: channelName.trim(), cluster_id: channelCluster, display_order: channelOrder, is_active: channelActive }).eq("id", editingChannel.id);
      if (e) { setError(e.message); setSavingChannel(false); return; }
      flash(`Channel "${channelName.trim()}" updated.`);
    } else {
      const { error: e } = await supabase.from("channels").insert({ name: channelName.trim(), cluster_id: channelCluster, display_order: channelOrder, is_active: channelActive });
      if (e) { setError(e.message); setSavingChannel(false); return; }
      flash(`Channel "${channelName.trim()}" created.`);
    }
    setShowChannelForm(false); setEditingChannel(null); await loadData(); setSavingChannel(false);
  }

  async function toggleChannelActive(channel: Channel) {
    const { error: e } = await supabase.from("channels").update({ is_active: !channel.is_active }).eq("id", channel.id);
    if (e) { setError(e.message); return; }
    flash(`"${channel.name}" ${channel.is_active ? "deactivated" : "activated"}.`); await loadData();
  }

  async function deleteChannel(channel: Channel) {
    if (!confirm(`Delete channel "${channel.name}"? This removes all forecast data and user assignments for it.`)) return;
    const { error: e } = await supabase.from("channels").delete().eq("id", channel.id);
    if (e) { setError(e.message); return; }
    flash(`Channel "${channel.name}" deleted.`); await loadData();
  }

  // ====== RENDER ======

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64"><p style={{ color: "var(--atlas-ink-muted)" }}>Loading...</p></div>
    );
  }

  if (profile?.role !== "admin") {
    return (
      <div className="py-16 text-center">
        <h2 className="text-2xl font-bold mb-4">Access Restricted</h2>
        <p style={{ color: "var(--atlas-ink-muted)" }}>Admin access required.</p>
        <Link href="/dashboard" className="inline-block mt-6 px-6 py-2 bg-atlas-surface-soft rounded-lg text-sm hover:bg-atlas-surface-soft transition">Back to Dashboard</Link>
      </div>
    );
  }

  return (
    <div>
      <div className="max-w-5xl mx-auto">
        <div className="flex items-start justify-between mb-6">
          <div>
            <h2 className="text-2xl font-bold">Channels & Clusters</h2>
            <p className="text-sm text-atlas-ink-muted mt-1">{clusters.length} clusters, {channels.length} channels ({channels.filter((c) => c.is_active).length} active)</p>
          </div>
          <div className="flex gap-3">
            <button onClick={() => openClusterForm()} className="px-4 py-2 text-sm bg-atlas-surface-soft text-atlas-ink rounded-lg hover:bg-atlas-surface-soft transition">+ Cluster</button>
            <button onClick={() => openChannelForm()} className="px-4 py-2 text-sm bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-500 transition">+ Channel</button>
          </div>
        </div>

        {successMsg && <div className="mb-4 p-3 bg-green-900/50 border border-green-500 rounded-lg"><p className="text-green-300 text-sm">{successMsg}</p></div>}
        {error && <div className="mb-4 p-3 bg-red-900/50 border border-red-500 rounded-lg"><p className="text-red-300 text-sm">{error}</p></div>}

        {/* CLUSTER FORM */}
        {showClusterForm && (
          <div className="mb-6 bg-atlas-surface border border-blue-500/30 rounded-xl p-6">
            <h3 className="text-lg font-semibold text-blue-400 mb-4">{editingCluster ? "Edit Cluster" : "New Cluster"}</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
              <div className="md:col-span-2">
                <label className="block text-xs text-atlas-ink-muted mb-1">Cluster Name</label>
                <input type="text" value={clusterName} onChange={(e) => setClusterName(e.target.value)} placeholder="e.g. E-Commerce"
                  className="w-full px-4 py-2 bg-atlas-surface-soft border border-atlas-line rounded-lg text-atlas-ink text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-xs text-atlas-ink-muted mb-1">Display Order</label>
                <input type="number" value={clusterOrder} onChange={(e) => setClusterOrder(Number(e.target.value))}
                  className="w-full px-4 py-2 bg-atlas-surface-soft border border-atlas-line rounded-lg text-atlas-ink text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>
            <div className="flex gap-3">
              <button onClick={saveCluster} disabled={savingCluster}
                className="px-5 py-2 text-sm bg-blue-500 text-atlas-ink font-semibold rounded-lg hover:bg-blue-400 disabled:opacity-50 transition">
                {savingCluster ? "Saving..." : editingCluster ? "Update Cluster" : "Create Cluster"}
              </button>
              <button onClick={() => { setShowClusterForm(false); setEditingCluster(null); setError(null); }}
                className="px-5 py-2 text-sm bg-atlas-surface-soft text-atlas-ink rounded-lg hover:bg-atlas-surface-soft transition">Cancel</button>
            </div>
          </div>
        )}

        {/* CHANNEL FORM */}
        {showChannelForm && (
          <div className="mb-6 bg-atlas-surface border border-blue-500/30 rounded-xl p-6">
            <h3 className="text-lg font-semibold text-blue-400 mb-4">{editingChannel ? "Edit Channel" : "New Channel"}</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-xs text-atlas-ink-muted mb-1">Channel Name</label>
                <input type="text" value={channelName} onChange={(e) => setChannelName(e.target.value)} placeholder="e.g. Amazon"
                  className="w-full px-4 py-2 bg-atlas-surface-soft border border-atlas-line rounded-lg text-atlas-ink text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-xs text-atlas-ink-muted mb-1">Cluster</label>
                <select value={channelCluster} onChange={(e) => setChannelCluster(e.target.value)}
                  className="w-full px-4 py-2 bg-atlas-surface-soft border border-atlas-line rounded-lg text-atlas-ink text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="">Select cluster...</option>
                  {clusters.map((cl) => (<option key={cl.id} value={cl.id}>{cl.name}</option>))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-atlas-ink-muted mb-1">Display Order</label>
                <input type="number" value={channelOrder} onChange={(e) => setChannelOrder(Number(e.target.value))}
                  className="w-full px-4 py-2 bg-atlas-surface-soft border border-atlas-line rounded-lg text-atlas-ink text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-xs text-atlas-ink-muted mb-1">Status</label>
                <div className="flex items-center gap-3 mt-1">
                  <button onClick={() => setChannelActive(true)}
                    className={`px-4 py-2 text-sm rounded-lg transition ${channelActive ? "bg-green-500/20 text-green-400 ring-1 ring-green-500" : "bg-atlas-surface-soft text-atlas-ink-muted"}`}>Active</button>
                  <button onClick={() => setChannelActive(false)}
                    className={`px-4 py-2 text-sm rounded-lg transition ${!channelActive ? "bg-red-500/20 text-red-400 ring-1 ring-red-500" : "bg-atlas-surface-soft text-atlas-ink-muted"}`}>Inactive</button>
                </div>
              </div>
            </div>
            <div className="flex gap-3">
              <button onClick={saveChannel} disabled={savingChannel}
                className="px-5 py-2 text-sm bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-500 disabled:opacity-50 transition">
                {savingChannel ? "Saving..." : editingChannel ? "Update Channel" : "Create Channel"}
              </button>
              <button onClick={() => { setShowChannelForm(false); setEditingChannel(null); setError(null); }}
                className="px-5 py-2 text-sm bg-atlas-surface-soft text-atlas-ink rounded-lg hover:bg-atlas-surface-soft transition">Cancel</button>
            </div>
          </div>
        )}

        {/* CLUSTERS & CHANNELS LIST */}
        {clusters.length === 0 ? (
          <div className="bg-atlas-surface border border-atlas-line rounded-xl p-12 text-center">
            <p className="text-atlas-ink-muted mb-4">No clusters yet. Create your first cluster, then add channels to it.</p>
            <button onClick={() => openClusterForm()} className="px-4 py-2 text-sm bg-atlas-surface-soft text-atlas-ink rounded-lg hover:bg-atlas-surface-soft transition">+ Create Cluster</button>
          </div>
        ) : (
          <div className="space-y-3">
            {clusters.map((cl) => {
              const clChannels = channels.filter((ch) => ch.cluster_id === cl.id);
              const activeCount = clChannels.filter((c) => c.is_active).length;
              const isExpanded = expandedClusters.has(cl.id);
              return (
                <div key={cl.id} className="bg-atlas-surface border border-atlas-line rounded-xl overflow-hidden">
                  <div className="flex items-center justify-between px-6 py-4 cursor-pointer hover:bg-atlas-surface-soft/30 transition" onClick={() => toggleCluster(cl.id)}>
                    <div className="flex items-center gap-3">
                      <span className="text-atlas-ink-muted text-sm w-5">{isExpanded ? "\u25BC" : "\u25B6"}</span>
                      <div>
                        <span className="font-medium text-atlas-ink">{cl.name}</span>
                        <span className="ml-3 text-xs text-atlas-ink-muted">{clChannels.length} channel{clChannels.length !== 1 ? "s" : ""} ({activeCount} active)</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                      <span className="text-xs text-atlas-ink-faint mr-2">Order: {cl.display_order}</span>
                      <button onClick={() => openChannelForm(undefined, cl.id)} className="text-xs text-blue-400 hover:text-blue-300 transition">+ Channel</button>
                      <button onClick={() => openClusterForm(cl)} className="text-xs text-blue-400 hover:text-blue-300 transition ml-2">Edit</button>
                      <button onClick={() => deleteCluster(cl)} className="text-xs text-red-400 hover:text-red-300 transition ml-2">Delete</button>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="border-t border-atlas-line">
                      {clChannels.length === 0 ? (
                        <div className="px-6 py-4 text-center">
                          <p className="text-atlas-ink-faint text-sm">No channels in this cluster.</p>
                          <button onClick={() => openChannelForm(undefined, cl.id)} className="mt-2 text-xs text-blue-400 hover:text-blue-300">+ Add Channel</button>
                        </div>
                      ) : (
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="bg-atlas-surface-soft/30">
                              <th className="text-left py-2 px-6 text-atlas-ink-muted font-medium text-xs">Channel</th>
                              <th className="text-center py-2 px-4 text-atlas-ink-muted font-medium text-xs">Status</th>
                              <th className="text-center py-2 px-4 text-atlas-ink-muted font-medium text-xs">Order</th>
                              <th className="text-right py-2 px-6 text-atlas-ink-muted font-medium text-xs">Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {clChannels.map((ch) => (
                              <tr key={ch.id} className="border-t border-atlas-line/50 hover:bg-atlas-surface-soft/20 transition">
                                <td className="py-3 px-6"><span className={ch.is_active ? "text-atlas-ink" : "text-atlas-ink-muted line-through"}>{ch.name}</span></td>
                                <td className="py-3 px-4 text-center">
                                  <button onClick={() => toggleChannelActive(ch)}
                                    className={`px-2.5 py-0.5 rounded-full text-xs font-medium transition ${ch.is_active ? "bg-green-500/20 text-green-400 hover:bg-green-500/30" : "bg-red-500/20 text-red-400 hover:bg-red-500/30"}`}>
                                    {ch.is_active ? "Active" : "Inactive"}
                                  </button>
                                </td>
                                <td className="py-3 px-4 text-center text-xs text-atlas-ink-muted">{ch.display_order}</td>
                                <td className="py-3 px-6 text-right">
                                  <div className="flex items-center justify-end gap-3">
                                    <button onClick={() => openChannelForm(ch)} className="text-xs text-blue-400 hover:text-blue-300 transition">Edit</button>
                                    <button onClick={() => deleteChannel(ch)} className="text-xs text-red-400 hover:text-red-300 transition">Delete</button>
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}