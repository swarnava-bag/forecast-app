"use client";
import { useRef, useState } from "react";
import * as XLSX from "xlsx";
import { csvToTable, extractOrders, COLUMNS, type ParsedUpload } from "@/lib/fulfillment/parse";
import type { ChannelMapRow, OrderRow } from "@/lib/fulfillment/engine";
import { monthLabel, type Snapshot } from "@/lib/fulfillment/snapshot";
import { uploadSpan, touchedMonths, monthsToLoad, planMonths, type MonthPlan } from "@/lib/fulfillment/months";
import { loadMonth } from "@/lib/fulfillment/store";
import { consolidate, splitRecords, parseRecord, escapeField, colKey, LOW_OVERLAP, type CsvFileInput, type FileReport } from "@/lib/consolidate";
import { surface, soft, muted, faint, fmtDayLong, fmtInt, todayDay, Btn, Notice } from "./ui";

const ACCEPT = /\.(csv|txt|xlsx|xlsm|xls|xlsb)$/i;
const isExcel = (n: string) => /\.(xlsx|xlsm|xls|xlsb)$/i.test(n);
const HEADER_KEY = colKey(COLUMNS.orderCode); // "display order code"

/** Drop any notes rows above the header (e.g. the workbook's Base sheet has one). */
function trimToHeader(text: string): string {
  const nl = text.indexOf("\n");
  const firstLine = nl < 0 ? text : text.slice(0, nl);
  if (parseRecord(firstLine.replace(/^﻿/, "")).some((c) => colKey(c) === HEADER_KEY)) return text;
  const recs = splitRecords(text);
  const i = recs.slice(0, 10).findIndex((r) => parseRecord(r).some((c) => colKey(c) === HEADER_KEY));
  return i > 0 ? recs.slice(i).join("\n") : text;
}

/** Any warehouse SO file → CSV text for the Consolidator. Excel → "Base" sheet if present, else the first. */
async function readAsCsv(f: File): Promise<CsvFileInput> {
  if (!isExcel(f.name)) return { name: f.name, text: trimToHeader(await f.text()) };
  const wb = XLSX.read(await f.arrayBuffer(), { type: "array", dense: true });
  const sheet = wb.SheetNames.find((s) => s.trim().toLowerCase() === "base") ?? wb.SheetNames[0];
  // raw values: dates stay Excel serials (parsed exactly), not locale-formatted text
  const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheet], { header: 1, raw: true, defval: "", blankrows: false });
  const h = Math.max(0, rows.slice(0, 10).findIndex((r) => r.some((c) => colKey(String(c ?? "")) === HEADER_KEY)));
  const text = rows.slice(h).map((r) => r.map((v) => escapeField(v === null || v === undefined ? "" : String(v))).join(",")).join("\n");
  return { name: f.name, text };
}

type Preview = ParsedUpload & {
  plans: MonthPlan[]; firstDay: number; lastDay: number; unmapped: { name: string; orders: number }[];
  reports: FileReport[]; columns: number; consolidatedCsv: string;
};

