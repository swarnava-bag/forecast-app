"use client";
import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";

type Cycle = {
  id: string;
  forecast_month: string;
  version: number;
  status: string;
  deadline: string | null;
  opened_at: string;
  locked_at: string | null;
  published_at: string | null;
  notes: string | null;
};

type DataCounts = Record<string, { draft: number; published: number; total: number }>;

type CarryForwardPreview = {
  source_cycle: { id: string; forecast_month: string; version: number; published_at: string };
  total_in_source: number;
  will_copy: number;
  will_skip: number;
};

export default function ForecastCyclesPage() {
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [counts, setCounts] = useState<DataCounts>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Create modal
  const [showCreate, setShowCreate] = useState(false);
  const [newMonth, setNewMonth] = useState("");
  const [newDeadline, setNewDeadline] = useState("");
  const [newNotes, setNewNotes] = useState("");

  // Carry Forward modal
  const [cfTarget, setCfTarget] = useState<Cycle | null>(null);
  const [cfPreview, setCfPreview] = useState<CarryForwardPreview | null>(null);
  const [cfLoading, setCfLoading] = useState(false);

  // Delete modal
  const [deleteTarget, setDeleteTarget] = useState<Cycle | null>(null);
  const [deleteMode, setDeleteMode] = useState<"full" | "drafts">("drafts");
  const [deleteConfirmText, setDeleteConfirmText] = useState("");

  const supabase = createClient();

  const loadCycles = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("forecast_cycles")
      .select("*")
      .order("forecast_month", { ascending: false })
      .order("version", { ascending: false });
    if (data) {
      setCycles(data);
      loadCounts(data);
    }
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { loadCycles(); }, [loadCycles]);

  async function loadCounts(cycleList: Cycle[]) {
    if (cycleList.length === 0) return;
    const ids = cycleList.map((c) => c.id);
    const { data } = await supabase
      .from("forecast_data")
      .select("cycle_id, status")
      .in("cycle_id", ids);
    if (!data) return;
    const result: DataCounts = {};
    for (const id of ids) result[id] = { draft: 0, published: 0, total: 0 };
    for (const row of data) {
      if (!result[row.cycle_id]) result[row.cycle_id] = { draft: 0, published: 0, total: 0 };
      result[row.cycle_id].total++;
      if (row.status === "draft") result[row.cycle_id].draft++;
      if (row.status === "published") result[row.cycle_id].published++;
    }
    setCounts(result);
  }

  async function createCycle() {
    if (!newMonth) return;
    setSaving(true);
    setError(null);
    const { data: { user } } = await supabase.auth.getUser();
    const existing = cycles.filter((c) => c.forecast_month === newMonth + "-01");
    const nextVersion = existing.length > 0 ? Math.max(...existing.map((c) => c.version)) + 1 : 1;

    const { error: insertError } = await supabase.from("forecast_cycles").insert({
      forecast_month: newMonth + "-01",
      version: nextVersion,
      status: "open",
      deadline: newDeadline ? new Date(newDeadline).toISOString() : null,
      created_by: user?.id,
      notes: newNotes || null,
    });

    if (insertError) {
      setError(insertError.message);
    } else {
      showSuccess(`Forecast cycle V${nextVersion} for ${newMonth} created!`);
      setShowCreate(false);
      setNewMonth(""); setNewDeadline(""); setNewNotes("");
      loadCycles();
    }
    setSaving(false);
  }

  async function updateStatus(cycle: Cycle, newStatus: string) {
    const label = `${formatMonth(cycle.forecast_month)} V${cycle.version}`;
    const msg =
      newStatus === "locked" ? `Lock submissions for ${label}? Teams will no longer be able to edit.`
      : newStatus === "published" ? `Publish ${label}? All draft data will become the official forecast. This cannot be undone.`
      : `Re-open ${label}? Teams will be able to edit again.`;
    if (!window.confirm(msg)) return;

    const { data: { user } } = await supabase.auth.getUser();
    const updates: Record<string, unknown> = { status: newStatus };
    if (newStatus === "locked") updates.locked_at = new Date().toISOString();
    if (newStatus === "published") { updates.published_at = new Date().toISOString(); updates.published_by = user?.id; }
    if (newStatus === "open") updates.locked_at = null;

    await supabase.from("forecast_cycles").update(updates).eq("id", cycle.id);

    if (newStatus === "published") {
      await supabase.from("forecast_data")
        .update({ status: "published", updated_at: new Date().toISOString() })
        .eq("cycle_id", cycle.id).in("status", ["draft", "submitted"]);
    }

    await supabase.from("audit_log").insert({
      user_id: user?.id, user_email: user?.email,
      action: `cycle_${newStatus}`, table_name: "forecast_cycles",
      record_id: cycle.id,
      old_values: { status: cycle.status }, new_values: { status: newStatus },
    });

    showSuccess(`Cycle ${newStatus}!`);
    loadCycles();
  }

  // ── Carry Forward ──────────────────────────────────────────────────────────
  async function openCarryForward(cycle: Cycle) {
    setCfTarget(cycle);
    setCfPreview(null);
    setCfLoading(true);
    try {
      const res = await fetch("/api/admin/carry-forward", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_cycle_id: cycle.id, preview: true }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error); setCfTarget(null); }
      else setCfPreview(data);
    } finally {
      setCfLoading(false);
    }
  }

  async function confirmCarryForward() {
    if (!cfTarget) return;
    setActionLoading(true);
    try {
      const res = await fetch("/api/admin/carry-forward", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_cycle_id: cfTarget.id }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error);
      else showSuccess(`Carried forward ${data.copied} records. ${data.skipped} already existed and were kept.`);
    } finally {
      setActionLoading(false);
      setCfTarget(null);
      setCfPreview(null);
      loadCycles();
    }
  }

  // ── Delete cycle / clear drafts ────────────────────────────────────────────
  async function confirmDelete() {
    if (!deleteTarget) return;
    const isDraftsOnly = deleteMode === "drafts";

    // Full delete requires typing the label to confirm
    if (!isDraftsOnly) {
      const label = `${formatMonth(deleteTarget.forecast_month)} V${deleteTarget.version}`;
      if (deleteConfirmText.trim() !== label) {
        setError(`Type exactly "${label}" to confirm.`);
        return;
      }
    }

    setActionLoading(true);
    try {
      const res = await fetch("/api/admin/delete-cycle", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cycle_id: deleteTarget.id, drafts_only: isDraftsOnly }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error);
      else showSuccess(isDraftsOnly ? "All draft data cleared." : "Cycle deleted permanently.");
    } finally {
      setActionLoading(false);
      setDeleteTarget(null);
      setDeleteConfirmText("");
      loadCycles();
    }
  }

  function showSuccess(msg: string) {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(null), 4000);
  }

  function formatMonth(dateStr: string) {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short" });
  }

  function formatDateTime(dateStr: string | null) {
    if (!dateStr) return "—";
    return new Date(dateStr).toLocaleString("en-US", {
      month: "short", day: "numeric", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  }

  const statusColors: Record<string, string> = {
    open: "bg-green-500/20 text-green-400 border border-green-500/30",
    locked: "bg-amber-500/20 text-amber-400 border border-amber-500/30",
    published: "bg-blue-500/20 text-blue-400 border border-blue-500/30",
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64"><p className="text-gray-400">Loading...</p></div>;
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">Forecast Cycles</h2>
          <p className="text-sm text-gray-400 mt-1">Manage submission windows, deadlines, and publish versions.</p>
        </div>
        <button onClick={() => setShowCreate(true)}
          className="px-4 py-2 text-sm bg-amber-500 text-black font-semibold rounded-lg hover:bg-amber-400 transition">
          + New Cycle
        </button>
      </div>

      {/* Alerts */}
      {successMsg && (
        <div className="mb-4 p-3 bg-green-900/50 border border-green-500 rounded-lg">
          <p className="text-green-300 text-sm">{successMsg}</p>
        </div>
      )}
      {error && (
        <div className="mb-4 p-3 bg-red-900/50 border border-red-500 rounded-lg flex justify-between">
          <p className="text-red-300 text-sm">{error}</p>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-300 text-xs ml-4">✕</button>
        </div>
      )}

      {/* ── Create Modal ──────────────────────────────────────────────────── */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg">
            <div className="p-6 border-b border-gray-800">
              <h3 className="text-lg font-semibold">Create New Forecast Cycle</h3>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Forecast Month *</label>
                <input type="month" value={newMonth} onChange={(e) => setNewMonth(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Submission Deadline</label>
                <input type="datetime-local" value={newDeadline} onChange={(e) => setNewDeadline(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />
                <p className="text-xs text-gray-500 mt-1">Teams won&apos;t be able to submit after this time.</p>
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Notes</label>
                <textarea value={newNotes} onChange={(e) => setNewNotes(e.target.value)} rows={2}
                  placeholder="Optional notes about this cycle..."
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />
              </div>
            </div>
            <div className="p-6 border-t border-gray-800 flex justify-end gap-3">
              <button onClick={() => setShowCreate(false)} className="px-4 py-2 text-sm bg-gray-800 text-gray-300 rounded-lg hover:bg-gray-700 transition">Cancel</button>
              <button onClick={createCycle} disabled={saving || !newMonth}
                className="px-6 py-2 text-sm bg-amber-500 text-black font-semibold rounded-lg hover:bg-amber-400 disabled:opacity-50 transition">
                {saving ? "Creating..." : "Create Cycle"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Carry Forward Modal ───────────────────────────────────────────── */}
      {cfTarget && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg">
            <div className="p-6 border-b border-gray-800">
              <h3 className="text-lg font-semibold">Carry Forward Forecast</h3>
              <p className="text-sm text-gray-400 mt-1">
                Into: <span className="text-white font-medium">{formatMonth(cfTarget.forecast_month)} V{cfTarget.version}</span>
              </p>
            </div>
            <div className="p-6">
              {cfLoading ? (
                <div className="flex items-center gap-3 text-gray-400 py-4">
                  <div className="w-4 h-4 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
                  <span className="text-sm">Checking available source data...</span>
                </div>
              ) : cfPreview ? (
                <div className="space-y-4">
                  {/* Source info */}
                  <div className="bg-gray-800/60 rounded-lg p-4 space-y-2">
                    <p className="text-xs text-gray-500 uppercase tracking-wider font-semibold">Source Cycle</p>
                    <p className="text-white font-medium">
                      {formatMonth(cfPreview.source_cycle.forecast_month)} V{cfPreview.source_cycle.version}
                      <span className="ml-2 px-1.5 py-0.5 text-[10px] bg-blue-500/20 text-blue-400 rounded">Published</span>
                    </p>
                    <p className="text-xs text-gray-400">Published {formatDateTime(cfPreview.source_cycle.published_at)}</p>
                  </div>

                  {/* Counts */}
                  <div className="grid grid-cols-3 gap-3">
                    <div className="bg-gray-800/40 rounded-lg p-3 text-center">
                      <p className="text-2xl font-bold text-white">{cfPreview.total_in_source.toLocaleString()}</p>
                      <p className="text-xs text-gray-400 mt-1">Records in source</p>
                    </div>
                    <div className="bg-green-900/30 border border-green-500/20 rounded-lg p-3 text-center">
                      <p className="text-2xl font-bold text-green-400">{cfPreview.will_copy.toLocaleString()}</p>
                      <p className="text-xs text-gray-400 mt-1">Will be added</p>
                    </div>
                    <div className="bg-amber-900/20 border border-amber-500/20 rounded-lg p-3 text-center">
                      <p className="text-2xl font-bold text-amber-400">{cfPreview.will_skip.toLocaleString()}</p>
                      <p className="text-xs text-gray-400 mt-1">Already exist (kept)</p>
                    </div>
                  </div>

                  {cfPreview.will_skip > 0 && (
                    <div className="bg-amber-900/20 border border-amber-500/30 rounded-lg p-3">
                      <p className="text-xs text-amber-300">
                        <strong>{cfPreview.will_skip} record{cfPreview.will_skip !== 1 ? "s" : ""}</strong> already exist in this cycle and will not be overwritten.
                        The existing data (including your Test entry) will be preserved.
                      </p>
                    </div>
                  )}

                  {cfPreview.will_copy === 0 && (
                    <div className="bg-gray-800 rounded-lg p-3">
                      <p className="text-sm text-gray-400">All records already exist in this cycle. Nothing new to carry forward.</p>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
            <div className="p-6 border-t border-gray-800 flex justify-end gap-3">
              <button onClick={() => { setCfTarget(null); setCfPreview(null); }}
                className="px-4 py-2 text-sm bg-gray-800 text-gray-300 rounded-lg hover:bg-gray-700 transition">
                Cancel
              </button>
              <button onClick={confirmCarryForward}
                disabled={actionLoading || cfLoading || !cfPreview || cfPreview.will_copy === 0}
                className="px-6 py-2 text-sm bg-amber-500 text-black font-semibold rounded-lg hover:bg-amber-400 disabled:opacity-50 transition">
                {actionLoading ? "Copying..." : `Carry Forward ${cfPreview ? cfPreview.will_copy.toLocaleString() : ""} Records`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete / Clear Drafts Modal ───────────────────────────────────── */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg">
            <div className="p-6 border-b border-gray-800">
              <h3 className="text-lg font-semibold text-red-400">
                {deleteMode === "drafts" ? "Clear Draft Data" : "Delete Cycle"}
              </h3>
              <p className="text-sm text-gray-400 mt-1">
                {formatMonth(deleteTarget.forecast_month)} V{deleteTarget.version}
                <span className={`ml-2 px-1.5 py-0.5 rounded text-[10px] font-medium ${statusColors[deleteTarget.status]}`}>
                  {deleteTarget.status}
                </span>
              </p>
            </div>
            <div className="p-6 space-y-4">
              {/* Mode selector */}
              <div className="flex gap-2">
                <button
                  onClick={() => setDeleteMode("drafts")}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition ${
                    deleteMode === "drafts"
                      ? "bg-amber-500/10 border-amber-500/50 text-amber-400"
                      : "bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-300"
                  }`}>
                  Clear Drafts Only
                </button>
                <button
                  onClick={() => setDeleteMode("full")}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition ${
                    deleteMode === "full"
                      ? "bg-red-500/10 border-red-500/50 text-red-400"
                      : "bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-300"
                  }`}>
                  Delete Entire Cycle
                </button>
              </div>

              {deleteMode === "drafts" ? (
                <div className="bg-amber-900/20 border border-amber-500/30 rounded-lg p-4">
                  <p className="text-sm text-amber-300">
                    All <strong>draft</strong> forecast data for this cycle will be deleted.
                    Published data and the cycle itself will be preserved.
                  </p>
                  {counts[deleteTarget.id] && (
                    <p className="text-xs text-amber-400/70 mt-2">
                      {counts[deleteTarget.id].draft} draft record{counts[deleteTarget.id].draft !== 1 ? "s" : ""} will be removed.
                    </p>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="bg-red-900/20 border border-red-500/30 rounded-lg p-4">
                    <p className="text-sm text-red-300">
                      <strong>This will permanently delete the entire cycle</strong> — all forecast data
                      (draft and published) and the cycle record itself. This cannot be undone.
                    </p>
                    {counts[deleteTarget.id] && (
                      <p className="text-xs text-red-400/70 mt-2">
                        {counts[deleteTarget.id].total} total record{counts[deleteTarget.id].total !== 1 ? "s" : ""} will be deleted.
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm text-gray-400 mb-1">
                      Type <span className="text-white font-mono">{formatMonth(deleteTarget.forecast_month)} V{deleteTarget.version}</span> to confirm
                    </label>
                    <input
                      type="text"
                      value={deleteConfirmText}
                      onChange={(e) => setDeleteConfirmText(e.target.value)}
                      placeholder={`${formatMonth(deleteTarget.forecast_month)} V${deleteTarget.version}`}
                      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
                    />
                  </div>
                </div>
              )}
            </div>
            <div className="p-6 border-t border-gray-800 flex justify-end gap-3">
              <button onClick={() => { setDeleteTarget(null); setDeleteConfirmText(""); }}
                className="px-4 py-2 text-sm bg-gray-800 text-gray-300 rounded-lg hover:bg-gray-700 transition">
                Cancel
              </button>
              <button onClick={confirmDelete} disabled={actionLoading}
                className="px-6 py-2 text-sm bg-red-600 text-white font-semibold rounded-lg hover:bg-red-500 disabled:opacity-50 transition">
                {actionLoading ? "Processing..." : deleteMode === "drafts" ? "Clear Drafts" : "Delete Cycle"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Cycles List ───────────────────────────────────────────────────── */}
      <div className="space-y-4">
        {cycles.length === 0 ? (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-12 text-center">
            <p className="text-gray-500">No forecast cycles yet. Create one to start collecting forecasts.</p>
          </div>
        ) : (
          cycles.map((cycle) => {
            const c = counts[cycle.id] || { draft: 0, published: 0, total: 0 };
            return (
              <div key={cycle.id} className="bg-gray-900 border border-gray-800 rounded-xl p-6">
                <div className="flex items-start justify-between gap-4">
                  {/* Left: cycle info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-2 flex-wrap">
                      <h3 className="text-lg font-semibold">{formatMonth(cycle.forecast_month)}</h3>
                      <span className="text-sm text-gray-400 font-mono">V{cycle.version}</span>
                      <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${statusColors[cycle.status]}`}>
                        {cycle.status.charAt(0).toUpperCase() + cycle.status.slice(1)}
                      </span>
                      {/* Data count badge */}
                      {c.total > 0 && (
                        <span className="flex items-center gap-1.5 text-xs text-gray-400">
                          <span className="w-1.5 h-1.5 rounded-full bg-gray-600 inline-block" />
                          {c.total.toLocaleString()} records
                          {c.draft > 0 && (
                            <span className="px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                              {c.draft} draft
                            </span>
                          )}
                          {c.published > 0 && (
                            <span className="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">
                              {c.published} published
                            </span>
                          )}
                        </span>
                      )}
                      {c.total === 0 && (
                        <span className="text-xs text-gray-600 italic">No data yet</span>
                      )}
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs text-gray-400">
                      <div>
                        <p className="text-gray-500">Opened</p>
                        <p>{formatDateTime(cycle.opened_at)}</p>
                      </div>
                      <div>
                        <p className="text-gray-500">Deadline</p>
                        <p className={cycle.deadline && new Date(cycle.deadline) < new Date() ? "text-red-400" : ""}>
                          {formatDateTime(cycle.deadline)}
                        </p>
                      </div>
                      <div>
                        <p className="text-gray-500">Locked</p>
                        <p>{formatDateTime(cycle.locked_at)}</p>
                      </div>
                      <div>
                        <p className="text-gray-500">Published</p>
                        <p>{formatDateTime(cycle.published_at)}</p>
                      </div>
                    </div>
                    {cycle.notes && <p className="text-xs text-gray-500 mt-2 italic">{cycle.notes}</p>}
                  </div>

                  {/* Right: action buttons */}
                  <div className="flex flex-col gap-2 items-end shrink-0">
                    {/* Primary status actions */}
                    <div className="flex gap-2 flex-wrap justify-end">
                      {cycle.status === "open" && (
                        <button onClick={() => updateStatus(cycle, "locked")}
                          className="px-3 py-1.5 text-xs bg-amber-500/20 text-amber-400 rounded-lg hover:bg-amber-500/30 transition font-medium">
                          Lock
                        </button>
                      )}
                      {cycle.status === "locked" && (
                        <>
                          <button onClick={() => updateStatus(cycle, "open")}
                            className="px-3 py-1.5 text-xs bg-gray-700 text-gray-300 rounded-lg hover:bg-gray-600 transition font-medium">
                            Re-open
                          </button>
                          <button onClick={() => updateStatus(cycle, "published")}
                            className="px-3 py-1.5 text-xs bg-blue-500/20 text-blue-400 rounded-lg hover:bg-blue-500/30 transition font-medium">
                            Publish
                          </button>
                        </>
                      )}
                      {cycle.status === "published" && (
                        <span className="px-3 py-1.5 text-xs text-gray-500">Final</span>
                      )}
                    </div>

                    {/* Secondary actions */}
                    <div className="flex gap-2 flex-wrap justify-end">
                      {/* Carry Forward — only for non-published cycles */}
                      {cycle.status !== "published" && (
                        <button onClick={() => openCarryForward(cycle)}
                          className="px-3 py-1.5 text-xs bg-green-500/10 text-green-400 border border-green-500/20 rounded-lg hover:bg-green-500/20 transition font-medium">
                          ↑ Carry Forward
                        </button>
                      )}
                      {/* Clear Drafts — only when there are drafts */}
                      {c.draft > 0 && cycle.status !== "published" && (
                        <button onClick={() => { setDeleteMode("drafts"); setDeleteTarget(cycle); setDeleteConfirmText(""); }}
                          className="px-3 py-1.5 text-xs bg-gray-700 text-gray-400 rounded-lg hover:bg-gray-600 transition font-medium">
                          Clear Drafts
                        </button>
                      )}
                      {/* Delete Cycle */}
                      <button onClick={() => { setDeleteMode("full"); setDeleteTarget(cycle); setDeleteConfirmText(""); }}
                        className="px-3 py-1.5 text-xs bg-red-500/10 text-red-400 border border-red-500/20 rounded-lg hover:bg-red-500/20 transition font-medium">
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
