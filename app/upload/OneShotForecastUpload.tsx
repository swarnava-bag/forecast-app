"use client";
// One-shot, whole-platform forecast upload.
//   Upload the long-format forecast file (New Master SKU · Platform · Channel ·
//   Forecast) and set the entire platform's forecast for a month in a single
//   shot — every channel at once. Reuses the same engine as the Forecast-vs-
//   Movement "Push forecast to platform" action: it creates the month's cycle
//   and any channel the file introduces, then publishes forecast_data.
import { useRef, useState } from "react";
import * as XLSX from "xlsx";
import { extractForecastRows } from "@/app/movement/pushForecast";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const labelOf = (key: string) => { const [y, m] = key.split("-").map(Number); return `${MON[m - 1]} ${y}`; };
// past 3 · current · next 3
const MONTHS = Array.from({ length: 7 }, (_, i) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 3 + i); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; }).reverse();
const CURRENT = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; })();
const fmtQty = (n: number) => n >= 1e7 ? `${(n / 1e7).toFixed(2)}Cr` : n >= 1e5 ? `${(n / 1e5).toFixed(1)}L` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : Math.round(n).toLocaleString("en-IN");

type Result = { month: string; version: number; inserted: number; totalQty: number; channelsCreated: string[]; skusSkipped: string[]; clustersMissing: string[] };

export default function OneShotForecastUpload() {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(CURRENT);
  const [file, setFile] = useState<{ name: string; wb: XLSX.WorkBook } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const pick = async (f: File) => {
    setErr(null); setResult(null);
    try { setFile({ name: f.name, wb: XLSX.read(await f.arrayBuffer()) }); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  const push = async () => {
    setErr(null); setResult(null);
    if (!file) { setErr("Choose the long-format forecast file first."); return; }
    setBusy(true);
    try {
      const rows = extractForecastRows(file.wb, XLSX);
      const r = await fetch("/api/movement/push-forecast", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ monthKey: month, rows }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `Upload failed (${r.status})`);
      setResult(d as Result);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="bg-atlas-surface border border-atlas-line rounded-xl overflow-hidden">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-atlas-surface-soft/30 transition">
        <div>
          <p className="text-sm font-semibold text-atlas-ink">One-shot platform forecast <span className="ml-2 px-2 py-0.5 rounded text-xs" style={{ background: "var(--atlas-accent-bg)", color: "var(--atlas-accent)" }}>Admin · all channels</span></p>
          <p className="text-xs text-atlas-ink-muted mt-0.5">Upload the whole platform&apos;s forecast for a month in one file — no per-channel entry.</p>
        </div>
        <span className="text-atlas-ink-muted text-sm">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="px-6 pb-6 pt-1 border-t border-atlas-line space-y-4">
          <p className="text-xs text-atlas-ink-muted leading-relaxed">
            File must be long-format with columns <span className="font-mono text-atlas-ink">New Master SKU · Platform · Channel · Forecast</span> (Platform = the channel e.g. Amazon / Blinkit / MT; Channel = its cluster). This publishes a forecast cycle for the month and adds any new channel automatically. Re-uploading a month replaces it.
          </p>

          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs text-atlas-ink-muted mb-1.5">Forecast month</label>
              <select value={month} onChange={(e) => setMonth(e.target.value)} className="px-3 py-2 bg-atlas-surface-soft border border-atlas-line rounded-lg text-sm text-atlas-ink focus:outline-none focus:ring-1 focus:ring-blue-500">
                {MONTHS.map((k) => <option key={k} value={k}>{labelOf(k)}</option>)}
              </select>
            </div>
            <div className="flex-1 min-w-[200px]">
              <label className="block text-xs text-atlas-ink-muted mb-1.5">Forecast file</label>
              <input ref={inputRef} type="file" accept=".xlsx,.xlsb,.xlsm,.csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); }} />
              <button onClick={() => inputRef.current?.click()} className="w-full px-3 py-2 rounded-lg text-left text-sm bg-atlas-surface-soft border border-dashed border-atlas-line hover:border-blue-500/40 transition" style={{ color: file ? "var(--atlas-ink)" : "var(--atlas-ink-muted)" }}>
                {file?.name ?? "Choose file…"}
              </button>
            </div>
            <button onClick={push} disabled={busy || !file} className="px-5 py-2 rounded-lg text-sm font-semibold text-white transition disabled:cursor-not-allowed" style={{ background: file && !busy ? "var(--atlas-accent)" : "var(--atlas-surface-soft)", opacity: busy ? 0.7 : 1 }}>
              {busy ? "Uploading…" : "↑ Upload to platform"}
            </button>
          </div>

          {err && <div className="p-3 rounded-lg text-sm" style={{ background: "var(--atlas-red-bg)", border: "1px solid var(--atlas-line)", color: "var(--atlas-red)" }}>{err}</div>}

          {result && (
            <div className="p-4 rounded-lg" style={{ background: "var(--atlas-green-bg)", border: "1px solid var(--atlas-line)" }}>
              <p className="text-sm font-semibold" style={{ color: "var(--atlas-green)" }}>✓ Published {labelOf(result.month)} · V{result.version} — {result.inserted.toLocaleString()} rows · {fmtQty(result.totalQty)} units</p>
              <ul className="mt-2 text-xs text-atlas-ink-muted space-y-0.5">
                {result.channelsCreated.length > 0 && <li>Added {result.channelsCreated.length} new channel(s): <span className="text-atlas-ink">{result.channelsCreated.join(", ")}</span></li>}
                {result.clustersMissing.length > 0 && <li className="text-amber-500">Unknown cluster(s) skipped: {result.clustersMissing.join(", ")}</li>}
                {result.skusSkipped.length > 0 && <li>{result.skusSkipped.length} SKU(s) not in SKU Master were skipped: {result.skusSkipped.slice(0, 8).join(", ")}{result.skusSkipped.length > 8 ? "…" : ""}</li>}
              </ul>
              <a href="/dashboard" className="inline-block mt-2 text-xs" style={{ color: "var(--atlas-accent)" }}>Open dashboard →</a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
