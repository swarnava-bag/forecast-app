"use client";
// Consolidator — drop any set of files that share the same columns (CSV or
// Excel), get one consolidated file back. Runs entirely in the browser.
import { useRef, useState } from "react";
import * as XLSX from "xlsx";
import AppShell from "@/app/components/AppShell";
import { consolidate, LOW_OVERLAP, type ConsolidateResult } from "@/lib/consolidate";

const surface: React.CSSProperties = { background: "var(--atlas-surface)", border: "1px solid var(--atlas-line)" };
const fmtMB = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;
const ACCEPT = /\.(csv|txt|xlsx|xlsm|xls|xlsb)$/i;
const isExcel = (name: string) => /\.(xlsx|xlsm|xls|xlsb)$/i.test(name);
const EXCEL_MAX_ROWS = 1_048_575;

type OutFormat = "csv" | "xlsx";

/** Read a file as CSV text. Excel → first sheet, as displayed (formatted) values. */
async function readAsCsv(f: File): Promise<{ text: string; sheet?: string }> {
  if (!isExcel(f.name)) return { text: await f.text() };
  const wb = XLSX.read(await f.arrayBuffer(), { type: "array", cellDates: false });
  const sheet = wb.SheetNames[0];
  if (!sheet) throw new Error(`"${f.name}" has no sheets.`);
  return { text: XLSX.utils.sheet_to_csv(wb.Sheets[sheet], { blankrows: false }), sheet };
}

