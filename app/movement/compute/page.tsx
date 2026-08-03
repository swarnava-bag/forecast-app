"use client";
// ============================================================================
// Compute the Forecast vs Movement dashboard from the 4 raw daily files:
//   Forecast + SO + STN + Shipsheet. Everything is parsed and computed in the
//   browser using your live Mapper Studio (sku_master + combo_mapper_rows) plus
//   the editable movement maps; the compact snapshot is then published.
// ============================================================================
import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import * as XLSX from "xlsx";
import AppShell from "@/app/components/AppShell";
import { createClient } from "@/lib/supabase/client";
import { downloadTemplate } from "../templates";
import { loadMappers } from "../mappers";
import { computeSnapshot, forecastFromSnapshot, EngineFiles } from "../engine";
import type { Snapshot } from "../lib";
import { fmtQty, fmtPct, pctOf, fmtInt } from "../lib";

const surface: React.CSSProperties = { background: "var(--atlas-surface)", border: "1px solid var(--atlas-line)" };
const mono = "font-mono uppercase";
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const labelOf = (key: string) => { const [y, m] = key.split("-").map(Number); return `${MON[m - 1]} ${y}`; };
// past 3 + current + next 3 months, so you can re-run an old month or set up a new one
const MONTH_OPTIONS = Array.from({ length: 7 }, (_, i) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 3 + i); const y = d.getFullYear(), m = d.getMonth() + 1; return `${y}-${String(m).padStart(2, "0")}`; }).reverse();
const CURRENT_MONTH = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; })();
type Slot = "forecast" | "so" | "stn" | "shipsheet";
const SLOTS: { k: Slot; label: string; hint: string; required: boolean }[] = [
  { k: "forecast", label: "Forecast", hint: "monthly — reused if omitted", required: false },
  { k: "so", label: "SO (Sales Orders)", hint: "daily · optional", required: false },
  { k: "stn", label: "STN (Stock Transfers)", hint: "daily · optional", required: false },
  { k: "shipsheet", label: "Shipsheet", hint: "yesterday's · optional", required: false },
];

