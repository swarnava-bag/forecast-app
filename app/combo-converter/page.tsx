"use client";
import { useEffect, useState, useRef, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import * as XLSX from "xlsx";
import Link from "next/link";

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
  const json = XLSX.utils.sheet_to_json<any>(ws);
  if (json.length === 0) return { comboRows: [], qtyColumns: [] };
  const headers = Object.keys(json[0]);
  const skuCol = headers.find((h) => h.toLowerCase().includes("master") || h.toLowerCase().includes("sku")) || headers[0];
  const qtyColumns = headers.filter((h) => h !== skuCol && h.trim() !== "");
  const comboRows: ComboInputRow[] = [];
  for (const row of json) {
    const sku = String(row[skuCol] || "").trim();
    if (!sku) continue;
    const quantities: Record<string, number> = {};
    for (const col of qtyColumns) { const val = Number(row[col]); quantities[col] = isNaN(val) ? 0 : val; }
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

  // Build singles
  const singles: SinglesRow[] = [];
  for (const sku of [...allSkus].sort()) {
    if (notInMapper.has(sku)) {
      const quantities: Record<string, number> = {};
      for (const col of qtyColumns) quantities[col] = consolidated.filter((r) => r.master_sku === sku).reduce((s, r) => s + (r.quantities[col] || 0), 0);
      if (Object.values(quantities).some((v) => v > 0)) singles.push({ master_sku: sku, quantities, status: "NOT IN MAPPER" });
      continue;
    }
    if (comboSkus.has(sku)) continue;
    const quantities: Record<string, number> = {};
    for (const col of qtyColumns) {
      let total = 0;
      if (!comboSkus.has(sku)) total += consolidated.filter((r) => r.master_sku === sku).reduce((s, r) => s + (r.quantities[col] || 0), 0);
      for (const row of consolidated) { for (const p of row.products) { if (p === sku) total += row.quantities[col] || 0; } }
      quantities[col] = total;
    }
    if (Object.values(quantities).some((v) => v > 0)) singles.push({ master_sku: sku, quantities, status: "Converted" });
  }
  return { consolidated, singles, qtyColumns, productCount, warnings };
}

// ========== EXCEL OUTPUT ==========

function buildOutputExcel(result: ConversionResult, mapperRows: MapperRow[], skuMap?: Map<string, SingleSku>): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  const consData = result.consolidated.map((r) => {
    const row: any = { "Master SKU": r.master_sku };
    for (const col of result.qtyColumns) row[col] = r.quantities[col] || 0;
    row["Mapper_Status"] = r.mapper_status; row["Combo"] = r.combo;
    r.products.forEach((p, i) => { if (p) row[`P${i + 1}`] = p; });
    return row;
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(consData), "Consolidated");
  const singData = result.singles.map((r) => {
    const sku = skuMap?.get(r.master_sku.toLowerCase());
    const row: any = { "Master SKU": r.master_sku, "FG Code": sku?.new_fg_code || "", "Product Name": sku?.product_name || "", "Status": r.status };
    for (const col of result.qtyColumns) row[col] = Math.round((r.quantities[col] || 0) * 100) / 100;
    return row;
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(singData), "Singles");
  const mapData = mapperRows.map((m) => {
    const row: any = { "Master_SKU": m.master_sku, "Combo": m.combo };
    m.products.forEach((p, i) => { if (p) row[`P${i + 1}`] = p; });
    return row;
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(mapData), "Mapper_Used");
  return wb;
}

// ========== COMPONENT ==========

type SingleSku = { new_master_sku: string; new_fg_code: string; product_name: string };

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
  // Conversion
  const [result, setResult] = useState<ConversionResult | null>(null);
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mapperFileRef = useRef<HTMLInputElement>(null);
  const supabase = createClient();

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
        .select("new_master_sku, new_fg_code, product_name")
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
        const convResult = runConversion(comboRows, mapperRows, qtyColumns, productCount);
        setResult(convResult);
        setCachedComboRows(comboRows);
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

  // ==================== RENDER ====================

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 text-white">
        <nav className="border-b border-gray-800 bg-gray-900"><div className="max-w-7xl mx-auto px-6 py-4"><Link href="/dashboard" className="text-lg font-bold text-white">Demand Planning Module - Yogabars</Link></div></nav>
        <div className="flex items-center justify-center h-64"><p className="text-gray-400">Loading...</p></div>
      </div>
    );
  }

  const isAdmin = profile?.role === "admin";
  const selectedSetInfo = mapperSets.find((s) => s.id === selectedMapperSetId);

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <nav className="border-b border-gray-800 bg-gray-900">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/dashboard" className="text-lg font-bold text-white">Demand Planning Module - Yogabars</Link>
            <div className="hidden md:flex items-center gap-4">
              <Link href="/dashboard" className="text-sm text-gray-400 hover:text-white transition">Dashboard</Link>
              <Link href="/upload" className="text-sm text-gray-400 hover:text-white transition">Upload</Link>
              <Link href="/channels" className="text-sm text-gray-400 hover:text-white transition">Forecast View</Link>
              <span className="text-sm text-amber-400 font-medium">Combo → Singles</span>
              {isAdmin && <Link href="/admin" className="text-sm text-gray-400 hover:text-white transition">Admin</Link>}
            </div>
          </div>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-6 py-8">
        <div className="flex items-start justify-between mb-6">
          <div>
            <h2 className="text-2xl font-bold">Combo → Singles Converter</h2>
            <p className="text-sm text-gray-400 mt-1">Convert combo SKU forecasts into individual single SKU quantities</p>
          </div>
          <div className="flex gap-3">
            {result && (
              <>
                <button onClick={downloadResult} className="px-4 py-2 text-sm bg-amber-500 text-black font-semibold rounded-lg hover:bg-amber-400 transition">Download Excel</button>
                <button onClick={() => { setResult(null); setError(null); }} className="px-4 py-2 text-sm bg-gray-800 text-gray-300 rounded-lg hover:bg-gray-700 transition">New Conversion</button>
              </>
            )}
            {!result && (
              <>
                <button onClick={downloadTemplate} className="px-4 py-2 text-sm bg-gray-800 text-gray-300 rounded-lg hover:bg-gray-700 transition">
                  Download Template
                </button>
              </>
            )}
            {isAdmin && !result && (
              <>
                <button onClick={() => setShowMapperManager(!showMapperManager)}
                  className={`px-4 py-2 text-sm rounded-lg transition ${showMapperManager ? "bg-blue-500/20 text-blue-400 ring-1 ring-blue-500" : "bg-gray-800 text-gray-300 hover:bg-gray-700"}`}>
                  {showMapperManager ? "Hide Mapper Manager" : "Manage Mappers"}
                </button>
                {pendingSuggestions.length > 0 && (
                  <button onClick={() => { setShowApprovals(!showApprovals); setShowMapperManager(false); }}
                    className={`px-4 py-2 text-sm rounded-lg transition relative ${showApprovals ? "bg-orange-500/20 text-orange-400 ring-1 ring-orange-500" : "bg-gray-800 text-gray-300 hover:bg-gray-700"}`}>
                    Approvals
                    <span className="absolute -top-1.5 -right-1.5 px-1.5 py-0.5 bg-red-500 text-white text-xs rounded-full">{pendingSuggestions.length}</span>
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {error && <div className="mb-6 p-4 bg-red-900/50 border border-red-500 rounded-xl"><p className="text-red-300 text-sm">{error}</p></div>}

        {/* ====== MAPPER MANAGER (Admin) ====== */}
        {showMapperManager && isAdmin && !result && (
          <div className="mb-6 bg-gray-900 border border-blue-500/30 rounded-xl p-6">
            <h3 className="text-lg font-semibold text-blue-400 mb-4">Mapper Manager</h3>

            {/* Existing mappers */}
            {mapperSets.length > 0 && (
              <div className="mb-6">
                <p className="text-sm text-gray-300 mb-3">Existing Mappers ({mapperSets.length})</p>
                <div className="space-y-2">
                  {mapperSets.map((ms) => (
                    <div key={ms.id} className="flex items-center justify-between p-3 bg-gray-800 rounded-lg">
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">{ms.name}</span>
                          {ms.is_default && <span className="px-1.5 py-0.5 text-xs bg-green-500/20 text-green-400 rounded">Default</span>}
                        </div>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {ms.row_count} SKUs · P1-P{ms.product_column_count} · {new Date(ms.created_at).toLocaleDateString()}
                          {ms.description && <span> · {ms.description}</span>}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {!ms.is_default && (
                          <button onClick={() => setDefaultMapper(ms.id)} className="text-xs text-gray-400 hover:text-green-400 transition">Set Default</button>
                        )}
                        <button onClick={() => downloadMapperSet(ms.id, ms.name)} disabled={uploadingMapper} className="text-xs text-blue-400 hover:text-blue-300 transition">Download</button>
                        <button onClick={() => resolveNestedForSet(ms.id)} disabled={uploadingMapper} className="text-xs text-green-400 hover:text-green-300 transition">Resolve Nested</button>
                        <label className="text-xs text-amber-400 hover:text-amber-300 cursor-pointer transition">
                          Update
                          <input type="file" accept=".xlsx,.xls" className="hidden"
                            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpdateMapper(ms.id, f); e.target.value = ""; }} />
                        </label>
                        <button onClick={() => deleteMapperSet(ms.id)} className="text-xs text-red-400 hover:text-red-300 transition">Delete</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Upload new mapper */}
            <div className="p-4 bg-gray-800/50 rounded-lg">
              <p className="text-sm text-gray-300 mb-3">Upload New Mapper</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                <input type="text" placeholder="Mapper name (e.g. 'Singles except VP & Enrobed Minis')" value={newMapperName} onChange={(e) => setNewMapperName(e.target.value)}
                  className="px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                <input type="text" placeholder="Description (optional)" value={newMapperDesc} onChange={(e) => setNewMapperDesc(e.target.value)}
                  className="px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div className="flex items-center gap-3">
                <label className={`px-4 py-2 text-sm rounded-lg cursor-pointer transition ${uploadingMapper ? "bg-gray-700 text-gray-500" : "bg-blue-500 text-white hover:bg-blue-400"}`}>
                  {uploadingMapper ? "Uploading..." : "Choose Mapper File"}
                  <input ref={mapperFileRef} type="file" accept=".xlsx,.xls" className="hidden" disabled={uploadingMapper}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) handleMapperUpload(f); if (mapperFileRef.current) mapperFileRef.current.value = ""; }} />
                </label>
                <span className="text-xs text-gray-500">Excel with "Mapper" sheet (Col B=SKU, Col G=Combo, Col J+=Products)</span>
              </div>
            </div>

            {mapperMsg && (
              <div className={`mt-3 p-3 rounded-lg text-sm ${mapperMsg.startsWith("Error") || mapperMsg.startsWith("Failed") || mapperMsg.startsWith("No ") ? "bg-red-900/50 text-red-300" : "bg-green-900/50 text-green-300"}`}>
                {mapperMsg}
              </div>
            )}
          </div>
        )}

        {/* ====== APPROVALS PANEL (Admin) ====== */}
        {showApprovals && isAdmin && !result && pendingSuggestions.length > 0 && (
          <div className="mb-6 bg-gray-900 border border-orange-500/30 rounded-xl p-6">
            <h3 className="text-lg font-semibold text-orange-400 mb-4">Pending Mapper Suggestions ({pendingSuggestions.length})</h3>
            <div className="space-y-3">
              {pendingSuggestions.map((s) => (
                <SuggestionCard key={s.id} suggestion={s} mapperSets={mapperSets}
                  onApprove={(selectedIds) => approveSuggestion(s, selectedIds)}
                  onReject={(note) => rejectSuggestion(s.id, note)} />
              ))}
            </div>
          </div>
        )}

        {/* ====== UPLOAD SECTION ====== */}
        {!result && (
          <div className="space-y-6">
            {/* Mapper Source */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
              <label className="block text-sm font-medium text-gray-300 mb-3">1. Mapper Source</label>
              {isAdmin ? (
                <div className="flex gap-3">
                  <button onClick={() => setMapperSource("file")}
                    className={`flex-1 px-4 py-3 rounded-lg text-sm text-left transition border ${mapperSource === "file" ? "bg-amber-500/10 text-amber-400 border-amber-500/30 ring-1 ring-amber-500" : "bg-gray-800 text-gray-400 border-transparent hover:bg-gray-700"}`}>
                    <p className="font-medium">From File (Admin)</p>
                    <p className="text-xs mt-0.5 opacity-70">Excel with both "Combo" and "Mapper" sheets</p>
                  </button>
                  <button onClick={() => setMapperSource("db")}
                    className={`flex-1 px-4 py-3 rounded-lg text-sm text-left transition border ${mapperSource === "db" ? "bg-amber-500/10 text-amber-400 border-amber-500/30 ring-1 ring-amber-500" : "bg-gray-800 text-gray-400 border-transparent hover:bg-gray-700"}`}>
                    <p className="font-medium">Database Mapper</p>
                    <p className="text-xs mt-0.5 opacity-70">{mapperSets.length > 0 ? `${mapperSets.length} mappers available` : "None uploaded yet"}</p>
                  </button>
                </div>
              ) : (
                <div>
                  <p className="text-xs text-gray-500 mb-3">Select a mapper uploaded by admin to use for conversion.</p>
                </div>
              )}

              {/* DB mapper selector */}
              {mapperSource === "db" && (
                <div className="mt-4">
                  {mapperSets.length === 0 ? (
                    <p className="text-xs text-red-400">{isAdmin ? 'No mappers yet. Click "Manage Mappers" above to upload one.' : "No mappers available. Ask admin to upload."}</p>
                  ) : (
                    <div>
                      <label className="block text-xs text-gray-400 mb-1.5">Select mapper:</label>
                      <select value={selectedMapperSetId} onChange={(e) => setSelectedMapperSetId(e.target.value)}
                        className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-500">
                        <option value="">Choose a mapper...</option>
                        {mapperSets.map((ms) => (
                          <option key={ms.id} value={ms.id}>
                            {ms.name} ({ms.row_count} SKUs, P1-P{ms.product_column_count}){ms.is_default ? " [Default]" : ""}
                          </option>
                        ))}
                      </select>
                      {loadingMapper && <p className="text-xs text-gray-500 mt-2">Loading mapper data...</p>}
                      {!loadingMapper && dbMapperRows.length > 0 && (
                        <p className="text-xs text-green-400 mt-2">Loaded: {dbMapperRows.length} SKUs, P1-P{dbProductCount}</p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Upload Combo File */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
              <label className="block text-sm font-medium text-gray-300 mb-3">
                2. Upload {mapperSource === "file" ? "Excel (Combo + Mapper sheets)" : "Combo Data"}
              </label>
              <div onClick={() => fileInputRef.current?.click()}
                onDragEnter={(e) => { e.preventDefault(); setDragActive(true); }}
                onDragLeave={(e) => { e.preventDefault(); setDragActive(false); }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); setDragActive(false); const f = e.dataTransfer.files?.[0]; if (f) handleComboFile(f); }}
                className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition ${dragActive ? "border-amber-500 bg-amber-500/5" : "border-gray-700 hover:border-gray-600"}`}>
                <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleComboFile(f); if (fileInputRef.current) fileInputRef.current.value = ""; }} />
                {processing ? (
                  <p className="text-amber-400 font-medium">Processing...</p>
                ) : (
                  <>
                    <div className="text-3xl mb-2">{"\uD83D\uDD04"}</div>
                    <p className="text-gray-300 font-medium mb-1">Drop your Excel file here</p>
                    <p className="text-gray-500 text-sm">{mapperSource === "file" ? 'Needs "Combo" + "Mapper" sheets' : 'Needs "Combo" sheet (or first sheet)'}</p>
                  </>
                )}
              </div>
            </div>

            {/* Format reference */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
              <h3 className="text-sm font-medium text-gray-300 mb-3">Expected Format</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                <div>
                  <p className="text-amber-400 font-medium mb-1">Combo Sheet</p>
                  <div className="bg-gray-800 rounded p-3 font-mono">
                    <p className="text-gray-400">Master SKU | Amazon | Flipkart | ...</p>
                    <p className="text-gray-300">SKU_ABC    | 500    | 300      | ...</p>
                  </div>
                  <p className="text-gray-500 mt-1">Col 1 = SKU, rest = qty columns (any names/count)</p>
                </div>
                <div>
                  <p className="text-blue-400 font-medium mb-1">Mapper Sheet</p>
                  <div className="bg-gray-800 rounded p-3 font-mono">
                    <p className="text-gray-400">_ | Master SKU | ... | Combo | ... | P1..P96</p>
                    <p className="text-gray-300">  | COMBO_XY   | ... | Yes   | ... | A | B ..</p>
                  </div>
                  <p className="text-gray-500 mt-1">Col B=SKU, G=Combo, J onwards=Products (auto-detects P1 to P96)</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ====== RESULTS ====== */}
        {result && (
          <div>
            {/* Summary */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <p className="text-xs text-gray-400">Input Rows</p>
                <p className="text-2xl font-bold">{result.consolidated.length}</p>
              </div>
              <div className="bg-gray-900 border border-green-800/30 rounded-xl p-4">
                <p className="text-xs text-green-400">Singles Output</p>
                <p className="text-2xl font-bold text-green-400">{result.singles.length}</p>
              </div>
              <div className="bg-gray-900 border border-amber-800/30 rounded-xl p-4">
                <p className="text-xs text-amber-400">Combos Resolved</p>
                <p className="text-2xl font-bold text-amber-400">{result.consolidated.filter((r) => ["yes", "y"].includes(r.combo.toLowerCase())).length}</p>
              </div>
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <p className="text-xs text-gray-400">Qty Columns</p>
                <p className="text-2xl font-bold">{result.qtyColumns.length}</p>
                <p className="text-xs text-gray-500 mt-0.5">{result.qtyColumns.join(", ")}</p>
              </div>
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <p className="text-xs text-gray-400">Warnings</p>
                <p className={`text-2xl font-bold ${result.warnings.length > 0 ? "text-red-400" : "text-gray-600"}`}>{result.warnings.length}</p>
              </div>
            </div>

            {/* Warnings */}
            {result.warnings.length > 0 && (
              <div className="mb-6 p-4 bg-amber-900/30 border border-amber-500/30 rounded-xl">
                <p className="text-amber-400 text-sm font-medium mb-2">Warnings ({result.warnings.length})</p>
                <div className="max-h-[120px] overflow-y-auto space-y-1">
                  {result.warnings.map((w, i) => (<p key={i} className="text-xs text-amber-300/70">{w}</p>))}
                </div>
              </div>
            )}

            {/* Tabs */}
            <div className="flex gap-2 mb-4">
              <button onClick={() => setActiveTab("singles")}
                className={`px-4 py-2 text-sm rounded-lg transition ${activeTab === "singles" ? "bg-green-500/20 text-green-400 ring-1 ring-green-500" : "bg-gray-800 text-gray-400 hover:bg-gray-700"}`}>
                Singles ({result.singles.length})
              </button>
              <button onClick={() => setActiveTab("consolidated")}
                className={`px-4 py-2 text-sm rounded-lg transition ${activeTab === "consolidated" ? "bg-amber-500/20 text-amber-400 ring-1 ring-amber-500" : "bg-gray-800 text-gray-400 hover:bg-gray-700"}`}>
                Consolidated ({result.consolidated.length})
              </button>
            </div>

            {/* Singles Table */}
            {activeTab === "singles" && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-gray-900 z-10">
                      <tr className="border-b border-gray-800">
                        <th className="text-left py-3 px-4 text-gray-400 font-medium">Master SKU</th>
                        <th className="text-left py-3 px-4 text-gray-400 font-medium">FG Code</th>
                        <th className="text-left py-3 px-4 text-gray-400 font-medium">Product Name</th>
                        <th className="text-left py-3 px-4 text-gray-400 font-medium">Status</th>
                        {result.qtyColumns.map((col) => (<th key={col} className="text-right py-3 px-4 text-gray-400 font-medium">{col}</th>))}
                        <th className="text-right py-3 px-4 text-gray-400 font-medium">Row Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.singles.map((row, i) => {
                        const rt = result.qtyColumns.reduce((s, c) => s + (row.quantities[c] || 0), 0);
                        const sku = skuLookup.get(row.master_sku.toLowerCase());
                        return (
                          <tr key={i} className={`border-b border-gray-800/50 hover:bg-gray-800/20 ${row.status === "NOT IN MAPPER" ? "bg-red-900/10" : ""}`}>
                            <td className="py-2.5 px-4 font-mono text-xs">{row.master_sku}</td>
                            <td className="py-2.5 px-4 font-mono text-xs">{sku?.new_fg_code || <span className="text-gray-600">—</span>}</td>
                            <td className="py-2.5 px-4 text-xs text-gray-300 truncate max-w-[200px]" title={sku?.product_name || ""}>{sku?.product_name || <span className="text-gray-600">—</span>}</td>
                            <td className="py-2.5 px-4"><span className={`px-2 py-0.5 rounded text-xs ${row.status === "Converted" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>{row.status}</span></td>
                            {result.qtyColumns.map((col) => (
                              <td key={col} className="py-2.5 px-4 text-right font-mono text-xs">
                                {(row.quantities[col] || 0) > 0 ? Math.round((row.quantities[col] || 0) * 100) / 100 : <span className="text-gray-700">-</span>}
                              </td>
                            ))}
                            <td className="py-2.5 px-4 text-right font-mono text-xs font-medium">{Math.round(rt * 100) / 100}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="bg-gray-800/50">
                        <td className="py-3 px-4 font-semibold" colSpan={4}>Total</td>
                        {result.qtyColumns.map((col) => (
                          <td key={col} className="py-3 px-4 text-right font-mono font-bold text-amber-400">
                            {Math.round(result.singles.reduce((s, r) => s + (r.quantities[col] || 0), 0) * 100) / 100}
                          </td>
                        ))}
                        <td className="py-3 px-4 text-right font-mono font-bold text-white">
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
                  <div className="mb-4 p-4 bg-blue-900/30 border border-blue-500/30 rounded-xl">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-blue-300 font-medium">{unmappedEdits.size} unmapped SKU(s) — edit Combo & Components below</p>
                        <p className="text-xs text-blue-400/60 mt-0.5">Set Combo = Yes/No. Enter component SKUs comma-separated. Then Re-Convert for instant results, or Submit to add permanently.</p>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={handleReConvert}
                          className="px-4 py-2 text-sm bg-blue-500 text-white font-semibold rounded-lg hover:bg-blue-400 transition whitespace-nowrap">
                          Re-Convert
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Submit banner — visible whenever there are NOT_IN_MAPPER rows */}
                {result.consolidated.some((r) => r.mapper_status === "NOT IN MAPPER") && (
                  <div className="mb-4 p-4 bg-orange-900/20 border border-orange-500/30 rounded-xl">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-orange-300 font-medium">Submit unmapped SKUs for admin approval</p>
                        <p className="text-xs text-orange-400/60 mt-0.5">Fill in Combo & Components for unmapped SKUs above, then submit to add them permanently to a mapper.</p>
                      </div>
                      <button onClick={submitSuggestions}
                        className="px-4 py-2 text-sm bg-orange-500 text-white font-semibold rounded-lg hover:bg-orange-400 transition whitespace-nowrap">
                        Submit to Mapper
                      </button>
                    </div>
                    {submitMsg && (
                      <p className={`mt-2 text-xs ${submitMsg.includes("Failed") ? "text-red-400" : "text-green-400"}`}>{submitMsg}</p>
                    )}
                  </div>
                )}

                <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                  <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-gray-900 z-10">
                        <tr className="border-b border-gray-800">
                          <th className="text-left py-3 px-4 text-gray-400 font-medium">Master SKU</th>
                          <th className="text-left py-3 px-4 text-gray-400 font-medium">FG Code</th>
                          {result.qtyColumns.map((col) => (<th key={col} className="text-right py-3 px-4 text-gray-400 font-medium">{col}</th>))}
                          <th className="text-left py-3 px-4 text-gray-400 font-medium">Mapper</th>
                          <th className="text-left py-3 px-4 text-gray-400 font-medium w-24">Combo</th>
                          <th className="text-left py-3 px-4 text-gray-400 font-medium">Components</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.consolidated.map((row, i) => {
                          const isUnmapped = row.mapper_status === "NOT IN MAPPER";
                          const edit = unmappedEdits.get(row.master_sku);
                          const mapperRow = allMapperRows.find((m) => m.master_sku === row.master_sku);
                          return (
                            <tr key={i} className={`border-b border-gray-800/50 hover:bg-gray-800/20 ${isUnmapped ? "bg-red-900/10" : ""}`}>
                              <td className="py-2.5 px-4 font-mono text-xs">{row.master_sku}</td>
                              <td className="py-2.5 px-4 font-mono text-xs text-gray-400">{mapperRow?.fg_code || <span className="text-gray-700">-</span>}</td>
                              {result.qtyColumns.map((col) => (
                                <td key={col} className="py-2.5 px-4 text-right font-mono text-xs">{(row.quantities[col] || 0) > 0 ? Math.round((row.quantities[col] || 0) * 100) / 100 : <span className="text-gray-700">-</span>}</td>
                              ))}
                              <td className="py-2.5 px-4">
                                <span className={`px-2 py-0.5 rounded text-xs ${row.mapper_status === "Found" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>{row.mapper_status}</span>
                              </td>
                              <td className="py-2.5 px-4 text-xs">
                                {isUnmapped && edit ? (
                                  <select value={edit.combo}
                                    onChange={(e) => { const next = new Map(unmappedEdits); next.set(row.master_sku, { ...edit, combo: e.target.value }); setUnmappedEdits(next); }}
                                    className="w-20 px-2 py-1 bg-gray-800 border border-amber-500/50 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-amber-500">
                                    <option value="No">No</option>
                                    <option value="Yes">Yes</option>
                                  </select>
                                ) : (
                                  <span>{row.combo || <span className="text-gray-700">-</span>}</span>
                                )}
                              </td>
                              <td className="py-2.5 px-4 text-xs">
                                {isUnmapped && edit ? (
                                  <input type="text" value={edit.products} placeholder="SKU_A, SKU_B, ..."
                                    onChange={(e) => { const next = new Map(unmappedEdits); next.set(row.master_sku, { ...edit, products: e.target.value }); setUnmappedEdits(next); }}
                                    className="w-full min-w-[200px] px-2 py-1 bg-gray-800 border border-amber-500/50 rounded text-xs text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-amber-500" />
                                ) : (
                                  <span className="text-gray-400 max-w-[300px] truncate block">{row.products.filter((p) => p).join(", ") || <span className="text-gray-700">-</span>}</span>
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
      </div>
    </div>
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
    <div className="p-4 bg-gray-800 rounded-lg">
      <div className="flex items-start justify-between mb-3">
        <div>
          <span className="font-mono text-sm font-medium text-white">{suggestion.master_sku}</span>
          <span className="ml-2 text-xs text-gray-500">by {suggestion.submitted_by_email?.split("@")[0] || "unknown"}</span>
          <span className="ml-2 text-xs text-gray-600">{new Date(suggestion.created_at).toLocaleDateString()}</span>
        </div>
      </div>

      {/* Editable fields - admin can modify before approving */}
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label className="block text-xs text-gray-400 mb-1">Combo</label>
          <select value={editCombo} onChange={(e) => setEditCombo(e.target.value)}
            className="w-full px-2 py-1.5 bg-gray-900 border border-gray-700 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-orange-500">
            <option value="No">No</option>
            <option value="Yes">Yes</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Components (comma-separated)</label>
          <input type="text" value={editProducts} onChange={(e) => setEditProducts(e.target.value)}
            className="w-full px-2 py-1.5 bg-gray-900 border border-gray-700 rounded text-xs text-white focus:outline-none focus:ring-1 focus:ring-orange-500" />
        </div>
      </div>

      {/* Select which mappers to add to */}
      <div className="mb-3">
        <label className="block text-xs text-gray-400 mb-1.5">Add to mapper(s):</label>
        <div className="flex flex-wrap gap-2">
          {mapperSets.map((ms) => (
            <button key={ms.id} onClick={() => toggleMapper(ms.id)}
              className={`px-3 py-1 text-xs rounded-lg transition border ${selectedMappers.has(ms.id) ? "bg-green-500/20 text-green-400 border-green-500/50" : "bg-gray-900 text-gray-400 border-gray-700 hover:border-gray-600"}`}>
              {ms.name}
            </button>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <button onClick={handleApprove} disabled={selectedMappers.size === 0}
          className="px-4 py-1.5 text-xs bg-green-500 text-white font-semibold rounded-lg hover:bg-green-400 disabled:opacity-40 disabled:cursor-not-allowed transition">
          Approve & Add to {selectedMappers.size} mapper(s)
        </button>
        {!showReject ? (
          <button onClick={() => setShowReject(true)} className="px-4 py-1.5 text-xs bg-gray-700 text-gray-300 rounded-lg hover:bg-gray-600 transition">
            Reject
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <input type="text" placeholder="Reason (optional)" value={rejectNote} onChange={(e) => setRejectNote(e.target.value)}
              className="px-2 py-1.5 bg-gray-900 border border-gray-700 rounded text-xs text-white placeholder-gray-600 focus:outline-none w-48" />
            <button onClick={() => { onReject(rejectNote); setShowReject(false); }}
              className="px-3 py-1.5 text-xs bg-red-500 text-white rounded-lg hover:bg-red-400 transition">Confirm</button>
            <button onClick={() => setShowReject(false)} className="text-xs text-gray-500">Cancel</button>
          </div>
        )}
      </div>
    </div>
  );
}