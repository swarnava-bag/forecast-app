"use client";
// Filterable data grid: a filter on every column (tick-list / contains / range),
// sort, column chooser, paging and "export this view" to Excel.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DAY } from "@/lib/fulfillment/engine";
import { buildGridWorkbook, saveFile } from "@/lib/fulfillment/download";
import { surface, soft, muted, faint, inputStyle, Btn, fmtInt } from "./ui";

export type ColType = "text" | "enum" | "number" | "date" | "datetime";
export type GridCol<R> = {
  key: string;
  label: string;
  type: ColType;
  /** raw value used for filter / sort / export (dates & datetimes: seconds) */
  value: (r: R) => string | number | null;
  render?: (r: R) => ReactNode;
  width?: number;
  align?: "left" | "right";
  /** hidden until switched on in "Columns" */
  optional?: boolean;
};
export type Filter =
  | { kind: "text"; q: string }
  | { kind: "enum"; values: string[] }
  | { kind: "range"; min: number | null; max: number | null };
export type Filters = Record<string, Filter>;
type Sort = { key: string; dir: 1 | -1 } | null;

const BLANK = "(blank)";
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");
const isoOf = (sec: number) => { const t = new Date(sec * 1000); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; };
const secOfIso = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d) / 1000; };

export function fmtValue(type: ColType, v: string | number | null): string {
  if (v === null || v === "") return "";
  if (typeof v === "number") {
    if (type === "date") { const t = new Date(v * 1000); return `${t.getUTCDate()} ${MON[t.getUTCMonth()]}`; }
    if (type === "datetime") { const t = new Date(v * 1000); return `${t.getUTCDate()} ${MON[t.getUTCMonth()]} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`; }
    return Number.isInteger(v) ? v.toLocaleString("en-IN") : v.toFixed(1);
  }
  return v;
}

function matches<R>(r: R, col: GridCol<R>, f: Filter): boolean {
  const v = col.value(r);
  if (f.kind === "text") return !f.q || String(v ?? "").toLowerCase().includes(f.q.toLowerCase());
  if (f.kind === "enum") return f.values.includes(v === null || v === "" ? BLANK : String(v));
  if (typeof v !== "number") return f.min === null && f.max === null;
  return (f.min === null || v >= f.min) && (f.max === null || v <= f.max);
}
const isActive = (f: Filter | undefined) =>
  !!f && (f.kind === "text" ? f.q.trim() !== "" : f.kind === "enum" ? true : f.min !== null || f.max !== null);

function describe(col: GridCol<unknown>, f: Filter): string {
  if (f.kind === "text") return `contains “${f.q}”`;
  if (f.kind === "enum") return f.values.length <= 3 ? f.values.join(", ") : `${f.values.length} selected`;
  const show = (v: number | null) => (v === null ? "…" : col.type === "date" || col.type === "datetime" ? fmtValue("date", v) : fmtValue("number", v));
  return `${show(f.min)} – ${show(f.max)}`;
}

/** Popover anchored to a header button, rendered position:fixed so table overflow doesn't clip it. */
function Popover({ anchor, onClose, children }: { anchor: DOMRect; onClose: () => void; children: ReactNode }) {
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - 300));
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
      <div className="rounded-lg p-3 space-y-2" style={{ ...surface, position: "fixed", top: anchor.bottom + 4, left, width: 280, zIndex: 41, boxShadow: "0 8px 24px rgba(0,0,0,.18)" }}>
        {children}
      </div>
    </>
  );
}

