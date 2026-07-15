"use client";
import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import * as XLSX from "xlsx";
import {
  buildRows, isBlocking, norm, ISSUE_META,
  type Row, type IssueCode, type MapperSet, type SkuMasterRow, type MapperDbRow,
} from "@/lib/mapper/model";
import { applyDirect, StalePlanError, type ApplyIntent } from "@/lib/mapper/client";
import NewLaunchPanel from "./NewLaunchPanel";
import ActionPreview from "./ActionPreview";

// ─────────────────────────────────────────────────────────────────────────────
// Mapper Studio — the single place a Master SKU is defined.
//
// The orphan defect this page exists to close: /admin/skus writes only sku_master,
// and /admin/fg-codes can only create combos (is_combo is hardcoded true), so a new
// single never got a combo_mapper_rows row — leaving the converter with no
// decomposition for it.
//
// This file is a VIEW. It owns no rules:
//   lib/mapper/model.ts   — the unified row model + issue detection (pure, tested)
//   lib/mapper/ops.ts     — what a change would do (pure, tested)
//   lib/mapper/client.ts  — the only way to write; posts to /api/admin/mapper/apply
//
// Reads are direct from Supabase (they cannot corrupt anything). Writes are not:
// the route re-plans against fresh data and refuses if the world moved while the
// admin was looking at the preview.
// ─────────────────────────────────────────────────────────────────────────────

type Field = "fgCode" | "productName" | "mrp" | "components";
const EDITABLE: Field[] = ["fgCode", "productName", "mrp", "components"];

const toneClass = {
  red:   "bg-atlas-red-bg text-atlas-red ring-atlas-red/30",
  amber: "bg-atlas-amber-bg text-atlas-amber-warn ring-atlas-amber-warn/30",
  blue:  "bg-atlas-blue-bg text-atlas-blue ring-atlas-blue/30",
};

