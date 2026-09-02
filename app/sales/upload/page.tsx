"use client";
// Sales ingestion — upload the "reconciled Sales workbook" workbook (Singles +
// Combos sheets) and append into aop_sales. Re-uploading a month replaces it.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import * as XLSX from "xlsx";
import AppShell from "@/app/components/AppShell";
import { createClient } from "@/lib/supabase/client";
import { extractAopRows, monthLabel, type AopRow } from "../lib";

const surface: React.CSSProperties = { background: "var(--atlas-surface)", border: "1px solid var(--atlas-line)" };

export default function AopUploadPage() {
  const supabase = createClient();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [rows, setRows] = useState<AopRow[] | null>(null);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setIsAdmin(false); return; }
      const { data: p } = await supabase.from("profiles").select("role").eq("id", user.id).single();
      setIsAdmin(p?.role === "admin");
    })();
  }, [supabase]);

  const pick = async (f: File) => {
    setErr(null); setDone(null); setRows(null); setFileName(f.name);
    try {
      const wb = XLSX.read(await f.arrayBuffer());
      const r = extractAopRows(wb, XLSX);
      if (r.length === 0) throw new Error("No rows found — the file needs a Singles and/or Combos sheet with Month · Channel 2 · Master SKU · Qty · NTO columns.");
      setRows(r);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  const ingest = async () => {
    if (!rows) return;
    setBusy(true); setErr(null); setDone(null);
    try {
      const r = await fetch("/api/sales/upload", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `Upload failed (${r.status})`);
      setDone(`${d.inserted.toLocaleString()} rows ingested · months: ${d.months.map((m: string) => monthLabel(m + "-01")).join(", ")}`);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const summary = rows && {
    single: rows.filter((r) => r.kind === "single").length,
    combo: rows.filter((r) => r.kind === "combo").length,
    months: [...new Set(rows.map((r) => r.month))].sort(),
    nto: rows.filter((r) => r.kind === "single").reduce((a, r) => a + r.nto, 0),
  };

  if (isAdmin === false) return <AppShell><div className="py-16 text-center"><h2 className="text-2xl font-bold mb-2">Admins only</h2><p style={{ color: "var(--atlas-ink-muted)" }}>This upload is restricted to admins.</p><Link href="/sales" style={{ color: "var(--atlas-accent)" }}>← Sales dashboard</Link></div></AppShell>;

  return (
    <AppShell>
      <div className="space-y-5" style={{ maxWidth: 760 }}>
        <div className="flex items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">Upload Sales</h1>
            <p className="text-sm mt-1" style={{ color: "var(--atlas-ink-muted)" }}>Drop the <b>reconciled Sales workbook</b> workbook. Monthly append — re-uploading a month replaces it.</p>
          </div>
          <Link href="/sales" className="px-3 py-1.5 rounded-lg" style={{ ...surface, fontSize: 12, textDecoration: "none", color: "var(--atlas-ink-soft)" }}>← Dashboard</Link>
        </div>

        <div className="p-4 rounded-xl" style={surface}>
          <input ref={inputRef} type="file" accept=".xlsx,.xlsb,.xlsm" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); }} />
          <button onClick={() => inputRef.current?.click()} className="w-full px-3 py-3 rounded-lg text-left" style={{ background: "var(--atlas-surface-soft)", border: `1px dashed ${rows ? "var(--atlas-green)" : "var(--atlas-line)"}`, cursor: "pointer", fontSize: 13, color: rows ? "var(--atlas-ink)" : "var(--atlas-ink-muted)" }}>
            {fileName || "Choose the reconciled Sales workbook file…"}
          </button>
          {summary && (
            <div className="mt-3 text-sm" style={{ color: "var(--atlas-ink-soft)" }}>
              <b style={{ color: "var(--atlas-ink)" }}>{summary.single.toLocaleString()}</b> single rows · <b style={{ color: "var(--atlas-ink)" }}>{summary.combo.toLocaleString()}</b> combo rows · {summary.months.length} months (
              {monthLabel(summary.months[0] + "-01")} → {monthLabel(summary.months[summary.months.length - 1] + "-01")}) · singles NTO ₹{summary.nto.toFixed(1)} Cr
            </div>
          )}
          <div className="mt-3 flex items-center gap-3">
            <button onClick={ingest} disabled={!rows || busy} className="px-4 py-2 rounded-lg font-semibold text-white" style={{ background: rows && !busy ? "var(--atlas-accent)" : "var(--atlas-surface-soft)", border: "none", fontSize: 13, cursor: rows && !busy ? "pointer" : "not-allowed" }}>{busy ? "Ingesting…" : "↑ Ingest to platform"}</button>
            {done && <span style={{ fontSize: 12.5, color: "var(--atlas-green)" }}>✓ {done} — <Link href="/sales" style={{ color: "var(--atlas-accent)" }}>open dashboard</Link></span>}
          </div>
          {err && <div className="mt-3 p-3 rounded-lg" style={{ background: "var(--atlas-red-bg)", border: "1px solid var(--atlas-line)", color: "var(--atlas-red)", fontSize: 13 }}>{err}</div>}
        </div>

        <p style={{ fontSize: 11.5, color: "var(--atlas-ink-faint)", lineHeight: 1.6 }}>
          Reads the <code>Singles</code> sheet (kind = single, the canonical sales-by-SKU) and the <code>Combos</code> sheet (kind = combo). NTO / GTO are ₹ Crore. Category is joined from SKU Master. First run needs <code>the sales table</code> applied.
        </p>
      </div>
    </AppShell>
  );
}