function FilterEditor<R>({ col, rowsForOptions, value, onChange }: {
  col: GridCol<R>; rowsForOptions: R[]; value: Filter | undefined; onChange: (f: Filter | undefined) => void;
}) {
  const [q, setQ] = useState("");
  const options = useMemo(() => {
    if (col.type !== "enum") return [];
    const m = new Map<string, number>();
    for (const r of rowsForOptions) { const v = col.value(r); const k = v === null || v === "" ? BLANK : String(v); m.set(k, (m.get(k) ?? 0) + 1); }
    return [...m].sort((a, b) => b[1] - a[1]);
  }, [col, rowsForOptions]);

  if (col.type === "enum") {
    const sel = value?.kind === "enum" ? new Set(value.values) : null; // null = all
    const shown = options.filter(([k]) => !q || k.toLowerCase().includes(q.toLowerCase()));
    const toggle = (k: string) => {
      const next = new Set(sel ?? options.map(([o]) => o));
      if (next.has(k)) next.delete(k); else next.add(k);
      onChange(next.size === options.length ? undefined : { kind: "enum", values: [...next] });
    };
    return (
      <>
        {options.length > 8 && <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search values…" style={inputStyle} />}
        <div className="flex gap-3" style={{ fontSize: 12 }}>
          <button onClick={() => onChange(undefined)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--atlas-accent)" }}>All</button>
          <button onClick={() => onChange({ kind: "enum", values: [] })} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--atlas-accent)" }}>None</button>
          {q && <button onClick={() => onChange({ kind: "enum", values: shown.map(([k]) => k) })} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--atlas-accent)" }}>Only matches</button>}
        </div>
        <div style={{ maxHeight: 260, overflowY: "auto" }} className="space-y-0.5">
          {shown.map(([k, n]) => (
            <label key={k} className="flex items-center gap-2 px-1 py-0.5 rounded" style={{ fontSize: 12.5, cursor: "pointer" }}>
              <input type="checkbox" checked={sel ? sel.has(k) : true} onChange={() => toggle(k)} />
              <span className="truncate flex-1" title={k} style={k === BLANK ? faint : undefined}>{k}</span>
              <span style={{ ...faint, fontVariantNumeric: "tabular-nums" }}>{fmtInt(n)}</span>
            </label>
          ))}
          {shown.length === 0 && <div style={{ fontSize: 12, ...faint }}>No values</div>}
        </div>
      </>
    );
  }
  if (col.type === "text") {
    return <input autoFocus value={value?.kind === "text" ? value.q : ""} placeholder="Contains…" style={inputStyle}
      onChange={(e) => onChange(e.target.value ? { kind: "text", q: e.target.value } : undefined)} />;
  }
  const r = value?.kind === "range" ? value : { kind: "range" as const, min: null, max: null };
  const isDate = col.type === "date" || col.type === "datetime";
  const set = (patch: Partial<{ min: number | null; max: number | null }>) => {
    const n = { ...r, ...patch };
    onChange(n.min === null && n.max === null ? undefined : n);
  };
  return (
    <div className="grid grid-cols-2 gap-2" style={{ fontSize: 12, ...muted }}>
      <label>From{isDate
        ? <input type="date" value={r.min !== null ? isoOf(r.min) : ""} onChange={(e) => set({ min: e.target.value ? secOfIso(e.target.value) : null })} style={inputStyle} />
        : <input type="number" value={r.min ?? ""} onChange={(e) => set({ min: e.target.value === "" ? null : Number(e.target.value) })} style={inputStyle} />}
      </label>
      <label>To{isDate
        ? <input type="date" value={r.max !== null ? isoOf(r.max - DAY + 1) : ""} onChange={(e) => set({ max: e.target.value ? secOfIso(e.target.value) + DAY - 1 : null })} style={inputStyle} />
        : <input type="number" value={r.max ?? ""} onChange={(e) => set({ max: e.target.value === "" ? null : Number(e.target.value) })} style={inputStyle} />}
      </label>
    </div>
  );
}

