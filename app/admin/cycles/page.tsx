"use client";
import { useEffect, useState } from "react";
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

export default function ForecastCyclesPage() {
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newMonth, setNewMonth] = useState("");
  const [newDeadline, setNewDeadline] = useState("");
  const [newNotes, setNewNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const supabase = createClient();

  useEffect(() => { loadCycles(); }, []);

  async function loadCycles() {
    setLoading(true);
    const { data } = await supabase
      .from("forecast_cycles")
      .select("*")
      .order("forecast_month", { ascending: false })
      .order("version", { ascending: false });
    if (data) setCycles(data);
    setLoading(false);
  }

  async function createCycle() {
    if (!newMonth) return;
    setSaving(true);
    setError(null);

    const { data: { user } } = await supabase.auth.getUser();

    // Find the latest version for this month
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
      setSuccessMsg(`Forecast cycle V${nextVersion} for ${newMonth} created!`);
      setShowCreate(false);
      setNewMonth("");
      setNewDeadline("");
      setNewNotes("");
      loadCycles();
    }
    setSaving(false);
    setTimeout(() => setSuccessMsg(null), 3000);
  }

  async function updateStatus(cycle: Cycle, newStatus: string) {
    const confirmed = window.confirm(
      newStatus === "locked"
        ? `Lock submissions for ${formatMonth(cycle.forecast_month)} V${cycle.version}? Teams will no longer be able to edit.`
        : newStatus === "published"
        ? `Publish ${formatMonth(cycle.forecast_month)} V${cycle.version}? All draft data will become the official forecast.`
        : `Re-open ${formatMonth(cycle.forecast_month)} V${cycle.version}? Teams will be able to edit again.`
    );
    if (!confirmed) return;

    const { data: { user } } = await supabase.auth.getUser();

    const updates: any = { status: newStatus };
    if (newStatus === "locked") updates.locked_at = new Date().toISOString();
    if (newStatus === "published") {
      updates.published_at = new Date().toISOString();
      updates.published_by = user?.id;
    }
    if (newStatus === "open") {
      updates.locked_at = null;
    }

    await supabase.from("forecast_cycles").update(updates).eq("id", cycle.id);

    // If publishing, update all draft forecast data for this cycle to 'published'
    if (newStatus === "published") {
      await supabase
        .from("forecast_data")
        .update({ status: "published", updated_at: new Date().toISOString() })
        .eq("cycle_id", cycle.id)
        .in("status", ["draft", "submitted"]);
    }

    // Audit log
    await supabase.from("audit_log").insert({
      user_id: user?.id,
      user_email: user?.email,
      action: `cycle_${newStatus}`,
      table_name: "forecast_cycles",
      record_id: cycle.id,
      old_values: { status: cycle.status },
      new_values: { status: newStatus },
    });

    setSuccessMsg(`Cycle ${newStatus}!`);
    loadCycles();
    setTimeout(() => setSuccessMsg(null), 3000);
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
    open: "bg-green-500/20 text-green-400",
    locked: "bg-amber-500/20 text-amber-400",
    published: "bg-blue-500/20 text-blue-400",
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64"><p className="text-gray-400">Loading...</p></div>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">Forecast Cycles</h2>
          <p className="text-sm text-gray-400 mt-1">
            Manage submission windows, deadlines, and publish versions.
          </p>
        </div>
        <button onClick={() => setShowCreate(true)}
          className="px-4 py-2 text-sm bg-amber-500 text-black font-semibold rounded-lg hover:bg-amber-400 transition">
          + New Cycle
        </button>
      </div>

      {successMsg && (
        <div className="mb-4 p-3 bg-green-900/50 border border-green-500 rounded-lg">
          <p className="text-green-300 text-sm">{successMsg}</p>
        </div>
      )}
      {error && (
        <div className="mb-4 p-3 bg-red-900/50 border border-red-500 rounded-lg">
          <p className="text-red-300 text-sm">{error}</p>
        </div>
      )}

      {/* Create Modal */}
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
                <textarea value={newNotes} onChange={(e) => setNewNotes(e.target.value)} rows={2} placeholder="Optional notes about this cycle..."
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

      {/* Cycles Table */}
      <div className="space-y-4">
        {cycles.length === 0 ? (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-12 text-center">
            <p className="text-gray-500">No forecast cycles yet. Create one to start collecting forecasts.</p>
          </div>
        ) : (
          cycles.map((cycle) => (
            <div key={cycle.id} className="bg-gray-900 border border-gray-800 rounded-xl p-6">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-3 mb-2">
                    <h3 className="text-lg font-semibold">{formatMonth(cycle.forecast_month)}</h3>
                    <span className="text-sm text-gray-400 font-mono">V{cycle.version}</span>
                    <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${statusColors[cycle.status]}`}>
                      {cycle.status.charAt(0).toUpperCase() + cycle.status.slice(1)}
                    </span>
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
                <div className="flex gap-2">
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
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}