export default function ComputePage() {
  const supabase = createClient();
  const [files, setFiles] = useState<Partial<Record<Slot, { name: string; wb: XLSX.WorkBook }>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ snapshot: Snapshot; diagnostics: Record<string, number>; stats: Record<string, number>; warnings: string[]; fcSource: string } | null>(null);
  const [published, setPublished] = useState<string | null>(null);
  const [targetMonth, setTargetMonth] = useState<string>(CURRENT_MONTH);
  const refs = useRef<Record<string, HTMLInputElement | null>>({});

  const pick = useCallback(async (slot: Slot, file: File) => {
    setError(null); setResult(null); setPublished(null);
    try {
      const wb = XLSX.read(await file.arrayBuffer());
      setFiles((f) => ({ ...f, [slot]: { name: file.name, wb } }));
    } catch (e) { setError(`${slot}: ${e instanceof Error ? e.message : String(e)}`); }
  }, []);

  const compute = async () => {
    setError(null); setResult(null); setPublished(null);
    if (!files.forecast && !files.so && !files.stn) { setError("Upload at least the Forecast (to start a month) or SO / STN (for movement)."); return; }
    setBusy("Loading Mapper Studio…");
    try {
      const { mappers, stats, warnings } = await loadMappers(supabase);
      const monthKey = targetMonth;                 // the selected month is the source of truth
      const monthLabel = labelOf(monthKey);
      const ef: EngineFiles = { forecast: files.forecast?.wb, so: files.so?.wb, stn: files.stn?.wb, ship: files.shipsheet?.wb };
      // Forecast is monthly: if not uploaded, reuse the month's last publish.
      let preset; let fcSource = "uploaded now";
      if (!files.forecast) {
        setBusy("Finding forecast…");
        const r = await fetch(`/api/movement-snapshot?month=${monthKey}`, { cache: "no-store" });
        if (!r.ok) { setError(`No forecast on file for ${monthLabel}. Upload the Forecast file once for ${monthLabel} — after that, daily updates need only SO / STN / Shipsheet.`); setBusy(null); return; }
        preset = forecastFromSnapshot(await r.json());
        fcSource = `reused from ${monthLabel} (last publish)`;
      }
      setBusy("Computing…");
      const { snapshot, diagnostics } = computeSnapshot(ef, mappers, monthKey, preset);
      setResult({ snapshot, diagnostics, stats, warnings, fcSource });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  const publish = async () => {
    if (!result) return;
    setBusy("Publishing…"); setError(null);
    try {
      const r = await fetch("/api/movement-snapshot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ monthKey: result.snapshot.meta.monthKey, month: result.snapshot.meta.month, snapshot: result.snapshot }) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error || `Publish failed (${r.status})`);
      setPublished(result.snapshot.meta.month);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  const m = result?.snapshot.meta;
  const d = result?.diagnostics;

  return (
    <AppShell>
      <div className="space-y-5" style={{ maxWidth: 960 }}>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className={mono} style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--atlas-ink-muted)" }}>Forecast vs Movement</div>
            <h1 className="font-display" style={{ fontSize: 28, fontWeight: 400, color: "var(--atlas-ink)", marginTop: 2 }}>Compute from raw files</h1>
            <div style={{ fontSize: 12, color: "var(--atlas-ink-muted)", marginTop: 2 }}>Daily: drop <b>SO + STN + Shipsheet</b> and Compute. Forecast is monthly — upload it once to start a month; later runs reuse it. SO / STN are optional (start a month with Forecast alone; re-run an old month when a late SO closes).</div>
          </div>
          <div className="flex gap-2">
            <Link href="/movement/mappers" className="px-3 py-1.5 rounded-lg" style={{ ...surface, fontSize: 12, color: "var(--atlas-ink-soft)", textDecoration: "none" }}>Movement Mappers</Link>
            <Link href="/movement" className="px-3 py-1.5 rounded-lg" style={{ ...surface, fontSize: 12, color: "var(--atlas-ink-soft)", textDecoration: "none" }}>← Dashboard</Link>
          </div>
        </div>

        {/* templates */}
        <div className="p-3 rounded-xl" style={surface}>
          <div className={mono} style={{ fontSize: 10, letterSpacing: "0.08em", color: "var(--atlas-ink-muted)", marginBottom: 8 }}>Templates</div>
          <div className="flex flex-wrap gap-2">
            {SLOTS.map((s) => <button key={s.k} onClick={() => downloadTemplate(s.k)} className="px-3 py-1.5 rounded-lg" style={{ background: "var(--atlas-surface-soft)", border: "1px solid var(--atlas-line)", color: "var(--atlas-ink-soft)", fontSize: 12, cursor: "pointer" }}>↓ {s.label}</button>)}
          </div>
        </div>

        {/* target month */}
        <div className="p-3 rounded-xl flex flex-wrap items-center gap-3" style={{ background: "var(--atlas-accent-bg)", border: "1px solid var(--atlas-line)" }}>
          <div>
            <div style={{ fontSize: 13, color: "var(--atlas-ink)", fontWeight: 600 }}>Target month</div>
            <div style={{ fontSize: 11.5, color: "var(--atlas-ink-muted)" }}>Every file is scoped to this month by date — so a multi-month export, or a late SO for an older month, only counts the rows that belong here. Pick a future month to <b>start it</b> from the Forecast alone.</div>
          </div>
          <div className="flex-1" />
          <select value={targetMonth} onChange={(e) => setTargetMonth(e.target.value)} className="px-3 py-1.5 rounded-lg text-sm" style={{ ...surface, color: "var(--atlas-ink)", cursor: "pointer" }}>
            {MONTH_OPTIONS.map((k) => <option key={k} value={k}>{labelOf(k)}</option>)}
          </select>
        </div>

        {/* file slots */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {SLOTS.map((s) => (
            <div key={s.k} className="p-3 rounded-xl" style={surface}>
              <div className="flex items-center justify-between mb-2">
                <span style={{ fontSize: 13, color: "var(--atlas-ink)", fontWeight: 600 }}>{s.label}{s.required ? <span style={{ color: "var(--atlas-red)" }}> *</span> : <span style={{ fontSize: 10.5, color: "var(--atlas-ink-faint)", fontWeight: 400 }}> · {s.hint}</span>}</span>
                {files[s.k] && <span style={{ fontSize: 11, color: "var(--atlas-green)" }}>✓ loaded</span>}
              </div>
              <input ref={(el) => { refs.current[s.k] = el; }} type="file" accept=".xlsx,.xlsb,.xlsm,.csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(s.k, f); }} />
              <button onClick={() => refs.current[s.k]?.click()} className="w-full px-3 py-2 rounded-lg text-left" style={{ background: "var(--atlas-surface-soft)", border: `1px dashed ${files[s.k] ? "var(--atlas-green)" : "var(--atlas-line)"}`, cursor: "pointer", fontSize: 12, color: files[s.k] ? "var(--atlas-ink)" : "var(--atlas-ink-muted)" }}>
                {files[s.k]?.name ?? "Choose file…"}
              </button>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <button onClick={compute} disabled={!!busy} className="px-4 py-2 rounded-lg font-mono" style={{ background: "var(--atlas-accent)", color: "#fff", border: "none", fontSize: 12, letterSpacing: "0.04em", cursor: busy ? "wait" : "pointer", opacity: busy ? 0.7 : 1 }}>
            {busy ?? "Compute & preview"}
          </button>
          {result && <button onClick={publish} disabled={!!busy} className="px-4 py-2 rounded-lg font-mono" style={{ background: "var(--atlas-green)", color: "#fff", border: "none", fontSize: 12, letterSpacing: "0.04em", cursor: "pointer" }}>Publish {m?.month}</button>}
          {published && <span style={{ fontSize: 12.5, color: "var(--atlas-green)" }}>✓ Published {published} — <Link href="/movement" style={{ color: "var(--atlas-accent)" }}>open dashboard</Link></span>}
        </div>

        {error && <div className="p-3 rounded-xl" style={{ background: "var(--atlas-red-bg)", border: "1px solid var(--atlas-line)", color: "var(--atlas-red)", fontSize: 13 }}>{error}</div>}

        {result && m && d && (
          <div className="space-y-4">
            <div className="p-3 rounded-xl flex items-center gap-2 flex-wrap" style={{ background: "var(--atlas-accent-bg)", border: "1px solid var(--atlas-line)" }}>
              <span className={mono} style={{ fontSize: 10, letterSpacing: "0.08em", color: "var(--atlas-ink-muted)" }}>Month</span>
              <b style={{ fontSize: 15, color: "var(--atlas-ink)" }}>{m.month}</b>
              <span style={{ fontSize: 12, color: "var(--atlas-ink-muted)" }}>· through day {m.daysElapsed} of {m.daysInMonth} · {m.counts.overall} SKUs</span>
              <span className="px-2 py-0.5 rounded" style={{ background: "var(--atlas-surface-soft)", border: "1px solid var(--atlas-line)", fontSize: 11, color: "var(--atlas-ink-soft)" }}>Forecast: {result.fcSource}</span>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { l: "Forecast (V7)", v: fmtQty(m.forecastV7Total) },
                { l: "Moved", v: fmtQty(d.movedTotal), sub: fmtPct(pctOf(d.movedTotal, m.forecastV7Total), 1) + " of forecast" },
                { l: "Shipsheet add-back", v: fmtQty(d.shipAddedBack), sub: `${d.shipMatchedPOs}/${d.shipSheetPOs} POs matched` },
                { l: "Unmapped (SO+STN)", v: fmtQty(d.soUnmapped + d.stnUnmapped), sub: "FG not resolved → check mappers" },
              ].map((k) => (
                <div key={k.l} className="p-4 rounded-xl" style={surface}>
                  <div className={mono} style={{ fontSize: 9.5, letterSpacing: "0.1em", color: "var(--atlas-ink-muted)" }}>{k.l}</div>
                  <div className="font-display" style={{ fontSize: 23, color: "var(--atlas-ink)" }}>{k.v}</div>
                  {k.sub && <div style={{ fontSize: 11, color: "var(--atlas-ink-muted)", marginTop: 2 }}>{k.sub}</div>}
                </div>
              ))}
            </div>

            <div className="p-3 rounded-xl" style={surface}>
              <div style={{ fontSize: 12.5, color: "var(--atlas-ink-soft)", lineHeight: 1.6 }}>
                <b style={{ color: "var(--atlas-ink)" }}>Diagnostics.</b> SO ex-node dispatch <b>{fmtInt(d.soRawExNode)}</b> · STN closed ex-node <b>{fmtInt(d.stnRawClosed)}</b> · internal: to Central <b>{fmtInt(d.toCentral)}</b>, to Quarantine <b>{fmtInt(d.toQuarantine)}</b>. Mapper Studio: {result.stats.skuMaster} SKUs, {result.stats.combos} combos, {result.stats.customers} customers, {result.stats.warehouses} warehouses, {result.stats.aliases} FG aliases.
              </div>
              {result.warnings.length > 0 && (
                <ul style={{ marginTop: 8, fontSize: 12, color: "var(--atlas-amber-warn, #D97706)", listStyle: "disc", paddingLeft: 18 }}>
                  {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              )}
              {(d.soUnmapped + d.stnUnmapped) > 0 && <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--atlas-ink-muted)" }}>Unmapped FG codes mean a SKU is missing from <Link href="/admin/skus" style={{ color: "var(--atlas-accent)" }}>SKU Master</Link> or needs an <Link href="/movement/mappers" style={{ color: "var(--atlas-accent)" }}>FG alias</Link>.</div>}
            </div>
          </div>
        )}

        <div style={{ fontSize: 11, color: "var(--atlas-ink-faint)", lineHeight: 1.6 }}>
          Files are read in your browser; only the computed summary is sent when you publish. FG→SKU + combo explosion reuse Mapper Studio (<code>sku_master</code> + <code>combo_mapper_rows</code>); channels use the editable Movement Mappers. First run needs the <code>movement_mappers.sql</code> + seed applied.
        </div>
      </div>
    </AppShell>
  );
}
