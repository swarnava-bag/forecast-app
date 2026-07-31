"use client";
import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import * as XLSX from "xlsx";
import AppShell from "@/app/components/AppShell";

// ============================================================================
// OVER / UNDER CHECK
//
//   DRR  = MTD secondary sales / days elapsed ("updated till")
//   DOS  = Forecast / DRR          -- days the forecast lasts at the current run rate
//   UNDER when DOS <  channel's under_days (default 20, editable per channel)
//   OVER  when DOS >  max_shelf_life_days  (per SKU, falling back to its category)
//   OK    otherwise
//
// Shelf life lives in the DB (shelf_life_master) so it is "in the background" —
// uploaded once, edited in place, never re-supplied with each run.
// ============================================================================

type Profile = { id: string; email: string; full_name: string; role: string };
type ShelfLifeRow = {
  id: string; scope: "sku" | "category"; scope_key: string;
  shelf_life_days: number | null; max_shelf_life_days: number | null; notes: string | null;
};
type ChannelSetting = { id: string; channel_name: string; under_days: number; is_active: boolean };
type SkuInfo = { master_sku: string; category: string; product_name: string };

type Rec = { channel: string; master_sku: string; category: string; qty: number };
type ParsedFile = { rows: Rec[]; channels: string[]; layout: "long" | "wide"; valueCol: string; warnings: string[] };

type Verdict = "OVER" | "UNDER" | "OK" | "NO SHELF LIFE";
type CheckRow = {
  channel: string; master_sku: string; category: string;
  mtd_qty: number; drr: number; forecast: number;
  dos: number | null;               // null => no run rate AND no forecast
  shelf_life: number | null; max_shelf_life: number | null;
  shelf_source: "SKU" | "Category" | "—";
  under_days: number; verdict: Verdict;
};

