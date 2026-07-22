"use client";
import { Fragment, useEffect, useState, useRef, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import * as XLSX from "xlsx";
import Link from "next/link";
import AppShell from "@/app/components/AppShell";

type Profile = { id: string; email: string; full_name: string; role: string };
type MapperSet = { id: string; name: string; description: string | null; product_column_count: number; row_count: number; is_default: boolean; uploaded_by: string; created_at: string };
type MapperRow = { master_sku: string; combo: string; products: string[]; fg_code: string };
type ComboInputRow = { master_sku: string; quantities: Record<string, number> };
type ConsolidatedRow = { master_sku: string; quantities: Record<string, number>; mapper_status: "Found" | "NOT IN MAPPER"; combo: string; products: string[] };
type SinglesRow = { master_sku: string; quantities: Record<string, number>; status: "Converted" | "NOT IN MAPPER" };
type ConversionResult = { consolidated: ConsolidatedRow[]; singles: SinglesRow[]; qtyColumns: string[]; productCount: number; warnings: string[] };

// ========== PARSING ==========

function parseMapper(ws: XLSX.WorkSheet): { mapperRows: MapperRow[]; productCount: number } {
  const json = XLSX.utils.sheet_to_json<any>(ws, { header: 1 });
  if (json.length < 2) return { mapperRows: [], productCount: 0 };
  const headers = json[0] as any[];

  // Col B(1)=Master SKU, Col G(6)=Combo, Col J(9)+ = Product 1..N
  let productCount = 0;
  const productIndices: number[] = [];
  for (let i = 9; i < headers.length; i++) {
    const h = String(headers[i] || "");
    if (h.toLowerCase().includes("product")) { productCount++; productIndices.push(i); }
  }

  // Detect FG Code column (look for header containing "fg")
  const fgIdx = headers.findIndex((h: any) => {
    const hl = String(h || "").toLowerCase();
    return hl.includes("fg") && (hl.includes("code") || hl.includes("fg_code"));
  });

  const mapperRows: MapperRow[] = [];
  for (let r = 1; r < json.length; r++) {
    const row = json[r] as any[];
    const sku = row?.[1];
    if (!sku || String(sku).trim() === "") continue;
    const combo = String(row?.[6] || "").trim();
    const products: string[] = productIndices.map((idx) => {
      const val = row?.[idx];
      return val && String(val).trim() ? String(val).trim() : "";
    });
    const fgCode = fgIdx >= 0 ? String(row?.[fgIdx] || "").trim() : "";
    mapperRows.push({ master_sku: String(sku).trim(), combo, products, fg_code: fgCode });
  }
  return { mapperRows, productCount };
}

function parseCombo(ws: XLSX.WorkSheet): { comboRows: ComboInputRow[]; qtyColumns: string[] } {
  // Read the ACTUAL header row (row 0) — NOT Object.keys of the first data row. The object form only
  // carries keys for cells that are populated in that specific row, so a sparse first row (e.g. one
  // where only the "Amazon" column has a value) would silently drop every other quantity column.
  const grid = XLSX.utils.sheet_to_json<any>(ws, { header: 1, blankrows: false });
  if (grid.length < 2) return { comboRows: [], qtyColumns: [] };
  const headers = (grid[0] as any[]).map((h) => String(h ?? "").trim());
  // Detect SKU column: Master SKU, SKU, FG Code, New FG Code — fallback to first column
  let skuIdx = headers.findIndex((h) => h.toLowerCase().includes("master") || h.toLowerCase().includes("sku"));
  if (skuIdx < 0) skuIdx = headers.findIndex((h) => { const l = h.toLowerCase(); return l.includes("fg") && (l.includes("code") || l === "fg"); });
  if (skuIdx < 0) skuIdx = 0;
  const qtyCols = headers.map((h, i) => ({ h, i })).filter(({ h, i }) => i !== skuIdx && h !== "");
  const qtyColumns = qtyCols.map(({ h }) => h);
  const comboRows: ComboInputRow[] = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r] as any[];
    const sku = String(row?.[skuIdx] ?? "").trim();
    if (!sku) continue;
    const quantities: Record<string, number> = {};
    for (const { h, i } of qtyCols) {
      const val = Number(String(row?.[i] ?? "").replace(/[, ]/g, ""));
      quantities[h] = isNaN(val) ? 0 : val;
    }
    comboRows.push({ master_sku: sku, quantities });
  }
  return { comboRows, qtyColumns };
}

// ========== CONVERSION ENGINE ==========

function runConversion(comboRows: ComboInputRow[], mapperRows: MapperRow[], qtyColumns: string[], productCount: number): ConversionResult {
  const warnings: string[] = [];
  const mapperDict = new Map<string, MapperRow>();
  for (const m of mapperRows) mapperDict.set(m.master_sku, m);

  // Consolidated
  const consolidated: ConsolidatedRow[] = comboRows.map((row) => {
    const mapper = mapperDict.get(row.master_sku);
    if (!mapper) {
      warnings.push(`SKU "${row.master_sku}" not found in mapper`);
      return { master_sku: row.master_sku, quantities: { ...row.quantities }, mapper_status: "NOT IN MAPPER" as const, combo: "", products: Array(productCount).fill("") };
    }
    return { master_sku: row.master_sku, quantities: { ...row.quantities }, mapper_status: "Found" as const, combo: mapper.combo, products: [...mapper.products] };
  });

  // Identify combos
  const comboSkus = new Set<string>();
  const notInMapper = new Set<string>();
  for (const row of consolidated) {
    if (row.mapper_status === "NOT IN MAPPER") { notInMapper.add(row.master_sku); continue; }
    const isFlag = ["yes", "y", "1", "true"].includes(row.combo.toLowerCase());
    const hasP = row.products.some((p) => p.length > 0);
    if (isFlag || hasP) comboSkus.add(row.master_sku);
  }

  // All unique SKUs
  const allSkus = new Set<string>();
  for (const row of consolidated) { allSkus.add(row.master_sku); row.products.forEach((p) => { if (p) allSkus.add(p); }); }

  // Build singles.
  // A SKU missing from the mapper is still a real single: it keeps its direct input qty AND any qty
  // contributed by combos that expand into it. Missing from the mapper is a labelling problem, never
  // a reason to drop units — flag it as NOT IN MAPPER but always count it.
  const singles: SinglesRow[] = [];
  for (const sku of [...allSkus].sort()) {
    if (comboSkus.has(sku)) continue; // combos expand into their components — never emitted as a single
    const quantities: Record<string, number> = {};
    for (const col of qtyColumns) {
      let total = consolidated.filter((r) => r.master_sku === sku).reduce((s, r) => s + (r.quantities[col] || 0), 0);
      for (const row of consolidated) { for (const p of row.products) { if (p === sku) total += row.quantities[col] || 0; } }
      quantities[col] = total;
    }
    if (Object.values(quantities).some((v) => v > 0))
      singles.push({ master_sku: sku, quantities, status: notInMapper.has(sku) ? "NOT IN MAPPER" : "Converted" });
  }
  return { consolidated, singles, qtyColumns, productCount, warnings };
}

// ========== NTO CONVERSION (MRP-RATIO SPLIT) ==========
// Splits a combo's NTO into component NTOs using the MRP ratio of components.
// contribution_i = MRP(c_i) * qty_i_in_combo  |  NTO_i = NTO_combo * contribution_i / sum(contributions)
// Singles pass through unchanged. Combos with ANY component missing MRP are BLOCKED and flagged CRITICAL.

type NtoCriticalEntry = { type: "MISSING_MRP" | "NOT_IN_MAPPER" | "COMPONENT_NOT_IN_SKU_MASTER"; combo_sku: string; detail: string };
type NtoResult = {
  consolidated: ConsolidatedRow[]; // combo/input SKU with its input NTO values
  singles: SinglesRow[]; // singles after split — `quantities` here holds NTO values (same shape)
  ntoColumns: string[];
  productCount: number;
  warnings: string[];
  criticals: NtoCriticalEntry[];
};

function runNtoConversion(
  comboRows: ComboInputRow[],
  mapperRows: MapperRow[],
  ntoColumns: string[],
  productCount: number,
  skuMap: Map<string, SingleSku>
): NtoResult {
  const warnings: string[] = [];
  const criticals: NtoCriticalEntry[] = [];
  const mapperDict = new Map<string, MapperRow>();
  for (const m of mapperRows) mapperDict.set(m.master_sku, m);

  // Helper: count component qty inside a combo (products array can have duplicates for qty > 1)
  function componentCounts(products: string[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const p of products) {
      if (!p) continue;
      counts.set(p, (counts.get(p) || 0) + 1);
    }
    return counts;
  }

  // Consolidated — same shape as qty converter
  const consolidated: ConsolidatedRow[] = comboRows.map((row) => {
    const mapper = mapperDict.get(row.master_sku);
    if (!mapper) {
      warnings.push(`SKU "${row.master_sku}" not found in mapper`);
      criticals.push({ type: "NOT_IN_MAPPER", combo_sku: row.master_sku, detail: "Not in mapper — NTO passed through as-is." });
      return { master_sku: row.master_sku, quantities: { ...row.quantities }, mapper_status: "NOT IN MAPPER" as const, combo: "", products: Array(productCount).fill("") };
    }
    return { master_sku: row.master_sku, quantities: { ...row.quantities }, mapper_status: "Found" as const, combo: mapper.combo, products: [...mapper.products] };
  });

  // Accumulator: component_sku -> { col -> NTO }
  const singleNto = new Map<string, Record<string, number>>();
  const singleStatus = new Map<string, "Converted" | "NOT IN MAPPER">();

  function addNto(sku: string, col: string, val: number, status: "Converted" | "NOT IN MAPPER") {
    if (!singleNto.has(sku)) singleNto.set(sku, {});
    const rec = singleNto.get(sku)!;
    rec[col] = (rec[col] || 0) + val;
    // Mark as NOT IN MAPPER only if we've never seen it as Converted
    if (!singleStatus.has(sku) || singleStatus.get(sku) === "NOT IN MAPPER") singleStatus.set(sku, status);
  }

  for (const row of consolidated) {
    const isFlag = ["yes", "y", "1", "true"].includes(row.combo.toLowerCase());
    const hasP = row.products.some((p) => p.length > 0);
    const isCombo = row.mapper_status === "Found" && (isFlag || hasP);

    if (row.mapper_status === "NOT IN MAPPER") {
      // Pass-through: treat input SKU as its own single
      for (const col of ntoColumns) addNto(row.master_sku, col, row.quantities[col] || 0, "NOT IN MAPPER");
      continue;
    }

    if (!isCombo) {
      // Single — pass NTO through unchanged
      for (const col of ntoColumns) addNto(row.master_sku, col, row.quantities[col] || 0, "Converted");
      continue;
    }

    // Combo — split NTO by MRP ratio
    const counts = componentCounts(row.products);
    // Check every component has a valid MRP > 0
    let missing: string[] = [];
    let contributions: Array<{ sku: string; weight: number; qty: number }> = [];
    let totalWeight = 0;
    for (const [sku, qty] of counts.entries()) {
      const single = skuMap.get(sku.toLowerCase());
      if (!single) {
        missing.push(`${sku} (not in SKU Master)`);
        continue;
      }
      if (single.mrp === null || single.mrp === undefined || single.mrp <= 0) {
        missing.push(`${sku} (MRP missing)`);
        continue;
      }
      const weight = single.mrp * qty;
      contributions.push({ sku, weight, qty });
      totalWeight += weight;
    }

    if (missing.length > 0) {
      criticals.push({
        type: "MISSING_MRP",
        combo_sku: row.master_sku,
        detail: `Cannot split NTO — missing MRP/component data: ${missing.join("; ")}`,
      });
      // Do NOT split — drop the combo's NTO (preserve consolidated row for audit).
      continue;
    }
    if (totalWeight <= 0) {
      criticals.push({ type: "MISSING_MRP", combo_sku: row.master_sku, detail: "Total MRP weight is zero." });
      continue;
    }

    for (const col of ntoColumns) {
      const comboNto = row.quantities[col] || 0;
      if (comboNto === 0) continue;
      for (const c of contributions) {
        const share = (comboNto * c.weight) / totalWeight;
        addNto(c.sku, col, share, "Converted");
      }
    }
  }

  const singles: SinglesRow[] = [...singleNto.entries()].map(([sku, nto]) => {
    // Round each value to 2dp
    const rounded: Record<string, number> = {};
    for (const col of ntoColumns) rounded[col] = Math.round((nto[col] || 0) * 100) / 100;
    return { master_sku: sku, quantities: rounded, status: singleStatus.get(sku) || "Converted" };
  }).filter((r) => Object.values(r.quantities).some((v) => v !== 0))
    .sort((a, b) => a.master_sku.localeCompare(b.master_sku));

  return { consolidated, singles, ntoColumns, productCount, warnings, criticals };
}

// ========== MULTI-PLATFORM (NTO + QTY) CONVERSION ==========
// Input: SKU, Channel, then paired columns like "Mar 2026 Qty" + "Mar 2026 NTO".
// Month keys are derived by stripping trailing " Qty" / " NTO" (case-insensitive).
// For combos: qty expands by component count; NTO splits by MRP ratio. Each row preserves its Channel.

type MultiInputRow = { master_sku: string; channel: string; qty: Record<string, number>; nto: Record<string, number> };
type MultiSingleRow = { master_sku: string; channel: string; qty: Record<string, number>; nto: Record<string, number>; status: "Converted" | "NOT IN MAPPER" };
type MultiResult = {
  input: MultiInputRow[];
  singles: MultiSingleRow[];
  months: string[];
  warnings: string[];
  criticals: NtoCriticalEntry[];
};

// Parse a single sheet (Qty OR NTO) into rows of {sku, channel, values[month]}.
// Month columns are every column that isn't SKU / Channel.
type SingleSheetRow = { master_sku: string; channel: string; values: Record<string, number> };
function parseSingleValueSheet(ws: XLSX.WorkSheet): { rows: SingleSheetRow[]; months: string[] } {
  // Read the real header row — see parseCombo: Object.keys of a sparse first data row would drop columns.
  const grid = XLSX.utils.sheet_to_json<any>(ws, { header: 1, blankrows: false });
  if (grid.length < 2) return { rows: [], months: [] };
  const headers = (grid[0] as any[]).map((h) => String(h ?? ""));
  let skuIdx = headers.findIndex((h) => /master.*sku/i.test(h) || /^sku$/i.test(h));
  if (skuIdx < 0) skuIdx = headers.findIndex((h) => /fg\s*code/i.test(h) || /^fg$/i.test(h));
  if (skuIdx < 0) skuIdx = 0;
  let channelIdx = headers.findIndex((h) => /channel/i.test(h));
  if (channelIdx < 0) channelIdx = skuIdx === 1 ? 0 : 1;
  const monthCols = headers.map((h, i) => ({ name: String(h).trim(), i }))
    .filter(({ name, i }) => i !== skuIdx && i !== channelIdx && name !== "");
  const months = monthCols.map((m) => m.name);

  const rows: SingleSheetRow[] = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r] as any[];
    const sku = String(row?.[skuIdx] ?? "").trim();
    if (!sku) continue;
    const channel = String(row?.[channelIdx] ?? "").trim();
    const values: Record<string, number> = {};
    for (const m of monthCols) {
      values[m.name] = Number(String(row?.[m.i] ?? "").replace(/[, ]/g, "")) || 0;
    }
    rows.push({ master_sku: sku, channel, values });
  }
  return { rows, months };
}

// Parse Qty + NTO sheets separately and merge, validating structure.
// Throws with a descriptive error if sheets don't match.
function parseMultiInput(qtyWs: XLSX.WorkSheet, ntoWs: XLSX.WorkSheet): { rows: MultiInputRow[]; months: string[] } {
  const qty = parseSingleValueSheet(qtyWs);
  const nto = parseSingleValueSheet(ntoWs);

  // Validation 1: both sheets must have data
  if (qty.rows.length === 0) throw new Error("Quantity sheet is empty.");
  if (nto.rows.length === 0) throw new Error("NTO sheet is empty.");

  // Validation 2: same month columns (same count + same names in same order)
  if (qty.months.length !== nto.months.length) {
    throw new Error(`Month columns differ: Quantity sheet has ${qty.months.length} months, NTO sheet has ${nto.months.length}.`);
  }
  for (let i = 0; i < qty.months.length; i++) {
    if (qty.months[i] !== nto.months[i]) {
      throw new Error(`Month column mismatch at position ${i + 1}: Quantity="${qty.months[i]}" vs NTO="${nto.months[i]}".`);
    }
  }

  // Validation 3: same number of rows
  if (qty.rows.length !== nto.rows.length) {
    throw new Error(`Row count mismatch: Quantity has ${qty.rows.length} rows, NTO has ${nto.rows.length} rows.`);
  }

  // Validation 4: same (SKU, Channel) pairs — order-independent
  const qtyKeys = new Set(qty.rows.map((r) => `${r.master_sku}||${r.channel}`));
  const ntoKeys = new Set(nto.rows.map((r) => `${r.master_sku}||${r.channel}`));
  const missingInNto: string[] = [];
  const missingInQty: string[] = [];
  for (const k of qtyKeys) if (!ntoKeys.has(k)) missingInNto.push(k);
  for (const k of ntoKeys) if (!qtyKeys.has(k)) missingInQty.push(k);
  if (missingInNto.length > 0 || missingInQty.length > 0) {
    const parts: string[] = [];
    if (missingInNto.length > 0) parts.push(`Missing in NTO sheet: ${missingInNto.slice(0, 5).join("; ")}${missingInNto.length > 5 ? ` (+${missingInNto.length - 5} more)` : ""}`);
    if (missingInQty.length > 0) parts.push(`Missing in Quantity sheet: ${missingInQty.slice(0, 5).join("; ")}${missingInQty.length > 5 ? ` (+${missingInQty.length - 5} more)` : ""}`);
    throw new Error(`Master SKU / Channel rows don't match between sheets.\n${parts.join("\n")}`);
  }

  // Validation 5: no duplicate (SKU, Channel) within either sheet
  if (qtyKeys.size !== qty.rows.length) {
    throw new Error(`Quantity sheet has duplicate Master SKU + Channel rows. Each combination must appear exactly once.`);
  }
  if (ntoKeys.size !== nto.rows.length) {
    throw new Error(`NTO sheet has duplicate Master SKU + Channel rows. Each combination must appear exactly once.`);
  }

  // Merge — use Qty's row order, look up NTO by key
  const ntoLookup = new Map<string, SingleSheetRow>();
  for (const r of nto.rows) ntoLookup.set(`${r.master_sku}||${r.channel}`, r);

  const merged: MultiInputRow[] = qty.rows.map((q) => {
    const n = ntoLookup.get(`${q.master_sku}||${q.channel}`)!;
    return { master_sku: q.master_sku, channel: q.channel, qty: q.values, nto: n.values };
  });
  return { rows: merged, months: qty.months };
}

