"use client";
// ============================================================================
// Movement Mappers — editable, movement-specific maps the compute engine reads.
// (Combo/SKU mapping lives in Mapper Studio; not duplicated here.)
//   • Customer → Channel + Platform   (movement_customer_map)
//   • Warehouse → Channel             (movement_warehouse_map)
//   • FG alias / transition → SKU     (movement_fg_alias)
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import * as XLSX from "xlsx";
import AppShell from "@/app/components/AppShell";
import { createClient } from "@/lib/supabase/client";

const surface: React.CSSProperties = { background: "var(--atlas-surface)", border: "1px solid var(--atlas-line)" };
const mono = "font-mono uppercase";
const CHANNELS = ["MT", "GT", "Qcom", "B2B", "B2C", "Growth", "CSD", "Sample", "Gifting"];

type Tab = "customer" | "warehouse" | "alias";
type Row = Record<string, string | null> & { _rid: string };
type Col = { k: string; label: string; kind: "text" | "channel" };
const CONF: Record<Tab, { table: string; key: string; cols: Col[]; label: string; title: string; note: string }> = {
  customer: { table: "movement_customer_map", key: "customer", label: "Customer", title: "Customer → Channel + Platform", note: "SO Party Name → channel; Platform for Qcom customers (Blinkit/Zepto/…).",
    cols: [{ k: "customer", label: "Customer", kind: "text" }, { k: "channel", label: "Channel", kind: "channel" }, { k: "platform", label: "Platform", kind: "text" }] },
  warehouse: { table: "movement_warehouse_map", key: "warehouse", label: "Warehouse", title: "Warehouse → Channel", note: "STN To Warehouse (CFA/3PL) → channel.",
    cols: [{ k: "warehouse", label: "Warehouse", kind: "text" }, { k: "channel", label: "Channel", kind: "channel" }] },
  alias: { table: "movement_fg_alias", key: "fg_code", label: "FG alias", title: "FG alias / transition → SKU", note: "Old or variant FG code → New Master SKU (e.g. 14473G → 21107N). Wins over sku_master.",
    cols: [{ k: "fg_code", label: "FG code", kind: "text" }, { k: "new_master_sku", label: "New Master SKU", kind: "text" }, { k: "note", label: "Note", kind: "text" }] },
};

let ridSeq = 0;
const rid = () => `r${Date.now()}_${ridSeq++}`;