export default function ConsolidatorPage() {
  const [files, setFiles] = useState<File[]>([]);
  const [sheets, setSheets] = useState<Record<string, string>>({});
  const [addSource, setAddSource] = useState(false);
  const [format, setFormat] = useState<OutFormat>("csv");
  const [outName, setOutName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<ConsolidateResult | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const reset = () => { setResult(null); setErr(null); };

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const ok = Array.from(list).filter((f) => ACCEPT.test(f.name));
    reset();
    if (ok.length < list.length) setErr("Only CSV / Excel files are accepted — other files were skipped.");
    const byName = new Map(files.map((f) => [f.name, f]));
    for (const f of ok) byName.set(f.name, f); // re-adding a name replaces it
    const next = [...byName.values()];
    setFiles(next);
    // default output format follows the inputs: all Excel → Excel
    if (next.length && next.every((f) => isExcel(f.name))) setFormat("xlsx");
  };

  const remove = (name: string) => { setFiles((p) => p.filter((f) => f.name !== name)); reset(); };

  const run = async () => {
    setBusy(true); reset();
    try {
      const sh: Record<string, string> = {};
      const inputs = [];
      for (const f of files) {
        const { text, sheet } = await readAsCsv(f);
        if (sheet) sh[f.name] = sheet;
        inputs.push({ name: f.name, text });
      }
      setSheets(sh);
      const r = consolidate(inputs, { addSourceColumn: addSource });
      if (format === "xlsx" && r.totalRows > EXCEL_MAX_ROWS) throw new Error(`${r.totalRows.toLocaleString()} rows is more than Excel's limit — choose CSV.`);
      setResult(r);
      await download(r, format);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const fileName = (fmt: OutFormat) => {
    const d = new Date();
    const stamp = `${String(d.getDate()).padStart(2, "0")}-${d.toLocaleString("en-GB", { month: "short" })}-${d.getFullYear()}`;
    const base = outName.trim().replace(/[\\/:*?"<>|]/g, "") || `Consolidated ${stamp}`;
    return `${base.replace(/\.(csv|xlsx)$/i, "")}.${fmt}`;
  };

  const download = async (r: ConsolidateResult, fmt: OutFormat) => {
    let blob: Blob;
    if (fmt === "csv") {
      blob = new Blob(["﻿", r.csv], { type: "text/csv;charset=utf-8" }); // BOM → Excel reads UTF-8
    } else {
      await new Promise((res) => setTimeout(res, 0)); // let "busy" paint before the heavy write
      // raw: keep every value as text exactly as in the source (no date/number re-guessing)
      const parsed = XLSX.read(r.csv, { type: "string", raw: true });
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, parsed.Sheets[parsed.SheetNames[0]], "Consolidated");
      const out = XLSX.write(wb, { type: "array", bookType: "xlsx", compression: true });
      blob = new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = fileName(fmt);
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const flagged = result?.reports.filter((r) => r.header === "realigned") ?? [];
  const canRun = files.length > 0 && !busy;

  return (
    <AppShell>
      <div className="space-y-5" style={{ maxWidth: 860 }}>
        <div>
          <h1 className="text-2xl font-bold">Consolidator</h1>
          <p className="text-sm mt-1" style={{ color: "var(--atlas-ink-muted)" }}>
            Combine any set of files that have the same columns into one file — header once, all rows below.
            Works with CSV and Excel (first sheet). Processed in your browser; nothing is uploaded.
          </p>
        </div>

        <div className="p-4 rounded-xl space-y-4" style={surface}>
          <input ref={inputRef} type="file" accept=".csv,.txt,.xlsx,.xlsm,.xls,.xlsb" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
          <div
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
            className="w-full px-4 py-8 rounded-lg text-center"
            style={{ background: "var(--atlas-surface-soft)", border: `1px dashed ${dragOver ? "var(--atlas-accent)" : "var(--atlas-line)"}`, cursor: "pointer", fontSize: 13, color: "var(--atlas-ink-muted)" }}
          >
            <b style={{ color: "var(--atlas-ink)" }}>Drop files here</b> or click to choose — .csv, .xlsx, .xls, .xlsb (any number, add more anytime)
          </div>

          {files.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table className="w-full" style={{ fontSize: 12.5, borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ color: "var(--atlas-ink-faint)", textAlign: "left" }}>
                    <th className="py-1.5 font-medium">File</th>
                    <th className="py-1.5 font-medium text-right">Size</th>
                    <th className="py-1.5 font-medium text-right">Rows</th>
                    <th className="py-1.5 font-medium text-right">Columns</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {files.map((f) => {
                    const rep = result?.reports.find((r) => r.name === f.name);
                    const low = rep && rep.overlap < LOW_OVERLAP;
                    return (
                      <tr key={f.name} style={{ borderTop: "1px solid var(--atlas-line)" }}>
                        <td className="py-1.5">
                          {f.name}
                          {sheets[f.name] && <span style={{ color: "var(--atlas-ink-faint)" }}> · sheet “{sheets[f.name]}”</span>}
                        </td>
                        <td className="py-1.5 text-right" style={{ color: "var(--atlas-ink-muted)" }}>{fmtMB(f.size)}</td>
                        <td className="py-1.5 text-right">{rep ? rep.rows.toLocaleString() : "—"}</td>
                        <td className="py-1.5 text-right" style={{ color: !rep ? undefined : low ? "var(--atlas-red)" : rep.header === "realigned" ? "var(--atlas-amber, #b45309)" : "var(--atlas-green)" }}>
                          {!rep ? "" : low ? `⚠ only ${Math.round(rep.overlap * 100)}% match` : rep.header === "exact" ? "✓ match" : "realigned"}
                        </td>
                        <td className="py-1.5 text-right">
                          <button onClick={() => remove(f.name)} title="Remove" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--atlas-ink-faint)" }}>✕</button>
                        </td>
                      </tr>
                    );
                  })}
                  {result && (
                    <tr style={{ borderTop: "1px solid var(--atlas-line)", fontWeight: 600 }}>
                      <td className="py-1.5">Consolidated</td>
                      <td />
                      <td className="py-1.5 text-right">{result.totalRows.toLocaleString()}</td>
                      <td className="py-1.5 text-right" style={{ color: "var(--atlas-ink-muted)", fontWeight: 400 }}>{result.header.length + (addSource ? 1 : 0)} cols</td>
                      <td />
                    </tr>
                  )}
                </tbody>
              </table>
              <button onClick={() => { setFiles([]); setSheets({}); reset(); }} className="mt-2" style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, color: "var(--atlas-ink-faint)" }}>Clear all</button>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-x-6 gap-y-3" style={{ fontSize: 12.5, color: "var(--atlas-ink-soft)" }}>
            <div className="flex items-center gap-2">
              Output
              {(["csv", "xlsx"] as const).map((f) => (
                <button key={f} onClick={() => setFormat(f)} className="px-2.5 py-1 rounded-md"
                  style={{ border: "1px solid var(--atlas-line)", cursor: "pointer", fontSize: 12, background: format === f ? "var(--atlas-accent)" : "var(--atlas-surface-soft)", color: format === f ? "#fff" : "var(--atlas-ink-soft)" }}>
                  {f === "csv" ? "CSV" : "Excel"}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2">
              File name
              <input value={outName} onChange={(e) => setOutName(e.target.value)} placeholder={fileName(format).replace(/\.\w+$/, "")}
                className="px-2 py-1 rounded-md" style={{ border: "1px solid var(--atlas-line)", background: "var(--atlas-surface-soft)", color: "var(--atlas-ink)", fontSize: 12.5, width: 220 }} />
            </label>
            <label className="flex items-center gap-2" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={addSource} onChange={(e) => { setAddSource(e.target.checked); setResult(null); }} />
              Add <b>Source File</b> column
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button onClick={run} disabled={!canRun} className="px-4 py-2 rounded-lg font-semibold text-white"
              style={{ background: canRun ? "var(--atlas-accent)" : "var(--atlas-surface-soft)", border: "none", fontSize: 13, cursor: canRun ? "pointer" : "not-allowed" }}>
              {busy ? (format === "xlsx" ? "Building Excel…" : "Consolidating…") : `↓ Consolidate ${files.length || ""} file${files.length === 1 ? "" : "s"}`}
            </button>
            {format === "xlsx" && files.reduce((a, f) => a + f.size, 0) > 10 * 1024 * 1024 && !result && (
              <span style={{ fontSize: 12, color: "var(--atlas-ink-faint)" }}>Large inputs — Excel output can take ~15s; CSV is instant.</span>
            )}
            {result && (
              <>
                <span style={{ fontSize: 12.5, color: "var(--atlas-green)" }}>✓ {result.totalRows.toLocaleString()} rows downloaded</span>
                <button onClick={() => download(result, format)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12.5, color: "var(--atlas-accent)" }}>
                  Download again as {format === "csv" ? "CSV" : "Excel"}
                </button>
              </>
            )}
          </div>

          {flagged.length > 0 && (
            <div className="p-3 rounded-lg" style={{ background: "var(--atlas-surface-soft)", border: "1px solid var(--atlas-line)", fontSize: 12.5, color: "var(--atlas-ink-soft)" }}>
              <b>Column differences</b> — these files were lined up to the first file&apos;s columns (names matched ignoring case/spacing):
              <ul className="mt-1 ml-4 list-disc">
                {flagged.map((r) => (
                  <li key={r.name} style={r.overlap < LOW_OVERLAP ? { color: "var(--atlas-red)" } : undefined}>
                    {r.name}
                    {r.overlap < LOW_OVERLAP && <> — <b>shares only {Math.round(r.overlap * 100)}% of columns, probably a different kind of file</b></>}
                    {r.missing.length > 0 && <> · missing (left blank): {r.missing.slice(0, 8).join(", ")}{r.missing.length > 8 ? ` +${r.missing.length - 8} more` : ""}</>}
                    {r.extra.length > 0 && <> · extra (added at end): {r.extra.slice(0, 8).join(", ")}{r.extra.length > 8 ? ` +${r.extra.length - 8} more` : ""}</>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {err && <div className="p-3 rounded-lg" style={{ background: "var(--atlas-red-bg)", border: "1px solid var(--atlas-line)", color: "var(--atlas-red)", fontSize: 13 }}>{err}</div>}
        </div>
      </div>
    </AppShell>
  );
}