export default function MapperStudioPage() {
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [skuMaster, setSkuMaster] = useState<SkuMasterRow[]>([]);
  const [allMapperRows, setAllMapperRows] = useState<MapperDbRow[]>([]);
  const [sets, setSets] = useState<MapperSet[]>([]);
  const [setId, setSetId] = useState<string>("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [stale, setStale] = useState(false);

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "single" | "combo">("all");
  const [issueFilter, setIssueFilter] = useState<"all" | IssueCode | "any">("all");
  // Shrink-to-grow means retiring SKUs in volume, and every retired single leaves
  // dead combos behind. This filter is how you find them.
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "discontinued">("all");

  // Excel-like editing: one cell at a time, keyboard-driven.
  const [cursor, setCursor] = useState<{ sku: string; field: Field } | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const [showAdd, setShowAdd] = useState(false);
  const [focusSku, setFocusSku] = useState<string | null>(null);
  // Destructive actions are never immediate — they open a preview computed from
  // fresh server state and confirmed against a hash.
  const [action, setAction] = useState<{
    intent: ApplyIntent; title: string; blurb: string; confirmLabel: string;
    danger?: boolean; requireTyping?: string; row: Row;
  } | null>(null);

  useEffect(() => { loadAll(); }, []);
  useEffect(() => { if (cursor) inputRef.current?.focus(); }, [cursor]);

  // The API layer is what stops the tables drifting; this only stops the SCREEN
  // going stale when another page (or another admin) writes.
  useEffect(() => {
    const onFocus = () => { void checkStale(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }); // no dep array: the closure must see current cursor/saving state

  // The grid shows one set at a time; the model is built from that set's rows.
  const mapperRows = useMemo(() => allMapperRows.filter((r) => r.mapper_set_id === setId), [allMapperRows, setId]);

  async function fetchAll<T>(table: string, select: string): Promise<T[]> {
    const out: T[] = [];
    let from = 0;
    const PAGE = 1000;
    for (;;) {
      const { data, error } = await supabase.from(table).select(select).range(from, from + PAGE - 1);
      if (error || !data || data.length === 0) break;
      out.push(...(data as unknown as T[]));
      if (data.length < PAGE) break;
      from += PAGE;
    }
    return out;
  }

  /** Every mapper row, all sets. Kept whole so the set selector is free and the
   *  delete preview can be honest about which sets it touches. */
  async function loadAll(keepSet?: string) {
    setLoading(true);
    const [sm, setsRes, mrAll] = await Promise.all([
      fetchAll<SkuMasterRow>("sku_master", "id, new_master_sku, new_fg_code, product_name, category, product_category, mrp, is_active, discontinued_at"),
      supabase.from("combo_mapper_sets").select("id, name, is_default").order("name"),
      fetchAll<MapperDbRow>("combo_mapper_rows", "id, mapper_set_id, master_sku, is_combo, products, fg_code, product_name"),
    ]);
    const allSets = (setsRes.data || []) as MapperSet[];
    const target = (keepSet && allSets.find((s) => s.id === keepSet)) || allSets.find((s) => s.is_default) || allSets[0];
    setSkuMaster(sm);
    setSets(allSets);
    setSetId(target?.id || "");
    setAllMapperRows(mrAll);
    setStale(false);
    setLoading(false);
  }

  /**
   * Has anyone written these tables since we loaded?
   *
   * Two cheap head-only counts on tab focus. Deliberately NOT a realtime
   * subscription: that needs publication config we can't verify, and a grid that
   * mutates under an in-progress cell edit is hostile. This only ever *offers* a
   * refresh — it never clobbers what the admin is typing.
   */
  async function checkStale() {
    if (cursor || action || showAdd || saving) return; // never interrupt an edit
    const [{ count: smN }, { count: mrN }] = await Promise.all([
      supabase.from("sku_master").select("id", { count: "exact", head: true }),
      supabase.from("combo_mapper_rows").select("id", { count: "exact", head: true }),
    ]);
    if ((smN !== null && smN !== skuMaster.length) || (mrN !== null && mrN !== allMapperRows.length)) setStale(true);
  }

  function flash(kind: "ok" | "err", text: string) {
    setMsg({ kind, text });
    setTimeout(() => setMsg(null), kind === "ok" ? 3500 : 8000);
  }

  const rows = useMemo(() => buildRows(skuMaster, mapperRows), [skuMaster, mapperRows]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { total: rows.length, singles: 0, combos: 0, issues: 0, blocking: 0, discontinued: 0, deadCombos: 0 };
    for (const r of rows) {
      if (r.isCombo) c.combos++; else c.singles++;
      if (r.issues.length) c.issues++;
      if (isBlocking(r)) c.blocking++;
      if (r.discontinued) {
        c.discontinued++;
        // Combos still hanging off a retired single — the shrink-to-grow cleanup list.
        if (r.usedIn.length > 0) c.deadCombos += r.usedIn.length;
      }
    }
    return c;
  }, [rows]);

  const filtered = useMemo(() => {
    const q = norm(search);
    return rows.filter((r) => {
      if (typeFilter === "single" && r.isCombo) return false;
      if (typeFilter === "combo" && !r.isCombo) return false;
      if (statusFilter === "active" && r.discontinued) return false;
      if (statusFilter === "discontinued" && !r.discontinued) return false;
      if (issueFilter === "any" && r.issues.length === 0) return false;
      if (issueFilter !== "all" && issueFilter !== "any" && !r.issues.some((i) => i.code === issueFilter)) return false;
      if (!q) return true;
      return norm(r.masterSku).includes(q) || norm(r.fgCode).includes(q) || norm(r.productName).includes(q) ||
        r.products.some((p) => norm(p).includes(q)) || r.usedIn.some((u) => norm(u.sku).includes(q));
    });
  }, [rows, search, typeFilter, issueFilter, statusFilter]);

  // ── Writes ─────────────────────────────────────────────────────────────────
  //
  // Every mutation goes through /api/admin/mapper/apply. Nothing here calls
  // supabase.from(...).insert/update/delete on these two tables: validation,
  // row_count maintenance, audit and the stale-plan check all live server-side, in
  // one place, so a second page cannot bypass them.

  async function runIntent(intent: Parameters<typeof applyDirect>[0], okMsg: (applied: number) => string) {
    setSaving(true);
    try {
      const res = await applyDirect(intent);
      await loadAll();
      if (res.applied === 0) flash("err", res.message || "Nothing to do.");
      else flash("ok", okMsg(res.applied));
    } catch (e) {
      if (e instanceof StalePlanError) flash("err", `${e.message} Refreshing…`);
      else flash("err", e instanceof Error ? e.message : String(e));
      await loadAll();
    } finally {
      setSaving(false);
    }
  }

  async function commitCell(row: Row, field: Field, raw: string) {
    // Confirm the one edit that silently changes what a row *is*.
    if (field === "components" && row.isCombo && raw.trim() === "" && row.products.length > 0) {
      if (!confirm(`Remove all components from "${row.masterSku}"? It becomes a single.`)) return;
    }
    await runIntent(
      { intent: "cell_edit", mapperSetId: setId, sku: row.masterSku, field, value: raw },
      () => `${row.masterSku} · ${field} updated`
    );
  }

  /** Create whichever side is missing so the converter can resolve the SKU. */
  async function fixRow(row: Row) {
    await runIntent(
      { intent: "fix", mapperSetId: setId, sku: row.masterSku },
      () => `${row.masterSku} is now in both tables — the converter can resolve it.`
    );
  }

  // ── Destructive actions ────────────────────────────────────────────────────
  //
  // Three genuinely different operations. Conflating them under one "Delete" is why
  // there was no precedent for any of them.

  /** A ghost has no row anywhere — it exists only inside other combos' components.
   *  There is nothing to delete, so the operation is on its parents. */
  /**
   * Delete every combo built on a dead component. The component itself is never
   * touched — for a retired single that is the whole point: its mapper row must
   * stay so historical forecasts still decompose.
   */
  function purgeComponent(row: Row) {
    const isGhost = !row.inMapper && !row.inSkuMaster;
    setAction({
      intent: { intent: "purge_component", sku: row.masterSku },
      title: `Remove the ${row.usedIn.length} combo(s) built on "${row.masterSku}"`,
      blurb: isGhost
        ? `"${row.masterSku}" is defined in neither table — it exists only inside other combos' component lists, so there is no row to delete. The combos built around it are deleted instead.`
        : `Deletes every combo that still consumes "${row.masterSku}". The SKU itself is KEPT and stays retired — deleting it would cascade away its forecast history. Any combo with history of its own is refused and listed below.`,
      confirmLabel: `Delete ${row.usedIn.length} combo(s)`,
      danger: true, requireTyping: row.masterSku, row,
    });
  }

  /** Soft delete. The mapper row stays: the mapper is a decomposition dictionary,
   *  and a retired SKU appearing in a historical upload must still decompose. */
  function retire(row: Row) {
    setAction({
      intent: { intent: "retire", sku: row.masterSku, retire: !row.discontinued },
      title: row.discontinued ? `Reactivate "${row.masterSku}"` : `Retire "${row.masterSku}"`,
      blurb: row.discontinued
        ? "Marks the SKU active again in SKU Master."
        : "Marks it discontinued in SKU Master. Its mapper row stays, so existing combos still decompose correctly. Forecast downloads silently omit inactive SKUs.",
      confirmLabel: row.discontinued ? "Reactivate" : "Retire",
      danger: !row.discontinued, row,
    });
  }

  /** Permanent. Refused server-side unless nothing anywhere references the SKU. */
  function hardDelete(row: Row) {
    setAction({
      intent: { intent: "hard_delete", sku: row.masterSku },
      title: `Delete "${row.masterSku}" permanently`,
      blurb: "Removes it from both tables, across every mapper set. Refused if any combo consumes it or any forecast, supply or history row references it — retire it instead. There is no undo in the app: recovery means reading the snapshot out of the audit log.",
      confirmLabel: "Delete permanently",
      danger: true, requireTyping: row.masterSku, row,
    });
  }

  // ── Keyboard grid navigation ───────────────────────────────────────────────
  const move = useCallback((dir: "up" | "down" | "left" | "right") => {
    if (!cursor) return;
    const ri = filtered.findIndex((r) => r.masterSku === cursor.sku);
    const fi = EDITABLE.indexOf(cursor.field);
    if (ri < 0) return;
    let nr = ri, nf = fi;
    if (dir === "down") nr = Math.min(filtered.length - 1, ri + 1);
    if (dir === "up") nr = Math.max(0, ri - 1);
    if (dir === "right") { nf = fi + 1; if (nf >= EDITABLE.length) { nf = 0; nr = Math.min(filtered.length - 1, ri + 1); } }
    if (dir === "left") { nf = fi - 1; if (nf < 0) { nf = EDITABLE.length - 1; nr = Math.max(0, ri - 1); } }
    const target = filtered[nr];
    setCursor({ sku: target.masterSku, field: EDITABLE[nf] });
    setDraft(cellValue(target, EDITABLE[nf]));
  }, [cursor, filtered]);

  function cellValue(r: Row, f: Field): string {
    if (f === "fgCode") return r.fgCode;
    if (f === "productName") return r.productName;
    if (f === "mrp") return r.mrp == null ? "" : String(r.mrp);
    return r.products.join(", ");
  }

  function openCell(r: Row, f: Field) {
    setCursor({ sku: r.masterSku, field: f });
    setDraft(cellValue(r, f));
  }

  async function onCellKey(e: React.KeyboardEvent<HTMLInputElement>, row: Row, field: Field) {
    if (e.key === "Escape") { e.preventDefault(); setCursor(null); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      if (draft !== cellValue(row, field)) await commitCell(row, field, draft);
      setCursor(null);
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      if (draft !== cellValue(row, field)) await commitCell(row, field, draft);
      move(e.shiftKey ? "left" : "right");
    }
  }

  function exportGrid() {
    const data = filtered.map((r) => ({
      "Master SKU": r.masterSku,
      "Type": r.isCombo ? "Combo" : "Single",
      "FG Code": r.fgCode,
      "Product Name": r.productName,
      "MRP": r.mrp ?? "",
      "Components": r.products.join(", "),
      "Used In": r.usedIn.map((u) => `${u.sku}${u.qty > 1 ? ` x${u.qty}` : ""}`).join(", "),
      "In SKU Master": r.inSkuMaster ? "Yes" : "No",
      "In Mapper": r.inMapper ? "Yes" : "No",
      "Issues": r.issues.map((i) => ISSUE_META[i.code].label).join("; "),
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    ws["!cols"] = [{ wch: 28 }, { wch: 8 }, { wch: 12 }, { wch: 40 }, { wch: 8 }, { wch: 50 }, { wch: 40 }, { wch: 13 }, { wch: 10 }, { wch: 30 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Mapper");
    XLSX.writeFile(wb, "Mapper_Studio.xlsx");
  }

  if (loading) return <div className="flex items-center justify-center h-64"><p className="text-atlas-ink-muted">Loading mapper…</p></div>;

  return (
    <div>
      {showAdd && (
        <NewLaunchPanel
          live={{ skuMaster, mapperRows }}
          rows={rows}
          mapperSetId={setId}
          onClose={() => setShowAdd(false)}
          onDone={async (label) => { setShowAdd(false); await loadAll(); flash("ok", label); }}
          onEditExisting={(sku) => {
            // Land the admin on the row itself with the FG cell already open —
            // recoding an existing SKU is overwhelmingly why they hit the collision.
            setSearch(sku);
            setTypeFilter("all");
            setIssueFilter("all");
            setFocusSku(sku);
            const target = rows.find((r) => norm(r.masterSku) === norm(sku));
            if (target) openCell(target, "fgCode");
            setTimeout(() => setFocusSku(null), 4000);
          }}
        />
      )}

      {action && (
        <ActionPreview
          intent={action.intent}
          title={action.title}
          blurb={action.blurb}
          confirmLabel={action.confirmLabel}
          danger={action.danger}
          requireTyping={action.requireTyping}
          row={action.row}
          onClose={() => setAction(null)}
          onDone={async (msg) => { setAction(null); await loadAll(); flash("ok", msg); }}
        />
      )}

      <div className="flex items-start justify-between mb-5 gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold text-atlas-ink">Mapper Studio</h2>
          <p className="text-sm text-atlas-ink-muted mt-1">
            Every Master SKU, single or combo, in one grid. Adding a SKU here writes both SKU Master and the
            Combo mapper — so it can never go missing from a conversion.
          </p>
        </div>
        <div className="flex gap-2 items-center">
          {sets.length > 1 && (
            <select value={setId} onChange={(e) => setSetId(e.target.value)}
              className="px-3 py-2 bg-atlas-surface border border-atlas-line rounded-lg text-atlas-ink text-sm focus:outline-none focus:ring-2 focus:ring-atlas-accent">
              {sets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}{s.is_default ? " (default)" : ""} — {allMapperRows.filter((r) => r.mapper_set_id === s.id).length} rows
                </option>
              ))}
            </select>
          )}
          <button onClick={exportGrid}
            className="px-3 py-2 bg-atlas-surface-soft border border-atlas-line text-atlas-ink text-sm rounded-lg hover:bg-atlas-surface transition">
            Export
          </button>
          <button onClick={() => setShowAdd(true)}
            className="px-4 py-2 bg-atlas-accent text-white text-sm font-semibold rounded-lg hover:bg-atlas-accent-light transition">
            + New Launch
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-5">
        <Stat label="Master SKUs" value={counts.total} />
        <Stat label="Singles" value={counts.singles} />
        <Stat label="Combos" value={counts.combos} />
        <Stat label="Discontinued" value={counts.discontinued}
          onClick={() => { setStatusFilter("discontinued"); setTypeFilter("all"); setIssueFilter("all"); setSearch(""); }} />
        <Stat label="With issues" value={counts.issues} tone={counts.issues ? "amber" : undefined} />
        <Stat label="Blocking" value={counts.blocking} tone={counts.blocking ? "red" : "green"} />
      </div>

      {/* Shrink-to-grow: retired singles that combos still hang off. Each one means
          combos the converter still expands into a product you no longer sell. */}
      {counts.deadCombos > 0 && (
        <div className="mb-4 p-3 bg-atlas-amber-bg border border-atlas-amber-warn/40 rounded-xl flex items-center justify-between gap-3">
          <p className="text-sm text-atlas-amber-warn">
            {counts.deadCombos} combo{counts.deadCombos > 1 ? "s" : ""} still build on discontinued SKUs.
            <span className="text-atlas-ink-soft"> They keep converting into products you no longer sell.</span>
          </p>
          <button onClick={() => { setStatusFilter("discontinued"); setTypeFilter("single"); setIssueFilter("all"); setSearch(""); }}
            className="px-3 py-1.5 bg-atlas-amber-warn text-white text-xs font-semibold rounded-lg hover:opacity-90 transition shrink-0">
            Show them
          </button>
        </div>
      )}

      {stale && (
        <div className="mb-4 p-3 rounded-xl border border-atlas-blue/40 bg-atlas-blue-bg flex items-center justify-between gap-3">
          <p className="text-sm text-atlas-blue">
            These tables changed elsewhere — SKU Master, the Combo Mapper, or another admin. This view is out of date.
          </p>
          <button onClick={() => loadAll(setId)}
            className="px-3 py-1.5 bg-atlas-blue text-white text-xs font-semibold rounded-lg hover:opacity-90 transition shrink-0">
            Refresh
          </button>
        </div>
      )}

      {msg && (
        <div className={`mb-4 p-3 rounded-xl border text-sm whitespace-pre-wrap ${
          msg.kind === "ok" ? "bg-atlas-green-bg border-atlas-green/40 text-atlas-green"
                            : "bg-atlas-red-bg border-atlas-red/40 text-atlas-red"}`}>
          {msg.text}
        </div>
      )}

      {counts.blocking > 0 && (
        <div className="mb-4 p-4 bg-atlas-red-bg border border-atlas-red/40 rounded-xl">
          <p className="text-atlas-red font-semibold text-sm">
            {counts.blocking} SKU{counts.blocking > 1 ? "s" : ""} will convert incorrectly
          </p>
          <p className="text-atlas-red/80 text-xs mt-1">
            Orphans are invisible to the converter; criticals cannot expand; ghosts are undefined. Filter to
            them below and hit Fix.
          </p>
        </div>
      )}

      {/* Controls */}
      <div className="flex gap-2 mb-3 items-center flex-wrap">
        <input value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search SKU, FG code, name, component, or parent combo…"
          className="flex-1 min-w-[260px] px-4 py-2 bg-atlas-surface border border-atlas-line rounded-lg text-atlas-ink text-sm focus:outline-none focus:ring-2 focus:ring-atlas-accent" />
        <Seg value={typeFilter} onChange={setTypeFilter} options={[
          { v: "all", l: `All (${counts.total})` }, { v: "single", l: `Singles (${counts.singles})` }, { v: "combo", l: `Combos (${counts.combos})` },
        ]} />
        <Seg value={statusFilter} onChange={setStatusFilter} options={[
          { v: "all", l: "Any status" }, { v: "active", l: "Active" }, { v: "discontinued", l: `Discontinued (${counts.discontinued})` },
        ]} />
        <select value={issueFilter} onChange={(e) => setIssueFilter(e.target.value as typeof issueFilter)}
          className="px-3 py-2 bg-atlas-surface border border-atlas-line rounded-lg text-atlas-ink text-sm focus:outline-none focus:ring-2 focus:ring-atlas-accent">
          <option value="all">All rows</option>
          <option value="any">Any issue ({counts.issues})</option>
          {(Object.keys(ISSUE_META) as IssueCode[]).map((c) => (
            <option key={c} value={c}>{ISSUE_META[c].label} ({rows.filter((r) => r.issues.some((i) => i.code === c)).length})</option>
          ))}
        </select>
      </div>

      <p className="text-xs text-atlas-ink-faint mb-3">
        Click any cell to edit · <kbd className="px-1 rounded bg-atlas-surface-soft border border-atlas-line">Enter</kbd> save ·
        {" "}<kbd className="px-1 rounded bg-atlas-surface-soft border border-atlas-line">Tab</kbd> save &amp; next ·
        {" "}<kbd className="px-1 rounded bg-atlas-surface-soft border border-atlas-line">Esc</kbd> cancel ·
        {" "}components are comma-separated, repeat a SKU for quantity (<span className="font-mono">A, A</span> = ×2)
      </p>

      {/* Grid */}
      <div className="bg-atlas-surface border border-atlas-line rounded-xl overflow-hidden">
        <div className="overflow-auto max-h-[640px]">
          <table className="w-full text-sm border-collapse">
            <thead className="sticky top-0 bg-atlas-surface z-10">
              <tr className="border-b border-atlas-line">
                {["", "Master SKU", "Type", "FG Code", "Product Name", "MRP", "Components", "Used In", ""].map((h, i) => (
                  <th key={i} className={`py-2.5 px-3 text-atlas-ink-muted font-medium text-xs uppercase tracking-wider whitespace-nowrap ${
                    h === "MRP" ? "text-right" : "text-left"}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const blocking = r.issues.some((i) => ISSUE_META[i.code].blocking);
                const highlight = focusSku && norm(focusSku) === norm(r.masterSku);
                return (
                  <tr key={r.masterSku}
                    className={`border-b border-atlas-line/50 transition-colors ${
                      highlight ? "bg-atlas-blue-bg" : blocking ? "bg-atlas-red-bg/60" : r.issues.length ? "bg-atlas-amber-bg/40" : "hover:bg-atlas-surface-soft/50"}`}>
                    <td className="py-1.5 px-3">
                      <span className={`inline-block w-2 h-2 rounded-full ${
                        blocking ? "bg-atlas-red" : r.issues.length ? "bg-atlas-amber-warn" : "bg-atlas-green"}`}
                        title={r.issues.length ? r.issues.map((i) => i.detail).join("\n") : "OK"} />
                    </td>

                    <td className="py-1.5 px-3 whitespace-nowrap">
                      <span className={`font-mono text-xs ${r.discontinued ? "line-through text-atlas-ink-faint" : "text-atlas-ink"}`}>
                        {r.masterSku}
                      </span>
                      <span className="ml-1.5 inline-flex gap-1 align-middle">
                        {r.issues.map((i, n) => (
                          <span key={n} title={i.detail}
                            className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ring-1 ${toneClass[ISSUE_META[i.code].tone]}`}>
                            {ISSUE_META[i.code].label}
                          </span>
                        ))}
                      </span>
                    </td>

                    <td className="py-1.5 px-3">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase ring-1 ${
                        r.isCombo ? toneClass.blue : "bg-atlas-surface-soft text-atlas-ink-muted ring-atlas-line"}`}>
                        {r.isCombo ? "Combo" : "Single"}
                      </span>
                    </td>

                    <Cell r={r} f="fgCode" cursor={cursor} draft={draft} setDraft={setDraft} inputRef={inputRef}
                      open={openCell} onKey={onCellKey} className="font-mono text-xs" placeholder="—" width="w-28" />
                    <Cell r={r} f="productName" cursor={cursor} draft={draft} setDraft={setDraft} inputRef={inputRef}
                      open={openCell} onKey={onCellKey} className="text-xs" placeholder="—" width="w-56" />
                    <Cell r={r} f="mrp" cursor={cursor} draft={draft} setDraft={setDraft} inputRef={inputRef}
                      open={openCell} onKey={onCellKey} className="font-mono text-xs text-right" placeholder="—" width="w-20" align="right" />
                    <Cell r={r} f="components" cursor={cursor} draft={draft} setDraft={setDraft} inputRef={inputRef}
                      open={openCell} onKey={onCellKey} className="font-mono text-xs" placeholder={r.isCombo ? "none — critical" : "—"} width="w-72" />

                    {/* Used In — the reverse links */}
                    <td className="py-1.5 px-3 max-w-[280px]">
                      {r.usedIn.length === 0 ? (
                        <span className="text-atlas-ink-faint text-xs">—</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {r.usedIn.map((u) => (
                            <button key={u.sku}
                              onClick={() => { setSearch(u.sku); setFocusSku(u.sku); setTimeout(() => setFocusSku(null), 2000); }}
                              title={`${u.sku} uses ${r.masterSku} ×${u.qty} — click to jump`}
                              className="px-1.5 py-0.5 rounded bg-atlas-surface-soft border border-atlas-line font-mono text-[10px] text-atlas-ink-soft hover:border-atlas-accent hover:text-atlas-accent transition">
                              {u.sku}{u.qty > 1 && <span className="text-atlas-accent font-bold">{" "}×{u.qty}</span>}
                            </button>
                          ))}
                        </div>
                      )}
                    </td>

                    <td className="py-1.5 px-3">
                      <div className="flex gap-1 justify-end">
                        {/* A ghost has no row to fix — the only action is on its parents. */}
                        {!r.inMapper && !r.inSkuMaster ? (
                          <button onClick={() => purgeComponent(r)} disabled={saving}
                            title="Defined nowhere. Delete the combos built around it."
                            className="px-2 py-1 bg-atlas-red-bg border border-atlas-red/40 text-atlas-red text-xs font-semibold rounded hover:opacity-80 transition disabled:opacity-50">
                            Remove
                          </button>
                        ) : (
                          <>
                            {/* A retired single with live combos is the shrink-to-grow
                                cleanup: the combos are dead, the single must stay. */}
                            {r.discontinued && r.usedIn.length > 0 && (
                              <button onClick={() => purgeComponent(r)} disabled={saving}
                                title={`Retired, but ${r.usedIn.length} combo(s) still use it. Delete those combos — this SKU is kept.`}
                                className="px-2 py-1 bg-atlas-amber-bg border border-atlas-amber-warn/40 text-atlas-amber-warn text-xs font-semibold rounded hover:opacity-80 transition disabled:opacity-50">
                                Clear {r.usedIn.length} combo{r.usedIn.length > 1 ? "s" : ""}
                              </button>
                            )}
                            {(!r.inMapper || !r.inSkuMaster) && (
                              <button onClick={() => fixRow(r)} disabled={saving}
                                title={!r.inMapper
                                  ? "No mapper row — the converter has no decomposition for this SKU. Create it."
                                  : "No SKU Master row — it has no FG code or MRP. Create it."}
                                className="px-2 py-1 bg-atlas-accent/10 border border-atlas-accent/40 text-atlas-accent text-xs font-semibold rounded hover:bg-atlas-accent/20 transition disabled:opacity-50">
                                Fix
                              </button>
                            )}
                            {r.inSkuMaster && (
                              <button onClick={() => retire(r)} disabled={saving}
                                title={r.discontinued ? "Mark active again" : "Mark discontinued. Keeps the mapper row so combos still decompose."}
                                className="px-2 py-1 bg-atlas-surface-soft border border-atlas-line text-atlas-ink-muted text-xs rounded hover:bg-atlas-surface transition disabled:opacity-50">
                                {r.discontinued ? "Restore" : "Retire"}
                              </button>
                            )}
                            {/* Only offered where it could succeed: nothing consumes it.
                                Note that is true of nearly EVERY combo — combos are
                                rarely components — so this button is reachable on most
                                rows. It is deliberately low-contrast, and the dialog
                                requires typing the SKU. The server re-checks regardless. */}
                            {r.usedIn.length === 0 && (
                              <button onClick={() => hardDelete(r)} disabled={saving}
                                aria-label={`Delete ${r.masterSku} permanently`}
                                title="Delete permanently — requires typing the SKU to confirm. Retire is usually what you want."
                                className="px-2 py-1 text-atlas-ink-faint text-xs rounded hover:text-atlas-red hover:bg-atlas-red-bg transition disabled:opacity-50">
                                ✕
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={9} className="py-12 text-center text-atlas-ink-faint">No SKUs match.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-xs text-atlas-ink-faint mt-3">
        Showing {filtered.length} of {rows.length}. Mapper set: <span className="font-mono">{sets.find((s) => s.id === setId)?.name || "—"}</span>
      </p>
    </div>
  );
}

// ─── Presentational bits ─────────────────────────────────────────────────────

function Stat({ label, value, tone, onClick }: { label: string; value: number; tone?: "red" | "amber" | "green"; onClick?: () => void }) {
  const c = tone === "red" ? "text-atlas-red" : tone === "amber" ? "text-atlas-amber-warn" : tone === "green" ? "text-atlas-green" : "text-atlas-ink";
  const body = (
    <>
      <p className="text-[10px] text-atlas-ink-muted uppercase tracking-wider">{label}</p>
      <p className={`text-xl font-bold mt-0.5 ${c}`}>{value}</p>
    </>
  );
  if (!onClick) return <div className="bg-atlas-surface border border-atlas-line rounded-xl p-3">{body}</div>;
  return (
    <button onClick={onClick}
      className="bg-atlas-surface border border-atlas-line rounded-xl p-3 text-left hover:border-atlas-accent transition focus:outline-none focus:ring-2 focus:ring-atlas-accent">
      {body}
    </button>
  );
}

function Seg<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: Array<{ v: T; l: string }> }) {
  return (
    <div className="flex gap-1">
      {options.map((o) => (
        <button key={o.v} onClick={() => onChange(o.v)}
          className={`px-3 py-2 rounded-lg text-xs font-medium transition ${
            value === o.v ? "bg-atlas-accent-bg text-atlas-accent border border-atlas-accent/30"
                          : "bg-atlas-surface text-atlas-ink-muted border border-atlas-line hover:bg-atlas-surface-soft"}`}>
          {o.l}
        </button>
      ))}
    </div>
  );
}

function Cell({ r, f, cursor, draft, setDraft, inputRef, open, onKey, className, placeholder, width, align }: {
  r: Row; f: Field;
  cursor: { sku: string; field: Field } | null;
  draft: string; setDraft: (s: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  open: (r: Row, f: Field) => void;
  onKey: (e: React.KeyboardEvent<HTMLInputElement>, r: Row, f: Field) => void;
  className?: string; placeholder?: string; width?: string; align?: "right";
}) {
  const editing = cursor?.sku === r.masterSku && cursor.field === f;
  const shown = f === "fgCode" ? r.fgCode : f === "productName" ? r.productName
    : f === "mrp" ? (r.mrp == null ? "" : r.mrp.toLocaleString("en-IN")) : r.products.join(", ");
  const empty = !shown;
  const critical = f === "components" && r.isCombo && r.products.length === 0;

  return (
    <td className={`py-1.5 px-3 ${align === "right" ? "text-right" : ""}`}
      onClick={() => !editing && open(r, f)}>
      {editing ? (
        <input ref={inputRef} value={draft} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => onKey(e, r, f)} onBlur={() => onKey({ key: "Escape", preventDefault: () => {} } as React.KeyboardEvent<HTMLInputElement>, r, f)}
          className={`${width} px-1.5 py-1 bg-atlas-surface border-2 border-atlas-accent rounded text-atlas-ink text-xs focus:outline-none ${className || ""}`} />
      ) : (
        <span className={`${className || ""} block ${width} truncate cursor-cell rounded px-1.5 py-1 -mx-1.5 hover:ring-1 hover:ring-atlas-line ${
          critical ? "text-atlas-red font-semibold" : empty ? "text-atlas-ink-faint" : "text-atlas-ink"}`}
          title={shown || undefined}>
          {shown || placeholder || "—"}
        </span>
      )}
    </td>
  );
}


// AddSkuModal lived here. It was a one-row New Launch with a weaker guarantee:
// its two inserts were not transactional and its FG check only looked at loaded
// rows. Two write paths for the same thing is how the tables drifted apart, so it
// was removed rather than left behind a hidden button. See ./NewLaunchPanel.tsx.