export default function MovementMappersPage() {
  const supabase = createClient();
  const [tab, setTab] = useState<Tab>("customer");
  const [rows, setRows] = useState<Row[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const conf = CONF[tab];

  const load = useCallback(async () => {
    setLoading(true); setStatus(null); setDirty(new Set());
    const { data, error } = await supabase.from(conf.table).select("*").order(conf.key).limit(5000);
    if (error) setStatus(`Load failed: ${error.message}. Apply supabase/sql/movement_mappers.sql + seed first.`);
    setRows(((data as Record<string, string | null>[]) ?? []).map((r) => ({ ...r, _rid: rid() })));
    setLoading(false);
  }, [supabase, conf.table, conf.key]);
  // defer out of the effect body so the initial setState isn't synchronous
  useEffect(() => { const t = setTimeout(() => { load(); }, 0); return () => clearTimeout(t); }, [load]);

  const filtered = useMemo(() => {
    if (!q.trim()) return rows;
    const s = q.toLowerCase();
    return rows.filter((r) => conf.cols.some((c) => String(r[c.k] ?? "").toLowerCase().includes(s)));
  }, [rows, q, conf]);

  const edit = (rowId: string, col: string, val: string) => {
    setRows((rs) => rs.map((r) => (r._rid === rowId ? { ...r, [col]: val || null } : r)));
    setDirty((d) => new Set(d).add(rowId));
  };
  const addRow = () => setRows((rs) => [{ _rid: rid(), ...Object.fromEntries(conf.cols.map((c) => [c.k, ""])) } as Row, ...rs]);

  const save = async () => {
    const up = rows.filter((r) => dirty.has(r._rid) && String(r[conf.key] ?? "").trim())
      .map((r) => Object.fromEntries(conf.cols.map((c) => [c.k, (r[c.k] ?? "") === "" ? null : r[c.k]])));
    if (up.length === 0) { setStatus("Nothing to save."); return; }
    setStatus("Saving…");
    const { error } = await supabase.from(conf.table).upsert(up, { onConflict: conf.key });
    if (error) { setStatus(`Save failed: ${error.message}`); return; }
    setStatus(`Saved ${up.length} row(s).`); await load();
  };
  const del = async (row: Row) => {
    const keyVal = String(row[conf.key] ?? "").trim();
    if (keyVal) { const { error } = await supabase.from(conf.table).delete().eq(conf.key, keyVal); if (error) { setStatus(`Delete failed: ${error.message}`); return; } }
    setRows((rs) => rs.filter((r) => r._rid !== row._rid));
  };

  // Download all 3 movement mappers as one Excel workbook (a sheet each).
  const downloadExcel = async () => {
    setStatus("Building Excel…");
    try {
      const wb = XLSX.utils.book_new();
      for (const t of Object.keys(CONF) as Tab[]) {
        const c = CONF[t];
        const { data } = await supabase.from(c.table).select("*").order(c.key).limit(20000);
        const cols = c.cols.map((x) => x.k);
        const aoa: (string | null)[][] = [cols, ...((data as Record<string, string | null>[]) ?? []).map((r) => cols.map((k) => r[k] ?? ""))];
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), c.label.slice(0, 31));
      }
      XLSX.writeFile(wb, `movement_mappers_${new Date().toISOString().slice(0, 10)}.xlsx`);
      setStatus("Downloaded.");
    } catch (e) { setStatus(`Export failed: ${e instanceof Error ? e.message : String(e)}`); }
  };

  return (
    <AppShell>
      <div className="space-y-4" style={{ maxWidth: 1000 }}>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className={mono} style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--atlas-ink-muted)" }}>Forecast vs Movement</div>
            <h1 className="font-display" style={{ fontSize: 26, fontWeight: 400, color: "var(--atlas-ink)", marginTop: 2 }}>Movement Mappers</h1>
          </div>
          <Link href="/movement/compute" className="px-3 py-1.5 rounded-lg" style={{ ...surface, fontSize: 12, color: "var(--atlas-ink-soft)", textDecoration: "none" }}>← Compute</Link>
        </div>

        <div className="flex gap-1 flex-wrap" style={{ borderBottom: "1px solid var(--atlas-line)" }}>
          {(Object.keys(CONF) as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`${mono} px-4 py-2`} style={{ fontSize: 10.5, letterSpacing: "0.06em", border: "none", background: "transparent", cursor: "pointer", borderBottom: tab === t ? "2px solid var(--atlas-accent)" : "2px solid transparent", color: tab === t ? "var(--atlas-accent)" : "var(--atlas-ink-muted)" }}>{CONF[t].label}</button>
          ))}
        </div>

        <div>
          <div style={{ fontSize: 13, color: "var(--atlas-ink)", fontWeight: 600 }}>{conf.title}</div>
          <div style={{ fontSize: 11.5, color: "var(--atlas-ink-muted)" }}>{conf.note}</div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="px-3 py-1.5 rounded-lg text-sm" style={{ background: "var(--atlas-surface-soft)", border: "1px solid var(--atlas-line)", color: "var(--atlas-ink)", minWidth: 200 }} />
          <button onClick={addRow} className="px-3 py-1.5 rounded-lg" style={{ ...surface, fontSize: 12, color: "var(--atlas-ink-soft)", cursor: "pointer" }}>+ Add row</button>
          <button onClick={save} className="px-3 py-1.5 rounded-lg font-mono" style={{ background: "var(--atlas-accent)", color: "#fff", border: "none", fontSize: 11.5, cursor: "pointer" }}>Save changes</button>
          <button onClick={downloadExcel} className="px-3 py-1.5 rounded-lg" style={{ ...surface, fontSize: 12, color: "var(--atlas-ink-soft)", cursor: "pointer" }} title="Download all 3 mappers as one Excel workbook">↓ Excel</button>
          <span style={{ fontSize: 11.5, color: "var(--atlas-ink-muted)" }}>{loading ? "loading…" : `${filtered.length} rows`}{dirty.size > 0 && ` · ${dirty.size} edited`}</span>
          {status && <span style={{ fontSize: 12, color: status.toLowerCase().includes("fail") ? "var(--atlas-red)" : "var(--atlas-green)" }}>{status}</span>}
        </div>

        <div className="rounded-xl overflow-hidden" style={surface}>
          <div style={{ overflowX: "auto", maxHeight: "62vh", overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead><tr>
                {conf.cols.map((c) => <th key={c.k} className={mono} style={{ fontSize: 9.5, letterSpacing: "0.06em", color: "var(--atlas-ink-muted)", textAlign: "left", padding: "9px 12px", borderBottom: "1px solid var(--atlas-line)", position: "sticky", top: 0, background: "var(--atlas-surface)" }}>{c.label}</th>)}
                <th style={{ borderBottom: "1px solid var(--atlas-line)", position: "sticky", top: 0, background: "var(--atlas-surface)" }} />
              </tr></thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r._rid} style={{ borderBottom: "1px solid var(--atlas-line-soft)", background: dirty.has(r._rid) ? "var(--atlas-accent-bg)" : undefined }}>
                    {conf.cols.map((c) => (
                      <td key={c.k} style={{ padding: "5px 8px" }}>
                        {c.kind === "channel" ? (
                          <select value={r[c.k] ?? ""} onChange={(e) => edit(r._rid, c.k, e.target.value)} style={{ width: "100%", background: "var(--atlas-surface-soft)", border: "1px solid var(--atlas-line)", color: "var(--atlas-ink)", borderRadius: 6, padding: "4px 6px", fontSize: 12 }}>
                            <option value="">—</option>{CHANNELS.map((ch) => <option key={ch} value={ch}>{ch}</option>)}
                          </select>
                        ) : (
                          <input value={r[c.k] ?? ""} onChange={(e) => edit(r._rid, c.k, e.target.value)} style={{ width: "100%", background: "var(--atlas-surface-soft)", border: "1px solid var(--atlas-line)", color: "var(--atlas-ink)", borderRadius: 6, padding: "4px 6px", fontSize: 12 }} />
                        )}
                      </td>
                    ))}
                    <td style={{ padding: "5px 8px", textAlign: "right" }}><button onClick={() => del(r)} style={{ border: "1px solid var(--atlas-line)", background: "var(--atlas-surface-soft)", color: "var(--atlas-red)", borderRadius: 6, width: 26, height: 26, cursor: "pointer", fontSize: 13 }}>×</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div style={{ fontSize: 11, color: "var(--atlas-ink-faint)" }}>Edit a cell then <b>Save changes</b> (upsert by {conf.key}). New rows: fill the key column then Save. Combo/SKU mapping is in <Link href="/admin/mapper" style={{ color: "var(--atlas-accent)" }}>Mapper Studio</Link>.</div>
      </div>
    </AppShell>
  );
}
