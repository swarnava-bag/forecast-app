"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type AuditEntry = {
  id: string;
  user_email: string;
  action: string;
  table_name: string;
  record_id: string;
  old_values: any;
  new_values: any;
  created_at: string;
};

export default function AuditLogPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  useEffect(() => {
    loadEntries();
  }, []);

  async function loadEntries() {
    setLoading(true);
    const { data } = await supabase
      .from("audit_log")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);
    if (data) setEntries(data);
    setLoading(false);
  }

  function formatAction(action: string) {
    return action.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function formatTime(dateStr: string) {
    return new Date(dateStr).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  }

  const actionColors: Record<string, string> = {
    create: "bg-green-500/20 text-green-400",
    update: "bg-blue-500/20 text-blue-400",
    discontinue: "bg-orange-500/20 text-orange-400",
    reactivate: "bg-green-500/20 text-green-400",
    bulk_upload: "bg-purple-500/20 text-purple-400",
    update_user_role: "bg-amber-500/20 text-amber-400",
    cycle_open: "bg-green-500/20 text-green-400",
    cycle_locked: "bg-amber-500/20 text-amber-400",
    cycle_published: "bg-blue-500/20 text-blue-400",
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64"><p className="text-atlas-ink-muted">Loading...</p></div>;
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-bold">Audit Log</h2>
        <p className="text-sm text-atlas-ink-muted mt-1">
          Track all changes made across the system. Showing last 100 entries.
        </p>
      </div>

      <div className="bg-atlas-surface border border-atlas-line rounded-xl overflow-hidden">
        {entries.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-atlas-ink-faint">No activity recorded yet.</p>
          </div>
        ) : (
          <div className="divide-y divide-atlas-line/50">
            {entries.map((entry) => (
              <div key={entry.id} className="px-6 py-4 hover:bg-atlas-surface-soft/20 transition">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${actionColors[entry.action] || "bg-atlas-surface-soft text-atlas-ink"}`}>
                      {formatAction(entry.action)}
                    </span>
                    <span className="text-sm text-atlas-ink">{entry.user_email}</span>
                  </div>
                  <span className="text-xs text-atlas-ink-faint">{formatTime(entry.created_at)}</span>
                </div>
                <p className="text-xs text-atlas-ink-muted">
                  Table: <span className="font-mono">{entry.table_name}</span>
                  {entry.record_id && <> · Record: <span className="font-mono">{entry.record_id.substring(0, 8)}...</span></>}
                </p>
                {entry.new_values && (
                  <details className="mt-1">
                    <summary className="text-xs text-atlas-ink-faint cursor-pointer hover:text-atlas-ink-muted">View details</summary>
                    <pre className="mt-1 text-xs text-atlas-ink-faint bg-atlas-surface-soft/50 p-2 rounded overflow-x-auto">
                      {JSON.stringify(entry.new_values, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