export default function UploadTab({ channelMap, existingMonths, onPublished }: {
  channelMap: ChannelMapRow[];
  existingMonths: string[];
  /** publish each month snapshot in turn; resolves after all are saved */
  onPublished: (snaps: Snapshot[], progress: (msg: string) => void) => Promise<void>;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const ref = useRef<HTMLInputElement | null>(null);

  const add = (list: FileList | null) => {
    if (!list) return;
    const ok = Array.from(list).filter((f) => ACCEPT.test(f.name));
    const by = new Map(files.map((f) => [f.name, f]));
    ok.forEach((f) => by.set(f.name, f));
    setFiles([...by.values()]); setPreview(null); setDone(null);
    setErr(ok.length < list.length ? "Only CSV / Excel files are accepted — other files were skipped." : null);
  };

  const analyse = async () => {
    setErr(null); setPreview(null); setDone(null);
    try {
      const inputs: CsvFileInput[] = [];
      for (const f of files) {
        setBusy(`Reading ${f.name}…`);
        await new Promise((r) => setTimeout(r, 0)); // let the status paint
        inputs.push(await readAsCsv(f));
      }
      // 1) Consolidator: one header, columns lined up across warehouse files
      setBusy(`Consolidating ${inputs.length} file${inputs.length === 1 ? "" : "s"}…`);
      await new Promise((r) => setTimeout(r, 0));
      const merged = consolidate(inputs);
      const wrong = merged.reports.filter((r) => r.overlap < LOW_OVERLAP);
      if (wrong.length) {
        throw new Error(`${wrong.map((r) => `"${r.name}" (${Math.round(r.overlap * 100)}% of columns match)`).join(", ")} ${wrong.length === 1 ? "does" : "do"} not look like the same Sales Order export as "${merged.reports[0].name}". Remove ${wrong.length === 1 ? "it" : "them"} and try again.`);
      }
      // 2) Base → one row per order
      setBusy("Building orders…");
      await new Promise((r) => setTimeout(r, 0));
      const p = { ...extractOrders([csvToTable("Consolidated Base", merged.csv)]), files: merged.reports.map((r) => ({ name: r.name, rows: r.rows })) };
      if (p.orders.length === 0) throw new Error("No active orders found in these files.");
      const span = uploadSpan(p.orders);
      if (!span) throw new Error("None of the orders has an Order Date — cannot tell which month they belong to.");
      if (span.last > todayDay()) throw new Error(`Orders are dated up to ${fmtDayLong(span.last)}, which is in the future — check the export.`);

      // 3) Month segregation: rebuild every month the upload touches (load what's stored first)
      const touched = touchedMonths(span, existingMonths);
      const stored = new Map<string, OrderRow[]>();
      for (const k of monthsToLoad(touched, existingMonths)) {
        setBusy(`Loading stored ${monthLabel(k)} to merge…`);
        stored.set(k, (await loadMonth(k)).orders);
      }
      const plans = planMonths(p.orders, stored, existingMonths);

      const mapped = new Set(channelMap.map((c) => c.channelName));
      const um = new Map<string, number>();
      for (const o of p.orders) if (!mapped.has(o.channelName)) um.set(o.channelName, (um.get(o.channelName) ?? 0) + 1);
      setPreview({
        ...p, plans, firstDay: span.first, lastDay: span.last,
        unmapped: [...um].map(([name, orders]) => ({ name, orders })).sort((a, b) => b.orders - a.orders),
        reports: merged.reports, columns: merged.header.length, consolidatedCsv: merged.csv,
      });
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  const publish = async () => {
    if (!preview) return;
    setBusy("Publishing…"); setErr(null);
    try {
      const snaps: Snapshot[] = preview.plans.map((pl) => ({
        monthKey: pl.monthKey, uploadedAt: new Date().toISOString(), uploadedBy: "",
        files: preview.files, itemRows: preview.itemRows, inactiveOrders: preview.inactiveOrders, orders: pl.orders,
      }));
      await onPublished(snaps, (m) => setBusy(m));
      setDone(`Published ${preview.plans.map((pl) => monthLabel(pl.monthKey)).join(", ")}.`);
      setFiles([]); setPreview(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  const monthsLabel = preview ? preview.plans.map((pl) => monthLabel(pl.monthKey)).join(" + ") : "";

  return (
    <div className="space-y-4" style={{ maxWidth: 860 }}>
      <div className="p-4 rounded-xl space-y-3" style={surface}>
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 700 }}>Daily upload — warehouse Sales Order files</h3>
          <p style={{ fontSize: 12.5, ...muted }} className="mt-0.5">
            Drop each warehouse&apos;s Unicommerce Sale Order export (EZ BLR, EZ DEL, EZ Mum, PMR, Prozo…) together, as exported.
            They are combined by the Consolidator into one Base — downloadable — which builds the dashboard.
            The upload is filed month by month: it <b>replaces the order dates it covers and keeps everything else</b>, so a 1 Nov → 2 Dec file updates November
            and starts December, and older months (back to April) can be backfilled. Tip: backfill one or two months per upload.
          </p>
        </div>
        <input ref={ref} type="file" multiple accept=".csv,.txt,.xlsx,.xlsm,.xls,.xlsb" hidden onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
        <div onClick={() => ref.current?.click()} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); add(e.dataTransfer.files); }}
          className="px-4 py-8 rounded-lg text-center" style={{ ...soft, borderStyle: "dashed", borderColor: drag ? "var(--atlas-accent)" : "var(--atlas-line)", cursor: "pointer", fontSize: 13, ...muted }}>
          <b style={{ color: "var(--atlas-ink)" }}>Drop files here</b> or click to choose — .csv or Excel
        </div>
        {files.length > 0 && (
          <ul style={{ fontSize: 12.5 }} className="space-y-1">
            {files.map((f) => (
              <li key={f.name} className="flex items-center gap-2">
                <span className="truncate">{f.name}</span><span style={faint}>{(f.size / 1048576).toFixed(1)} MB</span>
                <button onClick={() => { setFiles(files.filter((x) => x !== f)); setPreview(null); }} style={{ background: "none", border: "none", cursor: "pointer", ...faint }} title="Remove">✕</button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-3">
          <Btn primary disabled={files.length === 0 || !!busy} onClick={analyse}>Consolidate &amp; check</Btn>
          {busy && <span style={{ fontSize: 12.5, ...muted }}>{busy}</span>}
        </div>
        {err && <Notice tone="error">{err}</Notice>}
        {done && <Notice tone="ok">{done}</Notice>}
      </div>

      {preview && (
        <div className="p-4 rounded-xl space-y-3" style={surface}>
          <h3 style={{ fontSize: 14, fontWeight: 700 }}>Ready to publish: {monthsLabel}</h3>
          <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", fontSize: 12.5 }}>
            {[["Item rows", fmtInt(preview.itemRows)], ["Active orders", fmtInt(preview.orders.length)], ["Fully cancelled orders", fmtInt(preview.inactiveOrders)], ["Order dates", `${fmtDayLong(preview.firstDay)} → ${fmtDayLong(preview.lastDay)}`]].map(([k, v]) => (
              <div key={k} className="p-2.5 rounded-lg" style={soft}><div style={faint}>{k}</div><div style={{ fontWeight: 700, fontSize: 14 }}>{v}</div></div>
            ))}
          </div>
          <div className="rounded-lg p-3" style={soft}>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
              <b style={{ fontSize: 12.5 }}>Consolidated Base · {fmtInt(preview.itemRows)} rows · {preview.columns} columns</b>
              <Btn small onClick={() => {
                const blob = new Blob(["﻿", preview.consolidatedCsv], { type: "text/csv;charset=utf-8" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url; a.download = `Consolidated Base ${fmtDayLong(preview.firstDay)} to ${fmtDayLong(preview.lastDay)}.csv`;
                document.body.appendChild(a); a.click(); a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1500);
              }}>↓ Download consolidated Base</Btn>
            </div>
            <table className="w-full" style={{ fontSize: 12.5 }}>
              <tbody>
                {preview.reports.map((r) => (
                  <tr key={r.name}>
                    <td className="pr-4 py-0.5">{r.name}</td>
                    <td className="text-right pr-4" style={{ ...muted, fontVariantNumeric: "tabular-nums" }}>{fmtInt(r.rows)} rows</td>
                    <td className="text-right" style={{ fontSize: 12, color: r.header === "exact" ? "var(--atlas-green)" : "var(--atlas-ink-soft)" }}>
                      {r.header === "exact" ? "✓ columns match" : `columns lined up${r.missing.length ? ` · ${r.missing.length} missing (blank)` : ""}${r.extra.length ? ` · ${r.extra.length} extra` : ""}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.unmapped.length > 0 && (
            <Notice tone="warn">
              {preview.unmapped.length} channel name(s) are not in the Channel Mapper and will be left out of the dashboard until mapped (Settings → Channel Mapper):{" "}
              {preview.unmapped.map((u) => `${u.name} (${u.orders})`).join(", ")}
            </Notice>
          )}
          <div className="rounded-lg p-3" style={soft}>
            <b style={{ fontSize: 12.5 }}>What happens to each month</b>
            <table className="w-full mt-1.5" style={{ fontSize: 12.5, fontVariantNumeric: "tabular-nums" }}>
              <tbody>
                {preview.plans.map((pl) => (
                  <tr key={pl.monthKey}>
                    <td className="pr-4 py-0.5" style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{monthLabel(pl.monthKey)}</td>
                    <td className="pr-4" style={{ whiteSpace: "nowrap" }}>
                      {pl.isNew ? <span style={{ color: "var(--atlas-green)" }}>＋ New month</span> : <span>↻ Update</span>}
                    </td>
                    <td style={muted}>
                      {pl.replacedDays
                        ? <>{pl.isNew ? "" : "replaces "}{fmtDayLong(pl.replacedDays.first)} → {fmtDayLong(pl.replacedDays.last)} with {fmtInt(pl.fromUpload)} uploaded orders{pl.kept ? <> · keeps {fmtInt(pl.kept)} stored orders from other days</> : null}</>
                        : <>refreshes the carry-over of last month&apos;s final days (orders due in this month)</>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Btn primary disabled={!!busy} onClick={publish}>{busy ?? `Publish ${monthsLabel}`}</Btn>
        </div>
      )}
    </div>
  );
}