function runMultiConversion(
  input: MultiInputRow[],
  mapperRows: MapperRow[],
  months: string[],
  skuMap: Map<string, SingleSku>
): MultiResult {
  const warnings: string[] = [];
  const criticals: NtoCriticalEntry[] = [];
  const mapperDict = new Map<string, MapperRow>();
  for (const m of mapperRows) mapperDict.set(m.master_sku, m);

  function componentCounts(products: string[]): Map<string, number> {
    const c = new Map<string, number>();
    for (const p of products) { if (p) c.set(p, (c.get(p) || 0) + 1); }
    return c;
  }

  // key = `${sku}||${channel}`
  const agg = new Map<string, MultiSingleRow>();

  function addTo(sku: string, channel: string, month: string, qtyVal: number, ntoVal: number, status: "Converted" | "NOT IN MAPPER") {
    const key = `${sku}||${channel}`;
    let row = agg.get(key);
    if (!row) {
      row = { master_sku: sku, channel, qty: {}, nto: {}, status };
      for (const m of months) { row.qty[m] = 0; row.nto[m] = 0; }
      agg.set(key, row);
    }
    row.qty[month] = (row.qty[month] || 0) + qtyVal;
    row.nto[month] = (row.nto[month] || 0) + ntoVal;
    if (row.status === "Converted" && status === "NOT IN MAPPER") row.status = "NOT IN MAPPER";
  }

  for (const row of input) {
    const mapper = mapperDict.get(row.master_sku);
    if (!mapper) {
      warnings.push(`SKU "${row.master_sku}" not found in mapper (channel: ${row.channel})`);
      criticals.push({ type: "NOT_IN_MAPPER", combo_sku: row.master_sku, detail: `Channel: ${row.channel} — passed through as-is.` });
      for (const m of months) addTo(row.master_sku, row.channel, m, row.qty[m] || 0, row.nto[m] || 0, "NOT IN MAPPER");
      continue;
    }
    const isFlag = ["yes", "y", "1", "true"].includes(mapper.combo.toLowerCase());
    const hasP = mapper.products.some((p) => p.length > 0);
    const isCombo = isFlag || hasP;

    if (!isCombo) {
      // Single — pass through
      for (const m of months) addTo(row.master_sku, row.channel, m, row.qty[m] || 0, row.nto[m] || 0, "Converted");
      continue;
    }

    // Combo — qty expands, NTO splits by MRP ratio
    const counts = componentCounts(mapper.products);
    const contributions: Array<{ sku: string; weight: number; qty: number }> = [];
    const missing: string[] = [];
    let totalWeight = 0;
    for (const [sku, qty] of counts.entries()) {
      const single = skuMap.get(sku.toLowerCase());
      if (!single) { missing.push(`${sku} (not in SKU Master)`); continue; }
      if (single.mrp === null || single.mrp === undefined || single.mrp <= 0) { missing.push(`${sku} (MRP missing)`); continue; }
      const weight = single.mrp * qty;
      contributions.push({ sku, weight, qty });
      totalWeight += weight;
    }
    if (missing.length > 0 || totalWeight <= 0) {
      criticals.push({
        type: "MISSING_MRP",
        combo_sku: row.master_sku,
        detail: `Channel: ${row.channel} — cannot split NTO (${missing.join("; ") || "zero total weight"}). Qty still expanded.`,
      });
      // Expand qty only — skip NTO (drop to zero)
      for (const [compSku, q] of counts.entries()) {
        for (const m of months) {
          const qtyVal = (row.qty[m] || 0) * q;
          addTo(compSku, row.channel, m, qtyVal, 0, "Converted");
        }
      }
      continue;
    }

    for (const [compSku, q] of counts.entries()) {
      for (const m of months) {
        const qtyVal = (row.qty[m] || 0) * q;
        const contribution = (skuMap.get(compSku.toLowerCase())!.mrp! * q);
        const ntoShare = (row.nto[m] || 0) * contribution / totalWeight;
        addTo(compSku, row.channel, m, qtyVal, ntoShare, "Converted");
      }
    }
  }

  const singles: MultiSingleRow[] = [...agg.values()]
    .map((r) => {
      const qty: Record<string, number> = {};
      const nto: Record<string, number> = {};
      for (const m of months) {
        qty[m] = Math.round((r.qty[m] || 0) * 100) / 100;
        nto[m] = Math.round((r.nto[m] || 0) * 100) / 100;
      }
      return { ...r, qty, nto };
    })
    .filter((r) => months.some((m) => r.qty[m] !== 0 || r.nto[m] !== 0))
    .sort((a, b) => a.master_sku.localeCompare(b.master_sku) || a.channel.localeCompare(b.channel));

  return { input, singles, months, warnings, criticals };
}

// ========== EXCEL OUTPUT ==========