// ========== CHANNEL NAME NORMALISATION ==========
// The workbook uses shorthand ("Fk mins"); the channels table uses full names.
const CHANNEL_ALIASES: Record<string, string> = {
  blinkit: "Blinkit",
  fkmins: "Flipkart Minutes", fkminutes: "Flipkart Minutes",
  flipkartmins: "Flipkart Minutes", flipkartminutes: "Flipkart Minutes",
  flipkartminuteshyperlocal: "Flipkart Minutes",
  instamart: "Instamart", swiggyinstamart: "Instamart",
  zepto: "Zepto",
  bigbasket: "Big Basket",
};
function normChannel(raw: string): string {
  const key = String(raw || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return CHANNEL_ALIASES[key] || String(raw || "").trim();
}
const norm = (s: string) => String(s || "").trim().toLowerCase();

// ========== PARSING ==========
// Accepts either layout, because the source workbook contains both:
//   long : Channel | Master SKU | Category | <value>
//   wide : Master SKU | Blinkit | Fk mins | Instamart | Zepto
// Header row is located by scanning — these sheets carry a SUBTOTAL row above it.

function findHeaderRow(grid: any[][]): number {
  for (let r = 0; r < Math.min(grid.length, 15); r++) {
    const row = grid[r] || [];
    for (const cell of row) {
      const c = norm(String(cell ?? ""));
      if (/^master\s*sku$/.test(c) || c === "sku" || c === "channel") return r;
    }
  }
  return 0;
}

function parseFlexible(ws: XLSX.WorkSheet): ParsedFile {
  const warnings: string[] = [];
  const grid = XLSX.utils.sheet_to_json<any>(ws, { header: 1, blankrows: false });
  if (grid.length < 2) return { rows: [], channels: [], layout: "wide", valueCol: "", warnings: ["Sheet is empty."] };

  const hIdx = findHeaderRow(grid);
  const headers = (grid[hIdx] as any[]).map((h) => String(h ?? "").trim());

  const skuIdx = headers.findIndex((h) => /^master\s*sku$/i.test(h) || /^sku$/i.test(h));
  const channelIdx = headers.findIndex((h) => /^channel$/i.test(h));
  const categoryIdx = headers.findIndex((h) => /^categor/i.test(h));
  if (skuIdx < 0) return { rows: [], channels: [], layout: "wide", valueCol: "", warnings: ["No 'Master SKU' column found."] };

  const rows: Rec[] = [];
  const channelSet = new Set<string>();

  if (channelIdx >= 0) {
    // ---- LONG ----
    // Value column: prefer an explicitly named one, else the last unused column.
    let valIdx = headers.findIndex((h, i) =>
      i !== skuIdx && i !== channelIdx && i !== categoryIdx && /revise|qty|quantity|forecast|value|sales|units/i.test(h));
    if (valIdx < 0) {
      for (let i = headers.length - 1; i >= 0; i--) {
        if (i !== skuIdx && i !== channelIdx && i !== categoryIdx && headers[i] !== "") { valIdx = i; break; }
      }
    }
    if (valIdx < 0) return { rows: [], channels: [], layout: "long", valueCol: "", warnings: ["No value column found."] };

    for (let r = hIdx + 1; r < grid.length; r++) {
      const row = grid[r] as any[];
      const sku = String(row?.[skuIdx] ?? "").trim();
      const ch = normChannel(String(row?.[channelIdx] ?? "").trim());
      if (!sku || !ch) continue;
      const qty = Number(String(row?.[valIdx] ?? "").replace(/[, ]/g, "")) || 0;
      rows.push({ channel: ch, master_sku: sku, category: categoryIdx >= 0 ? String(row?.[categoryIdx] ?? "").trim() : "", qty });
      channelSet.add(ch);
    }
    return { rows, channels: [...channelSet].sort(), layout: "long", valueCol: headers[valIdx], warnings };
  }

  // ---- WIDE ---- every other non-empty column is a channel
  const chCols = headers
    .map((h, i) => ({ h, i }))
    .filter(({ h, i }) => i !== skuIdx && i !== categoryIdx && h !== "");
  if (chCols.length === 0) return { rows: [], channels: [], layout: "wide", valueCol: "", warnings: ["No channel columns found."] };

  // Guard: a per-channel working sheet (Qty/DRR/Forecast/DOS) is not a wide channel file.
  const suspicious = chCols.filter(({ h }) => /^(drr|dos|forecast|qty)$/i.test(h)).map(({ h }) => h);
  if (suspicious.length >= 2) {
    warnings.push(`Columns ${suspicious.join(", ")} look like a per-channel working sheet, not channel columns. Check you picked the right sheet.`);
  }

  for (let r = hIdx + 1; r < grid.length; r++) {
    const row = grid[r] as any[];
    const sku = String(row?.[skuIdx] ?? "").trim();
    if (!sku) continue;
    const cat = categoryIdx >= 0 ? String(row?.[categoryIdx] ?? "").trim() : "";
    for (const { h, i } of chCols) {
      const qty = Number(String(row?.[i] ?? "").replace(/[, ]/g, "")) || 0;
      const ch = normChannel(h);
      rows.push({ channel: ch, master_sku: sku, category: cat, qty });
      channelSet.add(ch);
    }
  }
  return { rows, channels: [...channelSet].sort(), layout: "wide", valueCol: "", warnings };
}

// Pick the most likely sheet from a workbook by name, else the first.
function pickSheet(wb: XLSX.WorkBook, patterns: RegExp[]): string {
  for (const p of patterns) {
    const hit = wb.SheetNames.find((n) => p.test(n));
    if (hit) return hit;
  }
  return wb.SheetNames[0];
}

// ========== ENGINE ==========

function runCheck(
  forecast: Rec[], sales: Rec[], daysElapsed: number,
  shelfLife: ShelfLifeRow[], settings: ChannelSetting[], skuInfo: Map<string, SkuInfo>
): CheckRow[] {
  const slSku = new Map<string, ShelfLifeRow>();
  const slCat = new Map<string, ShelfLifeRow>();
  for (const s of shelfLife) {
    (s.scope === "sku" ? slSku : slCat).set(norm(s.scope_key), s);
  }
  const under = new Map<string, number>();
  for (const s of settings) under.set(norm(s.channel_name), Number(s.under_days));

  const fMap = new Map<string, number>();
  const sMap = new Map<string, number>();
  const catMap = new Map<string, string>();
  const key = (c: string, s: string) => `${norm(c)}||${norm(s)}`;
  const label = new Map<string, { channel: string; master_sku: string }>();

  for (const r of forecast) {
    const k = key(r.channel, r.master_sku);
    fMap.set(k, (fMap.get(k) || 0) + r.qty);
    if (r.category) catMap.set(norm(r.master_sku), r.category);
    if (!label.has(k)) label.set(k, { channel: r.channel, master_sku: r.master_sku });
  }
  for (const r of sales) {
    const k = key(r.channel, r.master_sku);
    sMap.set(k, (sMap.get(k) || 0) + r.qty);
    if (r.category) catMap.set(norm(r.master_sku), r.category);
    if (!label.has(k)) label.set(k, { channel: r.channel, master_sku: r.master_sku });
  }

  const out: CheckRow[] = [];
  for (const [k, lab] of label) {
    const fc = fMap.get(k) || 0;
    const mtd = sMap.get(k) || 0;
    if (fc === 0 && mtd === 0) continue; // nothing to judge

    const category = catMap.get(norm(lab.master_sku)) || skuInfo.get(norm(lab.master_sku))?.category || "";
    const sl = slSku.get(norm(lab.master_sku)) || (category ? slCat.get(norm(category)) : undefined);
    const shelfSource: CheckRow["shelf_source"] = slSku.has(norm(lab.master_sku)) ? "SKU" : (sl ? "Category" : "—");
    const maxSl = sl?.max_shelf_life_days ?? null;
    const underDays = under.get(norm(lab.channel)) ?? 20;

    const drr = daysElapsed > 0 ? mtd / daysElapsed : 0;
    // No run rate but a forecast exists => the forecast never sells through. Treat as infinite DOS.
    const dos = drr > 0 ? fc / drr : (fc > 0 ? Infinity : null);

    let verdict: Verdict;
    if (dos === null) verdict = "OK";
    else if (dos < underDays) verdict = "UNDER";
    else if (maxSl === null) verdict = "NO SHELF LIFE";
    else if (dos > maxSl) verdict = "OVER";
    else verdict = "OK";

    out.push({
      channel: lab.channel, master_sku: lab.master_sku, category,
      mtd_qty: mtd, drr: Math.round(drr * 100) / 100, forecast: fc,
      dos: dos === null ? null : (dos === Infinity ? Infinity : Math.round(dos * 100) / 100),
      shelf_life: sl?.shelf_life_days ?? null, max_shelf_life: maxSl, shelf_source: shelfSource,
      under_days: underDays, verdict,
    });
  }

  const rank: Record<Verdict, number> = { OVER: 0, UNDER: 1, "NO SHELF LIFE": 2, OK: 3 };
  return out.sort((a, b) =>
    a.channel.localeCompare(b.channel) || rank[a.verdict] - rank[b.verdict] || a.master_sku.localeCompare(b.master_sku));
}

// ========== EXCEL OUT ==========

const dosCell = (d: number | null) => (d === null ? "" : d === Infinity ? "No Sales" : d);

function sheetRows(rows: CheckRow[], withChannel: boolean) {
  return rows.map((r) => {
    const o: any = {};
    if (withChannel) o["Channel"] = r.channel;
    o["Master SKU"] = r.master_sku;
    o["Category"] = r.category;
    o["MTD Qty"] = r.mtd_qty;
    o["DRR"] = r.drr;
    o["Forecast"] = r.forecast;
    o["DOS"] = dosCell(r.dos);
    o["Shelf Life"] = r.shelf_life ?? "";
    o["Max Shelf Life"] = r.max_shelf_life ?? "";
    o["Under Days"] = r.under_days;
    o["Verdict"] = r.verdict;
    return o;
  });
}

function buildExcel(rows: CheckRow[], daysElapsed: number, updatedTill: string): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();

  // Summary
  const channels = [...new Set(rows.map((r) => r.channel))].sort();
  const summary: any[] = [
    { Metric: "Updated till", Value: updatedTill || "—" },
    { Metric: "Days elapsed", Value: daysElapsed },
    { Metric: "Rows checked", Value: rows.length },
    { Metric: "OVER", Value: rows.filter((r) => r.verdict === "OVER").length },
    { Metric: "UNDER", Value: rows.filter((r) => r.verdict === "UNDER").length },
    { Metric: "OK", Value: rows.filter((r) => r.verdict === "OK").length },
    { Metric: "Missing shelf life", Value: rows.filter((r) => r.verdict === "NO SHELF LIFE").length },
    {},
  ];
  for (const c of channels) {
    const cr = rows.filter((r) => r.channel === c);
    summary.push({
      Metric: c,
      Value: `${cr.length} rows`,
      OVER: cr.filter((r) => r.verdict === "OVER").length,
      UNDER: cr.filter((r) => r.verdict === "UNDER").length,
      OK: cr.filter((r) => r.verdict === "OK").length,
    });
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), "Summary");

  // All channels combined
  const all = XLSX.utils.json_to_sheet(sheetRows(rows, true));
  all["!cols"] = [{ wch: 18 }, { wch: 24 }, { wch: 14 }, { wch: 11 }, { wch: 10 }, { wch: 11 }, { wch: 10 }, { wch: 11 }, { wch: 14 }, { wch: 11 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, all, "All Channels");

  // One sheet per channel — mirrors the existing workbook layout
  for (const c of channels) {
    const ws = XLSX.utils.json_to_sheet(sheetRows(rows.filter((r) => r.channel === c), false));
    ws["!cols"] = [{ wch: 24 }, { wch: 14 }, { wch: 11 }, { wch: 10 }, { wch: 11 }, { wch: 10 }, { wch: 11 }, { wch: 14 }, { wch: 11 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, ws, c.replace(/[\\/*?:[\]]/g, "").slice(0, 31));
  }

  // Missing shelf life — the list to go fill in
  const missing = rows.filter((r) => r.verdict === "NO SHELF LIFE");
  const mData = missing.length
    ? [...new Map(missing.map((r) => [norm(r.master_sku), { "Master SKU": r.master_sku, "Category": r.category }])).values()]
    : [{ "Master SKU": "", "Category": "None — every SKU has shelf life" }];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(mData), "Missing Shelf Life");

  return wb;
}

// ============================================================================
// COMPONENT
// ============================================================================

export default function OverUnderCheckPage() {
  const supabase = createClient();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  // Background master data
  const [shelfLife, setShelfLife] = useState<ShelfLifeRow[]>([]);
  const [settings, setSettings] = useState<ChannelSetting[]>([]);
  const [skuInfo, setSkuInfo] = useState<Map<string, SkuInfo>>(new Map());
  const [schemaMissing, setSchemaMissing] = useState(false);

  // Inputs. Both slots hold their own workbook + chosen sheet; in "single" mode the
  // two slots simply point at the same workbook, so sheet pickers work identically.
  const [uploadMode, setUploadMode] = useState<"single" | "separate">("single");
  const [wbF, setWbF] = useState<XLSX.WorkBook | null>(null);
  const [wbS, setWbS] = useState<XLSX.WorkBook | null>(null);
  const [forecastFile, setForecastFile] = useState<ParsedFile | null>(null);
  const [salesFile, setSalesFile] = useState<ParsedFile | null>(null);
  const [forecastName, setForecastName] = useState("");
  const [salesName, setSalesName] = useState("");
  const [fSheet, setFSheet] = useState("");
  const [sSheet, setSSheet] = useState("");
  const [updatedTill, setUpdatedTill] = useState("");
  const [daysElapsed, setDaysElapsed] = useState(22);

  // Result
  const [result, setResult] = useState<CheckRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filterChannel, setFilterChannel] = useState("all");
  const [filterVerdict, setFilterVerdict] = useState("all");
  const [search, setSearch] = useState("");

  // Panels
  const [showShelf, setShowShelf] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shelfSearch, setShelfSearch] = useState("");

  const isAdmin = profile?.role === "admin";

  useEffect(() => { init(); }, []);

  async function init() {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { data: p } = await supabase.from("profiles").select("*").eq("id", user.id).single();
      setProfile(p);
    }
    await Promise.all([loadShelfLife(), loadSettings(), loadSkuMaster()]);
    setLoading(false);
  }

  async function loadShelfLife() {
    const { data, error } = await supabase.from("shelf_life_master").select("*").order("scope").order("scope_key");
    if (error) { setSchemaMissing(true); return; }
    setShelfLife((data || []) as ShelfLifeRow[]);
  }
  async function loadSettings() {
    const { data, error } = await supabase.from("over_under_channel_settings").select("*").order("channel_name");
    if (error) { setSchemaMissing(true); return; }
    setSettings((data || []) as ChannelSetting[]);
  }
  async function loadSkuMaster() {
    let all: any[] = [], from = 0;
    while (true) {
      const { data } = await supabase.from("sku_master").select("new_master_sku, category, product_name").range(from, from + 999);
      if (!data || data.length === 0) break;
      all = all.concat(data);
      if (data.length < 1000) break;
      from += 1000;
    }
    const m = new Map<string, SkuInfo>();
    for (const r of all) {
      const sku = String(r.new_master_sku || "").trim();
      if (sku) m.set(norm(sku), { master_sku: sku, category: String(r.category || "").trim(), product_name: String(r.product_name || "").trim() });
    }
    setSkuInfo(m);
  }

  // ====== FILE HANDLING ======

  // Sales sheets are rarely named "sales" — in the source workbook the MTD numbers sit
  // on a channel-named sheet ("Zepto"). So: try the obvious names, then fall back to the
  // first sheet that neither looks like a forecast nor is already taken as one.
  function guessSalesSheet(wb: XLSX.WorkBook, exclude: string): string {
    for (const p of [/mtd/i, /secondary/i, /sales/i]) {
      const hit = wb.SheetNames.find((n) => p.test(n) && n !== exclude);
      if (hit) return hit;
    }
    return wb.SheetNames.find((n) => n !== exclude && !/forecast/i.test(n))
      || wb.SheetNames.find((n) => n !== exclude)
      || wb.SheetNames[0];
  }

  function applyParse(wb: XLSX.WorkBook, sheet: string, which: "forecast" | "sales") {
    const parsed = parseFlexible(wb.Sheets[sheet]);
    if (which === "forecast") setForecastFile(parsed.rows.length ? parsed : null);
    else setSalesFile(parsed.rows.length ? parsed : null);
    if (parsed.rows.length === 0) {
      setError(`${which === "forecast" ? "Forecast" : "MTD Sales"} sheet "${sheet}": ${parsed.warnings[0] || "no rows parsed"}. Pick a different sheet below.`);
    }
    setResult(null);
  }

  function readFile(file: File, target: "forecast" | "sales" | "both") {
    setError(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target?.result, { type: "binary" });
        let fGuess = "";
        if (target === "both" || target === "forecast") {
          fGuess = pickSheet(wb, [/forecast\s*base/i, /forecast\s*fin/i, /forecast/i]);
          setWbF(wb); setForecastName(file.name); setFSheet(fGuess);
          applyParse(wb, fGuess, "forecast");
        }
        if (target === "both" || target === "sales") {
          const sGuess = target === "both"
            ? guessSalesSheet(wb, fGuess)
            : pickSheet(wb, [/mtd/i, /secondary/i, /sales/i]);
          setWbS(wb); setSalesName(file.name); setSSheet(sGuess);
          applyParse(wb, sGuess, "sales");
        }
      } catch (err: any) { setError(`Could not read file: ${err.message}`); }
    };
    reader.readAsBinaryString(file);
  }

  function changeSheet(which: "forecast" | "sales", sheet: string) {
    setError(null);
    const wb = which === "forecast" ? wbF : wbS;
    if (!wb) return;
    if (which === "forecast") setFSheet(sheet); else setSSheet(sheet);
    applyParse(wb, sheet, which);
  }

  function clearInputs() {
    setWbF(null); setWbS(null); setForecastFile(null); setSalesFile(null);
    setForecastName(""); setSalesName(""); setFSheet(""); setSSheet("");
    setResult(null); setError(null);
  }

  function onDateChange(v: string) {
    setUpdatedTill(v);
    if (v) { const d = new Date(v); if (!isNaN(d.getTime())) setDaysElapsed(d.getDate()); }
  }

  function run() {
    setError(null);
    if (!forecastFile) { setError("Upload the Forecast file first."); return; }
    if (!salesFile) { setError("Upload the MTD Secondary Sales file first."); return; }
    if (daysElapsed <= 0) { setError("Days elapsed must be greater than 0."); return; }
    const rows = runCheck(forecastFile.rows, salesFile.rows, daysElapsed, shelfLife, settings, skuInfo);
    if (rows.length === 0) { setError("No matching SKU/channel rows between the two files. Check the Master SKUs and channel names line up."); return; }
    setResult(rows);
  }

  function download() {
    if (!result) return;
    XLSX.writeFile(buildExcel(result, daysElapsed, updatedTill), `Over_Under_Check${updatedTill ? "_" + updatedTill : ""}.xlsx`);
  }

  // ====== SHELF LIFE MANAGEMENT ======

  // Template is pre-filled with every category and every active SKU so only the
  // two number columns need typing.
  function downloadShelfTemplate() {
    const cats = [...new Set([...skuInfo.values()].map((s) => s.category).filter(Boolean))].sort();
    const existSku = new Map(shelfLife.filter((s) => s.scope === "sku").map((s) => [norm(s.scope_key), s]));
    const existCat = new Map(shelfLife.filter((s) => s.scope === "category").map((s) => [norm(s.scope_key), s]));
    const rows: any[] = [];
    for (const c of cats) {
      const e = existCat.get(norm(c));
      rows.push({ Scope: "Category", Key: c, "Shelf Life (Days)": e?.shelf_life_days ?? "", "Max Shelf Life (Days)": e?.max_shelf_life_days ?? "", Notes: e?.notes ?? "" });
    }
    for (const s of [...skuInfo.values()].sort((a, b) => a.master_sku.localeCompare(b.master_sku))) {
      const e = existSku.get(norm(s.master_sku));
      rows.push({ Scope: "SKU", Key: s.master_sku, "Shelf Life (Days)": e?.shelf_life_days ?? "", "Max Shelf Life (Days)": e?.max_shelf_life_days ?? "", Notes: e?.notes ?? s.product_name });
    }
    const wb = XLSX.utils.book_new();
    const info = XLSX.utils.aoa_to_sheet([
      ["Shelf Life Master — fill the two number columns and upload this file back."],
      [],
      ["Scope", "Either 'Category' or 'SKU'. A SKU row overrides its category row."],
      ["Key", "The category name, or the Master SKU."],
      ["Shelf Life (Days)", "Total product shelf life. Reference — stored, not used for the verdict."],
      ["Max Shelf Life (Days)", "Drives the OVER verdict: OVER when DOS exceeds this."],
      ["Notes", "Optional."],
      [],
      ["Leave a row blank to skip it — blanks are never written over existing values."],
    ]);
    info["!cols"] = [{ wch: 22 }, { wch: 90 }];
    XLSX.utils.book_append_sheet(wb, info, "Instructions");
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [{ wch: 10 }, { wch: 28 }, { wch: 18 }, { wch: 22 }, { wch: 50 }];
    XLSX.utils.book_append_sheet(wb, ws, "Shelf Life");
    XLSX.writeFile(wb, "Shelf_Life_Master_Template.xlsx");
  }

  async function uploadShelfLife(file: File) {
    setBusy(true); setMsg(null);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheet = wb.Sheets[pickSheet(wb, [/shelf/i])];
      const json = XLSX.utils.sheet_to_json<any>(sheet);
      const { data: { user } } = await supabase.auth.getUser();

      const payload: any[] = [];
      for (const r of json) {
        const scopeRaw = norm(String(r["Scope"] ?? ""));
        const key = String(r["Key"] ?? "").trim();
        if (!key) continue;
        const scope = scopeRaw.startsWith("cat") ? "category" : scopeRaw.startsWith("sku") ? "sku" : "";
        if (!scope) continue;
        const sl = r["Shelf Life (Days)"];
        const ml = r["Max Shelf Life (Days)"];
        const slN = sl === "" || sl === undefined || sl === null ? null : Number(sl);
        const mlN = ml === "" || ml === undefined || ml === null ? null : Number(ml);
        if (slN === null && mlN === null) continue; // blank row => skip, never wipe existing
        payload.push({
          scope, scope_key: key,
          shelf_life_days: slN !== null && !isNaN(slN) ? Math.round(slN) : null,
          max_shelf_life_days: mlN !== null && !isNaN(mlN) ? Math.round(mlN) : null,
          notes: r["Notes"] ? String(r["Notes"]).trim() : null,
          updated_by: user?.id ?? null,
        });
      }
      if (payload.length === 0) { setMsg("No usable rows found — fill at least one Shelf Life value."); setBusy(false); return; }

      // Upsert in batches against the (scope, lower(scope_key)) unique index.
      const BATCH = 300;
      for (let i = 0; i < payload.length; i += BATCH) {
        const { error } = await supabase.from("shelf_life_master")
          .upsert(payload.slice(i, i + BATCH), { onConflict: "scope,scope_key" });
        if (error) { setMsg(`Upload failed: ${error.message}`); setBusy(false); return; }
      }
      await loadShelfLife();
      setMsg(`Saved ${payload.length} shelf life row(s).`);
      setResult(null);
    } catch (e: any) { setMsg(`Upload failed: ${e.message}`); }
    setBusy(false);
  }

  async function saveShelfRow(row: ShelfLifeRow) {
    setBusy(true);
    const { error } = await supabase.from("shelf_life_master")
      .update({ shelf_life_days: row.shelf_life_days, max_shelf_life_days: row.max_shelf_life_days })
      .eq("id", row.id);
    setMsg(error ? `Save failed: ${error.message}` : `Saved ${row.scope_key}.`);
    if (!error) { await loadShelfLife(); setResult(null); }
    setBusy(false);
  }

  async function deleteShelfRow(id: string, key: string) {
    if (!confirm(`Delete shelf life entry for "${key}"?`)) return;
    setBusy(true);
    const { error } = await supabase.from("shelf_life_master").delete().eq("id", id);
    setMsg(error ? `Delete failed: ${error.message}` : `Deleted ${key}.`);
    if (!error) { await loadShelfLife(); setResult(null); }
    setBusy(false);
  }

  async function saveSetting(s: ChannelSetting) {
    setBusy(true);
    const { error } = await supabase.from("over_under_channel_settings")
      .update({ under_days: s.under_days }).eq("id", s.id);
    setMsg(error ? `Save failed: ${error.message}` : `${s.channel_name}: UNDER below ${s.under_days} days.`);
    if (!error) { await loadSettings(); setResult(null); }
    setBusy(false);
  }

  // ====== DERIVED ======
  const filtered = useMemo(() => {
    if (!result) return [];
    const q = norm(search);
    return result.filter((r) =>
      (filterChannel === "all" || r.channel === filterChannel) &&
      (filterVerdict === "all" || r.verdict === filterVerdict) &&
      (!q || norm(r.master_sku).includes(q) || norm(r.category).includes(q)));
  }, [result, filterChannel, filterVerdict, search]);

  const stats = useMemo(() => {
    const r = result || [];
    return {
      total: r.length,
      over: r.filter((x) => x.verdict === "OVER").length,
      under: r.filter((x) => x.verdict === "UNDER").length,
      ok: r.filter((x) => x.verdict === "OK").length,
      missing: r.filter((x) => x.verdict === "NO SHELF LIFE").length,
    };
  }, [result]);

  const shelfFiltered = useMemo(() => {
    const q = norm(shelfSearch);
    return shelfLife.filter((s) => !q || norm(s.scope_key).includes(q));
  }, [shelfLife, shelfSearch]);

  const verdictPill = (v: Verdict) => {
    const map: Record<Verdict, string> = {
      OVER: "bg-atlas-red-bg text-atlas-red",
      UNDER: "bg-atlas-amber-bg text-atlas-amber-warn",
      OK: "bg-atlas-green-bg text-atlas-green",
      "NO SHELF LIFE": "bg-atlas-surface-soft text-atlas-ink-muted",
    };
    return <span className={`px-2 py-0.5 rounded text-[10px] uppercase font-medium whitespace-nowrap ${map[v]}`}>{v}</span>;
  };

  if (loading) {
    return <AppShell><div className="flex items-center justify-center h-64"><p className="text-atlas-ink-muted">Loading…</p></div></AppShell>;
  }

  return (
    <AppShell>
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
          <div>
            <h2 className="text-2xl font-bold">Over / Under Check</h2>
            <p className="text-sm text-atlas-ink-muted mt-1">
              DRR = MTD sales ÷ days elapsed · DOS = Forecast ÷ DRR ·
              <span className="text-atlas-red"> OVER</span> above Max Shelf Life ·
              <span className="text-atlas-amber-warn"> UNDER</span> below the channel threshold
            </p>
          </div>
          <div className="flex gap-3 flex-wrap">
            {result && <button onClick={download} className="px-4 py-2 text-sm bg-atlas-navy text-white font-semibold rounded-lg hover:bg-atlas-navy-soft transition">Download Excel</button>}
            <button onClick={() => { setShowShelf(!showShelf); setShowSettings(false); }}
              className={`px-4 py-2 text-sm rounded-lg transition ${showShelf ? "bg-atlas-blue-bg text-atlas-blue ring-1 ring-atlas-blue" : "bg-atlas-surface-soft text-atlas-ink hover:bg-atlas-surface-soft"}`}>
              Shelf Life ({shelfLife.length})
            </button>
            <button onClick={() => { setShowSettings(!showSettings); setShowShelf(false); }}
              className={`px-4 py-2 text-sm rounded-lg transition ${showSettings ? "bg-atlas-blue-bg text-atlas-blue ring-1 ring-atlas-blue" : "bg-atlas-surface-soft text-atlas-ink hover:bg-atlas-surface-soft"}`}>
              Thresholds
            </button>
          </div>
        </div>

        {schemaMissing && (
          <div className="mb-6 p-4 bg-atlas-red-bg border border-atlas-red rounded-xl">
            <p className="text-atlas-red text-sm font-medium">Database tables are missing.</p>
            <p className="text-atlas-ink-soft text-xs mt-1">
              Run <span className="font-mono">supabase/sql/over_under_check.sql</span> in the Supabase SQL editor, then reload this page.
              Shelf life and thresholds can&apos;t be stored until then.
            </p>
          </div>
        )}
        {error && <div className="mb-6 p-4 bg-atlas-red-bg border border-atlas-red rounded-xl"><p className="text-atlas-red text-sm">{error}</p></div>}
        {msg && <div className="mb-6 p-3 bg-atlas-blue-bg border border-atlas-blue/30 rounded-lg"><p className="text-atlas-blue text-sm">{msg}</p></div>}

        {/* ===== THRESHOLDS PANEL ===== */}
        {showSettings && (
          <div className="mb-6 bg-atlas-surface border border-atlas-blue/30 rounded-xl p-6">
            <h3 className="text-lg font-semibold text-atlas-blue mb-1">Per-Channel UNDER Threshold</h3>
            <p className="text-xs text-atlas-ink-muted mb-4">A row is UNDER when its DOS falls below this many days. Default 20.</p>
            <div className="space-y-2">
              {settings.length === 0 && <p className="text-sm text-atlas-ink-muted">No channels configured yet — run the SQL file.</p>}
              {settings.map((s, i) => (
                <div key={s.id} className="flex items-center gap-3 p-3 bg-atlas-surface-soft rounded-lg">
                  <span className="text-sm font-medium flex-1">{s.channel_name}</span>
                  <input type="number" min={0} value={s.under_days} disabled={!isAdmin}
                    onChange={(e) => { const n = [...settings]; n[i] = { ...s, under_days: Number(e.target.value) }; setSettings(n); }}
                    className="w-24 px-3 py-1.5 bg-atlas-surface border border-atlas-line rounded-lg text-sm text-right focus:outline-none focus:ring-1 focus:ring-atlas-blue disabled:opacity-50" />
                  <span className="text-xs text-atlas-ink-muted w-10">days</span>
                  {isAdmin && <button onClick={() => saveSetting(s)} disabled={busy}
                    className="px-3 py-1.5 text-xs bg-atlas-blue text-white rounded-lg hover:bg-atlas-blue/80 transition disabled:opacity-50">Save</button>}
                </div>
              ))}
            </div>
            {!isAdmin && <p className="text-xs text-atlas-ink-muted mt-3">Read-only — admin access is needed to change thresholds.</p>}
          </div>
        )}

        {/* ===== SHELF LIFE PANEL ===== */}
        {showShelf && (
          <div className="mb-6 bg-atlas-surface border border-atlas-blue/30 rounded-xl p-6">
            <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
              <div>
                <h3 className="text-lg font-semibold text-atlas-blue">Shelf Life Master</h3>
                <p className="text-xs text-atlas-ink-muted mt-1">
                  Stored in the background. A <span className="text-atlas-ink font-medium">SKU</span> entry wins over its <span className="text-atlas-ink font-medium">Category</span> entry.
                  <span className="text-atlas-ink"> Max Shelf Life</span> drives the OVER verdict.
                </p>
              </div>
              <div className="flex gap-2 flex-wrap">
                <button onClick={downloadShelfTemplate} className="px-3 py-2 text-xs bg-atlas-surface-soft text-atlas-ink rounded-lg hover:bg-atlas-surface-soft transition">Download Template</button>
                {isAdmin && (
                  <label className={`px-3 py-2 text-xs rounded-lg cursor-pointer transition ${busy ? "bg-atlas-surface-soft text-atlas-ink-muted" : "bg-atlas-blue text-white hover:bg-atlas-blue/80"}`}>
                    {busy ? "Working…" : "Upload Filled File"}
                    <input type="file" accept=".xlsx,.xls" className="hidden" disabled={busy}
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadShelfLife(f); e.currentTarget.value = ""; }} />
                  </label>
                )}
              </div>
            </div>

            <input type="text" value={shelfSearch} onChange={(e) => setShelfSearch(e.target.value)} placeholder="Search SKU or category…"
              className="w-full mb-3 px-3 py-2 bg-atlas-surface-soft border border-atlas-line rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-atlas-blue" />

            {shelfLife.length === 0 ? (
              <p className="text-sm text-atlas-ink-muted py-4 text-center">
                No shelf life data yet. Download the template — it comes pre-filled with every category and SKU — then upload it back.
              </p>
            ) : (
              <div className="border border-atlas-line rounded-lg overflow-hidden">
                <div className="overflow-auto max-h-[420px]">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-atlas-surface">
                      <tr className="border-b border-atlas-line">
                        <th className="text-left py-2.5 px-3 text-atlas-ink-muted font-medium">Scope</th>
                        <th className="text-left py-2.5 px-3 text-atlas-ink-muted font-medium">Key</th>
                        <th className="text-right py-2.5 px-3 text-atlas-ink-muted font-medium">Shelf Life</th>
                        <th className="text-right py-2.5 px-3 text-atlas-ink-muted font-medium">Max Shelf Life</th>
                        <th className="py-2.5 px-3"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {shelfFiltered.map((s) => {
                        const idx = shelfLife.findIndex((x) => x.id === s.id);
                        return (
                          <tr key={s.id} className="border-b border-atlas-line/50 hover:bg-atlas-surface-soft/30">
                            <td className="py-2 px-3">
                              <span className={`px-2 py-0.5 rounded text-[10px] uppercase ${s.scope === "sku" ? "bg-atlas-accent-bg text-atlas-accent" : "bg-atlas-surface-soft text-atlas-ink-muted"}`}>{s.scope}</span>
                            </td>
                            <td className="py-2 px-3 font-mono text-xs">{s.scope_key}</td>
                            <td className="py-2 px-3 text-right">
                              <input type="number" min={0} value={s.shelf_life_days ?? ""} disabled={!isAdmin}
                                onChange={(e) => { const n = [...shelfLife]; n[idx] = { ...s, shelf_life_days: e.target.value === "" ? null : Number(e.target.value) }; setShelfLife(n); }}
                                className="w-20 px-2 py-1 bg-atlas-surface-soft border border-atlas-line rounded text-xs text-right focus:outline-none focus:ring-1 focus:ring-atlas-blue disabled:opacity-50" />
                            </td>
                            <td className="py-2 px-3 text-right">
                              <input type="number" min={0} value={s.max_shelf_life_days ?? ""} disabled={!isAdmin}
                                onChange={(e) => { const n = [...shelfLife]; n[idx] = { ...s, max_shelf_life_days: e.target.value === "" ? null : Number(e.target.value) }; setShelfLife(n); }}
                                className="w-20 px-2 py-1 bg-atlas-surface-soft border border-atlas-line rounded text-xs text-right focus:outline-none focus:ring-1 focus:ring-atlas-blue disabled:opacity-50" />
                            </td>
                            <td className="py-2 px-3 text-right whitespace-nowrap">
                              {isAdmin && (
                                <>
                                  <button onClick={() => saveShelfRow(shelfLife[idx])} disabled={busy} className="text-xs text-atlas-blue hover:underline mr-3 disabled:opacity-50">Save</button>
                                  <button onClick={() => deleteShelfRow(s.id, s.scope_key)} disabled={busy} className="text-xs text-atlas-red hover:underline disabled:opacity-50">Delete</button>
                                </>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ===== INPUTS ===== */}
        {!result && (
          <div className="space-y-4">
            {/* Upload mode */}
            <div className="flex items-center gap-3 flex-wrap">
              <div className="bg-atlas-surface border border-atlas-line rounded-xl p-1.5 inline-flex gap-1">
                {([
                  { k: "single" as const, label: "One workbook", desc: "Both Forecast and MTD Sales live in the same file" },
                  { k: "separate" as const, label: "Separate files", desc: "Forecast and MTD Sales come as two files" },
                ]).map((t) => (
                  <button key={t.k} title={t.desc}
                    onClick={() => { setUploadMode(t.k); clearInputs(); }}
                    className={`px-4 py-1.5 rounded-lg text-sm transition ${uploadMode === t.k ? "bg-atlas-accent-bg text-atlas-accent ring-1 ring-atlas-accent/40" : "text-atlas-ink-muted hover:bg-atlas-surface-soft"}`}>
                    {t.label}
                  </button>
                ))}
              </div>
              {(forecastFile || salesFile) && (
                <button onClick={clearInputs} className="text-xs text-atlas-ink-muted hover:text-atlas-ink transition">Clear</button>
              )}
            </div>

            {/* ---- ONE WORKBOOK ---- */}
            {uploadMode === "single" && (
              <div className="bg-atlas-surface border border-atlas-line rounded-xl p-5">
                <label className="block text-sm font-medium text-atlas-ink">Workbook (Forecast + MTD Sales)</label>
                <p className="text-xs text-atlas-ink-muted mt-1 mb-3">
                  Drop the whole file — I&apos;ll pick the two sheets and you can correct them below.
                </p>
                <label className={`flex flex-col items-center justify-center gap-1.5 border-2 border-dashed rounded-xl py-8 cursor-pointer transition ${wbF ? "border-atlas-green/50 bg-atlas-green-bg/20" : "border-atlas-line hover:border-atlas-blue/50 hover:bg-atlas-surface-soft/30"}`}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) readFile(f, "both"); }}>
                  {wbF ? (
                    <>
                      <p className="text-sm text-atlas-green font-medium">{forecastName}</p>
                      <p className="text-xs text-atlas-ink-muted">{wbF.SheetNames.length} sheets · click to replace</p>
                    </>
                  ) : (
                    <>
                      <p className="text-sm text-atlas-ink">Drop Excel here, or click</p>
                      <p className="text-xs text-atlas-ink-muted">.xlsx / .xls</p>
                    </>
                  )}
                  <input type="file" accept=".xlsx,.xls" className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f, "both"); e.currentTarget.value = ""; }} />
                </label>

                {wbF && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
                    {([
                      { which: "forecast" as const, title: "Forecast sheet", sheet: fSheet, file: forecastFile },
                      { which: "sales" as const, title: "MTD Sales sheet", sheet: sSheet, file: salesFile },
                    ]).map((s) => (
                      <div key={s.which}>
                        <label className="block text-xs font-medium text-atlas-ink mb-1.5">{s.title}</label>
                        <select value={s.sheet} onChange={(e) => changeSheet(s.which, e.target.value)}
                          className="w-full px-3 py-2 bg-atlas-surface-soft border border-atlas-line rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-atlas-blue">
                          {wbF.SheetNames.map((n) => <option key={n} value={n}>{n}</option>)}
                        </select>
                        {s.file ? (
                          <p className="text-[11px] text-atlas-green mt-1.5">
                            {s.file.rows.length.toLocaleString()} rows · {s.file.channels.length} channel(s) · {s.file.layout} layout{s.file.valueCol ? ` · value: ${s.file.valueCol}` : ""}
                          </p>
                        ) : <p className="text-[11px] text-atlas-red mt-1.5">Nothing parsed from this sheet.</p>}
                        {s.file && s.file.warnings.length > 0 && <p className="text-[11px] text-atlas-amber-warn mt-1">{s.file.warnings[0]}</p>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ---- SEPARATE FILES ---- */}
            {uploadMode === "separate" && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {([
                  { k: "forecast" as const, title: "Forecast", sub: "Channel · Master SKU · Category · Qty — or Master SKU + one column per channel", file: forecastFile, name: forecastName, wb: wbF, sheet: fSheet },
                  { k: "sales" as const, title: "MTD Secondary Sales", sub: "Month-to-date sales for the current month, same layouts accepted", file: salesFile, name: salesName, wb: wbS, sheet: sSheet },
                ]).map((box) => (
                  <div key={box.k} className="bg-atlas-surface border border-atlas-line rounded-xl p-5">
                    <label className="block text-sm font-medium text-atlas-ink">{box.title}</label>
                    <p className="text-xs text-atlas-ink-muted mt-1 mb-3">{box.sub}</p>
                    <label className={`flex flex-col items-center justify-center gap-1.5 border-2 border-dashed rounded-xl py-8 cursor-pointer transition ${box.file ? "border-atlas-green/50 bg-atlas-green-bg/20" : "border-atlas-line hover:border-atlas-blue/50 hover:bg-atlas-surface-soft/30"}`}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) readFile(f, box.k); }}>
                      {box.file ? (
                        <>
                          <p className="text-sm text-atlas-green font-medium">{box.file.rows.length.toLocaleString()} rows · {box.file.channels.length} channel(s)</p>
                          <p className="text-xs text-atlas-ink-muted text-center px-3">{box.name}</p>
                          <p className="text-[10px] text-atlas-ink-faint">{box.file.layout} layout{box.file.valueCol ? ` · value: ${box.file.valueCol}` : ""} · click to replace</p>
                        </>
                      ) : (
                        <>
                          <p className="text-sm text-atlas-ink">Drop Excel here, or click</p>
                          <p className="text-xs text-atlas-ink-muted">.xlsx / .xls</p>
                        </>
                      )}
                      <input type="file" accept=".xlsx,.xls" className="hidden"
                        onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f, box.k); e.currentTarget.value = ""; }} />
                    </label>
                    {box.wb && box.wb.SheetNames.length > 1 && (
                      <div className="mt-3">
                        <label className="block text-xs font-medium text-atlas-ink mb-1.5">Sheet</label>
                        <select value={box.sheet} onChange={(e) => changeSheet(box.k, e.target.value)}
                          className="w-full px-3 py-2 bg-atlas-surface-soft border border-atlas-line rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-atlas-blue">
                          {box.wb.SheetNames.map((n) => <option key={n} value={n}>{n}</option>)}
                        </select>
                      </div>
                    )}
                    {box.file && box.file.warnings.length > 0 && (
                      <p className="text-xs text-atlas-amber-warn mt-2">{box.file.warnings[0]}</p>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="bg-atlas-surface border border-atlas-line rounded-xl p-5">
              <div className="flex items-end gap-6 flex-wrap">
                <div>
                  <label className="block text-sm font-medium text-atlas-ink mb-1.5">Updated till</label>
                  <input type="date" value={updatedTill} onChange={(e) => onDateChange(e.target.value)}
                    className="px-3 py-2 bg-atlas-surface-soft border border-atlas-line rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-atlas-blue" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-atlas-ink mb-1.5">Days elapsed</label>
                  <input type="number" min={1} value={daysElapsed} onChange={(e) => setDaysElapsed(Number(e.target.value))}
                    className="w-28 px-3 py-2 bg-atlas-surface-soft border border-atlas-line rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-atlas-blue" />
                  <p className="text-[11px] text-atlas-ink-muted mt-1">DRR = MTD ÷ this</p>
                </div>
                <button onClick={run} disabled={!forecastFile || !salesFile}
                  className="px-6 py-2.5 bg-atlas-accent text-white font-semibold rounded-lg hover:bg-atlas-accent-deep transition text-sm disabled:opacity-40 disabled:cursor-not-allowed">
                  Run Check
                </button>
              </div>
              {shelfLife.length === 0 && !schemaMissing && (
                <p className="text-xs text-atlas-amber-warn mt-3">
                  No shelf life data loaded — rows will come back as “NO SHELF LIFE” and OVER can&apos;t be judged. Add it under <span className="font-medium">Shelf Life</span> above.
                </p>
              )}
            </div>
          </div>
        )}

        {/* ===== RESULTS ===== */}
        {result && (
          <div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-4">
              {[
                { l: "Rows Checked", v: stats.total, c: "" },
                { l: "OVER", v: stats.over, c: "text-atlas-red" },
                { l: "UNDER", v: stats.under, c: "text-atlas-amber-warn" },
                { l: "OK", v: stats.ok, c: "text-atlas-green" },
                { l: "No Shelf Life", v: stats.missing, c: stats.missing > 0 ? "text-atlas-ink-muted" : "text-atlas-ink-faint" },
              ].map((t) => (
                <div key={t.l} className="bg-atlas-surface border border-atlas-line rounded-xl p-4">
                  <p className="text-xs text-atlas-ink-muted">{t.l}</p>
                  <p className={`text-2xl font-bold ${t.c}`}>{t.v}</p>
                </div>
              ))}
            </div>

            <div className="flex gap-3 mb-4 flex-wrap items-center">
              <button onClick={download} className="px-5 py-2 bg-atlas-navy text-white font-semibold rounded-lg hover:bg-atlas-navy-soft transition text-sm">Download Excel</button>
              <button onClick={() => setResult(null)} className="px-5 py-2 bg-atlas-surface-soft text-atlas-ink rounded-lg hover:bg-atlas-surface-soft transition text-sm">New Check</button>
              <select value={filterChannel} onChange={(e) => setFilterChannel(e.target.value)}
                className="px-3 py-2 bg-atlas-surface border border-atlas-line rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-atlas-blue">
                <option value="all">All channels</option>
                {[...new Set(result.map((r) => r.channel))].sort().map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <select value={filterVerdict} onChange={(e) => setFilterVerdict(e.target.value)}
                className="px-3 py-2 bg-atlas-surface border border-atlas-line rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-atlas-blue">
                <option value="all">All verdicts</option>
                <option value="OVER">OVER</option>
                <option value="UNDER">UNDER</option>
                <option value="OK">OK</option>
                <option value="NO SHELF LIFE">No shelf life</option>
              </select>
              <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search SKU / category…"
                className="flex-1 min-w-[180px] px-3 py-2 bg-atlas-surface border border-atlas-line rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-atlas-blue" />
              <span className="text-xs text-atlas-ink-muted">{filtered.length} shown</span>
            </div>

            <div className="bg-atlas-surface border border-atlas-line rounded-xl overflow-hidden">
              <div className="overflow-auto max-h-[620px]">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-atlas-surface">
                    <tr className="border-b border-atlas-line">
                      <th className="text-left py-3 px-3 text-atlas-ink-muted font-medium">Channel</th>
                      <th className="text-left py-3 px-3 text-atlas-ink-muted font-medium">Master SKU</th>
                      <th className="text-left py-3 px-3 text-atlas-ink-muted font-medium">Category</th>
                      <th className="text-right py-3 px-3 text-atlas-ink-muted font-medium">MTD Qty</th>
                      <th className="text-right py-3 px-3 text-atlas-ink-muted font-medium">DRR</th>
                      <th className="text-right py-3 px-3 text-atlas-ink-muted font-medium">Forecast</th>
                      <th className="text-right py-3 px-3 text-atlas-ink-muted font-medium">DOS</th>
                      <th className="text-right py-3 px-3 text-atlas-ink-muted font-medium">Max SL</th>
                      <th className="text-left py-3 px-3 text-atlas-ink-muted font-medium">Verdict</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((r, i) => (
                      <tr key={`${r.channel}-${r.master_sku}-${i}`}
                        className={`border-b border-atlas-line/50 hover:bg-atlas-surface-soft/30 ${r.verdict === "OVER" ? "bg-atlas-red-bg/20" : r.verdict === "UNDER" ? "bg-atlas-amber-bg/20" : ""}`}>
                        <td className="py-2 px-3 text-xs">{r.channel}</td>
                        <td className="py-2 px-3 font-mono text-xs">{r.master_sku}</td>
                        <td className="py-2 px-3 text-xs text-atlas-ink-muted">{r.category || "—"}</td>
                        <td className="py-2 px-3 text-right font-mono text-xs">{r.mtd_qty.toLocaleString()}</td>
                        <td className="py-2 px-3 text-right font-mono text-xs">{r.drr.toLocaleString()}</td>
                        <td className="py-2 px-3 text-right font-mono text-xs">{r.forecast.toLocaleString()}</td>
                        <td className="py-2 px-3 text-right font-mono text-xs font-medium">
                          {r.dos === null ? "—" : r.dos === Infinity ? <span className="text-atlas-red">No Sales</span> : r.dos.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                        </td>
                        <td className="py-2 px-3 text-right font-mono text-xs text-atlas-ink-muted">
                          {r.max_shelf_life ?? "—"}
                          {r.shelf_source === "Category" && r.max_shelf_life !== null && <span className="text-[9px] text-atlas-ink-faint ml-1">cat</span>}
                        </td>
                        <td className="py-2 px-3">{verdictPill(r.verdict)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
