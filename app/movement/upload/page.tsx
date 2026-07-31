"use client";
// ============================================================================
// Upload portal — refresh the Forecast vs Movement dashboard.
//   Drop the refreshed base workbook (Power Query applied). It is parsed in the
//   browser into the dashboard snapshot, previewed, then published so every
//   team reads the same numbers.
// ============================================================================
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import AppShell from "@/app/components/AppShell";
import { parseWorkbook, ParseResult } from "../parse";
import { downloadTemplate } from "../templates";
import { fmtQty, fmtPct, pctOf } from "../lib";

const surface: React.CSSProperties = { background: "var(--atlas-surface)", border: "1px solid var(--atlas-line)" };
const mono = "font-mono uppercase";

function fmtWhen(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}

export default function MovementUploadPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [fileName, setFileName] = useState("");
  const [result, setResult] = useState<ParseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState<{ publishedAt: string; source?: string } | null>(null);
  const [months, setMonths] = useState<{ monthKey: string; month: string; publishedAt: string | null }[]>([]);
  const [drag, setDrag] = useState(false);

  const refreshMonths = useCallback(() => { fetch("/api/movement-snapshot?list=1").then((r) => r.json()).then((d) => setMonths(d.months || [])).catch(() => {}); }, []);
  useEffect(() => { refreshMonths(); }, [refreshMonths]);

  const handleFile = useCallback(async (file: File) => {
    setError(null); setResult(null); setPublished(null); setBusy(true); setFileName(file.name);
    try {
      const buf = await file.arrayBuffer();
      const res = parseWorkbook(buf);
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const onPublish = async () => {
    if (!result) return;
    setPublishing(true); setError(null);
    try {
      const r = await fetch("/api/movement-snapshot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ monthKey: result.snapshot.meta.monthKey, month: result.snapshot.meta.month, snapshot: result.snapshot }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `Publish failed (${r.status})`);
      setPublished({ publishedAt: d.publishedAt });
      refreshMonths();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPublishing(false);
    }
  };

  const onDownload = () => {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(result.snapshot)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = "movement-latest.json"; a.click(); URL.revokeObjectURL(url);
  };

  const m = result?.snapshot.meta;
  const moved = result ? result.snapshot.overall.reduce((a, r) => a + r.totalSupplied, 0) : 0;
  const forecast = m?.forecastV7Total ?? 0;

  return (
    <AppShell>
      <div className="space-y-5" style={{ maxWidth: 920 }}>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className={mono} style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--atlas-ink-muted)" }}>Forecast vs Movement</div>
            <h1 className="font-display" style={{ fontSize: 28, fontWeight: 400, color: "var(--atlas-ink)", marginTop: 2 }}>Upload &amp; refresh</h1>
            <div style={{ fontSize: 12, color: "var(--atlas-ink-muted)", marginTop: 2 }}>Drop the refreshed base workbook — parsed in your browser, then published for all teams.</div>
          </div>
          <Link href="/movement" className="px-3 py-1.5 rounded-lg" style={{ ...surface, fontSize: 12, color: "var(--atlas-ink-soft)", textDecoration: "none" }}>← Back to dashboard</Link>
        </div>

        {/* published months */}
        <div className="p-3 rounded-xl" style={surface}>
          <div className={mono} style={{ fontSize: 10, letterSpacing: "0.08em", color: "var(--atlas-ink-muted)", marginBottom: 8 }}>Published months</div>
          <div className="flex flex-wrap gap-2">
            {months.length === 0 && <span style={{ fontSize: 12, color: "var(--atlas-ink-muted)" }}>None yet.</span>}
            {months.map((m) => (
              <span key={m.monthKey} className="px-2.5 py-1 rounded-lg" style={{ background: "var(--atlas-surface-soft)", border: "1px solid var(--atlas-line)", fontSize: 12 }}>
                <b style={{ color: "var(--atlas-ink)" }}>{m.month}</b>{m.publishedAt && <span style={{ color: "var(--atlas-ink-muted)" }}> · {fmtWhen(m.publishedAt)}</span>}
              </span>
            ))}
          </div>
        </div>

        {/* raw-sheet templates */}
        <div className="p-3 rounded-xl" style={surface}>
          <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
            <div className={mono} style={{ fontSize: 10, letterSpacing: "0.08em", color: "var(--atlas-ink-muted)" }}>Raw-sheet templates</div>
            <div style={{ fontSize: 11, color: "var(--atlas-ink-faint)" }}>Export from BizeeBuy in these exact column layouts</div>
          </div>
          <div className="flex flex-wrap gap-2">
            {([["so", "SO (Sales Orders)"], ["stn", "STN (Stock Transfers)"], ["shipsheet", "Shipsheet"]] as const).map(([k, lbl]) => (
              <button key={k} onClick={() => downloadTemplate(k)} className="px-3 py-1.5 rounded-lg" style={{ background: "var(--atlas-surface-soft)", border: "1px solid var(--atlas-line)", color: "var(--atlas-ink-soft)", fontSize: 12, cursor: "pointer" }}>
                ↓ {lbl} template
              </button>
            ))}
          </div>
        </div>

        {/* dropzone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); }}
          onClick={() => inputRef.current?.click()}
          className="rounded-xl flex flex-col items-center justify-center text-center"
          style={{ border: `1.5px dashed ${drag ? "var(--atlas-accent)" : "var(--atlas-line)"}`, background: drag ? "var(--atlas-accent-bg)" : "var(--atlas-surface-soft)", padding: "40px 20px", cursor: "pointer" }}>
          <input ref={inputRef} type="file" accept=".xlsx,.xlsb,.xlsm" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
          <div style={{ fontSize: 26, marginBottom: 6 }}>↑</div>
          <div style={{ fontSize: 14, color: "var(--atlas-ink)", fontWeight: 600 }}>{busy ? "Parsing…" : "Drop the base workbook, or click to choose"}</div>
          <div style={{ fontSize: 12, color: "var(--atlas-ink-muted)", marginTop: 4 }}>.xlsx with sheets: Overall · Channelwise Final · Qcom · SO · STN · Shipsheet Today</div>
          {fileName && <div style={{ fontSize: 12, color: "var(--atlas-ink-soft)", marginTop: 8 }}>Selected: <b>{fileName}</b></div>}
        </div>

        {error && <div className="p-3 rounded-xl" style={{ background: "var(--atlas-red-bg)", border: "1px solid var(--atlas-line)", color: "var(--atlas-red)", fontSize: 13 }}>{error}</div>}

        {/* preview */}
        {result && m && (
          <div className="space-y-4">
            <div className="p-3 rounded-xl flex items-center gap-2 flex-wrap" style={{ background: "var(--atlas-accent-bg)", border: "1px solid var(--atlas-line)" }}>
              <span className={mono} style={{ fontSize: 10, letterSpacing: "0.08em", color: "var(--atlas-ink-muted)" }}>Detected month</span>
              <b style={{ fontSize: 15, color: "var(--atlas-ink)" }}>{m.month}</b>
              <span style={{ fontSize: 12, color: "var(--atlas-ink-muted)" }}>· through day {m.updatedOnDay ?? m.daysElapsed} of {m.daysInMonth}</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { l: "Forecast (V7)", v: fmtQty(forecast) },
                { l: "Moved", v: fmtQty(moved), sub: fmtPct(pctOf(moved, forecast), 1) + " of forecast" },
                { l: "SKUs", v: String(m.counts.overall) },
                { l: "Days with movement", v: String(result.snapshot.daily.length) },
              ].map((k) => (
                <div key={k.l} className="p-4 rounded-xl" style={surface}>
                  <div className={mono} style={{ fontSize: 9.5, letterSpacing: "0.1em", color: "var(--atlas-ink-muted)" }}>{k.l}</div>
                  <div className="font-display" style={{ fontSize: 24, color: "var(--atlas-ink)" }}>{k.v}</div>
                  {k.sub && <div style={{ fontSize: 11, color: "var(--atlas-ink-muted)", marginTop: 2 }}>{k.sub}</div>}
                </div>
              ))}
            </div>

            <div className="p-3 rounded-xl" style={surface}>
              <div style={{ fontSize: 12.5, color: "var(--atlas-ink-soft)" }}>
                Parsed <b style={{ color: "var(--atlas-ink)" }}>{m.counts.overall}</b> overall · <b style={{ color: "var(--atlas-ink)" }}>{m.counts.channelwise}</b> channel · <b style={{ color: "var(--atlas-ink)" }}>{m.counts.qcom}</b> qcom rows across <b style={{ color: "var(--atlas-ink)" }}>{m.channels.length}</b> channels and <b style={{ color: "var(--atlas-ink)" }}>{m.platforms.length}</b> platforms.
              </div>
              {result.warnings.length > 0 && (
                <ul style={{ marginTop: 8, fontSize: 12, color: "var(--atlas-amber-warn, #D97706)", listStyle: "disc", paddingLeft: 18 }}>
                  {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              )}
            </div>

            <div className="flex items-center gap-3 flex-wrap">
              <button onClick={onPublish} disabled={publishing} className="px-4 py-2 rounded-lg font-mono"
                style={{ background: "var(--atlas-accent)", color: "#fff", border: "none", fontSize: 12, letterSpacing: "0.04em", cursor: publishing ? "wait" : "pointer", opacity: publishing ? 0.7 : 1 }}>
                {publishing ? "Publishing…" : `Publish ${m.month} to dashboard`}
              </button>
              <button onClick={onDownload} className="px-4 py-2 rounded-lg font-mono" style={{ ...surface, color: "var(--atlas-ink-soft)", fontSize: 12, letterSpacing: "0.04em", cursor: "pointer" }}>↓ Download JSON</button>
              {published && <span style={{ fontSize: 12.5, color: "var(--atlas-green)" }}>✓ Published {fmtWhen(published.publishedAt)} — <Link href="/movement" style={{ color: "var(--atlas-accent)" }}>open dashboard</Link></span>}
            </div>
          </div>
        )}

        <div style={{ fontSize: 11, color: "var(--atlas-ink-faint)", lineHeight: 1.6 }}>
          The workbook is read entirely in your browser; only the compact JSON summary is sent to the server when you publish. Publishing writes <code>public/data/movement-latest.json</code>, which the dashboard reads first (falling back to the bundled June snapshot).
        </div>
      </div>
    </AppShell>
  );
}