function buildOutputExcel(result: ConversionResult, mapperRows: MapperRow[], skuMap?: Map<string, SingleSku>): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();

  // Build combo FG code lookup from mapper (combo_mapper_rows.fg_code)
  const comboFgMap = new Map<string, string>();
  for (const m of mapperRows) {
    if (m.combo === "Yes" && m.fg_code) {
      comboFgMap.set(m.master_sku.toLowerCase(), m.fg_code);
    }
  }

  // Diagnostics collector
  const diagnostics: Array<{ type: string; master_sku: string; context: string; details: string }> = [];

  // 1. Consolidated (existing — unchanged)
  const consData = result.consolidated.map((r) => {
    const row: any = { "Master SKU": r.master_sku };
    for (const col of result.qtyColumns) row[col] = r.quantities[col] || 0;
    row["Mapper_Status"] = r.mapper_status; row["Combo"] = r.combo;
    r.products.forEach((p, i) => { if (p) row[`P${i + 1}`] = p; });
    return row;
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(consData), "Consolidated");

  // 2. Singles (existing — adds diagnostics for missing FG codes)
  const singData = result.singles.map((r) => {
    const sku = skuMap?.get(r.master_sku.toLowerCase());
    const fgCode = sku?.new_fg_code || "";
    if (r.status === "Converted" && !fgCode) {
      diagnostics.push({
        type: "MISSING FG CODE",
        master_sku: r.master_sku,
        context: "Singles sheet",
        details: "No new_fg_code in sku_master",
      });
    }
    const row: any = { "Master SKU": r.master_sku, "FG Code": fgCode, "Product Name": sku?.product_name || "", "Status": r.status };
    for (const col of result.qtyColumns) row[col] = Math.round((r.quantities[col] || 0) * 100) / 100;
    return row;
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(singData), "Singles");

  // 3. NEW: Consolidated_FG_Codes — mirrors Consolidated but with FG codes
  // For combos: own FG from combo_mapper_rows, components (P1..Pn) as FG codes from sku_master
  // For singles: own FG from sku_master, no P1..Pn
  const consFgData = result.consolidated.map((r) => {
    const isCombo = r.combo === "Yes";
    let ownFgCode = "";
    if (isCombo) {
      ownFgCode = comboFgMap.get(r.master_sku.toLowerCase()) || "";
      if (!ownFgCode && r.mapper_status === "Found") {
        diagnostics.push({
          type: "MISSING FG CODE",
          master_sku: r.master_sku,
          context: "Combo (Consolidated_FG_Codes)",
          details: "No fg_code in combo_mapper_rows",
        });
      }
    } else if (r.mapper_status === "Found") {
      const sku = skuMap?.get(r.master_sku.toLowerCase());
      ownFgCode = sku?.new_fg_code || "";
      if (!ownFgCode) {
        diagnostics.push({
          type: "MISSING FG CODE",
          master_sku: r.master_sku,
          context: "Single (Consolidated_FG_Codes)",
          details: "No new_fg_code in sku_master",
        });
      }
    }
    const row: any = { "Master SKU": r.master_sku };
    for (const col of result.qtyColumns) row[col] = r.quantities[col] || 0;
    row["Combo"] = r.combo;
    row["FG Code"] = ownFgCode;
    if (isCombo) {
      r.products.forEach((p, i) => {
        if (p) {
          const sku = skuMap?.get(p.toLowerCase());
          const fg = sku?.new_fg_code || "";
          row[`P${i + 1}`] = fg;
          if (!fg) {
            diagnostics.push({
              type: "MISSING FG CODE",
              master_sku: p,
              context: `Component of ${r.master_sku}`,
              details: "No new_fg_code in sku_master",
            });
          }
        }
      });
    }
    return row;
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(consFgData), "Consolidated_FG_Codes");

  // 4. NEW: Diagnostics — all issues in one place
  result.consolidated.filter((r) => r.mapper_status === "NOT IN MAPPER").forEach((r) => {
    diagnostics.push({
      type: "NOT IN MAPPER",
      master_sku: r.master_sku,
      context: "Consolidated",
      details: "SKU not found in mapper",
    });
  });
  // Data inconsistencies in the mapper itself
  for (const m of mapperRows) {
    const hasProducts = m.products.some((p) => p && p.length > 0);
    if (m.combo === "No" && hasProducts) {
      diagnostics.push({
        type: "DATA INCONSISTENCY",
        master_sku: m.master_sku,
        context: "Mapper",
        details: `Combo=No but has ${m.products.filter((p) => p).length} component(s). Edit in Mapper Row Editor.`,
      });
    } else if (m.combo === "Yes" && !hasProducts) {
      diagnostics.push({
        type: "CRITICAL",
        master_sku: m.master_sku,
        context: "Mapper",
        details: "Combo=Yes but NO components listed. Combo cannot expand — data may be missing. Admin must resolve immediately in Mapper Row Editor.",
      });
    }
  }
  result.warnings.forEach((w) => {
    diagnostics.push({
      type: "WARNING",
      master_sku: "",
      context: "Conversion",
      details: w,
    });
  });
  // De-duplicate
  const seen = new Set<string>();
  const dedupedDiag = diagnostics.filter((d) => {
    const key = `${d.type}|${d.master_sku}|${d.details}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Sort by severity: CRITICAL first, then DATA INCONSISTENCY, then NOT IN MAPPER, then others
  const severityRank: Record<string, number> = { "CRITICAL": 0, "DATA INCONSISTENCY": 1, "NOT IN MAPPER": 2, "WARNING": 3 };
  dedupedDiag.sort((a, b) => (severityRank[a.type] ?? 99) - (severityRank[b.type] ?? 99));
  const diagData = dedupedDiag.length > 0
    ? dedupedDiag.map((d) => ({ "Type": d.type, "Master SKU": d.master_sku, "Context": d.context, "Details": d.details }))
    : [{ "Type": "OK", "Master SKU": "", "Context": "", "Details": "No issues found" }];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(diagData), "Diagnostics");

  // 5. Mapper_Used (existing — unchanged)
  const mapData = mapperRows.map((m) => {
    const row: any = { "Master_SKU": m.master_sku, "Combo": m.combo };
    m.products.forEach((p, i) => { if (p) row[`P${i + 1}`] = p; });
    return row;
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(mapData), "Mapper_Used");

  return wb;
}

// ========== NTO EXCEL OUTPUT ==========

function buildNtoOutputExcel(result: NtoResult, mapperRows: MapperRow[], skuMap: Map<string, SingleSku>): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();

  // 1. Singles_NTO — final output: each single SKU with NTO per month
  const singlesData = result.singles.map((r) => {
    const row: any = { "Master SKU": r.master_sku };
    const single = skuMap.get(r.master_sku.toLowerCase());
    row["FG Code"] = single?.new_fg_code || "";
    row["Product Name"] = single?.product_name || "";
    row["MRP"] = single?.mrp ?? "";
    for (const col of result.ntoColumns) row[col] = r.quantities[col] || 0;
    row["Status"] = r.status;
    return row;
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(singlesData), "Singles_NTO");

  // 2. Consolidated_Input — the raw combo input with NTO pre-split
  const consData = result.consolidated.map((r) => {
    const row: any = { "Master SKU": r.master_sku, "Mapper Status": r.mapper_status, "Combo": r.combo };
    for (const col of result.ntoColumns) row[col] = r.quantities[col] || 0;
    r.products.forEach((p, i) => { if (p) row[`P${i + 1}`] = p; });
    return row;
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(consData), "Consolidated_Input");

  // 3. Diagnostics — CRITICAL first (blocked combos), then warnings
  const diag: Array<{ Type: string; "Combo SKU": string; Details: string }> = [];
  for (const c of result.criticals) {
    const typeLabel = c.type === "MISSING_MRP" ? "CRITICAL" : c.type === "NOT_IN_MAPPER" ? "NOT IN MAPPER" : "WARNING";
    diag.push({ Type: typeLabel, "Combo SKU": c.combo_sku, Details: c.detail });
  }
  for (const w of result.warnings) diag.push({ Type: "WARNING", "Combo SKU": "", Details: w });
  const seen = new Set<string>();
  const deduped = diag.filter((d) => {
    const k = `${d.Type}|${d["Combo SKU"]}|${d.Details}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const rank: Record<string, number> = { CRITICAL: 0, "NOT IN MAPPER": 1, WARNING: 2 };
  deduped.sort((a, b) => (rank[a.Type] ?? 99) - (rank[b.Type] ?? 99));
  const diagSheet = deduped.length > 0 ? deduped : [{ Type: "OK", "Combo SKU": "", Details: "No issues — all combos split successfully." }];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(diagSheet), "Diagnostics");

  // 4. Mapper_Used
  const mapData = mapperRows.map((m) => {
    const row: any = { "Master_SKU": m.master_sku, "Combo": m.combo };
    m.products.forEach((p, i) => { if (p) row[`P${i + 1}`] = p; });
    return row;
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(mapData), "Mapper_Used");

  return wb;
}

// ========== MULTI-PLATFORM EXCEL OUTPUT ==========

function buildMultiOutputExcel(result: MultiResult, mapperRows: MapperRow[], skuMap: Map<string, SingleSku>): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();

  // 1. Singles_Multi — per SKU per Channel.
  // Layout: identifiers | all Qty columns | all NTO columns | Status
  const singlesData = result.singles.map((r) => {
    const row: any = { "Master SKU": r.master_sku, "Channel": r.channel };
    const single = skuMap.get(r.master_sku.toLowerCase());
    row["FG Code"] = single?.new_fg_code || "";
    row["MRP"] = single?.mrp ?? "";
    for (const m of result.months) row[`${m} Qty`] = r.qty[m] || 0;
    for (const m of result.months) row[`${m} NTO`] = r.nto[m] || 0;
    row["Status"] = r.status;
    return row;
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(singlesData), "Singles_Multi");

  // 2. Input_Snapshot — the raw input rows (same grouping)
  const inputData = result.input.map((r) => {
    const row: any = { "Master SKU": r.master_sku, "Channel": r.channel };
    for (const m of result.months) row[`${m} Qty`] = r.qty[m] || 0;
    for (const m of result.months) row[`${m} NTO`] = r.nto[m] || 0;
    return row;
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(inputData), "Input_Snapshot");

  // 3. Diagnostics
  const diag: Array<{ Type: string; "Combo SKU": string; Details: string }> = [];
  for (const c of result.criticals) {
    const typeLabel = c.type === "MISSING_MRP" ? "CRITICAL" : c.type === "NOT_IN_MAPPER" ? "NOT IN MAPPER" : "WARNING";
    diag.push({ Type: typeLabel, "Combo SKU": c.combo_sku, Details: c.detail });
  }
  for (const w of result.warnings) diag.push({ Type: "WARNING", "Combo SKU": "", Details: w });
  const seen = new Set<string>();
  const deduped = diag.filter((d) => {
    const k = `${d.Type}|${d["Combo SKU"]}|${d.Details}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const rank: Record<string, number> = { CRITICAL: 0, "NOT IN MAPPER": 1, WARNING: 2 };
  deduped.sort((a, b) => (rank[a.Type] ?? 99) - (rank[b.Type] ?? 99));
  const diagSheet = deduped.length > 0 ? deduped : [{ Type: "OK", "Combo SKU": "", Details: "No issues." }];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(diagSheet), "Diagnostics");

  // 4. Mapper_Used
  const mapData = mapperRows.map((m) => {
    const row: any = { "Master_SKU": m.master_sku, "Combo": m.combo };
    m.products.forEach((p, i) => { if (p) row[`P${i + 1}`] = p; });
    return row;
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(mapData), "Mapper_Used");

  return wb;
}

// ========== DAILY PENDING-QTY CONVERTER ==========
// Purpose: one-click daily flow. Input file is keyed by FG Code with a Product Name and a single
// order-qty column (e.g. "FG code" | "Product Name" | "Sum of Order Qty"). We resolve each FG Code to
// its Master SKU, expand combos into their component singles, and emit ONE flat sheet:
//   Master SKU | FG Code | Product Name | Qty | Remarks(Converted / Not in Mapper)
// FG Codes in the daily file carry a trailing letter that may differ from sku_master (e.g. "14048N"
// vs "14048G"). So matching is: exact FG first, then the numeric "base" (trailing letter(s) stripped).

type DailyInputRow = { fg_code: string; product_name: string; qty: number };
type DailyOutputRow = { master_sku: string; fg_code: string; product_name: string; qty: number; remark: "Converted" | "Not in Mapper" };
type DailyResult = { rows: DailyOutputRow[]; inputCount: number; convertedCount: number; notInMapperCount: number; comboExpandedCount: number };

// Strip a trailing alphabetic suffix only when a digit-bearing stem remains (so "14048N" -> "14048",
// but a purely-alpha code like "NPIaG" is left untouched to avoid collapsing to an empty base).
function fgBase(fg: string): string {
  const s = String(fg || "").trim();
  const m = s.match(/^(.*?)[a-zA-Z]+$/);
  if (m && /\d/.test(m[1]) && m[1].length > 0) return m[1].toLowerCase();
  return s.toLowerCase();
}

function parseDailyPending(ws: XLSX.WorkSheet): DailyInputRow[] {
  const json = XLSX.utils.sheet_to_json<any>(ws);
  if (json.length === 0) return [];
  const headers = Object.keys(json[0]);
  const fgCol = headers.find((h) => { const l = h.toLowerCase(); return l.includes("fg") && (l.includes("code") || l === "fg"); })
    || headers.find((h) => h.toLowerCase().includes("fg")) || headers[0];
  const nameCol = headers.find((h) => { const l = h.toLowerCase(); return l.includes("product") || l.includes("name") || l.includes("description"); }) || "";
  const qtyCol = headers.find((h) => { const l = h.toLowerCase(); return l.includes("qty") || l.includes("quantity") || l.includes("order"); })
    || headers.filter((h) => h !== fgCol && h !== nameCol).slice(-1)[0] || "";
  const rows: DailyInputRow[] = [];
  for (const r of json) {
    const fg = String(r[fgCol] ?? "").trim();
    if (!fg) continue;
    const qty = Number(String(r[qtyCol] ?? "").toString().replace(/[, ]/g, "")) || 0;
    rows.push({ fg_code: fg, product_name: nameCol ? String(r[nameCol] ?? "").trim() : "", qty });
  }
  return rows;
}

function runDailyConversion(input: DailyInputRow[], mapperRows: MapperRow[], skuMaster: SingleSku[]): DailyResult {
  // --- Lookups ---
  // FG (exact + base) -> single SKU from sku_master
  const fgExact = new Map<string, SingleSku>();
  const fgBaseMap = new Map<string, SingleSku>();
  const masterToSingle = new Map<string, SingleSku>();
  for (const s of skuMaster) {
    if (s.new_master_sku) masterToSingle.set(s.new_master_sku.toLowerCase(), s);
    const fg = s.new_fg_code;
    if (fg) {
      fgExact.set(fg.toLowerCase(), s);
      const b = fgBase(fg);
      if (b && !fgBaseMap.has(b)) fgBaseMap.set(b, s);
    }
  }
  // Master SKU -> mapper row, and combo FG (exact + base) -> mapper row
  const masterToMapper = new Map<string, MapperRow>();
  const comboFgExact = new Map<string, MapperRow>();
  const comboFgBase = new Map<string, MapperRow>();
  for (const m of mapperRows) {
    masterToMapper.set(m.master_sku.toLowerCase(), m);
    const isCombo = ["yes", "y", "1", "true"].includes(m.combo.toLowerCase()) || m.products.some((p) => p.length > 0);
    if (isCombo && m.fg_code) {
      comboFgExact.set(m.fg_code.toLowerCase(), m);
      const b = fgBase(m.fg_code);
      if (b && !comboFgBase.has(b)) comboFgBase.set(b, m);
    }
  }

  // --- Aggregation ---
  // Output rows accumulate qty by a stable key (resolved -> master SKU; unresolved -> the raw FG code).
  const agg = new Map<string, DailyOutputRow>();
  function add(key: string, master: string, fg: string, name: string, qty: number, remark: "Converted" | "Not in Mapper") {
    const existing = agg.get(key);
    if (existing) {
      existing.qty += qty;
      // "Not in Mapper" is the attention-worthy state — let it stick if any contribution was unmapped.
      if (remark === "Not in Mapper") existing.remark = "Not in Mapper";
      if (!existing.product_name && name) existing.product_name = name;
      if (!existing.fg_code && fg) existing.fg_code = fg;
    } else {
      agg.set(key, { master_sku: master, fg_code: fg, product_name: name, qty, remark });
    }
  }
  function nameFor(single: SingleSku | undefined, fallback: string): string {
    return single?.product_name || fallback || "";
  }

  let comboExpandedCount = 0;

  for (const row of input) {
    const l = row.fg_code.toLowerCase();
    const b = fgBase(row.fg_code);

    // 1) Combo FG? (a combo master lives in the mapper with its own fg_code)
    const comboMapper = comboFgExact.get(l) || comboFgBase.get(b);
    if (comboMapper) {
      comboExpandedCount++;
      for (const p of comboMapper.products) {
        if (!p) continue;
        const single = masterToSingle.get(p.toLowerCase());
        add(p.toLowerCase(), p, single?.new_fg_code || "", nameFor(single, ""), row.qty, "Converted");
      }
      continue;
    }

    // 2) Single FG -> master SKU (exact then base)
    const single = fgExact.get(l) || fgBaseMap.get(b);
    if (single) {
      const master = single.new_master_sku;
      const mapper = masterToMapper.get(master.toLowerCase());
      const inMapper = !!mapper;
      // If the resolved master IS a combo in the mapper, expand it.
      if (mapper) {
        const isCombo = ["yes", "y", "1", "true"].includes(mapper.combo.toLowerCase()) || mapper.products.some((p) => p.length > 0);
        if (isCombo) {
          comboExpandedCount++;
          for (const p of mapper.products) {
            if (!p) continue;
            const comp = masterToSingle.get(p.toLowerCase());
            add(p.toLowerCase(), p, comp?.new_fg_code || "", nameFor(comp, ""), row.qty, "Converted");
          }
          continue;
        }
      }
      add(master.toLowerCase(), master, single.new_fg_code, nameFor(single, row.product_name), row.qty, inMapper ? "Converted" : "Not in Mapper");
      continue;
    }

    // 3) Unresolved — not in sku_master nor mapper. Copy through as-is, flagged.
    add("fg::" + l, "", row.fg_code, row.product_name, row.qty, "Not in Mapper");
  }

  const rows = [...agg.values()]
    .map((r) => ({ ...r, qty: Math.round(r.qty * 100) / 100 }))
    .filter((r) => r.qty !== 0)
    // Not-in-Mapper first (needs attention), then by Master SKU / FG.
    .sort((a, b2) => {
      if (a.remark !== b2.remark) return a.remark === "Not in Mapper" ? -1 : 1;
      return (a.master_sku || a.fg_code).localeCompare(b2.master_sku || b2.fg_code);
    });

  return {
    rows,
    inputCount: input.length,
    convertedCount: rows.filter((r) => r.remark === "Converted").length,
    notInMapperCount: rows.filter((r) => r.remark === "Not in Mapper").length,
    comboExpandedCount,
  };
}

function buildDailyOutputExcel(result: DailyResult): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  const data = result.rows.map((r) => ({
    "Master SKU": r.master_sku,
    "FG Code": r.fg_code,
    "Product Name": r.product_name,
    "Qty": r.qty,
    "Remarks": r.remark,
  }));
  const ws = XLSX.utils.json_to_sheet(data.length > 0 ? data : [{ "Master SKU": "", "FG Code": "", "Product Name": "No rows", "Qty": 0, "Remarks": "" }]);
  ws["!cols"] = [{ wch: 22 }, { wch: 12 }, { wch: 60 }, { wch: 12 }, { wch: 16 }];
  XLSX.utils.book_append_sheet(wb, ws, "Singles");
  return wb;
}

// ========== COMPONENT ==========

type SingleSku = { new_master_sku: string; new_fg_code: string; product_name: string; mrp: number | null };

export default function ComboConverterPage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [skuMaster, setSkuMaster] = useState<SingleSku[]>([]);
  const [mapperSource, setMapperSource] = useState<"file" | "db">("file");
  // DB mappers
  const [mapperSets, setMapperSets] = useState<MapperSet[]>([]);
  const [selectedMapperSetId, setSelectedMapperSetId] = useState("");
  const [dbMapperRows, setDbMapperRows] = useState<MapperRow[]>([]);
  const [dbProductCount, setDbProductCount] = useState(0);
  const [loadingMapper, setLoadingMapper] = useState(false);
  // Mapper management
  const [showMapperManager, setShowMapperManager] = useState(false);
  const [newMapperName, setNewMapperName] = useState("");
  const [newMapperDesc, setNewMapperDesc] = useState("");
  const [uploadingMapper, setUploadingMapper] = useState(false);
  const [mapperMsg, setMapperMsg] = useState<string | null>(null);
  // Mode / View: qty-only (existing) | nto-only (MRP-ratio split) | nto + qty multi-platform
  const [mode, setMode] = useState<"qty" | "nto" | "multi" | "daily">("qty");
  // Input identifier: Master SKU or FG Code
  const [inputIdentifier, setInputIdentifier] = useState<"sku" | "fg">("sku");
  // Unresolved FG codes (FG mode only): fg_code -> { quantities, action user wants to take }
  type UnresolvedFg = { fg_code: string; quantities: Record<string, number>; action: "none" | "add_single" | "add_combo" | "update_existing"; targetMasterSku: string; comboComponents: string; submitting: boolean; submitted: boolean };
  const [unresolvedFgCodes, setUnresolvedFgCodes] = useState<UnresolvedFg[]>([]);
  // Conversion
  const [result, setResult] = useState<ConversionResult | null>(null);
  const [ntoResult, setNtoResult] = useState<NtoResult | null>(null);
  const [multiResult, setMultiResult] = useState<MultiResult | null>(null);
  const [dailyResult, setDailyResult] = useState<DailyResult | null>(null);
  const [allMapperRows, setAllMapperRows] = useState<MapperRow[]>([]);
  const [processing, setProcessing] = useState(false);
  // Inline edit for unmapped rows: key = master_sku, value = { combo, products }
  const [unmappedEdits, setUnmappedEdits] = useState<Map<string, { combo: string; products: string }>>(new Map());
  // Cache combo input for re-conversion
  const [cachedComboRows, setCachedComboRows] = useState<ComboInputRow[]>([]);
  const [cachedQtyColumns, setCachedQtyColumns] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"singles" | "consolidated">("singles");
  const [dragActive, setDragActive] = useState(false);
  // Suggestions
  const [pendingSuggestions, setPendingSuggestions] = useState<any[]>([]);
  const [showApprovals, setShowApprovals] = useState(false);
  const [submitMsg, setSubmitMsg] = useState<string | null>(null);
  // Row Editor (admin)
  type EditorRow = { id: string | null; master_sku: string; is_combo: boolean; products: string; fg_code: string; dirty: boolean; saving: boolean; isNew: boolean };
  const [rowEditorSetId, setRowEditorSetId] = useState<string | null>(null);
  const [editorRows, setEditorRows] = useState<EditorRow[]>([]);
  const [editorSearch, setEditorSearch] = useState("");
  const [editorIssuesOnly, setEditorIssuesOnly] = useState(false);
  const [editorLoading, setEditorLoading] = useState(false);
  const [editorMsg, setEditorMsg] = useState<string | null>(null);
  const [editorHistory, setEditorHistory] = useState<Array<{ ts: string; master_sku: string; action: string; details: string }>>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mapperFileRef = useRef<HTMLInputElement>(null);
  const supabase = createClient();

  // Log usage for analytics
  async function logUsage(conversionType: "qty" | "nto" | "multi" | "daily", skuCount: number) {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      await supabase.from("combo_usage_log").insert({
        user_id: user.id,
        user_email: user.email || "",
        user_name: profile?.full_name || profile?.email || user.email || "",
        conversion_type: conversionType,
        sku_count: skuCount,
      });
    } catch { /* silent — don't block UX for logging */ }
  }

  useEffect(() => { init(); }, []);

  async function init() {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data: profileData } = await supabase.from("profiles").select("*").eq("id", user.id).single();
    setProfile(profileData);
    // Non-admin defaults to DB mapper (no file upload option)
    if (profileData?.role !== "admin") setMapperSource("db");
    await loadMapperSets();
    await loadSkuMaster();
    // Admin: load pending suggestions
    if (profileData?.role === "admin") await loadSuggestions();
    setLoading(false);
  }

  async function loadMapperSets() {
    const { data } = await supabase.from("combo_mapper_sets").select("*").order("created_at", { ascending: false });
    if (data) {
      setMapperSets(data);
      const def = data.find((s: MapperSet) => s.is_default);
      if (def) setSelectedMapperSetId(def.id);
      else if (data.length > 0) setSelectedMapperSetId(data[0].id);
    }
  }

  async function loadSkuMaster() {
    let all: any[] = [];
    let from = 0;
    const PAGE = 1000;
    while (true) {
      const { data, error } = await supabase
        .from("sku_master")
        .select("new_master_sku, new_fg_code, product_name, mrp")
        .range(from, from + PAGE - 1);
      if (error || !data || data.length === 0) break;
      all = all.concat(data);
      if (data.length < PAGE) break;
      from += PAGE;
    }
    setSkuMaster(all.map((r: any) => ({
      new_master_sku: String(r.new_master_sku || "").trim(),
      new_fg_code: String(r.new_fg_code || "").trim(),
      product_name: String(r.product_name || "").trim(),
      mrp: r.mrp === null || r.mrp === undefined ? null : Number(r.mrp),
    })));
  }

  // Load mapper rows for selected set
  async function loadMapperData(setId: string) {
    if (!setId) return;
    setLoadingMapper(true);
    
    // Supabase returns max 1000 rows by default - paginate for large mappers
    let allData: any[] = [];
    let from = 0;
    const PAGE = 1000;
    while (true) {
      const { data, error } = await supabase
        .from("combo_mapper_rows")
        .select("master_sku, is_combo, products, fg_code")
        .eq("mapper_set_id", setId)
        .range(from, from + PAGE - 1);
      if (error || !data || data.length === 0) break;
      allData = allData.concat(data);
      if (data.length < PAGE) break;
      from += PAGE;
    }
    
    if (allData.length > 0) {
      const rows: MapperRow[] = allData.map((r: any) => ({
        master_sku: String(r.master_sku || "").trim(),
        combo: (r.is_combo === true || r.is_combo === "true") ? "Yes" : "No",
        products: Array.isArray(r.products) ? r.products.map((p: any) => String(p || "").trim()) : [],
        fg_code: String(r.fg_code || "").trim(),
      }));
      const maxP = rows.reduce((max, r) => Math.max(max, r.products.length), 0);
      setDbMapperRows(rows);
      setDbProductCount(maxP);
    } else {
      setDbMapperRows([]);
      setDbProductCount(0);
    }
    setLoadingMapper(false);
  }

  useEffect(() => { 
    if (selectedMapperSetId && mapperSource === "db") loadMapperData(selectedMapperSetId); 
  }, [selectedMapperSetId, mapperSource]);

  // ====== MAPPER MANAGEMENT (Admin) ======

  async function handleMapperUpload(file: File) {
    if (!newMapperName.trim()) { setMapperMsg("Please enter a name for this mapper."); return; }
    setUploadingMapper(true); setMapperMsg(null);
    try {
      const data = await file.arrayBuffer();
      const wb = XLSX.read(data, { type: "array" });
      const sheetName = wb.SheetNames.includes("Mapper") ? "Mapper" : wb.SheetNames[0];
      const { mapperRows, productCount } = parseMapper(wb.Sheets[sheetName]);
      if (mapperRows.length === 0) { setMapperMsg("No valid rows found in mapper file."); setUploadingMapper(false); return; }

      const { data: { user } } = await supabase.auth.getUser();

      // Create mapper set
      const { data: setData, error: setErr } = await supabase.from("combo_mapper_sets").insert({
        name: newMapperName.trim(),
        description: newMapperDesc.trim() || null,
        product_column_count: productCount,
        row_count: mapperRows.length,
        is_default: mapperSets.length === 0,
        uploaded_by: user?.id,
      }).select().single();

      if (setErr || !setData) { setMapperMsg(`Failed to create mapper set: ${setErr?.message}`); setUploadingMapper(false); return; }

      // Insert rows in batches
      const BATCH = 500;
      const rows = mapperRows.map((m) => ({
        mapper_set_id: setData.id,
        master_sku: m.master_sku,
        is_combo: ["yes", "y", "1", "true"].includes(m.combo.toLowerCase()),
        products: m.products.filter((p) => p.length > 0),
        fg_code: m.fg_code || null,
      }));

      for (let i = 0; i < rows.length; i += BATCH) {
        const { error: insErr } = await supabase.from("combo_mapper_rows").insert(rows.slice(i, i + BATCH));
        if (insErr) { setMapperMsg(`Row insert failed at batch ${Math.floor(i / BATCH)}: ${insErr.message}`); setUploadingMapper(false); return; }
      }

      // Auto-resolve nested combos
      const dbRows = rows.map(r => ({ master_sku: r.master_sku, is_combo: r.is_combo, products: r.products }));
      const resolvedCount = await resolveNestedInDb(setData.id, dbRows, true);

      await supabase.from("audit_log").insert({
        user_id: user?.id, user_email: user?.email, action: "mapper_upload",
        table_name: "combo_mapper_sets", record_id: setData.id,
        new_values: { name: newMapperName.trim(), rows: mapperRows.length, products: productCount },
      });

      setMapperMsg(`Mapper "${newMapperName.trim()}" uploaded: ${mapperRows.length} SKUs, P1-P${productCount}${resolvedCount > 0 ? `. Auto-resolved ${resolvedCount} nested combo(s).` : ""}`);
      setNewMapperName(""); setNewMapperDesc("");
      await loadMapperSets();
      setSelectedMapperSetId(setData.id);
    } catch (err: any) {
      setMapperMsg(`Error: ${err.message}`);
    }
    setUploadingMapper(false);
  }

  async function handleUpdateMapper(setId: string, file: File) {
    const ms = mapperSets.find((s) => s.id === setId);
    if (!ms) return;
    setUploadingMapper(true); setMapperMsg(null);
    try {
      const data = await file.arrayBuffer();
      const wb = XLSX.read(data, { type: "array" });
      const sheetName = wb.SheetNames.includes("Mapper") ? "Mapper" : wb.SheetNames[0];
      const { mapperRows, productCount } = parseMapper(wb.Sheets[sheetName]);
      if (mapperRows.length === 0) { setMapperMsg("No valid rows."); setUploadingMapper(false); return; }

      // Preserve fg_code and product_name from existing rows before deleting
      const { data: existingRows } = await supabase.from("combo_mapper_rows").select("master_sku, fg_code, product_name").eq("mapper_set_id", setId);
      const preservedData = new Map<string, { fg_code: string | null; product_name: string | null }>();
      for (const r of (existingRows || [])) {
        if (r.fg_code || r.product_name) preservedData.set(r.master_sku.toLowerCase(), { fg_code: r.fg_code, product_name: r.product_name });
      }

      // Delete old rows
      await supabase.from("combo_mapper_rows").delete().eq("mapper_set_id", setId);

      // Insert new — restore fg_code and product_name for SKUs that still exist
      const BATCH = 500;
      const rows = mapperRows.map((m) => {
        const preserved = preservedData.get(m.master_sku.toLowerCase());
        return {
          mapper_set_id: setId,
          master_sku: m.master_sku,
          is_combo: ["yes", "y", "1", "true"].includes(m.combo.toLowerCase()),
          products: m.products.filter((p) => p.length > 0),
          fg_code: m.fg_code || preserved?.fg_code || null,
          product_name: preserved?.product_name || null,
        };
      });
      for (let i = 0; i < rows.length; i += BATCH) {
        const { error: insErr } = await supabase.from("combo_mapper_rows").insert(rows.slice(i, i + BATCH));
        if (insErr) { setMapperMsg(`Insert failed: ${insErr.message}`); setUploadingMapper(false); return; }
      }

      // Auto-resolve nested combos
      const dbRows = rows.map(r => ({ master_sku: r.master_sku, is_combo: r.is_combo, products: r.products }));
      const resolvedCount = await resolveNestedInDb(setId, dbRows, true);

      await supabase.from("combo_mapper_sets").update({
        product_column_count: productCount, row_count: mapperRows.length, updated_at: new Date().toISOString(),
      }).eq("id", setId);

      setMapperMsg(`"${ms.name}" updated: ${mapperRows.length} SKUs, P1-P${productCount}${resolvedCount > 0 ? `. Auto-resolved ${resolvedCount} nested combo(s).` : ""}`);
      await loadMapperSets();
      if (selectedMapperSetId === setId) loadMapperData(setId);
    } catch (err: any) { setMapperMsg(`Error: ${err.message}`); }
    setUploadingMapper(false);
  }

  // ====== ROW EDITOR (Admin) ======

  function parseProductsStr(s: string): string[] {
    return s.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  }

  async function openRowEditor(setId: string) {
    setRowEditorSetId(setId);
    setEditorLoading(true);
    setEditorMsg(null);
    setEditorSearch("");
    setEditorIssuesOnly(false);
    const rows = await loadMapperSetRows(setId);
    const ed: EditorRow[] = rows.map((r) => ({
      id: null, // will use master_sku + setId as key for DB ops
      master_sku: r.master_sku,
      is_combo: r.is_combo,
      products: r.products.join(", "),
      fg_code: r.fg_code || "",
      dirty: false,
      saving: false,
      isNew: false,
    }));
    // Sort: CRITICAL first, then other issues, then alphabetical
    ed.sort((a, b) => {
      const aCrit = isCriticalRow(a) ? 0 : 1;
      const bCrit = isCriticalRow(b) ? 0 : 1;
      if (aCrit !== bCrit) return aCrit - bCrit;
      const aIssue = hasInconsistency(a) ? 0 : 1;
      const bIssue = hasInconsistency(b) ? 0 : 1;
      if (aIssue !== bIssue) return aIssue - bIssue;
      return a.master_sku.localeCompare(b.master_sku);
    });
    setEditorRows(ed);
    setEditorHistory([]);
    setEditorLoading(false);
  }

  function hasInconsistency(r: { is_combo: boolean; products: string }): boolean {
    const prods = parseProductsStr(r.products);
    if (!r.is_combo && prods.length > 0) return true; // has products but not marked combo
    if (r.is_combo && prods.length === 0) return true; // marked combo but no products
    return false;
  }

  // CRITICAL: Combo=Yes but no components — combo cannot expand; likely data loss.
  function isCriticalRow(r: { is_combo: boolean; products: string }): boolean {
    const prods = parseProductsStr(r.products);
    return r.is_combo && prods.length === 0;
  }

  function closeRowEditor() {
    // Check for unsaved dirty rows
    const dirty = editorRows.filter((r) => r.dirty).length;
    if (dirty > 0 && !confirm(`${dirty} row(s) have unsaved changes. Close anyway?`)) return;
    setRowEditorSetId(null);
    setEditorRows([]);
    setEditorMsg(null);
    setEditorHistory([]);
    // Refresh mapper data if this was the selected one
    if (selectedMapperSetId === rowEditorSetId) loadMapperData(selectedMapperSetId);
  }

  function updateEditorRow(index: number, field: keyof EditorRow, value: any) {
    setEditorRows((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value, dirty: true };
      return next;
    });
  }

  function addEditorRow() {
    setEditorRows((prev) => [
      { id: null, master_sku: "", is_combo: false, products: "", fg_code: "", dirty: true, saving: false, isNew: true },
      ...prev,
    ]);
  }

  async function saveEditorRow(index: number) {
    const row = editorRows[index];
    if (!row || !rowEditorSetId) return;
    const sku = row.master_sku.trim();
    if (!sku) {
      setEditorMsg("Master SKU is required.");
      return;
    }

    // Auto-correct SAFE direction only: products exist → force is_combo = true.
    // DANGEROUS direction (Combo=Yes + no products) is BLOCKED — must be resolved by admin manually.
    const prods = parseProductsStr(row.products);
    let correctedIsCombo = row.is_combo;
    let correction: string | null = null;
    if (prods.length > 0 && !row.is_combo) {
      correctedIsCombo = true;
      correction = `Combo: No → Yes (auto-correct: has ${prods.length} component(s))`;
    } else if (prods.length === 0 && row.is_combo) {
      // Do NOT silently flip to No — this could mask data loss (missing components).
      // Block the save and flag as CRITICAL. Admin must either add components or explicitly uncheck Combo.
      setEditorRows((prev) => {
        const next = [...prev];
        next[index] = { ...next[index], saving: false };
        return next;
      });
      setEditorMsg(`CRITICAL: "${sku}" is marked Combo=Yes but has no components. Add components, or explicitly uncheck Combo before saving.`);
      setTimeout(() => setEditorMsg(null), 8000);
      return;
    }

    setEditorRows((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], saving: true };
      return next;
    });

    const payload = {
      mapper_set_id: rowEditorSetId,
      master_sku: sku,
      is_combo: correctedIsCombo,
      products: prods,
      fg_code: row.fg_code.trim() || null,
    };

    const { data: { user } } = await supabase.auth.getUser();

    let opError: string | null = null;
    if (row.isNew) {
      // Check if SKU already exists
      const { data: existing } = await supabase
        .from("combo_mapper_rows")
        .select("id")
        .eq("mapper_set_id", rowEditorSetId)
        .eq("master_sku", sku)
        .limit(1);
      if (existing && existing.length > 0) {
        opError = `SKU "${sku}" already exists in this mapper.`;
      } else {
        const { error } = await supabase.from("combo_mapper_rows").insert(payload);
        if (error) opError = error.message;
      }
    } else {
      const { error } = await supabase
        .from("combo_mapper_rows")
        .update({ is_combo: payload.is_combo, products: payload.products, fg_code: payload.fg_code })
        .eq("mapper_set_id", rowEditorSetId)
        .eq("master_sku", sku);
      if (error) opError = error.message;
    }

    if (opError) {
      setEditorRows((prev) => {
        const next = [...prev];
        next[index] = { ...next[index], saving: false };
        return next;
      });
      setEditorMsg(`Save failed: ${opError}`);
      setTimeout(() => setEditorMsg(null), 4000);
      return;
    }

    // Audit log
    await supabase.from("audit_log").insert({
      user_id: user?.id,
      user_email: user?.email,
      action: row.isNew ? "mapper_row_insert" : "mapper_row_update",
      table_name: "combo_mapper_rows",
      record_id: null,
      new_values: { mapper_set_id: rowEditorSetId, master_sku: sku, is_combo: correctedIsCombo, products: prods, fg_code: payload.fg_code, auto_correction: correction },
    });

    // Update local state
    setEditorRows((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], is_combo: correctedIsCombo, products: prods.join(", "), dirty: false, saving: false, isNew: false };
      return next;
    });

    // History log
    const ts = new Date().toLocaleTimeString();
    const historyEntries: typeof editorHistory = [];
    historyEntries.push({ ts, master_sku: sku, action: row.isNew ? "Added" : "Updated", details: `Combo=${correctedIsCombo ? "Yes" : "No"}, ${prods.length} component(s)${payload.fg_code ? `, FG=${payload.fg_code}` : ""}` });
    if (correction) {
      historyEntries.push({ ts, master_sku: sku, action: "Auto-correct", details: correction });
    }
    setEditorHistory((prev) => [...historyEntries, ...prev].slice(0, 50));
  }

  async function deleteEditorRow(index: number) {
    const row = editorRows[index];
    if (!row || !rowEditorSetId) return;
    if (row.isNew) {
      // Just remove locally
      setEditorRows((prev) => prev.filter((_, i) => i !== index));
      return;
    }
    if (!confirm(`Delete "${row.master_sku}" from this mapper?`)) return;

    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase
      .from("combo_mapper_rows")
      .delete()
      .eq("mapper_set_id", rowEditorSetId)
      .eq("master_sku", row.master_sku);
    if (error) {
      setEditorMsg(`Delete failed: ${error.message}`);
      setTimeout(() => setEditorMsg(null), 4000);
      return;
    }
    await supabase.from("audit_log").insert({
      user_id: user?.id,
      user_email: user?.email,
      action: "mapper_row_delete",
      table_name: "combo_mapper_rows",
      record_id: null,
      new_values: { mapper_set_id: rowEditorSetId, master_sku: row.master_sku },
    });
    setEditorRows((prev) => prev.filter((_, i) => i !== index));
    setEditorHistory((prev) => [
      { ts: new Date().toLocaleTimeString(), master_sku: row.master_sku, action: "Deleted", details: "Removed from mapper" },
      ...prev,
    ].slice(0, 50));
  }

  async function deleteMapperSet(setId: string) {
    const ms = mapperSets.find((s) => s.id === setId);
    if (!ms || !confirm(`Delete mapper "${ms.name}"? This cannot be undone.`)) return;
    await supabase.from("combo_mapper_sets").delete().eq("id", setId);
    await loadMapperSets();
    if (selectedMapperSetId === setId) { setSelectedMapperSetId(""); setDbMapperRows([]); }
  }

  async function setDefaultMapper(setId: string) {
    await supabase.from("combo_mapper_sets").update({ is_default: false }).neq("id", setId);
    await supabase.from("combo_mapper_sets").update({ is_default: true }).eq("id", setId);
    await loadMapperSets();
  }

  // ====== CONVERSION ======

  function handleComboFile(file: File) {
    setError(null); setProcessing(true); setResult(null);
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = evt.target?.result;
        const wb = XLSX.read(data, { type: "binary" });
        const comboSheet = wb.SheetNames.includes("Combo") ? "Combo" : wb.SheetNames[0];
        const { comboRows, qtyColumns } = parseCombo(wb.Sheets[comboSheet]);
        if (comboRows.length === 0) { setError("No data found in Combo sheet."); setProcessing(false); return; }

        let mapperRows: MapperRow[] = [];
        let productCount = 0;

        if (mapperSource === "file") {
          if (wb.SheetNames.includes("Mapper")) {
            const parsed = parseMapper(wb.Sheets["Mapper"]);
            mapperRows = parsed.mapperRows; productCount = parsed.productCount;
          } else { setError('File has no "Mapper" sheet. Add one or switch to DB Mapper.'); setProcessing(false); return; }
        } else {
          if (dbMapperRows.length === 0) { setError("No mapper loaded. Select a mapper first."); setProcessing(false); return; }
          mapperRows = dbMapperRows; productCount = dbProductCount;
        }

        setAllMapperRows(mapperRows);
        // FG Code mode: resolve FG codes to Master SKUs before conversion
        let finalComboRows = comboRows;
        let fgResolutionWarnings: string[] = [];
        if (inputIdentifier === "fg") {
          const { resolved, fgWarnings, unresolved } = resolveFgCodes(comboRows);
          finalComboRows = resolved;
          fgResolutionWarnings = fgWarnings;
          setUnresolvedFgCodes(unresolved);
        } else {
          setUnresolvedFgCodes([]);
        }
        const convResult = runConversion(finalComboRows, mapperRows, qtyColumns, productCount);
        if (fgResolutionWarnings.length > 0) convResult.warnings.push(...fgResolutionWarnings);
        setResult(convResult);
        logUsage("qty", convResult.singles.length);
        setCachedComboRows(finalComboRows);
        setCachedQtyColumns(qtyColumns);
        // Init edits for unmapped rows
        const edits = new Map<string, { combo: string; products: string }>();
        convResult.consolidated.filter((r) => r.mapper_status === "NOT IN MAPPER").forEach((r) => {
          edits.set(r.master_sku, { combo: "No", products: "" });
        });
        setUnmappedEdits(edits);
        setActiveTab("singles");
      } catch (err: any) { setError(`Processing failed: ${err.message}`); }
      setProcessing(false);
    };
    reader.readAsBinaryString(file);
  }

  function downloadResult() {
    if (!result) return;
    XLSX.writeFile(buildOutputExcel(result, allMapperRows, skuLookup), "Combo_to_Singles_Output.xlsx");
  }

  // ====== NTO-ONLY CONVERSION ======

  function handleNtoFile(file: File) {
    setError(null); setProcessing(true); setNtoResult(null);
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = evt.target?.result;
        const wb = XLSX.read(data, { type: "binary" });
        const sheetName = wb.SheetNames.includes("NTO") ? "NTO" : wb.SheetNames.includes("Combo") ? "Combo" : wb.SheetNames[0];
        // Reuse parseCombo since shape is identical: SKU + month columns (values are NTO instead of qty)
        const { comboRows, qtyColumns } = parseCombo(wb.Sheets[sheetName]);
        if (comboRows.length === 0) { setError("No data found in the first sheet."); setProcessing(false); return; }

        // NTO mode ALWAYS uses DB mapper — MRP lookup depends on DB SKU Master anyway.
        if (dbMapperRows.length === 0) {
          setError("No DB mapper loaded. Ask an admin to upload a mapper set.");
          setProcessing(false); return;
        }
        const mapperRows = dbMapperRows;
        const productCount = dbProductCount;

        setAllMapperRows(mapperRows);
        // FG Code mode: resolve FG codes to Master SKUs
        let finalComboRows = comboRows;
        let fgResolutionWarnings: string[] = [];
        if (inputIdentifier === "fg") {
          const { resolved, fgWarnings, unresolved } = resolveFgCodes(comboRows);
          finalComboRows = resolved;
          fgResolutionWarnings = fgWarnings;
          setUnresolvedFgCodes(unresolved);
        } else { setUnresolvedFgCodes([]); }
        const res = runNtoConversion(finalComboRows, mapperRows, qtyColumns, productCount, skuLookup);
        if (fgResolutionWarnings.length > 0) res.warnings.push(...fgResolutionWarnings);
        setNtoResult(res);
        logUsage("nto", res.singles.length);
      } catch (err: any) { setError(`Processing failed: ${err.message}`); }
      setProcessing(false);
    };
    reader.readAsBinaryString(file);
  }

  function downloadNtoResult() {
    if (!ntoResult) return;
    XLSX.writeFile(buildNtoOutputExcel(ntoResult, allMapperRows, skuLookup), "Combo_to_Singles_NTO_Output.xlsx");
  }

  // ====== MULTI-PLATFORM (NTO + QTY) CONVERSION ======

  function handleMultiFile(file: File) {
    setError(null); setProcessing(true); setMultiResult(null);
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = evt.target?.result;
        const wb = XLSX.read(data, { type: "binary" });

        // Locate the two required sheets by name (case-insensitive, common variants)
        const findSheet = (patterns: RegExp[]): string | null => {
          for (const name of wb.SheetNames) {
            for (const p of patterns) if (p.test(name)) return name;
          }
          return null;
        };
        const qtySheetName = findSheet([/^quantity$/i, /^qty$/i, /quantity/i, /\bqty\b/i]);
        const ntoSheetName = findSheet([/^nto$/i, /nto/i]);
        if (!qtySheetName) {
          setError('Quantity sheet not found. Create a sheet named "Quantity" (or "Qty").');
          setProcessing(false); return;
        }
        if (!ntoSheetName) {
          setError('NTO sheet not found. Create a sheet named "NTO".');
          setProcessing(false); return;
        }
        if (qtySheetName === ntoSheetName) {
          setError("Could not distinguish Quantity and NTO sheets — they resolved to the same sheet. Rename them.");
          setProcessing(false); return;
        }

        const { rows, months } = parseMultiInput(wb.Sheets[qtySheetName], wb.Sheets[ntoSheetName]);
        if (rows.length === 0) { setError("No data found after merging sheets."); setProcessing(false); return; }
        if (months.length === 0) { setError("No month columns detected. Each sheet must have Master SKU, Channel, then one column per month."); setProcessing(false); return; }

        // Multi-Platform mode ALWAYS uses DB mapper — no file-mapper option.
        if (dbMapperRows.length === 0) {
          setError("No DB mapper loaded. Ask an admin to upload a mapper set.");
          setProcessing(false); return;
        }
        const mapperRows = dbMapperRows;

        setAllMapperRows(mapperRows);
        // FG Code mode: resolve FG codes to Master SKUs
        let finalRows = rows;
        let fgResolutionWarnings: string[] = [];
        if (inputIdentifier === "fg") {
          const { resolved, fgWarnings, unresolved } = resolveFgCodesMulti(rows);
          finalRows = resolved;
          fgResolutionWarnings = fgWarnings;
          setUnresolvedFgCodes(unresolved);
        } else { setUnresolvedFgCodes([]); }
        const res = runMultiConversion(finalRows, mapperRows, months, skuLookup);
        if (fgResolutionWarnings.length > 0) res.warnings.push(...fgResolutionWarnings);
        setMultiResult(res);
        logUsage("multi", res.singles.length);
      } catch (err: any) { setError(`${err.message}`); }
      setProcessing(false);
    };
    reader.readAsBinaryString(file);
  }

  function downloadMultiResult() {
    if (!multiResult) return;
    XLSX.writeFile(buildMultiOutputExcel(multiResult, allMapperRows, skuLookup), "MultiPlatform_NTO_Qty_Output.xlsx");
  }

  // ====== DAILY PENDING-QTY CONVERSION ======
  // One-click: upload the daily "pending qty" file (FG Code, Product Name, Order Qty) and get back a
  // single flat sheet of singles with FG Code, Name, Qty and a Converted / Not in Mapper remark.

  function handleDailyFile(file: File) {
    setError(null); setProcessing(true); setDailyResult(null);
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = evt.target?.result;
        const wb = XLSX.read(data, { type: "binary" });
        const input = parseDailyPending(wb.Sheets[wb.SheetNames[0]]);
        if (input.length === 0) { setError("No rows found. Expecting columns: FG Code, Product Name, Order Qty."); setProcessing(false); return; }

        // Always uses the DB mapper + SKU Master (FG-code resolution depends on both).
        if (dbMapperRows.length === 0) { setError("No mapper loaded. Select a mapper first (or ask an admin to upload one)."); setProcessing(false); return; }
        if (skuMaster.length === 0) { setError("SKU Master not loaded yet — try again in a moment."); setProcessing(false); return; }

        const res = runDailyConversion(input, dbMapperRows, skuMaster);
        setDailyResult(res);
        logUsage("daily", res.rows.length);
      } catch (err: any) { setError(`Processing failed: ${err.message}`); }
      setProcessing(false);
    };
    reader.readAsBinaryString(file);
  }

  function downloadDailyResult() {
    if (!dailyResult) return;
    XLSX.writeFile(buildDailyOutputExcel(dailyResult), "Pending_Qty_Singles.xlsx");
  }

  // Intuitive multi-sheet template: Instructions → Quantity → NTO.
  // Qty and NTO share the same (Master SKU, Channel) row order.
  // Sample numbers are deliberately different so users can see what goes where.
  function downloadMultiTemplate() {
    const wb = XLSX.utils.book_new();

    // ===== Sheet 1: Instructions =====
    const instr: (string | number)[][] = [
      ["Multi-Platform Converter — Workbook Template"],
      [""],
      ["This workbook MUST contain two data sheets: 'Quantity' and 'NTO'."],
      ["Both sheets must have the SAME Master SKU + Channel rows, in any order,"],
      ["and the SAME month columns. A pre-conversion check enforces this."],
      [""],
      ["Column structure (both sheets):"],
      ["  • Column A: Master SKU"],
      ["  • Column B: Channel"],
      ["  • Column C onward: one column per month (e.g. 'Mar 2026', 'Apr 2026', ...)"],
      [""],
      ["What each sheet means:"],
      ["  • Quantity sheet  → units forecast per SKU × Channel × Month"],
      ["  • NTO sheet       → rupee NTO forecast per SKU × Channel × Month"],
      [""],
      ["Conversion behaviour:"],
      ["  • Singles  → passed through as-is (Qty + NTO)"],
      ["  • Combos   → Qty expands by component count; NTO splits across"],
      ["               components by MRP ratio: NTO_i = NTO × (MRP_i × qty_i) / Σ(MRP_j × qty_j)"],
      ["  • Missing MRP on any component → row flagged CRITICAL; Qty still expands,"],
      ["    NTO is zeroed (set MRPs in SKU Master and re-run)."],
      [""],
      ["Tips:"],
      ["  • Keep row order identical across both sheets — easier to eyeball."],
      ["  • Do not add extra columns besides SKU, Channel, and month columns."],
      ["  • No duplicate (Master SKU, Channel) rows within a sheet."],
      ["  • Replace the sample rows in Quantity and NTO with your real data."],
    ];
    const instrWs = XLSX.utils.aoa_to_sheet(instr);
    instrWs["!cols"] = [{ wch: 90 }];
    XLSX.utils.book_append_sheet(wb, instrWs, "Instructions");

    // Shared (SKU, Channel) identity for both data sheets
    const pairs = [
      { sku: "EXAMPLE_SKU1", channel: "Amazon" },
      { sku: "EXAMPLE_SKU1", channel: "Flipkart" },
      { sku: "EXAMPLE_SKU2", channel: "Amazon" },
      { sku: "EXAMPLE_COMBO1", channel: "Amazon" },
    ];

    // ===== Sheet 2: Quantity (units) =====
    const qtyData = pairs.map((p, i) => ({
      "Master SKU": p.sku, "Channel": p.channel,
      "Mar 2026": 100 + i * 50,
      "Apr 2026": 120 + i * 60,
    }));
    const qtyWs = XLSX.utils.json_to_sheet(qtyData);
    qtyWs["!cols"] = [{ wch: 22 }, { wch: 14 }, { wch: 12 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, qtyWs, "Quantity");

    // ===== Sheet 3: NTO (rupee value, larger numbers) =====
    const ntoData = pairs.map((p, i) => ({
      "Master SKU": p.sku, "Channel": p.channel,
      "Mar 2026": (100 + i * 50) * 50, // units × ~MRP/NTO to make the distinction obvious
      "Apr 2026": (120 + i * 60) * 50,
    }));
    const ntoWs = XLSX.utils.json_to_sheet(ntoData);
    ntoWs["!cols"] = [{ wch: 22 }, { wch: 14 }, { wch: 12 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ntoWs, "NTO");

    // Open on the Instructions sheet by default
    wb.Workbook = { Views: [{ RTL: false }] } as any;
    (wb.Workbook as any).Views[0].activeTab = 0;

    XLSX.writeFile(wb, "MultiPlatform_Template.xlsx");
  }

  // Resolve nested combos in a set of mapper rows — returns which ones need updating
  function findNestedCombos(rows: { master_sku: string; is_combo: boolean; products: string[] }[]): { master_sku: string; resolved: string[] }[] {
    const comboMap = new Map<string, { products: string[] }>();
    for (const r of rows) {
      if (r.is_combo && !comboMap.has(r.master_sku.toLowerCase())) {
        comboMap.set(r.master_sku.toLowerCase(), { products: r.products });
      }
    }
    function resolve(products: string[], parentSku?: string, visited = new Set<string>()): string[] {
      const out: string[] = [];
      for (const p of products) {
        const key = p.toLowerCase();
        if (visited.has(key)) { out.push(p); continue; } // circular reference guard
        const nested = comboMap.get(key);
        if (nested && key !== parentSku?.toLowerCase()) {
          visited.add(key);
          out.push(...resolve(nested.products.filter(x => x), key, visited));
        } else if (p) {
          out.push(p);
        }
      }
      return out;
    }
    const toUpdate: { master_sku: string; resolved: string[] }[] = [];
    for (const r of rows) {
      if (!r.is_combo) continue;
      const resolved = resolve(r.products.filter(p => p), r.master_sku);
      if (JSON.stringify(r.products.filter(p => p).sort()) !== JSON.stringify(resolved.sort())) {
        toUpdate.push({ master_sku: r.master_sku, resolved });
      }
    }
    return toUpdate;
  }

  // Auto-resolve nested combos in DB for a given mapper set
  async function resolveNestedInDb(setId: string, rows: { master_sku: string; is_combo: boolean; products: string[] }[], silent = false): Promise<number> {
    const toUpdate = findNestedCombos(rows);
    if (toUpdate.length === 0) return 0;
    let count = 0;
    for (const u of toUpdate) {
      const { error: err } = await supabase
        .from("combo_mapper_rows")
        .update({ products: u.resolved })
        .eq("master_sku", u.master_sku)
        .eq("mapper_set_id", setId);
      if (!err) count++;
    }
    if (!silent && count > 0) {
      setSubmitMsg(`Auto-resolved nested components for ${count} combo(s).`);
      setTimeout(() => setSubmitMsg(null), 4000);
    }
    return count;
  }

  // Load rows for a mapper set from DB
  async function loadMapperSetRows(setId: string): Promise<{ master_sku: string; is_combo: boolean; products: string[]; fg_code: string }[]> {
    let allData: any[] = [];
    let from = 0;
    const PAGE = 1000;
    while (true) {
      const { data, error } = await supabase
        .from("combo_mapper_rows")
        .select("master_sku, is_combo, products, fg_code")
        .eq("mapper_set_id", setId)
        .range(from, from + PAGE - 1);
      if (error || !data || data.length === 0) break;
      allData = allData.concat(data);
      if (data.length < PAGE) break;
      from += PAGE;
    }
    return allData.map((r: any) => ({
      master_sku: String(r.master_sku || "").trim(),
      is_combo: r.is_combo === true,
      products: Array.isArray(r.products) ? r.products.map((p: any) => String(p || "").trim()).filter((p: string) => p) : [],
      fg_code: String(r.fg_code || "").trim(),
    }));
  }

  // Resolve nested combos for a specific mapper set
  async function resolveNestedForSet(setId: string) {
    setUploadingMapper(true);
    const rows = await loadMapperSetRows(setId);
    const toUpdate = findNestedCombos(rows);
    if (toUpdate.length === 0) {
      setMapperMsg("No nested combos found in this mapper.");
      setUploadingMapper(false);
      return;
    }
    if (!confirm(`Found ${toUpdate.length} nested combo(s). Resolve them to singles in the mapper?`)) {
      setUploadingMapper(false);
      return;
    }
    const count = await resolveNestedInDb(setId, rows, true);
    setMapperMsg(`Resolved ${count} nested combo(s) to singles.`);
    setUploadingMapper(false);
    if (selectedMapperSetId === setId) await loadMapperData(setId);
  }

  // Download a mapper set as Excel
  async function downloadMapperSet(setId: string, name: string) {
    setUploadingMapper(true);
    const rows = await loadMapperSetRows(setId);
    let maxCols = 0;
    for (const r of rows) maxCols = Math.max(maxCols, r.products.length);
    const wb = XLSX.utils.book_new();
    const headers = ["Master SKU", "Combo", "FG Code", ...Array.from({ length: maxCols }, (_, i) => `Product ${i + 1}`)];
    const aoa: any[][] = [headers];
    for (const r of rows) {
      const row: any[] = [r.master_sku, r.is_combo ? "Yes" : "No", r.fg_code || ""];
      for (let i = 0; i < maxCols; i++) row.push(r.products[i] || "");
      aoa.push(row);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [{ wch: 28 }, { wch: 8 }, { wch: 14 }, ...Array.from({ length: maxCols }, () => ({ wch: 22 }))];
    XLSX.utils.book_append_sheet(wb, ws, "Mapper");
    XLSX.writeFile(wb, `${name.replace(/[^a-zA-Z0-9_-]/g, "_")}_Mapper.xlsx`);
    setUploadingMapper(false);
  }

  function downloadTemplate() {
    const wb = XLSX.utils.book_new();
    const comboAoa = [
      ["New Master SKU", "Month 1", "Month 2", "Month 3"],
      ["COMBO_SKU_EXAMPLE", 500, 400, 300],
      ["SINGLE_SKU_EXAMPLE", 200, 150, 100],
    ];
    const ws = XLSX.utils.aoa_to_sheet(comboAoa);
    ws["!cols"] = [{ wch: 24 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws, "Combo");
    XLSX.writeFile(wb, "Combo_Input_Template.xlsx");
  }

  // Re-convert with user-edited unmapped rows merged into mapper
  function handleReConvert() {
    if (!result || cachedComboRows.length === 0) return;

    // Build patched mapper: original + user edits for unmapped SKUs
    const patchedMapper = [...allMapperRows];
    let maxProducts = allMapperRows.reduce((max, r) => Math.max(max, r.products.length), 0);

    for (const [sku, edit] of unmappedEdits) {
      if (!edit.combo && !edit.products.trim()) continue; // skip untouched
      const prods = edit.products.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
      maxProducts = Math.max(maxProducts, prods.length);
      patchedMapper.push({ master_sku: sku, combo: edit.combo || "No", products: prods, fg_code: "" });
    }

    setAllMapperRows(patchedMapper);
    const convResult = runConversion(cachedComboRows, patchedMapper, cachedQtyColumns, maxProducts);
    setResult(convResult);

    // Re-init edits for any still-unmapped rows
    const edits = new Map<string, { combo: string; products: string }>();
    convResult.consolidated.filter((r) => r.mapper_status === "NOT IN MAPPER").forEach((r) => {
      const prev = unmappedEdits.get(r.master_sku);
      edits.set(r.master_sku, prev || { combo: "No", products: "" });
    });
    setUnmappedEdits(edits);
  }

  // SKU Master lookup: master_sku -> { new_fg_code, product_name }
  const skuLookup = useMemo(() => {
    const map = new Map<string, SingleSku>();
    for (const s of skuMaster) map.set(s.new_master_sku.toLowerCase(), s);
    return map;
  }, [skuMaster]);

  // FG Code -> Master SKU resolution (used when inputIdentifier === "fg")
  function buildFgMaps() {
    const fgCodeMap = new Map<string, SingleSku>();
    for (const s of skuMaster) {
      if (s.new_fg_code) {
        fgCodeMap.set(s.new_fg_code.toLowerCase(), s);
        if (s.new_fg_code.toLowerCase().endsWith("g")) {
          fgCodeMap.set(s.new_fg_code.slice(0, -1).toLowerCase(), s);
        }
      }
    }
    const comboFgMap = new Map<string, MapperRow>();
    for (const m of (dbMapperRows.length > 0 ? dbMapperRows : allMapperRows)) {
      const isCombo = ["yes", "y", "1", "true"].includes(m.combo.toLowerCase()) || m.products.some((p) => p.length > 0);
      if (isCombo && m.fg_code) comboFgMap.set(m.fg_code.toLowerCase(), m);
    }
    return { fgCodeMap, comboFgMap };
  }

  function resolveFgCodes(comboRows: ComboInputRow[]): { resolved: ComboInputRow[]; fgWarnings: string[]; unresolved: UnresolvedFg[] } {
    const fgWarnings: string[] = [];
    const unresolved: UnresolvedFg[] = [];
    const { fgCodeMap, comboFgMap } = buildFgMaps();

    const resolved: ComboInputRow[] = [];
    for (const row of comboRows) {
      const lower = row.master_sku.toLowerCase().trim();
      const single = fgCodeMap.get(lower);
      if (single) { resolved.push({ ...row, master_sku: single.new_master_sku }); continue; }
      const combo = comboFgMap.get(lower);
      if (combo) { resolved.push({ ...row, master_sku: combo.master_sku }); continue; }
      // Unresolved — exclude from conversion, track separately
      fgWarnings.push(`FG Code "${row.master_sku}" not found in SKU Master or Combo Mapper`);
      unresolved.push({ fg_code: row.master_sku, quantities: row.quantities, action: "none", targetMasterSku: "", comboComponents: "", submitting: false, submitted: false });
    }
    return { resolved, fgWarnings, unresolved };
  }

  // Resolve FG codes for multi-platform input rows
  function resolveFgCodesMulti(rows: MultiInputRow[]): { resolved: MultiInputRow[]; fgWarnings: string[]; unresolved: UnresolvedFg[] } {
    const fgWarnings: string[] = [];
    const unresolved: UnresolvedFg[] = [];
    const { fgCodeMap, comboFgMap } = buildFgMaps();

    const resolved: MultiInputRow[] = [];
    for (const row of rows) {
      const lower = row.master_sku.toLowerCase().trim();
      const single = fgCodeMap.get(lower);
      if (single) { resolved.push({ ...row, master_sku: single.new_master_sku }); continue; }
      const combo = comboFgMap.get(lower);
      if (combo) { resolved.push({ ...row, master_sku: combo.master_sku }); continue; }
      fgWarnings.push(`FG Code "${row.master_sku}" not found in SKU Master or Combo Mapper`);
      unresolved.push({ fg_code: row.master_sku, quantities: { ...row.qty, ...row.nto }, action: "none", targetMasterSku: "", comboComponents: "", submitting: false, submitted: false });
    }
    return { resolved, fgWarnings, unresolved };
  }

  const hasUnmappedEdits = useMemo(() => {
    for (const [, edit] of unmappedEdits) {
      if (edit.products.trim().length > 0) return true;
    }
    return false;
  }, [unmappedEdits]);

  // ====== SUGGESTIONS ======

  async function loadSuggestions() {
    const { data } = await supabase.from("mapper_suggestions").select("*").eq("status", "pending").order("created_at", { ascending: false });
    if (data) setPendingSuggestions(data);
  }

  async function submitSuggestions() {
    const { data: { user } } = await supabase.auth.getUser();
    const toSubmit: any[] = [];
    for (const [sku, edit] of unmappedEdits) {
      if (!edit.products.trim()) continue;
      toSubmit.push({
        master_sku: sku,
        is_combo: edit.combo.toLowerCase() === "yes",
        products: edit.products.split(",").map((p) => p.trim()).filter((p) => p),
        submitted_by: user?.id,
        submitted_by_email: profile?.email,
        status: "pending",
      });
    }
    if (toSubmit.length === 0) { setSubmitMsg("No edits to submit. Fill in components first."); setTimeout(() => setSubmitMsg(null), 3000); return; }
    const { error: err } = await supabase.from("mapper_suggestions").insert(toSubmit);
    if (err) { setSubmitMsg(`Failed: ${err.message}`); } else { setSubmitMsg(`${toSubmit.length} suggestion(s) submitted for admin approval.`); }
    setTimeout(() => setSubmitMsg(null), 4000);
  }

  async function approveSuggestion(suggestion: any, selectedMapperIds: string[]) {
    if (selectedMapperIds.length === 0) return;
    // Add to each selected mapper
    for (const msId of selectedMapperIds) {
      // Check if SKU already exists in this mapper
      const { data: existing } = await supabase.from("combo_mapper_rows").select("id").eq("mapper_set_id", msId).eq("master_sku", suggestion.master_sku).limit(1);
      if (existing && existing.length > 0) {
        // Update existing
        await supabase.from("combo_mapper_rows").update({ is_combo: suggestion.is_combo, products: suggestion.products }).eq("id", existing[0].id);
      } else {
        // Insert new
        await supabase.from("combo_mapper_rows").insert({ mapper_set_id: msId, master_sku: suggestion.master_sku, is_combo: suggestion.is_combo, products: suggestion.products, fg_code: suggestion.fg_code || null });
      }
      // Update row count
      const { count } = await supabase.from("combo_mapper_rows").select("id", { count: "exact", head: true }).eq("mapper_set_id", msId);
      if (count !== null) await supabase.from("combo_mapper_sets").update({ row_count: count, updated_at: new Date().toISOString() }).eq("id", msId);
    }
    // Mark approved
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from("mapper_suggestions").update({ status: "approved", reviewed_by: user?.id, reviewed_at: new Date().toISOString(), applied_to_mapper_ids: selectedMapperIds }).eq("id", suggestion.id);
    await loadSuggestions();
  }

  async function rejectSuggestion(id: string, note?: string) {
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from("mapper_suggestions").update({ status: "rejected", reviewed_by: user?.id, reviewed_at: new Date().toISOString(), review_note: note || null }).eq("id", id);
    await loadSuggestions();
  }

  // Submit unresolved FG code suggestion to mapper_suggestions
  async function submitFgSuggestion(index: number) {
    const item = unresolvedFgCodes[index];
    if (!item || item.action === "none") return;
    setUnresolvedFgCodes((prev) => prev.map((r, i) => i === index ? { ...r, submitting: true } : r));

    const { data: { user } } = await supabase.auth.getUser();
    try {
      if (item.action === "add_single") {
        // Suggest adding a new single with this FG code
        await supabase.from("mapper_suggestions").insert({
          master_sku: item.fg_code, // Use FG code as placeholder — admin will assign real Master SKU
          is_combo: false,
          products: [],
          fg_code: item.fg_code,
          submitted_by: user?.id,
          submitted_by_email: profile?.email,
          status: "pending",
          notes: `New single suggested from FG Code input. FG Code: ${item.fg_code}`,
        });
      } else if (item.action === "add_combo") {
        // Suggest adding a new combo with this FG code and components
        const components = item.comboComponents.split(",").map((p) => p.trim()).filter((p) => p);
        await supabase.from("mapper_suggestions").insert({
          master_sku: item.fg_code,
          is_combo: true,
          products: components,
          fg_code: item.fg_code,
          submitted_by: user?.id,
          submitted_by_email: profile?.email,
          status: "pending",
          notes: `New combo suggested from FG Code input. FG Code: ${item.fg_code}, Components: ${components.join(", ")}`,
        });
      } else if (item.action === "update_existing") {
        // Suggest updating an existing Master SKU's FG code
        if (!item.targetMasterSku.trim()) return;
        await supabase.from("mapper_suggestions").insert({
          master_sku: item.targetMasterSku.trim(),
          is_combo: false,
          products: [],
          fg_code: item.fg_code,
          submitted_by: user?.id,
          submitted_by_email: profile?.email,
          status: "pending",
          notes: `Update FG Code for existing Master SKU "${item.targetMasterSku.trim()}" to "${item.fg_code}"`,
        });
      }
      setUnresolvedFgCodes((prev) => prev.map((r, i) => i === index ? { ...r, submitting: false, submitted: true } : r));
    } catch (err: any) {
      setUnresolvedFgCodes((prev) => prev.map((r, i) => i === index ? { ...r, submitting: false } : r));
      setError(`Failed to submit suggestion for ${item.fg_code}: ${err.message}`);
    }
  }

  function updateUnresolvedFg(index: number, field: string, value: any) {
    setUnresolvedFgCodes((prev) => prev.map((r, i) => i === index ? { ...r, [field]: value } : r));
  }

  // ==================== RENDER ====================

  if (loading) {
    return (
      <AppShell>
        <div className="flex items-center justify-center h-64"><p style={{ color: "var(--atlas-ink-muted)" }}>Loading...</p></div>
      </AppShell>
    );
  }

  const isAdmin = profile?.role === "admin";
  const selectedSetInfo = mapperSets.find((s) => s.id === selectedMapperSetId);

  return (
    <AppShell>
      <div className="max-w-7xl mx-auto">
        <div className="flex items-start justify-between mb-6">
          <div>
            <h2 className="text-2xl font-bold">Combo → Singles Converter</h2>
            <div className="flex items-center gap-3 mt-1">
              <p className="text-sm text-atlas-ink-muted">Convert combo SKU forecasts into individual single SKU quantities</p>
              {!result && !ntoResult && !multiResult && !dailyResult && mode !== "daily" && (
                <div className="flex items-center gap-2 ml-4 shrink-0">
                  <span className={`text-xs font-medium transition ${inputIdentifier === "sku" ? "text-atlas-ink" : "text-atlas-ink-muted"}`}>Master SKU</span>
                  <button
                    onClick={() => { setInputIdentifier(inputIdentifier === "sku" ? "fg" : "sku"); setError(null); }}
                    className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${inputIdentifier === "fg" ? "bg-atlas-accent" : "bg-atlas-line"}`}
                    title={inputIdentifier === "fg" ? "FG Code mode: Input uses 6-digit+G FG Codes" : "Master SKU mode: Input uses Master SKU codes"}
                  >
                    <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform duration-200 ${inputIdentifier === "fg" ? "translate-x-5" : "translate-x-0"}`} />
                  </button>
                  <span className={`text-xs font-medium transition ${inputIdentifier === "fg" ? "text-atlas-accent" : "text-atlas-ink-muted"}`}>FG Code</span>
                  {inputIdentifier === "fg" && <span className="text-[10px] text-atlas-accent bg-atlas-accent-bg px-1.5 py-0.5 rounded font-mono">e.g. 14244G</span>}
                </div>
              )}
            </div>
          </div>
          <div className="flex gap-3">
            {result && (
              <>
                <button onClick={downloadResult} className="px-4 py-2 text-sm bg-atlas-navy text-white font-semibold rounded-lg hover:bg-atlas-navy-soft transition">Download Excel</button>
                {isAdmin && mapperSource === "db" && selectedMapperSetId && (
                  <button onClick={() => openRowEditor(selectedMapperSetId)} className="px-4 py-2 text-sm bg-atlas-accent-bg text-atlas-accent ring-1 ring-atlas-accent/40 rounded-lg hover:bg-atlas-accent-bg transition">Edit Mapper</button>
                )}
                <button onClick={() => { setResult(null); setError(null); setUnresolvedFgCodes([]); }} className="px-4 py-2 text-sm bg-atlas-surface-soft text-atlas-ink rounded-lg hover:bg-atlas-surface-soft transition">New Conversion</button>
              </>
            )}
            {!result && mode !== "multi" && mode !== "daily" && (
              <>
                <button onClick={downloadTemplate} className="px-4 py-2 text-sm bg-atlas-surface-soft text-atlas-ink rounded-lg hover:bg-atlas-surface-soft transition">
                  Download Template
                </button>
              </>
            )}
            {isAdmin && !result && (
              <>
                <button onClick={() => setShowMapperManager(!showMapperManager)}
                  className={`px-4 py-2 text-sm rounded-lg transition ${showMapperManager ? "bg-atlas-blue-bg text-atlas-blue ring-1 ring-atlas-blue" : "bg-atlas-surface-soft text-atlas-ink hover:bg-atlas-surface-soft"}`}>
                  {showMapperManager ? "Hide Mapper Manager" : "Manage Mappers"}
                </button>
                {pendingSuggestions.length > 0 && (
                  <button onClick={() => { setShowApprovals(!showApprovals); setShowMapperManager(false); }}
                    className={`px-4 py-2 text-sm rounded-lg transition relative ${showApprovals ? "bg-atlas-blue-bg text-atlas-blue ring-1 ring-atlas-blue" : "bg-atlas-surface-soft text-atlas-ink hover:bg-atlas-surface-soft"}`}>
                    Approvals
                    <span className="absolute -top-1.5 -right-1.5 px-1.5 py-0.5 bg-atlas-red text-white text-xs rounded-full">{pendingSuggestions.length}</span>
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {error && <div className="mb-6 p-4 bg-atlas-red-bg border border-atlas-red rounded-xl"><p className="text-atlas-red text-sm">{error}</p></div>}

        {/* ====== MAPPER MANAGER (Admin) ====== */}
        {showMapperManager && isAdmin && !result && (
          <div className="mb-6 bg-atlas-surface border border-atlas-blue/30 rounded-xl p-6">
            <h3 className="text-lg font-semibold text-atlas-blue mb-4">Mapper Manager</h3>

            {/* Existing mappers */}
            {mapperSets.length > 0 && (
              <div className="mb-6">
                <p className="text-sm text-atlas-ink mb-3">Existing Mappers ({mapperSets.length})</p>
                <div className="space-y-2">
                  {mapperSets.map((ms) => (
                    <div key={ms.id} className="flex items-center justify-between p-3 bg-atlas-surface-soft rounded-lg">
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">{ms.name}</span>
                          {ms.is_default && <span className="px-1.5 py-0.5 text-xs bg-atlas-green-bg text-atlas-green rounded">Default</span>}
                        </div>
                        <p className="text-xs text-atlas-ink-muted mt-0.5">
                          {ms.row_count} SKUs · P1-P{ms.product_column_count} · {new Date(ms.created_at).toLocaleDateString()}
                          {ms.description && <span> · {ms.description}</span>}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {!ms.is_default && (
                          <button onClick={() => setDefaultMapper(ms.id)} className="text-xs text-atlas-ink-muted hover:text-atlas-green transition">Set Default</button>
                        )}
                        <button onClick={() => downloadMapperSet(ms.id, ms.name)} disabled={uploadingMapper} className="text-xs text-atlas-blue hover:text-atlas-blue transition">Download</button>
                        <button onClick={() => openRowEditor(ms.id)} disabled={uploadingMapper} className="text-xs text-atlas-accent hover:text-atlas-accent transition">Edit Rows</button>
                        <button onClick={() => resolveNestedForSet(ms.id)} disabled={uploadingMapper} className="text-xs text-atlas-green hover:text-atlas-green transition">Resolve Nested</button>
                        <label className="text-xs text-atlas-blue hover:text-atlas-blue cursor-pointer transition">
                          Update
                          <input type="file" accept=".xlsx,.xls" className="hidden"
                            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpdateMapper(ms.id, f); e.target.value = ""; }} />
                        </label>
                        <button onClick={() => deleteMapperSet(ms.id)} className="text-xs text-atlas-red hover:text-atlas-red transition">Delete</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Upload new mapper */}
            <div className="p-4 bg-atlas-surface-soft/50 rounded-lg">
              <p className="text-sm text-atlas-ink mb-3">Upload New Mapper</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                <input type="text" placeholder="Mapper name (e.g. 'Singles except VP & Enrobed Minis')" value={newMapperName} onChange={(e) => setNewMapperName(e.target.value)}
                  className="px-3 py-2 bg-atlas-surface border border-atlas-line rounded-lg text-sm text-atlas-ink placeholder-atlas-ink-faint focus:outline-none focus:ring-2 focus:ring-atlas-blue" />
                <input type="text" placeholder="Description (optional)" value={newMapperDesc} onChange={(e) => setNewMapperDesc(e.target.value)}
                  className="px-3 py-2 bg-atlas-surface border border-atlas-line rounded-lg text-sm text-atlas-ink placeholder-atlas-ink-faint focus:outline-none focus:ring-2 focus:ring-atlas-blue" />
              </div>
              <div className="flex items-center gap-3">
                <label className={`px-4 py-2 text-sm rounded-lg cursor-pointer transition ${uploadingMapper ? "bg-atlas-surface-soft text-atlas-ink-muted" : "bg-atlas-blue text-white hover:bg-atlas-blue/80"}`}>
                  {uploadingMapper ? "Uploading..." : "Choose Mapper File"}
                  <input ref={mapperFileRef} type="file" accept=".xlsx,.xls" className="hidden" disabled={uploadingMapper}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) handleMapperUpload(f); if (mapperFileRef.current) mapperFileRef.current.value = ""; }} />
                </label>
                <span className="text-xs text-atlas-ink-muted">Excel with "Mapper" sheet (Col B=SKU, Col G=Combo, Col J+=Products)</span>
              </div>
            </div>

            {mapperMsg && (
              <div className={`mt-3 p-3 rounded-lg text-sm ${mapperMsg.startsWith("Error") || mapperMsg.startsWith("Failed") || mapperMsg.startsWith("No ") ? "bg-atlas-red-bg text-atlas-red" : "bg-atlas-green-bg text-atlas-green"}`}>
                {mapperMsg}
              </div>
            )}
          </div>
        )}

        {/* ====== APPROVALS PANEL (Admin) ====== */}
        {showApprovals && isAdmin && !result && pendingSuggestions.length > 0 && (
          <div className="mb-6 bg-atlas-surface border border-atlas-blue/30 rounded-xl p-6">
            <h3 className="text-lg font-semibold text-atlas-blue mb-4">Pending Mapper Suggestions ({pendingSuggestions.length})</h3>
            <div className="space-y-3">
              {pendingSuggestions.map((s) => (
                <SuggestionCard key={s.id} suggestion={s} mapperSets={mapperSets}
                  onApprove={(selectedIds) => approveSuggestion(s, selectedIds)}
                  onReject={(note) => rejectSuggestion(s.id, note)} />
              ))}
            </div>
          </div>
        )}

        {/* ====== MODE TABS ====== */}
        <div className="mb-6 bg-atlas-surface border border-atlas-line rounded-xl p-2 inline-flex gap-1">
          {([
            { k: "qty", label: "Qty Only", desc: "Original converter — quantities" },
            { k: "nto", label: "NTO Only", desc: "Split NTO by MRP ratio" },
            { k: "multi", label: "NTO + Qty (Multi-Platform)", desc: "Per-channel Qty + NTO" },
            { k: "daily", label: "Daily Pending Qty", desc: "Upload the daily FG-Code pending file → one flat Singles sheet" },
          ] as const).map((t) => {
            const active = mode === t.k;
            return (
              <button
                key={t.k}
                onClick={() => {
                  setMode(t.k);
                  setError(null);
                  // Clear the other modes' results when switching
                  if (t.k !== "qty") setResult(null);
                  if (t.k !== "nto") setNtoResult(null);
                  if (t.k !== "multi") setMultiResult(null);
                  if (t.k !== "daily") setDailyResult(null);
                  setUnresolvedFgCodes([]);
                  // NTO, Multi and Daily modes always use DB mapper — auto-load if needed
                  if ((t.k === "nto" || t.k === "multi" || t.k === "daily") && dbMapperRows.length === 0) {
                    const setId = selectedMapperSetId || (mapperSets.find((s) => s.is_default) || mapperSets[0])?.id || "";
                    if (setId) {
                      if (setId !== selectedMapperSetId) setSelectedMapperSetId(setId);
                      loadMapperData(setId);
                    }
                  }
                }}
                className={`px-4 py-2 rounded-lg text-sm transition ${active ? "bg-atlas-accent-bg text-atlas-accent ring-1 ring-atlas-accent/40" : "text-atlas-ink-muted hover:bg-atlas-surface-soft"}`}
                title={t.desc}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        {/* ====== INPUT IDENTIFIER TOGGLE ====== */}

        {/* ====== NTO-ONLY VIEW ====== */}
        {mode === "nto" && (
          <div className="space-y-6">
            {!ntoResult ? (
              <>
                <div className="bg-atlas-surface border border-atlas-line rounded-xl p-6">
                  <label className="block text-sm font-medium text-atlas-ink mb-3">Upload NTO Sheet</label>
                  <p className="text-xs text-atlas-ink-muted mb-3">
                    Sheet name: <span className="font-mono text-atlas-ink">NTO</span> or first sheet. Columns: <span className="font-mono text-atlas-ink">{inputIdentifier === "fg" ? "FG Code" : "Master SKU"}</span> + one column per month containing NTO values.{inputIdentifier === "fg" && <span className="text-atlas-accent font-medium"> (6-digit+G FG Codes)</span>}
                    Combos are split across components using MRP ratio (<span className="font-mono">NTO × MRP × qty / Σ(MRP × qty)</span>).
                    Missing MRP on any component <span className="text-atlas-red font-semibold">blocks that combo</span> and is flagged CRITICAL.
                  </p>
                  <div className="border-2 border-dashed border-atlas-line rounded-xl p-10 text-center hover:border-atlas-line transition cursor-pointer"
                    onClick={() => document.getElementById("nto-file-input")?.click()}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) handleNtoFile(f); }}>
                    <input id="nto-file-input" type="file" accept=".xlsx,.xls,.csv" className="hidden"
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) handleNtoFile(f); (e.target as HTMLInputElement).value = ""; }} />
                    {processing ? <p className="text-atlas-accent font-medium">Processing...</p> : (
                      <>
                        <div className="text-3xl mb-2">₹</div>
                        <p className="text-atlas-ink font-medium mb-1">Drop NTO Excel here</p>
                        <p className="text-atlas-ink-muted text-sm">First sheet (or &quot;NTO&quot;): {inputIdentifier === "fg" ? "FG Code" : "SKU"} + month NTO columns</p>
                      </>
                    )}
                  </div>
                </div>
                {error && <div className="p-3 bg-atlas-red-bg border border-atlas-red rounded-lg"><p className="text-atlas-red text-sm">{error}</p></div>}
              </>
            ) : (
              <div>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
                  <div className="bg-atlas-surface border border-atlas-line rounded-xl p-4"><p className="text-xs text-atlas-ink-muted">Input Rows</p><p className="text-2xl font-bold">{ntoResult.consolidated.length}</p></div>
                  <div className="bg-atlas-green-bg border border-atlas-green/20 rounded-xl p-4"><p className="text-xs text-atlas-green font-medium">Singles Output</p><p className="text-2xl font-bold text-atlas-green">{ntoResult.singles.length}</p></div>
                  <div className="bg-atlas-surface border border-atlas-line rounded-xl p-4"><p className="text-xs text-atlas-ink-muted">NTO Columns</p><p className="text-2xl font-bold">{ntoResult.ntoColumns.length}</p><p className="text-xs text-atlas-ink-muted mt-0.5">{ntoResult.ntoColumns.join(", ")}</p></div>
                  <div className="bg-atlas-red-bg border border-atlas-red/20 rounded-xl p-4"><p className="text-xs text-atlas-red font-medium">CRITICAL</p><p className={`text-2xl font-bold ${ntoResult.criticals.filter(c => c.type === "MISSING_MRP").length > 0 ? "text-atlas-red" : "text-atlas-ink-faint"}`}>{ntoResult.criticals.filter(c => c.type === "MISSING_MRP").length}</p></div>
                  <div className="bg-atlas-surface border border-atlas-line rounded-xl p-4"><p className="text-xs text-atlas-ink-muted">Warnings</p><p className={`text-2xl font-bold ${ntoResult.warnings.length > 0 ? "text-atlas-amber-warn" : "text-atlas-ink-faint"}`}>{ntoResult.warnings.length}</p></div>
                </div>

                {ntoResult.criticals.filter(c => c.type === "MISSING_MRP").length > 0 && (
                  <div className="mb-6 p-4 bg-atlas-red-bg border border-atlas-red/30 rounded-xl">
                    <div className="flex items-start gap-3">
                      <span className="text-atlas-red text-xl leading-none">⚠</span>
                      <div className="flex-1">
                        <div className="text-atlas-red font-bold uppercase tracking-wider text-sm">CRITICAL — {ntoResult.criticals.filter(c => c.type === "MISSING_MRP").length} combo(s) blocked: missing component MRP</div>
                        <div className="text-atlas-ink-soft text-xs mt-1">These combos' NTO could NOT be split because one or more components are missing MRP in SKU Master. Set the MRPs and re-run, or accept that these combos are excluded from the Singles output. Full list in the Diagnostics sheet.</div>
                        <ul className="mt-2 text-xs text-atlas-ink-soft space-y-0.5 max-h-40 overflow-auto">
                          {ntoResult.criticals.filter(c => c.type === "MISSING_MRP").slice(0, 20).map((c, i) => (
                            <li key={i}><span className="font-mono">{c.combo_sku}</span> — {c.detail}</li>
                          ))}
                          {ntoResult.criticals.filter(c => c.type === "MISSING_MRP").length > 20 && <li>… +{ntoResult.criticals.filter(c => c.type === "MISSING_MRP").length - 20} more</li>}
                        </ul>
                      </div>
                    </div>
                  </div>
                )}

                {/* Unresolved FG Codes (NTO) */}
                {unresolvedFgCodes.length > 0 && (
                  <div className="mb-4 p-5 bg-atlas-accent-bg/30 border border-atlas-accent/30 rounded-xl">
                    <div className="flex items-center gap-2 mb-3">
                      <span className="text-atlas-accent text-lg leading-none">!</span>
                      <p className="text-sm font-semibold text-atlas-accent">{unresolvedFgCodes.length} FG Code(s) not found</p>
                    </div>
                    <p className="text-xs text-atlas-ink-muted mb-4">These FG Codes could not be mapped. Suggest adding them so an admin can review.</p>
                    <div className="space-y-3">
                      {unresolvedFgCodes.map((item, idx) => (
                        <div key={idx} className={`p-4 rounded-lg border ${item.submitted ? "bg-atlas-green-bg/30 border-atlas-green/30" : "bg-atlas-surface border-atlas-line"}`}>
                          <div className="flex items-center justify-between mb-2">
                            <span className="font-mono text-sm font-semibold text-atlas-ink">{item.fg_code}</span>
                            {item.submitted && <span className="text-xs text-atlas-green font-medium px-2 py-0.5 bg-atlas-green-bg rounded">Submitted</span>}
                          </div>
                          {!item.submitted && (
                            <div className="space-y-2">
                              <div className="flex gap-2 flex-wrap">
                                {(["add_single", "add_combo", "update_existing"] as const).map((act) => (
                                  <button key={act} onClick={() => updateUnresolvedFg(idx, "action", act)}
                                    className={`px-3 py-1.5 text-xs rounded-lg border transition ${item.action === act ? "bg-atlas-accent-bg text-atlas-accent border-atlas-accent/40 ring-1 ring-atlas-accent/30" : "bg-atlas-surface-soft text-atlas-ink-muted border-transparent hover:bg-atlas-surface-soft"}`}>
                                    {act === "add_single" ? "Add as New Single" : act === "add_combo" ? "Add as New Combo" : "Update Existing SKU"}
                                  </button>
                                ))}
                              </div>
                              {item.action === "add_combo" && (
                                <input type="text" value={item.comboComponents} onChange={(e) => updateUnresolvedFg(idx, "comboComponents", e.target.value)}
                                  placeholder="Component SKUs (comma-separated)" className="w-full px-3 py-2 text-xs bg-atlas-surface-soft border border-atlas-line rounded-lg font-mono focus:outline-none focus:ring-1 focus:ring-atlas-accent" />
                              )}
                              {item.action === "update_existing" && (
                                <input type="text" value={item.targetMasterSku} onChange={(e) => updateUnresolvedFg(idx, "targetMasterSku", e.target.value)}
                                  placeholder="Existing Master SKU to update" className="w-full px-3 py-2 text-xs bg-atlas-surface-soft border border-atlas-line rounded-lg font-mono focus:outline-none focus:ring-1 focus:ring-atlas-accent" />
                              )}
                              {item.action !== "none" && (
                                <button onClick={() => submitFgSuggestion(idx)} disabled={item.submitting || (item.action === "update_existing" && !item.targetMasterSku.trim()) || (item.action === "add_combo" && !item.comboComponents.trim())}
                                  className="px-4 py-1.5 text-xs bg-atlas-accent text-white font-semibold rounded-lg hover:bg-atlas-accent-deep transition disabled:opacity-50 disabled:cursor-not-allowed">
                                  {item.submitting ? "Submitting..." : "Submit Suggestion"}
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="flex gap-3 mb-4">
                  <button onClick={downloadNtoResult} className="px-5 py-2 bg-atlas-accent text-white font-semibold rounded-lg hover:bg-atlas-accent-deep transition text-sm">Download Output (Excel)</button>
                  <button onClick={() => { setNtoResult(null); setUnresolvedFgCodes([]); }} className="px-5 py-2 bg-atlas-surface-soft text-atlas-ink rounded-lg hover:bg-atlas-surface-soft transition text-sm">Upload Another</button>
                </div>

                <div className="bg-atlas-surface border border-atlas-line rounded-xl overflow-hidden">
                  <div className="overflow-auto max-h-[600px]">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-atlas-surface">
                        <tr className="border-b border-atlas-line">
                          <th className="text-left py-3 px-4 text-atlas-ink-muted font-medium">Master SKU</th>
                          <th className="text-left py-3 px-4 text-atlas-ink-muted font-medium">FG Code</th>
                          <th className="text-right py-3 px-4 text-atlas-ink-muted font-medium">MRP</th>
                          {ntoResult.ntoColumns.map((c) => <th key={c} className="text-right py-3 px-4 text-atlas-ink-muted font-medium">{c}</th>)}
                          <th className="text-left py-3 px-4 text-atlas-ink-muted font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ntoResult.singles.map((r) => {
                          const single = skuLookup.get(r.master_sku.toLowerCase());
                          return (
                            <tr key={r.master_sku} className="border-b border-atlas-line/50 hover:bg-atlas-surface-soft/30">
                              <td className="py-2 px-4 font-mono text-xs">{r.master_sku}</td>
                              <td className="py-2 px-4 font-mono text-xs text-atlas-ink-muted">{single?.new_fg_code || "—"}</td>
                              <td className="py-2 px-4 text-right font-mono text-xs">{single?.mrp ?? "—"}</td>
                              {ntoResult.ntoColumns.map((c) => <td key={c} className="py-2 px-4 text-right font-mono text-xs">{(r.quantities[c] || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>)}
                              <td className="py-2 px-4 text-xs">
                                {r.status === "NOT IN MAPPER" ? <span className="px-2 py-0.5 rounded bg-atlas-amber-bg text-atlas-amber-warn text-[10px] uppercase">Not in Mapper</span> : <span className="px-2 py-0.5 rounded bg-atlas-green-bg text-atlas-green text-[10px] uppercase">Converted</span>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ====== MULTI-PLATFORM VIEW ====== */}
        {mode === "multi" && (
          <div className="space-y-6">
            {!multiResult ? (
              <>
                <div className="bg-atlas-surface border border-atlas-line rounded-xl p-6">
                  <div className="flex items-start justify-between mb-3 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-atlas-ink">Upload Multi-Platform Workbook</label>
                      <p className="text-xs text-atlas-ink-muted mt-1">
                        One Excel file with <span className="text-atlas-ink font-medium">two sheets</span>: <span className="font-mono text-atlas-ink">Quantity</span> and <span className="font-mono text-atlas-ink">NTO</span>.
                        Each sheet: <span className="font-mono text-atlas-ink">{inputIdentifier === "fg" ? "FG Code" : "Master SKU"}</span>, <span className="font-mono text-atlas-ink">Channel</span>, then one column per month.{inputIdentifier === "fg" && <span className="text-atlas-accent font-medium"> (6-digit+G FG Codes)</span>}
                        Both sheets must have the <span className="text-atlas-amber-warn">same months, same row count, and same (SKU × Channel) pairs</span> — a pre-conversion check enforces this.
                        Combos: Qty expands; NTO splits by MRP ratio.
                      </p>
                    </div>
                    <button
                      onClick={downloadMultiTemplate}
                      className="shrink-0 px-3 py-2 text-xs bg-atlas-surface-soft text-atlas-ink rounded-lg hover:bg-atlas-surface-soft transition whitespace-nowrap"
                    >
                      Download Template
                    </button>
                  </div>
                  <div className="border-2 border-dashed border-atlas-line rounded-xl p-10 text-center hover:border-atlas-line transition cursor-pointer"
                    onClick={() => document.getElementById("multi-file-input")?.click()}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) handleMultiFile(f); }}>
                    <input id="multi-file-input" type="file" accept=".xlsx,.xls,.csv" className="hidden"
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) handleMultiFile(f); (e.target as HTMLInputElement).value = ""; }} />
                    {processing ? <p className="text-atlas-accent font-medium">Processing...</p> : (
                      <>
                        <div className="text-3xl mb-2">⊞</div>
                        <p className="text-atlas-ink font-medium mb-1">Drop Multi-Platform Excel here</p>
                        <p className="text-atlas-ink-muted text-sm">Workbook with &quot;Quantity&quot; and &quot;NTO&quot; sheets{inputIdentifier === "fg" ? " (FG Code input)" : ""}</p>
                      </>
                    )}
                  </div>
                </div>
                {error && <div className="p-3 bg-atlas-red-bg border border-atlas-red rounded-lg"><p className="text-atlas-red text-sm">{error}</p></div>}
              </>
            ) : (
              <div>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
                  <div className="bg-atlas-surface border border-atlas-line rounded-xl p-4"><p className="text-xs text-atlas-ink-muted">Input Rows</p><p className="text-2xl font-bold">{multiResult.input.length}</p></div>
                  <div className="bg-atlas-green-bg border border-atlas-green/20 rounded-xl p-4"><p className="text-xs text-atlas-green font-medium">Singles × Channels</p><p className="text-2xl font-bold text-atlas-green">{multiResult.singles.length}</p></div>
                  <div className="bg-atlas-surface border border-atlas-line rounded-xl p-4"><p className="text-xs text-atlas-ink-muted">Months</p><p className="text-2xl font-bold">{multiResult.months.length}</p><p className="text-xs text-atlas-ink-muted mt-0.5">{multiResult.months.join(", ")}</p></div>
                  <div className="bg-atlas-red-bg border border-atlas-red/20 rounded-xl p-4"><p className="text-xs text-atlas-red font-medium">CRITICAL</p><p className={`text-2xl font-bold ${multiResult.criticals.filter(c => c.type === "MISSING_MRP").length > 0 ? "text-atlas-red" : "text-atlas-ink-faint"}`}>{multiResult.criticals.filter(c => c.type === "MISSING_MRP").length}</p></div>
                  <div className="bg-atlas-surface border border-atlas-line rounded-xl p-4"><p className="text-xs text-atlas-ink-muted">Warnings</p><p className={`text-2xl font-bold ${multiResult.warnings.length > 0 ? "text-atlas-amber-warn" : "text-atlas-ink-faint"}`}>{multiResult.warnings.length}</p></div>
                </div>

                {multiResult.criticals.filter(c => c.type === "MISSING_MRP").length > 0 && (
                  <div className="mb-6 p-4 bg-atlas-red-bg border border-atlas-red/30 rounded-xl">
                    <div className="flex items-start gap-3">
                      <span className="text-atlas-red text-xl leading-none">⚠</span>
                      <div className="flex-1">
                        <div className="text-atlas-red font-bold uppercase tracking-wider text-sm">CRITICAL — {multiResult.criticals.filter(c => c.type === "MISSING_MRP").length} combo-channel row(s): NTO not split (missing MRP)</div>
                        <div className="text-atlas-ink-soft text-xs mt-1">Qty still expanded for these, but NTO is zeroed. Set MRPs in SKU Master and re-run.</div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Unresolved FG Codes (Multi) */}
                {unresolvedFgCodes.length > 0 && (
                  <div className="mb-4 p-5 bg-atlas-accent-bg/30 border border-atlas-accent/30 rounded-xl">
                    <div className="flex items-center gap-2 mb-3">
                      <span className="text-atlas-accent text-lg leading-none">!</span>
                      <p className="text-sm font-semibold text-atlas-accent">{unresolvedFgCodes.length} FG Code(s) not found</p>
                    </div>
                    <p className="text-xs text-atlas-ink-muted mb-4">These FG Codes could not be mapped. Suggest adding them so an admin can review.</p>
                    <div className="space-y-3">
                      {unresolvedFgCodes.map((item, idx) => (
                        <div key={idx} className={`p-4 rounded-lg border ${item.submitted ? "bg-atlas-green-bg/30 border-atlas-green/30" : "bg-atlas-surface border-atlas-line"}`}>
                          <div className="flex items-center justify-between mb-2">
                            <span className="font-mono text-sm font-semibold text-atlas-ink">{item.fg_code}</span>
                            {item.submitted && <span className="text-xs text-atlas-green font-medium px-2 py-0.5 bg-atlas-green-bg rounded">Submitted</span>}
                          </div>
                          {!item.submitted && (
                            <div className="space-y-2">
                              <div className="flex gap-2 flex-wrap">
                                {(["add_single", "add_combo", "update_existing"] as const).map((act) => (
                                  <button key={act} onClick={() => updateUnresolvedFg(idx, "action", act)}
                                    className={`px-3 py-1.5 text-xs rounded-lg border transition ${item.action === act ? "bg-atlas-accent-bg text-atlas-accent border-atlas-accent/40 ring-1 ring-atlas-accent/30" : "bg-atlas-surface-soft text-atlas-ink-muted border-transparent hover:bg-atlas-surface-soft"}`}>
                                    {act === "add_single" ? "Add as New Single" : act === "add_combo" ? "Add as New Combo" : "Update Existing SKU"}
                                  </button>
                                ))}
                              </div>
                              {item.action === "add_combo" && (
                                <input type="text" value={item.comboComponents} onChange={(e) => updateUnresolvedFg(idx, "comboComponents", e.target.value)}
                                  placeholder="Component SKUs (comma-separated)" className="w-full px-3 py-2 text-xs bg-atlas-surface-soft border border-atlas-line rounded-lg font-mono focus:outline-none focus:ring-1 focus:ring-atlas-accent" />
                              )}
                              {item.action === "update_existing" && (
                                <input type="text" value={item.targetMasterSku} onChange={(e) => updateUnresolvedFg(idx, "targetMasterSku", e.target.value)}
                                  placeholder="Existing Master SKU to update" className="w-full px-3 py-2 text-xs bg-atlas-surface-soft border border-atlas-line rounded-lg font-mono focus:outline-none focus:ring-1 focus:ring-atlas-accent" />
                              )}
                              {item.action !== "none" && (
                                <button onClick={() => submitFgSuggestion(idx)} disabled={item.submitting || (item.action === "update_existing" && !item.targetMasterSku.trim()) || (item.action === "add_combo" && !item.comboComponents.trim())}
                                  className="px-4 py-1.5 text-xs bg-atlas-accent text-white font-semibold rounded-lg hover:bg-atlas-accent-deep transition disabled:opacity-50 disabled:cursor-not-allowed">
                                  {item.submitting ? "Submitting..." : "Submit Suggestion"}
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="flex gap-3 mb-4">
                  <button onClick={downloadMultiResult} className="px-5 py-2 bg-atlas-accent text-white font-semibold rounded-lg hover:bg-atlas-accent-deep transition text-sm">Download Output (Excel)</button>
                  <button onClick={() => { setMultiResult(null); setUnresolvedFgCodes([]); }} className="px-5 py-2 bg-atlas-surface-soft text-atlas-ink rounded-lg hover:bg-atlas-surface-soft transition text-sm">Upload Another</button>
                </div>

                <div className="bg-atlas-surface border border-atlas-line rounded-xl overflow-hidden">
                  <div className="overflow-auto max-h-[600px]">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-atlas-surface">
                        <tr className="border-b border-atlas-line">
                          <th className="text-left py-3 px-4 text-atlas-ink-muted font-medium">Master SKU</th>
                          <th className="text-left py-3 px-4 text-atlas-ink-muted font-medium">Channel</th>
                          {multiResult.months.map((m) => <th key={m} colSpan={2} className="text-center py-3 px-4 text-atlas-ink-muted font-medium border-l border-atlas-line">{m}</th>)}
                          <th className="text-left py-3 px-4 text-atlas-ink-muted font-medium">Status</th>
                        </tr>
                        <tr className="border-b border-atlas-line text-[10px] text-atlas-ink-muted">
                          <th></th><th></th>
                          {multiResult.months.map((m) => (
                            <Fragment key={m}>
                              <th className="text-right py-1 px-4 border-l border-atlas-line">Qty</th>
                              <th className="text-right py-1 px-4">NTO</th>
                            </Fragment>
                          ))}
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {multiResult.singles.map((r, i) => (
                          <tr key={`${r.master_sku}-${r.channel}-${i}`} className="border-b border-atlas-line/50 hover:bg-atlas-surface-soft/30">
                            <td className="py-2 px-4 font-mono text-xs">{r.master_sku}</td>
                            <td className="py-2 px-4 text-xs">{r.channel}</td>
                            {multiResult.months.map((m) => (
                              <Fragment key={m}>
                                <td className="py-2 px-4 text-right font-mono text-xs border-l border-atlas-line/50">{(r.qty[m] || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                                <td className="py-2 px-4 text-right font-mono text-xs">{(r.nto[m] || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                              </Fragment>
                            ))}
                            <td className="py-2 px-4 text-xs">
                              {r.status === "NOT IN MAPPER" ? <span className="px-2 py-0.5 rounded bg-atlas-amber-bg text-atlas-amber-warn text-[10px] uppercase">Not in Mapper</span> : <span className="px-2 py-0.5 rounded bg-atlas-green-bg text-atlas-green text-[10px] uppercase">Converted</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ====== UPLOAD SECTION (QTY ONLY — existing, untouched) ====== */}
        {mode === "qty" && !result && (
          <div className="space-y-6">
            {/* Mapper Source */}
            <div className="bg-atlas-surface border border-atlas-line rounded-xl p-6">
              <label className="block text-sm font-medium text-atlas-ink mb-3">1. Mapper Source</label>
              {isAdmin ? (
                <div className="flex gap-3">
                  <button onClick={() => setMapperSource("file")}
                    className={`flex-1 px-4 py-3 rounded-lg text-sm text-left transition border ${mapperSource === "file" ? "bg-atlas-blue-bg text-atlas-blue border-atlas-blue/30 ring-1 ring-atlas-blue" : "bg-atlas-surface-soft text-atlas-ink-muted border-transparent hover:bg-atlas-surface-soft"}`}>
                    <p className="font-medium">From File (Admin)</p>
                    <p className="text-xs mt-0.5 opacity-70">Excel with both "Combo" and "Mapper" sheets</p>
                  </button>
                  <button onClick={() => setMapperSource("db")}
                    className={`flex-1 px-4 py-3 rounded-lg text-sm text-left transition border ${mapperSource === "db" ? "bg-atlas-blue-bg text-atlas-blue border-atlas-blue/30 ring-1 ring-atlas-blue" : "bg-atlas-surface-soft text-atlas-ink-muted border-transparent hover:bg-atlas-surface-soft"}`}>
                    <p className="font-medium">Database Mapper</p>
                    <p className="text-xs mt-0.5 opacity-70">{mapperSets.length > 0 ? `${mapperSets.length} mappers available` : "None uploaded yet"}</p>
                  </button>
                </div>
              ) : (
                <div>
                  <p className="text-xs text-atlas-ink-muted mb-3">Select a mapper uploaded by admin to use for conversion.</p>
                </div>
              )}

              {/* DB mapper selector */}
              {mapperSource === "db" && (
                <div className="mt-4">
                  {mapperSets.length === 0 ? (
                    <p className="text-xs text-atlas-red">{isAdmin ? 'No mappers yet. Click "Manage Mappers" above to upload one.' : "No mappers available. Ask admin to upload."}</p>
                  ) : (
                    <div>
                      <label className="block text-xs text-atlas-ink-muted mb-1.5">Select mapper:</label>
                      <select value={selectedMapperSetId} onChange={(e) => setSelectedMapperSetId(e.target.value)}
                        className="w-full px-4 py-2.5 bg-atlas-surface-soft border border-atlas-line rounded-lg text-atlas-ink text-sm focus:outline-none focus:ring-2 focus:ring-atlas-blue">
                        <option value="">Choose a mapper...</option>
                        {mapperSets.map((ms) => (
                          <option key={ms.id} value={ms.id}>
                            {ms.name} ({ms.row_count} SKUs, P1-P{ms.product_column_count}){ms.is_default ? " [Default]" : ""}
                          </option>
                        ))}
                      </select>
                      {loadingMapper && <p className="text-xs text-atlas-ink-muted mt-2">Loading mapper data...</p>}
                      {!loadingMapper && dbMapperRows.length > 0 && (
                        <p className="text-xs text-atlas-green mt-2">Loaded: {dbMapperRows.length} SKUs, P1-P{dbProductCount}</p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Upload Combo File */}
            <div className="bg-atlas-surface border border-atlas-line rounded-xl p-6">
              <label className="block text-sm font-medium text-atlas-ink mb-3">
                2. Upload {mapperSource === "file" ? "Excel (Combo + Mapper sheets)" : "Combo Data"}
              </label>
              <div onClick={() => fileInputRef.current?.click()}
                onDragEnter={(e) => { e.preventDefault(); setDragActive(true); }}
                onDragLeave={(e) => { e.preventDefault(); setDragActive(false); }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); setDragActive(false); const f = e.dataTransfer.files?.[0]; if (f) handleComboFile(f); }}
                className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition ${dragActive ? "border-atlas-blue bg-atlas-blue-bg" : "border-atlas-line hover:border-atlas-line"}`}>
                <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleComboFile(f); if (fileInputRef.current) fileInputRef.current.value = ""; }} />
                {processing ? (
                  <p className="text-atlas-blue font-medium">Processing...</p>
                ) : (
                  <>
                    <div className="text-3xl mb-2">{"\uD83D\uDD04"}</div>
                    <p className="text-atlas-ink font-medium mb-1">Drop your Excel file here</p>
                    <p className="text-atlas-ink-muted text-sm">
                      {mapperSource === "file" ? 'Needs "Combo" + "Mapper" sheets' : 'Needs "Combo" sheet (or first sheet)'}
                      {inputIdentifier === "fg" && <span className="text-atlas-accent ml-1">(FG Code input)</span>}
                    </p>
                  </>
                )}
              </div>
            </div>

            {/* Format reference */}
            <div className="bg-atlas-surface border border-atlas-line rounded-xl p-6">
              <h3 className="text-sm font-medium text-atlas-ink mb-3">Expected Format</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                <div>
                  <p className="text-atlas-blue font-medium mb-1">Combo Sheet</p>
                  <div className="bg-atlas-surface-soft rounded p-3 font-mono">
                    <p className="text-atlas-ink-muted">{inputIdentifier === "fg" ? "FG Code" : "Master SKU"} | Amazon | Flipkart | ...</p>
                    <p className="text-atlas-ink">{inputIdentifier === "fg" ? "14244G     | 500    | 300      | ..." : "SKU_ABC    | 500    | 300      | ..."}</p>
                  </div>
                  <p className="text-atlas-ink-muted mt-1">Col 1 = {inputIdentifier === "fg" ? "FG Code (6-digit+G)" : "SKU"}, rest = qty columns (any names/count)</p>
                </div>
                <div>
                  <p className="text-atlas-blue font-medium mb-1">Mapper Sheet</p>
                  <div className="bg-atlas-surface-soft rounded p-3 font-mono">
                    <p className="text-atlas-ink-muted">_ | Master SKU | ... | Combo | ... | P1..P96</p>
                    <p className="text-atlas-ink">  | COMBO_XY   | ... | Yes   | ... | A | B ..</p>
                  </div>
                  <p className="text-atlas-ink-muted mt-1">Col B=SKU, G=Combo, J onwards=Products (auto-detects P1 to P96)</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ====== RESULTS (QTY ONLY — existing) ====== */}
        {mode === "qty" && result && (
          <div>
            {/* Summary */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
              <div className="bg-atlas-surface border border-atlas-line rounded-xl p-4">
                <p className="text-xs text-atlas-ink-muted">Input Rows</p>
                <p className="text-2xl font-bold">{result.consolidated.length}</p>
              </div>
              <div className="bg-atlas-green-bg border border-atlas-green/20 rounded-xl p-4">
                <p className="text-xs text-atlas-green font-medium">Singles Output</p>
                <p className="text-2xl font-bold text-atlas-green">{result.singles.length}</p>
              </div>
              <div className="bg-atlas-blue-bg border border-atlas-blue/20 rounded-xl p-4">
                <p className="text-xs text-atlas-blue font-medium">Combos Resolved</p>
                <p className="text-2xl font-bold text-atlas-blue">{result.consolidated.filter((r) => ["yes", "y"].includes(r.combo.toLowerCase())).length}</p>
              </div>
              <div className="bg-atlas-surface border border-atlas-line rounded-xl p-4">
                <p className="text-xs text-atlas-ink-muted">Qty Columns</p>
                <p className="text-2xl font-bold">{result.qtyColumns.length}</p>
                <p className="text-xs text-atlas-ink-muted mt-0.5">{result.qtyColumns.join(", ")}</p>
              </div>
              <div className="bg-atlas-surface border border-atlas-line rounded-xl p-4">
                <p className="text-xs text-atlas-ink-muted">Warnings</p>
                <p className={`text-2xl font-bold ${result.warnings.length > 0 ? "text-atlas-red" : "text-atlas-ink-faint"}`}>{result.warnings.length}</p>
              </div>
            </div>

            {/* Warnings */}
            {result.warnings.length > 0 && (
              <div className="mb-6 p-4 bg-atlas-amber-bg border border-atlas-amber-warn/30 rounded-xl">
                <p className="text-atlas-amber-warn text-sm font-medium mb-2">Warnings ({result.warnings.length})</p>
                <div className="max-h-[120px] overflow-y-auto space-y-1">
                  {result.warnings.map((w, i) => (<p key={i} className="text-xs text-atlas-ink-soft">{w}</p>))}
                </div>
              </div>
            )}

            {/* Unresolved FG Codes */}
            {unresolvedFgCodes.length > 0 && (
              <div className="mb-6 p-5 bg-atlas-accent-bg/30 border border-atlas-accent/30 rounded-xl">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-atlas-accent text-lg leading-none">!</span>
                  <p className="text-sm font-semibold text-atlas-accent">{unresolvedFgCodes.length} FG Code(s) not found</p>
                </div>
                <p className="text-xs text-atlas-ink-muted mb-4">These FG Codes could not be mapped. Suggest adding them so an admin can review.</p>
                <div className="space-y-3">
                  {unresolvedFgCodes.map((item, idx) => (
                    <div key={idx} className={`p-4 rounded-lg border ${item.submitted ? "bg-atlas-green-bg/30 border-atlas-green/30" : "bg-atlas-surface border-atlas-line"}`}>
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-mono text-sm font-semibold text-atlas-ink">{item.fg_code}</span>
                        {item.submitted && <span className="text-xs text-atlas-green font-medium px-2 py-0.5 bg-atlas-green-bg rounded">Submitted</span>}
                      </div>
                      {!item.submitted && (
                        <div className="space-y-2">
                          <div className="flex gap-2 flex-wrap">
                            {(["add_single", "add_combo", "update_existing"] as const).map((act) => (
                              <button key={act} onClick={() => updateUnresolvedFg(idx, "action", act)}
                                className={`px-3 py-1.5 text-xs rounded-lg border transition ${item.action === act ? "bg-atlas-accent-bg text-atlas-accent border-atlas-accent/40 ring-1 ring-atlas-accent/30" : "bg-atlas-surface-soft text-atlas-ink-muted border-transparent hover:bg-atlas-surface-soft"}`}>
                                {act === "add_single" ? "Add as New Single" : act === "add_combo" ? "Add as New Combo" : "Update Existing SKU"}
                              </button>
                            ))}
                          </div>
                          {item.action === "add_combo" && (
                            <input type="text" value={item.comboComponents} onChange={(e) => updateUnresolvedFg(idx, "comboComponents", e.target.value)}
                              placeholder="Component SKUs (comma-separated)" className="w-full px-3 py-2 text-xs bg-atlas-surface-soft border border-atlas-line rounded-lg font-mono focus:outline-none focus:ring-1 focus:ring-atlas-accent" />
                          )}
                          {item.action === "update_existing" && (
                            <input type="text" value={item.targetMasterSku} onChange={(e) => updateUnresolvedFg(idx, "targetMasterSku", e.target.value)}
                              placeholder="Existing Master SKU to update" className="w-full px-3 py-2 text-xs bg-atlas-surface-soft border border-atlas-line rounded-lg font-mono focus:outline-none focus:ring-1 focus:ring-atlas-accent" />
                          )}
                          {item.action !== "none" && (
                            <button onClick={() => submitFgSuggestion(idx)} disabled={item.submitting || (item.action === "update_existing" && !item.targetMasterSku.trim()) || (item.action === "add_combo" && !item.comboComponents.trim())}
                              className="px-4 py-1.5 text-xs bg-atlas-accent text-white font-semibold rounded-lg hover:bg-atlas-accent-deep transition disabled:opacity-50 disabled:cursor-not-allowed">
                              {item.submitting ? "Submitting..." : "Submit Suggestion"}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Tabs */}
            <div className="flex gap-2 mb-4">
              <button onClick={() => setActiveTab("singles")}
                className={`px-4 py-2 text-sm rounded-lg transition ${activeTab === "singles" ? "bg-atlas-green-bg text-atlas-green ring-1 ring-atlas-green" : "bg-atlas-surface-soft text-atlas-ink-muted hover:bg-atlas-surface-soft"}`}>
                Singles ({result.singles.length})
              </button>
              <button onClick={() => setActiveTab("consolidated")}
                className={`px-4 py-2 text-sm rounded-lg transition ${activeTab === "consolidated" ? "bg-atlas-blue-bg text-atlas-blue ring-1 ring-atlas-blue" : "bg-atlas-surface-soft text-atlas-ink-muted hover:bg-atlas-surface-soft"}`}>
                Consolidated ({result.consolidated.length})
              </button>
            </div>

            {/* Singles Table */}
            {activeTab === "singles" && (
              <div className="bg-atlas-surface border border-atlas-line rounded-xl overflow-hidden">
                <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-atlas-surface z-10">
                      <tr className="border-b border-atlas-line">
                        <th className="text-left py-3 px-4 text-atlas-ink-muted font-medium">Master SKU</th>
                        <th className="text-left py-3 px-4 text-atlas-ink-muted font-medium">FG Code</th>
                        <th className="text-left py-3 px-4 text-atlas-ink-muted font-medium">Product Name</th>
                        <th className="text-left py-3 px-4 text-atlas-ink-muted font-medium">Status</th>
                        {result.qtyColumns.map((col) => (<th key={col} className="text-right py-3 px-4 text-atlas-ink-muted font-medium">{col}</th>))}
                        <th className="text-right py-3 px-4 text-atlas-ink-muted font-medium">Row Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.singles.map((row, i) => {
                        const rt = result.qtyColumns.reduce((s, c) => s + (row.quantities[c] || 0), 0);
                        const sku = skuLookup.get(row.master_sku.toLowerCase());
                        return (
                          <tr key={i} className={`border-b border-atlas-line/50 hover:bg-atlas-surface-soft/20 ${row.status === "NOT IN MAPPER" ? "bg-atlas-red-bg" : ""}`}>
                            <td className="py-2.5 px-4 font-mono text-xs">{row.master_sku}</td>
                            <td className="py-2.5 px-4 font-mono text-xs">{sku?.new_fg_code || <span className="text-atlas-ink-faint">—</span>}</td>
                            <td className="py-2.5 px-4 text-xs text-atlas-ink truncate max-w-[200px]" title={sku?.product_name || ""}>{sku?.product_name || <span className="text-atlas-ink-faint">—</span>}</td>
                            <td className="py-2.5 px-4"><span className={`px-2 py-0.5 rounded text-xs ${row.status === "Converted" ? "bg-atlas-green-bg text-atlas-green" : "bg-atlas-red-bg text-atlas-red"}`}>{row.status}</span></td>
                            {result.qtyColumns.map((col) => (
                              <td key={col} className="py-2.5 px-4 text-right font-mono text-xs">
                                {(row.quantities[col] || 0) > 0 ? Math.round((row.quantities[col] || 0) * 100) / 100 : <span className="text-atlas-ink-faint">-</span>}
                              </td>
                            ))}
                            <td className="py-2.5 px-4 text-right font-mono text-xs font-medium">{Math.round(rt * 100) / 100}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="bg-atlas-surface-soft/50">
                        <td className="py-3 px-4 font-semibold" colSpan={4}>Total</td>
                        {result.qtyColumns.map((col) => (
                          <td key={col} className="py-3 px-4 text-right font-mono font-bold text-atlas-blue">
                            {Math.round(result.singles.reduce((s, r) => s + (r.quantities[col] || 0), 0) * 100) / 100}
                          </td>
                        ))}
                        <td className="py-3 px-4 text-right font-mono font-bold text-atlas-ink">
                          {Math.round(result.singles.reduce((s, r) => s + result.qtyColumns.reduce((ss, c) => ss + (r.quantities[c] || 0), 0), 0) * 100) / 100}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            )}

            {/* Consolidated Table */}
            {activeTab === "consolidated" && (
              <div>
                {/* Re-convert banner for unmapped edits */}
                {unmappedEdits.size > 0 && (
                  <div className="mb-4 p-4 bg-atlas-blue-bg border border-atlas-blue/30 rounded-xl">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-atlas-blue font-medium">{unmappedEdits.size} unmapped SKU(s) — edit Combo & Components below</p>
                        <p className="text-xs text-atlas-blue/60 mt-0.5">Set Combo = Yes/No. Enter component SKUs comma-separated. Then Re-Convert for instant results, or Submit to add permanently.</p>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={handleReConvert}
                          className="px-4 py-2 text-sm bg-atlas-blue text-white font-semibold rounded-lg hover:bg-atlas-blue/80 transition whitespace-nowrap">
                          Re-Convert
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Submit banner — visible whenever there are NOT_IN_MAPPER rows */}
                {result.consolidated.some((r) => r.mapper_status === "NOT IN MAPPER") && (
                  <div className="mb-4 p-4 bg-orange-900/20 border border-atlas-blue/30 rounded-xl">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-atlas-blue font-medium">Submit unmapped SKUs for admin approval</p>
                        <p className="text-xs text-atlas-blue/60 mt-0.5">Fill in Combo & Components for unmapped SKUs above, then submit to add them permanently to a mapper.</p>
                      </div>
                      <button onClick={submitSuggestions}
                        className="px-4 py-2 text-sm bg-atlas-navy text-white font-semibold rounded-lg hover:bg-atlas-navy-soft transition whitespace-nowrap">
                        Submit to Mapper
                      </button>
                    </div>
                    {submitMsg && (
                      <p className={`mt-2 text-xs ${submitMsg.includes("Failed") ? "text-atlas-red" : "text-atlas-green"}`}>{submitMsg}</p>
                    )}
                  </div>
                )}

                <div className="bg-atlas-surface border border-atlas-line rounded-xl overflow-hidden">
                  <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-atlas-surface z-10">
                        <tr className="border-b border-atlas-line">
                          <th className="text-left py-3 px-4 text-atlas-ink-muted font-medium">Master SKU</th>
                          <th className="text-left py-3 px-4 text-atlas-ink-muted font-medium">FG Code</th>
                          {result.qtyColumns.map((col) => (<th key={col} className="text-right py-3 px-4 text-atlas-ink-muted font-medium">{col}</th>))}
                          <th className="text-left py-3 px-4 text-atlas-ink-muted font-medium">Mapper</th>
                          <th className="text-left py-3 px-4 text-atlas-ink-muted font-medium w-24">Combo</th>
                          <th className="text-left py-3 px-4 text-atlas-ink-muted font-medium">Components</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...result.consolidated].sort((a, b) => {
                          const aUnmapped = a.mapper_status === "NOT IN MAPPER" ? 0 : 1;
                          const bUnmapped = b.mapper_status === "NOT IN MAPPER" ? 0 : 1;
                          return aUnmapped - bUnmapped;
                        }).map((row, i) => {
                          const isUnmapped = row.mapper_status === "NOT IN MAPPER";
                          const edit = unmappedEdits.get(row.master_sku);
                          const mapperRow = allMapperRows.find((m) => m.master_sku === row.master_sku);
                          return (
                            <tr key={i} className={`border-b border-atlas-line/50 hover:bg-atlas-surface-soft/20 ${isUnmapped ? "bg-atlas-red-bg" : ""}`}>
                              <td className="py-2.5 px-4 font-mono text-xs">{row.master_sku}</td>
                              <td className="py-2.5 px-4 font-mono text-xs text-atlas-ink-muted">{mapperRow?.fg_code || <span className="text-atlas-ink-faint">-</span>}</td>
                              {result.qtyColumns.map((col) => (
                                <td key={col} className="py-2.5 px-4 text-right font-mono text-xs">{(row.quantities[col] || 0) > 0 ? Math.round((row.quantities[col] || 0) * 100) / 100 : <span className="text-atlas-ink-faint">-</span>}</td>
                              ))}
                              <td className="py-2.5 px-4">
                                <span className={`px-2 py-0.5 rounded text-xs ${row.mapper_status === "Found" ? "bg-atlas-green-bg text-atlas-green" : "bg-atlas-red-bg text-atlas-red"}`}>{row.mapper_status}</span>
                              </td>
                              <td className="py-2.5 px-4 text-xs">
                                {isUnmapped && edit ? (
                                  <select value={edit.combo}
                                    onChange={(e) => { const next = new Map(unmappedEdits); next.set(row.master_sku, { ...edit, combo: e.target.value }); setUnmappedEdits(next); }}
                                    className="w-20 px-2 py-1 bg-atlas-surface-soft border border-atlas-blue/50 rounded text-xs text-atlas-ink focus:outline-none focus:ring-1 focus:ring-atlas-blue">
                                    <option value="No">No</option>
                                    <option value="Yes">Yes</option>
                                  </select>
                                ) : (
                                  <span>{row.combo || <span className="text-atlas-ink-faint">-</span>}</span>
                                )}
                              </td>
                              <td className="py-2.5 px-4 text-xs">
                                {isUnmapped && edit ? (
                                  <input type="text" value={edit.products} placeholder="SKU_A, SKU_B, ..."
                                    onChange={(e) => { const next = new Map(unmappedEdits); next.set(row.master_sku, { ...edit, products: e.target.value }); setUnmappedEdits(next); }}
                                    className="w-full min-w-[200px] px-2 py-1 bg-atlas-surface-soft border border-atlas-blue/50 rounded text-xs text-atlas-ink placeholder-atlas-ink-faint focus:outline-none focus:ring-1 focus:ring-atlas-blue" />
                                ) : (
                                  <span className="text-atlas-ink-muted max-w-[300px] truncate block">{row.products.filter((p) => p).join(", ") || <span className="text-atlas-ink-faint">-</span>}</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ====== DAILY PENDING-QTY VIEW ====== */}
        {mode === "daily" && (
          <div className="space-y-6">
            {!dailyResult ? (
              <div className="bg-atlas-surface border border-atlas-line rounded-xl p-6">
                <label className="block text-sm font-medium text-atlas-ink">Upload Daily Pending-Qty File</label>
                <p className="text-xs text-atlas-ink-muted mt-1 mb-4">
                  One sheet with columns <span className="font-mono text-atlas-ink">FG Code</span>, <span className="font-mono text-atlas-ink">Product Name</span>, and an order-qty column
                  (e.g. <span className="font-mono text-atlas-ink">Sum of Order Qty</span>). Each FG Code is resolved to its Master SKU, combos are expanded into singles,
                  and you get back a single flat sheet: <span className="text-atlas-ink font-medium">Master SKU · FG Code · Product Name · Qty · Remarks</span>.
                  Rows whose Master SKU isn&apos;t in the mapper are copied through and flagged <span className="text-atlas-amber-warn font-medium">Not in Mapper</span>.
                </p>
                <label
                  className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-xl py-12 cursor-pointer transition ${dragActive ? "border-atlas-accent bg-atlas-accent-bg/30" : "border-atlas-line hover:border-atlas-accent/50 hover:bg-atlas-surface-soft/30"}`}
                  onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
                  onDragLeave={() => setDragActive(false)}
                  onDrop={(e) => { e.preventDefault(); setDragActive(false); const f = e.dataTransfer.files?.[0]; if (f) handleDailyFile(f); }}
                >
                  <svg className="w-10 h-10 text-atlas-ink-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.9A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" /></svg>
                  <p className="text-sm text-atlas-ink">{processing ? "Processing…" : "Drop the pending-qty Excel here, or click to browse"}</p>
                  <p className="text-xs text-atlas-ink-muted">Uses the selected DB mapper &amp; SKU Master · FG Codes matched exactly, then by base number</p>
                  <input type="file" accept=".xlsx,.xls" className="hidden" disabled={processing}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) handleDailyFile(f); e.currentTarget.value = ""; }} />
                </label>
                {mapperSource === "db" && (
                  <p className="text-xs text-atlas-ink-muted mt-3">
                    Mapper: <span className="text-atlas-ink font-medium">{mapperSets.find((s) => s.id === selectedMapperSetId)?.name || "—"}</span>
                    {loadingMapper ? " · loading…" : ` · ${dbMapperRows.length} rows`}
                  </p>
                )}
              </div>
            ) : (
              <div>
                {/* Summary tiles */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                  <div className="bg-atlas-surface border border-atlas-line rounded-xl p-4">
                    <p className="text-xs text-atlas-ink-muted">Input Rows</p>
                    <p className="text-2xl font-bold">{dailyResult.inputCount}</p>
                  </div>
                  <div className="bg-atlas-surface border border-atlas-line rounded-xl p-4">
                    <p className="text-xs text-atlas-ink-muted">Output Singles</p>
                    <p className="text-2xl font-bold text-atlas-green">{dailyResult.rows.length}</p>
                  </div>
                  <div className="bg-atlas-surface border border-atlas-line rounded-xl p-4">
                    <p className="text-xs text-atlas-ink-muted">Combos Expanded</p>
                    <p className="text-2xl font-bold text-atlas-blue">{dailyResult.comboExpandedCount}</p>
                  </div>
                  <div className="bg-atlas-surface border border-atlas-line rounded-xl p-4">
                    <p className="text-xs text-atlas-ink-muted">Not in Mapper</p>
                    <p className={`text-2xl font-bold ${dailyResult.notInMapperCount > 0 ? "text-atlas-amber-warn" : "text-atlas-ink-faint"}`}>{dailyResult.notInMapperCount}</p>
                  </div>
                </div>

                <div className="flex gap-3 mb-4">
                  <button onClick={downloadDailyResult} className="px-5 py-2 bg-atlas-navy text-white font-semibold rounded-lg hover:bg-atlas-navy-soft transition text-sm">Download Singles (Excel)</button>
                  <button onClick={() => setDailyResult(null)} className="px-5 py-2 bg-atlas-surface-soft text-atlas-ink rounded-lg hover:bg-atlas-surface-soft transition text-sm">Upload Another</button>
                </div>

                <div className="bg-atlas-surface border border-atlas-line rounded-xl overflow-hidden">
                  <div className="overflow-auto max-h-[600px]">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-atlas-surface">
                        <tr className="border-b border-atlas-line">
                          <th className="text-left py-3 px-4 text-atlas-ink-muted font-medium">Master SKU</th>
                          <th className="text-left py-3 px-4 text-atlas-ink-muted font-medium">FG Code</th>
                          <th className="text-left py-3 px-4 text-atlas-ink-muted font-medium">Product Name</th>
                          <th className="text-right py-3 px-4 text-atlas-ink-muted font-medium">Qty</th>
                          <th className="text-left py-3 px-4 text-atlas-ink-muted font-medium">Remarks</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dailyResult.rows.map((r, i) => (
                          <tr key={`${r.master_sku || r.fg_code}-${i}`} className="border-b border-atlas-line/50 hover:bg-atlas-surface-soft/30">
                            <td className="py-2 px-4 font-mono text-xs">{r.master_sku || <span className="text-atlas-ink-faint">—</span>}</td>
                            <td className="py-2 px-4 font-mono text-xs text-atlas-ink-muted">{r.fg_code || "—"}</td>
                            <td className="py-2 px-4 text-xs text-atlas-ink-soft max-w-[420px] truncate" title={r.product_name}>{r.product_name || "—"}</td>
                            <td className="py-2 px-4 text-right font-mono text-xs">{r.qty.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                            <td className="py-2 px-4 text-xs">
                              {r.remark === "Not in Mapper"
                                ? <span className="px-2 py-0.5 rounded bg-atlas-amber-bg text-atlas-amber-warn text-[10px] uppercase">Not in Mapper</span>
                                : <span className="px-2 py-0.5 rounded bg-atlas-green-bg text-atlas-green text-[10px] uppercase">Converted</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ====== ROW EDITOR MODAL (Admin) ====== */}
      {rowEditorSetId && isAdmin && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={(e) => { if (e.target === e.currentTarget) closeRowEditor(); }}>
          <div className="bg-atlas-surface border border-atlas-accent/30 rounded-xl w-full max-w-[1400px] max-h-[90vh] flex flex-col shadow-2xl">
            <div className="flex items-center justify-between p-5 border-b border-atlas-line">
              <div>
                <h3 className="text-lg font-semibold text-atlas-accent">Mapper Row Editor</h3>
                <p className="text-xs text-atlas-ink-muted mt-0.5">
                  {mapperSets.find((s) => s.id === rowEditorSetId)?.name} · {editorRows.length} row(s)
                  {(() => {
                    const critical = editorRows.filter((r) => isCriticalRow(r)).length;
                    const issues = editorRows.filter((r) => hasInconsistency(r) && !isCriticalRow(r)).length;
                    return (
                      <>
                        {critical > 0 && <span className="ml-2 text-atlas-red font-semibold">· {critical} CRITICAL</span>}
                        {issues > 0 && <span className="ml-2 text-atlas-blue">· {issues} with issues</span>}
                      </>
                    );
                  })()}
                  <span className="ml-2 text-atlas-ink-faint">· Safe direction auto-corrected (silent, logged). Critical requires manual fix.</span>
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={addEditorRow} className="px-3 py-1.5 text-xs bg-atlas-green-bg text-atlas-green ring-1 ring-atlas-green/40 rounded-lg hover:bg-atlas-green-bg transition">+ Add Row</button>
                <button onClick={closeRowEditor} className="px-3 py-1.5 text-xs bg-atlas-surface-soft text-atlas-ink rounded-lg hover:bg-atlas-surface-soft transition">Close</button>
              </div>
            </div>

            <div className="flex items-center gap-3 px-5 py-3 border-b border-atlas-line">
              <input
                type="text"
                placeholder="Search Master SKU or component..."
                value={editorSearch}
                onChange={(e) => setEditorSearch(e.target.value)}
                className="flex-1 px-3 py-1.5 bg-atlas-surface-soft border border-atlas-line rounded text-sm text-atlas-ink placeholder-atlas-ink-faint focus:outline-none focus:ring-1 focus:ring-atlas-accent"
              />
              <label className="flex items-center gap-2 text-xs text-atlas-ink-muted cursor-pointer">
                <input type="checkbox" checked={editorIssuesOnly} onChange={(e) => setEditorIssuesOnly(e.target.checked)} className="accent-purple-500" />
                Issues only
              </label>
            </div>

            {(() => {
              const criticalRows = editorRows.filter((r) => isCriticalRow(r));
              if (criticalRows.length === 0) return null;
              return (
                <div className="px-5 py-3 text-xs bg-atlas-red-bg text-atlas-red border-b border-atlas-red/40">
                  <div className="font-bold text-atlas-red uppercase tracking-wider mb-1">⚠ {criticalRows.length} Critical row{criticalRows.length > 1 ? "s" : ""} — Admin action required</div>
                  <div className="text-atlas-red/80">
                    These rows have <span className="font-mono">Combo=Yes</span> but no components. Combos cannot expand into singles and will silently drop from conversions. Either add the component SKUs, or uncheck the Combo flag if the SKU is actually a single.
                  </div>
                </div>
              );
            })()}
            {editorMsg && (
              <div className="px-5 py-2 text-xs bg-atlas-red-bg text-atlas-red border-b border-atlas-red/20">{editorMsg}</div>
            )}

            <div className="flex-1 overflow-hidden flex">
              {/* Rows table */}
              <div className="flex-1 overflow-auto">
                {editorLoading ? (
                  <div className="p-8 text-center text-atlas-ink-muted text-sm">Loading rows...</div>
                ) : (
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-atlas-surface z-10">
                      <tr className="border-b border-atlas-line">
                        <th className="text-left py-2 px-3 text-atlas-ink-muted font-medium w-10">!</th>
                        <th className="text-left py-2 px-3 text-atlas-ink-muted font-medium">Master SKU</th>
                        <th className="text-left py-2 px-3 text-atlas-ink-muted font-medium w-20">Combo</th>
                        <th className="text-left py-2 px-3 text-atlas-ink-muted font-medium w-28">FG Code</th>
                        <th className="text-left py-2 px-3 text-atlas-ink-muted font-medium">Components (comma-separated)</th>
                        <th className="text-right py-2 px-3 text-atlas-ink-muted font-medium w-32">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {editorRows
                        .map((r, origIdx) => ({ r, origIdx }))
                        .filter(({ r }) => {
                          if (editorIssuesOnly && !hasInconsistency(r)) return false;
                          if (editorSearch) {
                            const q = editorSearch.toLowerCase();
                            if (!r.master_sku.toLowerCase().includes(q) && !r.products.toLowerCase().includes(q) && !r.fg_code.toLowerCase().includes(q)) return false;
                          }
                          return true;
                        })
                        .map(({ r, origIdx }) => {
                          const critical = isCriticalRow(r);
                          const issue = hasInconsistency(r);
                          const rowBg = critical ? "bg-atlas-red-bg hover:bg-atlas-red-bg" : issue ? "bg-atlas-amber-bg" : r.isNew ? "bg-atlas-green-bg" : "";
                          return (
                            <tr key={origIdx} className={`border-b border-atlas-line/50 ${rowBg} ${r.dirty ? "ring-1 ring-atlas-blue/20" : ""}`}>
                              <td className="py-1.5 px-3">
                                {critical ? (
                                  <span title="CRITICAL: Combo=Yes but no components — cannot expand" className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-atlas-red-bg text-atlas-red font-bold text-[10px] uppercase ring-1 ring-atlas-red/60">⚠ Crit</span>
                                ) : issue ? (
                                  <span title="Inconsistent: Combo flag doesn't match components (will auto-correct on save)" className="text-atlas-amber-warn">⚠</span>
                                ) : r.dirty ? (
                                  <span className="text-atlas-blue" title="Unsaved">●</span>
                                ) : ""}
                              </td>
                              <td className="py-1.5 px-3">
                                {r.isNew ? (
                                  <input type="text" value={r.master_sku} onChange={(e) => updateEditorRow(origIdx, "master_sku", e.target.value)} placeholder="Master SKU" className="w-full px-2 py-1 bg-atlas-surface-soft border border-atlas-line rounded font-mono text-xs" />
                                ) : (
                                  <span className="font-mono text-atlas-ink">{r.master_sku}</span>
                                )}
                              </td>
                              <td className="py-1.5 px-3">
                                <select value={r.is_combo ? "Yes" : "No"} onChange={(e) => updateEditorRow(origIdx, "is_combo", e.target.value === "Yes")} className="w-full px-2 py-1 bg-atlas-surface-soft border border-atlas-line rounded text-xs">
                                  <option value="No">No</option>
                                  <option value="Yes">Yes</option>
                                </select>
                              </td>
                              <td className="py-1.5 px-3">
                                <input type="text" value={r.fg_code} onChange={(e) => updateEditorRow(origIdx, "fg_code", e.target.value)} placeholder="FG Code" className="w-full px-2 py-1 bg-atlas-surface-soft border border-atlas-line rounded font-mono text-xs" />
                              </td>
                              <td className="py-1.5 px-3">
                                <textarea value={r.products} onChange={(e) => updateEditorRow(origIdx, "products", e.target.value)} placeholder="SKU_A, SKU_B, ..." rows={1} className="w-full px-2 py-1 bg-atlas-surface-soft border border-atlas-line rounded font-mono text-xs resize-y min-h-[28px]" />
                              </td>
                              <td className="py-1.5 px-3 text-right">
                                <div className="flex gap-1 justify-end">
                                  <button onClick={() => saveEditorRow(origIdx)} disabled={r.saving || !r.dirty}
                                    className="px-2 py-0.5 text-xs bg-atlas-accent-bg text-atlas-accent rounded hover:bg-atlas-accent-bg disabled:opacity-30 disabled:cursor-not-allowed transition">
                                    {r.saving ? "..." : "Save"}
                                  </button>
                                  <button onClick={() => deleteEditorRow(origIdx)} disabled={r.saving}
                                    className="px-2 py-0.5 text-xs bg-atlas-red-bg text-atlas-red rounded hover:bg-atlas-red-bg transition">
                                    Del
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                )}
              </div>

              {/* History panel */}
              <div className="w-72 border-l border-atlas-line flex flex-col">
                <div className="px-4 py-2 text-xs font-semibold text-atlas-ink-muted border-b border-atlas-line bg-atlas-surface">Session History ({editorHistory.length})</div>
                <div className="flex-1 overflow-auto">
                  {editorHistory.length === 0 ? (
                    <p className="p-4 text-xs text-atlas-ink-faint">No changes yet this session. Auto-corrections will be logged here.</p>
                  ) : (
                    <div className="divide-y divide-atlas-line">
                      {editorHistory.map((h, i) => (
                        <div key={i} className="p-3 text-xs">
                          <div className="flex items-center justify-between">
                            <span className={`font-mono ${h.action === "Auto-correct" ? "text-atlas-amber-warn" : h.action === "Deleted" ? "text-atlas-red" : "text-atlas-green"}`}>{h.action}</span>
                            <span className="text-atlas-ink-faint">{h.ts}</span>
                          </div>
                          <div className="font-mono text-atlas-ink mt-0.5 truncate" title={h.master_sku}>{h.master_sku}</div>
                          <div className="text-atlas-ink-muted mt-0.5">{h.details}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}

// ========== SUGGESTION APPROVAL CARD ==========

function SuggestionCard({ suggestion, mapperSets, onApprove, onReject }: {
  suggestion: any;
  mapperSets: MapperSet[];
  onApprove: (mapperIds: string[]) => void;
  onReject: (note?: string) => void;
}) {
  const [selectedMappers, setSelectedMappers] = useState<Set<string>>(new Set());
  const [editCombo, setEditCombo] = useState(suggestion.is_combo ? "Yes" : "No");
  const [editProducts, setEditProducts] = useState((suggestion.products || []).join(", "));
  const [rejectNote, setRejectNote] = useState("");
  const [showReject, setShowReject] = useState(false);

  function toggleMapper(id: string) {
    setSelectedMappers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function handleApprove() {
    if (selectedMappers.size === 0) return;
    // Update suggestion with any admin edits before approving
    suggestion.is_combo = editCombo.toLowerCase() === "yes";
    suggestion.products = editProducts.split(",").map((p: string) => p.trim()).filter((p: string) => p);
    onApprove([...selectedMappers]);
  }

  return (
    <div className="p-4 bg-atlas-surface-soft rounded-lg">
      <div className="flex items-start justify-between mb-3">
        <div>
          <span className="font-mono text-sm font-medium text-atlas-ink">{suggestion.master_sku}</span>
          <span className="ml-2 text-xs text-atlas-ink-muted">by {suggestion.submitted_by_email?.split("@")[0] || "unknown"}</span>
          <span className="ml-2 text-xs text-atlas-ink-faint">{new Date(suggestion.created_at).toLocaleDateString()}</span>
        </div>
      </div>

      {/* Editable fields - admin can modify before approving */}
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label className="block text-xs text-atlas-ink-muted mb-1">Combo</label>
          <select value={editCombo} onChange={(e) => setEditCombo(e.target.value)}
            className="w-full px-2 py-1.5 bg-atlas-surface border border-atlas-line rounded text-xs text-atlas-ink focus:outline-none focus:ring-1 focus:ring-atlas-blue">
            <option value="No">No</option>
            <option value="Yes">Yes</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-atlas-ink-muted mb-1">Components (comma-separated)</label>
          <input type="text" value={editProducts} onChange={(e) => setEditProducts(e.target.value)}
            className="w-full px-2 py-1.5 bg-atlas-surface border border-atlas-line rounded text-xs text-atlas-ink focus:outline-none focus:ring-1 focus:ring-atlas-blue" />
        </div>
      </div>

      {/* Select which mappers to add to */}
      <div className="mb-3">
        <label className="block text-xs text-atlas-ink-muted mb-1.5">Add to mapper(s):</label>
        <div className="flex flex-wrap gap-2">
          {mapperSets.map((ms) => (
            <button key={ms.id} onClick={() => toggleMapper(ms.id)}
              className={`px-3 py-1 text-xs rounded-lg transition border ${selectedMappers.has(ms.id) ? "bg-atlas-green-bg text-atlas-green border-atlas-green/50" : "bg-atlas-surface text-atlas-ink-muted border-atlas-line hover:border-atlas-line"}`}>
              {ms.name}
            </button>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <button onClick={handleApprove} disabled={selectedMappers.size === 0}
          className="px-4 py-1.5 text-xs bg-atlas-green text-white font-semibold rounded-lg hover:bg-atlas-green/80 disabled:opacity-40 disabled:cursor-not-allowed transition">
          Approve & Add to {selectedMappers.size} mapper(s)
        </button>
        {!showReject ? (
          <button onClick={() => setShowReject(true)} className="px-4 py-1.5 text-xs bg-atlas-surface-soft text-atlas-ink rounded-lg hover:bg-atlas-surface-soft transition">
            Reject
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <input type="text" placeholder="Reason (optional)" value={rejectNote} onChange={(e) => setRejectNote(e.target.value)}
              className="px-2 py-1.5 bg-atlas-surface border border-atlas-line rounded text-xs text-atlas-ink placeholder-atlas-ink-faint focus:outline-none w-48" />
            <button onClick={() => { onReject(rejectNote); setShowReject(false); }}
              className="px-3 py-1.5 text-xs bg-atlas-red text-white rounded-lg hover:bg-atlas-red/80 transition">Confirm</button>
            <button onClick={() => setShowReject(false)} className="text-xs text-atlas-ink-muted">Cancel</button>
          </div>
        )}
      </div>
    </div>
  );
}