export default function DataGrid<R>({ rows, cols, rowKey, initialFilters, initialSort, exportName, storageKey, toolbar, pageSize = 100, emptyText = "No rows match the filters." }: {
  rows: R[];
  cols: GridCol<R>[];
  rowKey: (r: R) => string;
  initialFilters?: Filters;
  initialSort?: Sort;
  exportName: string;
  storageKey: string; // remembers visible columns per grid
  toolbar?: (view: R[]) => ReactNode;
  pageSize?: number;
  emptyText?: string;
}) {
  const [filters, setFilters] = useState<Filters>(initialFilters ?? {});
  const [sort, setSort] = useState<Sort>(initialSort ?? null);
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<{ key: string; rect: DOMRect } | null>(null);
  const [colsOpen, setColsOpen] = useState<DOMRect | null>(null);
  const [visible, setVisible] = useState<Set<string>>(() => new Set(cols.filter((c) => !c.optional).map((c) => c.key)));
  const loaded = useRef(false);

  // remembered column choice (per-viewer convenience)
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    try {
      const saved = JSON.parse(localStorage.getItem(`ff-grid-cols:${storageKey}`) ?? "null");
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time restore from browser storage
      if (Array.isArray(saved)) setVisible(new Set(saved.filter((k: string) => cols.some((c) => c.key === k))));
    } catch { /* storage unavailable */ }
  }, [cols, storageKey]);
  const setVis = (next: Set<string>) => {
    setVisible(next);
    try { localStorage.setItem(`ff-grid-cols:${storageKey}`, JSON.stringify([...next])); } catch { /* ignore */ }
  };

  const byKey = useMemo(() => new Map(cols.map((c) => [c.key, c])), [cols]);
  const active = useMemo(() => Object.entries(filters).filter(([, f]) => isActive(f)), [filters]);

  const view = useMemo(() => {
    let out = rows;
    for (const [k, f] of active) { const c = byKey.get(k); if (c) out = out.filter((r) => matches(r, c, f)); }
    if (sort) {
      const c = byKey.get(sort.key);
      if (c) {
        out = [...out].sort((a, b) => {
          const x = c.value(a), y = c.value(b);
          if (x === null || x === "") return 1;
          if (y === null || y === "") return -1;
          return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * sort.dir;
        });
      }
    }
    return out;
  }, [rows, active, byKey, sort]);

  // options for an open enum filter: rows filtered by every OTHER filter (faceted counts)
  const rowsForOptions = useMemo(() => {
    if (!open) return rows;
    let out = rows;
    for (const [k, f] of active) { if (k === open.key) continue; const c = byKey.get(k); if (c) out = out.filter((r) => matches(r, c, f)); }
    return out;
  }, [open, rows, active, byKey]);

  const shownCols = cols.filter((c) => visible.has(c.key));
  const pages = Math.max(1, Math.ceil(view.length / pageSize));
  const cur = Math.min(page, pages - 1);
  const slice = view.slice(cur * pageSize, cur * pageSize + pageSize);

  const setFilter = (key: string, f: Filter | undefined) => {
    setFilters((fs) => { const n = { ...fs }; if (f) n[key] = f; else delete n[key]; return n; });
    setPage(0);
  };
  const cycleSort = (key: string) => setSort((s) => (!s || s.key !== key ? { key, dir: 1 } : s.dir === 1 ? { key, dir: -1 } : null));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {active.length === 0
          ? <span style={{ fontSize: 12, ...faint }}>Tip: use the ▾ on any column header to filter.</span>
          : active.map(([k, f]) => {
              const c = byKey.get(k);
              return c && (
                <span key={k} className="flex items-center gap-1 px-2 py-0.5 rounded-full" style={{ ...soft, fontSize: 12 }}>
                  <b>{c.label}:</b> {describe(c as GridCol<unknown>, f)}
                  <button onClick={() => setFilter(k, undefined)} title="Remove filter" style={{ background: "none", border: "none", cursor: "pointer", ...faint }}>✕</button>
                </span>
              );
            })}
        {active.length > 0 && <button onClick={() => { setFilters({}); setPage(0); }} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, color: "var(--atlas-accent)" }}>Clear all</button>}
        <span className="ml-auto flex items-center gap-2" style={{ fontSize: 12, ...muted }}>
          {fmtInt(view.length)}{view.length !== rows.length && ` of ${fmtInt(rows.length)}`} rows
          <Btn small onClick={(e) => setColsOpen(colsOpen ? null : e.currentTarget.getBoundingClientRect())}>Columns</Btn>
          {toolbar?.(view)}
          <Btn small disabled={view.length === 0} title="Exactly the rows and columns shown, with filters applied"
            onClick={() => saveFile(buildGridWorkbook(view, shownCols), `${exportName}.xlsx`)}>↓ Export view</Btn>
        </span>
      </div>

      {colsOpen && (
        <Popover anchor={colsOpen} onClose={() => setColsOpen(null)}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>Show columns</div>
          <div style={{ maxHeight: 320, overflowY: "auto" }}>
            {cols.map((c) => (
              <label key={c.key} className="flex items-center gap-2 py-0.5" style={{ fontSize: 12.5, cursor: "pointer" }}>
                <input type="checkbox" checked={visible.has(c.key)} onChange={() => { const n = new Set(visible); if (n.has(c.key)) n.delete(c.key); else n.add(c.key); setVis(n); }} />
                {c.label}
              </label>
            ))}
          </div>
          <button onClick={() => setVis(new Set(cols.filter((c) => !c.optional).map((c) => c.key)))} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, color: "var(--atlas-accent)" }}>Reset to default</button>
        </Popover>
      )}

      <div className="rounded-xl overflow-hidden" style={surface}>
        <div style={{ overflow: "auto", maxHeight: "68vh" }}>
          <table style={{ fontSize: 12.5, borderCollapse: "separate", borderSpacing: 0, minWidth: "100%" }}>
            <thead style={{ position: "sticky", top: 0, zIndex: 2, background: "var(--atlas-surface)" }}>
              <tr>
                {shownCols.map((c) => {
                  const on = isActive(filters[c.key]);
                  const s = sort?.key === c.key ? (sort.dir === 1 ? " ↑" : " ↓") : "";
                  return (
                    <th key={c.key} className="px-2 py-1.5 font-medium" style={{ ...muted, textAlign: c.align ?? (c.type === "number" ? "right" : "left"), whiteSpace: "nowrap", minWidth: c.width, borderBottom: "1px solid var(--atlas-line)", background: "var(--atlas-surface)" }}>
                      <span className="inline-flex items-center gap-1">
                        <button onClick={() => cycleSort(c.key)} title="Sort" style={{ background: "none", border: "none", cursor: "pointer", color: "inherit", font: "inherit", padding: 0 }}>{c.label}{s}</button>
                        <button title={`Filter ${c.label}`} onClick={(e) => setOpen(open?.key === c.key ? null : { key: c.key, rect: e.currentTarget.getBoundingClientRect() })}
                          className="px-1 rounded" style={{ border: "none", cursor: "pointer", fontSize: 11, background: on ? "var(--atlas-accent)" : "transparent", color: on ? "#fff" : "var(--atlas-ink-faint)" }}>▾</button>
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {slice.map((r) => (
                <tr key={rowKey(r)}>
                  {shownCols.map((c) => (
                    <td key={c.key} className="px-2 py-1.5" style={{ borderTop: "1px solid var(--atlas-line-soft, var(--atlas-line))", textAlign: c.align ?? (c.type === "number" ? "right" : "left"), whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                      {c.render ? c.render(r) : fmtValue(c.type, c.value(r))}
                    </td>
                  ))}
                </tr>
              ))}
              {slice.length === 0 && <tr><td colSpan={shownCols.length} className="px-3 py-10 text-center" style={muted}>{emptyText}</td></tr>}
            </tbody>
          </table>
        </div>
        {pages > 1 && (
          <div className="flex items-center justify-end gap-2 px-3 py-2" style={{ fontSize: 12, ...muted, borderTop: "1px solid var(--atlas-line)" }}>
            Rows {fmtInt(cur * pageSize + 1)}–{fmtInt(Math.min(view.length, (cur + 1) * pageSize))} of {fmtInt(view.length)}
            <Btn small disabled={cur === 0} onClick={() => setPage(0)}>«</Btn>
            <Btn small disabled={cur === 0} onClick={() => setPage(cur - 1)}>‹ Prev</Btn>
            <Btn small disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)}>Next ›</Btn>
          </div>
        )}
      </div>

      {open && byKey.get(open.key) && (
        <Popover anchor={open.rect} onClose={() => setOpen(null)}>
          <div className="flex items-center justify-between" style={{ fontSize: 12, fontWeight: 600 }}>
            Filter: {byKey.get(open.key)!.label}
            {isActive(filters[open.key]) && <button onClick={() => setFilter(open.key, undefined)} style={{ background: "none", border: "none", cursor: "pointer", fontWeight: 400, color: "var(--atlas-accent)" }}>Clear</button>}
          </div>
          <FilterEditor col={byKey.get(open.key)!} rowsForOptions={rowsForOptions} value={filters[open.key]} onChange={(f) => setFilter(open.key, f)} />
        </Popover>
      )}
    </div>
  );
}
