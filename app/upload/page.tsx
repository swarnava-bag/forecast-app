"use client";
import { useEffect, useState, useRef, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import * as XLSX from "xlsx";
import Link from "next/link";

type Profile = { id: string; email: string; full_name: string; role: string };
type Channel = { id: string; name: string; cluster_id: string };
type Cluster = { id: string; name: string };
type Cycle = { id: string; forecast_month: string; version: number; status: string; deadline: string | null };
type SKU = { id: string; new_master_sku: string; fg_code: string; product_name: string; category: string; product_category: string; is_active: boolean; discontinued_at: string | null };

type UploadRow = {
  sku_id: string;
  new_master_sku: string;
  product_name: string;
  channel_id: string;
  channel_name: string;
  qty_m1: number;
  qty_m2: number;
  qty_m3: number;
  isValid: boolean;
  errors: string[];
  originalRow: number;
};

// ── Combo-in-upload: types & pure conversion engine ───────────────────────
type ComboInputRow = { master_sku: string; quantities: Record<string, number> };
type UploadMapperRow = { master_sku: string; combo: string; products: string[] };
type ComboSingleRow = { master_sku: string; quantities: Record<string, number>; status: string };
type MapperSet = { id: string; name: string; row_count: number; product_column_count: number; is_default: boolean };
type ComboMapperRow = { master_sku: string; is_combo: boolean; products: string[] };
type ConversionSummary = { inputRows: number; singlesOutput: number; combosResolved: number; warnings: string[] };

function runComboConversion(
  comboRows: ComboInputRow[],
  mapperRows: UploadMapperRow[],
  qtyColumns: string[],
): { singles: ComboSingleRow[]; warnings: string[]; combosResolved: number } {
  const warnings: string[] = [];
  const mapperDict = new Map<string, UploadMapperRow>();
  for (const m of mapperRows) mapperDict.set(m.master_sku, m);

  const comboSkus = new Set<string>();
  const notInMapper = new Set<string>();
  const allSkus = new Set<string>();

  for (const row of comboRows) {
    allSkus.add(row.master_sku);
    const mapper = mapperDict.get(row.master_sku);
    if (!mapper) {
      notInMapper.add(row.master_sku);
      warnings.push(`"${row.master_sku}" not in mapper — treated as single`);
      continue;
    }
    const isCombo = ["yes", "y", "1", "true"].includes(mapper.combo.toLowerCase()) || mapper.products.some(p => p.length > 0);
    if (isCombo) {
      comboSkus.add(row.master_sku);
      mapper.products.forEach(p => { if (p) allSkus.add(p); });
    }
  }

  const singles: ComboSingleRow[] = [];
  for (const sku of [...allSkus].sort()) {
    if (comboSkus.has(sku)) continue;
    const quantities: Record<string, number> = {};
    for (const col of qtyColumns) {
      let total = 0;
      comboRows.filter(r => r.master_sku === sku).forEach(r => { total += r.quantities[col] || 0; });
      comboRows.filter(r => comboSkus.has(r.master_sku)).forEach(r => {
        const m = mapperDict.get(r.master_sku);
        const count = m?.products.filter(p => p === sku).length || 0;
        if (count > 0) total += (r.quantities[col] || 0) * count;
      });
      quantities[col] = Math.round(total * 100) / 100;
    }
    if (Object.values(quantities).some(v => v > 0))
      singles.push({ master_sku: sku, quantities, status: notInMapper.has(sku) ? "NOT IN MAPPER" : "Converted" });
  }
  return { singles, warnings, combosResolved: comboSkus.size };
}
// ─────────────────────────────────────────────────────────────────────────────

function addMonths(dateStr: string, n: number): string {
  const d = new Date(dateStr);
  d.setMonth(d.getMonth() + n);
  return d.toISOString().slice(0, 10);
}

function formatMonthShort(dateStr: string): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short" });
}

export default function UploadPage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [skus, setSkus] = useState<SKU[]>([]);
  const [channelSkuMapping, setChannelSkuMapping] = useState<Map<string, Set<string>>>(new Map());
  const [allowedChannelIds, setAllowedChannelIds] = useState<string[]>([]);
  const [selectedChannelIds, setSelectedChannelIds] = useState<string[]>([]); // multi-mode channel selection
  const [selectedChannel, setSelectedChannel] = useState("");
  const [selectedCycle, setSelectedCycle] = useState("");
  const [uploadMode, setUploadMode] = useState<"single" | "multi">("single");
  const [loading, setLoading] = useState(true);
  const [uploadData, setUploadData] = useState<UploadRow[]>([]);
  const [showPreview, setShowPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  // Combo integration state
  const [hasCombo, setHasCombo] = useState(false);
  const [comboMapperSets, setComboMapperSets] = useState<MapperSet[]>([]);
  const [comboMapperId, setComboMapperId] = useState("");
  const [comboMapperRows, setComboMapperRows] = useState<ComboMapperRow[]>([]);
  const [comboProductCount, setComboProductCount] = useState(0);
  const [comboLoadingMapper, setComboLoadingMapper] = useState(false);
  const [conversionSummary, setConversionSummary] = useState<ConversionSummary | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const supabase = createClient();

  useEffect(() => { loadData(); }, []);

  useEffect(() => {
    if (!comboMapperId) return;
    setComboLoadingMapper(true);
    let allData: any[] = [];
    let from = 0;
    const PAGE = 1000;
    (async () => {
      while (true) {
        const { data, error } = await supabase
          .from("combo_mapper_rows").select("master_sku, is_combo, products")
          .eq("mapper_set_id", comboMapperId).range(from, from + PAGE - 1);
        if (error || !data || data.length === 0) break;
        allData = allData.concat(data);
        if (data.length < PAGE) break;
        from += PAGE;
      }
      const rows: ComboMapperRow[] = allData.map((r: any) => ({
        master_sku: String(r.master_sku || "").trim(),
        is_combo: r.is_combo === true || r.is_combo === "true",
        products: Array.isArray(r.products) ? r.products.map((p: any) => String(p || "").trim()) : [],
      }));
      const maxP = rows.reduce((max, r) => Math.max(max, r.products.length), 0);
      setComboMapperRows(rows);
      setComboProductCount(maxP);
      setComboLoadingMapper(false);
    })();
  }, [comboMapperId]);

  async function loadData() {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data: profileData } = await supabase.from("profiles").select("*").eq("id", user.id).single();
    setProfile(profileData);

    const { data: channelData } = await supabase.from("channels").select("*").eq("is_active", true).order("display_order");
    if (channelData) setChannels(channelData);

    const { data: clusterData } = await supabase.from("clusters").select("*").order("display_order");
    if (clusterData) setClusters(clusterData);

    const { data: cycleData } = await supabase.from("forecast_cycles").select("*").eq("status", "open").order("forecast_month", { ascending: false });
    if (cycleData) setCycles(cycleData);

    const { data: skuData } = await supabase.from("sku_master").select("*").eq("is_active", true).is("discontinued_at", null).order("product_name");
    if (skuData) setSkus(skuData);

    // Load channel-SKU mappings
    const { data: mappingData } = await supabase.from("channel_sku_mapping").select("channel_id, sku_id").eq("is_enabled", true);
    if (mappingData) {
      const map = new Map<string, Set<string>>();
      mappingData.forEach((m: any) => {
        if (!map.has(m.channel_id)) map.set(m.channel_id, new Set());
        map.get(m.channel_id)!.add(m.sku_id);
      });
      setChannelSkuMapping(map);
    }

    // Load combo mapper sets (for checkbox feature)
    const { data: mapperSetData } = await supabase
      .from("combo_mapper_sets").select("id, name, row_count, product_column_count, is_default")
      .order("created_at", { ascending: false });
    if (mapperSetData) {
      setComboMapperSets(mapperSetData);
      const def = mapperSetData.find((s: MapperSet) => s.is_default);
      if (def) setComboMapperId(def.id);
      else if (mapperSetData.length > 0) setComboMapperId(mapperSetData[0].id);
    }

    // Determine allowed channels based on role
    let computedAllowedIds: string[] = [];
    if (profileData) {
      if (profileData.role === "admin") {
        if (channelData) computedAllowedIds = channelData.map((c: Channel) => c.id);
      } else if (profileData.role === "head_kam") {
        const { data: userClusters } = await supabase.from("user_clusters").select("cluster_id").eq("user_id", user.id);
        if (userClusters && channelData) {
          const clusterIds = userClusters.map((uc: any) => uc.cluster_id);
          computedAllowedIds = channelData.filter((ch: Channel) => clusterIds.includes(ch.cluster_id)).map((ch: Channel) => ch.id);
        }
      } else if (profileData.role === "channel_kam") {
        const { data: userChannels } = await supabase.from("user_channels").select("channel_id").eq("user_id", user.id);
        if (userChannels) computedAllowedIds = userChannels.map((uc: any) => uc.channel_id);
      }
    }
    setAllowedChannelIds(computedAllowedIds);
    setSelectedChannelIds(computedAllowedIds); // default: all allowed channels selected
    setLoading(false);
  }

  const allowedChannels = channels.filter((ch) => allowedChannelIds.includes(ch.id));
  const selectedChannels = allowedChannels.filter((ch) => selectedChannelIds.includes(ch.id));
  const selectedCycleData = cycles.find((c) => c.id === selectedCycle);
  const isDeadlinePassed = selectedCycleData?.deadline && new Date(selectedCycleData.deadline) < new Date();

  // Multi mode: Admin and Head KAM only (they manage multiple channels)
  const canUseMultiMode = profile?.role === "admin" || profile?.role === "head_kam";
  const canUpload = profile?.role === "admin" || profile?.role === "head_kam" || profile?.role === "channel_kam";

  // 3-month labels
  const month1 = selectedCycleData?.forecast_month || "";
  const month2 = month1 ? addMonths(month1, 1) : "";
  const month3 = month1 ? addMonths(month1, 2) : "";
  const m1Label = formatMonthShort(month1);
  const m2Label = formatMonthShort(month2);
  const m3Label = formatMonthShort(month3);

  function getChannelsByCluster() {
    const grouped: { cluster: Cluster; channels: Channel[] }[] = [];
    clusters.forEach((cl) => {
      const clChannels = allowedChannels.filter((ch) => ch.cluster_id === cl.id);
      if (clChannels.length > 0) grouped.push({ cluster: cl, channels: clChannels });
    });
    return grouped;
  }

  function getSkusForChannel(channelId: string): SKU[] {
    const chMapping = channelSkuMapping.get(channelId);
    if (chMapping && chMapping.size > 0) return skus.filter((s) => chMapping.has(s.id));
    return skus;
  }

  // ====== TEMPLATE DOWNLOAD ======
  function downloadTemplate() {
    if (!selectedCycle) { setError("Please select a forecast cycle first."); return; }

    if (uploadMode === "single") {
      if (!selectedChannel) { setError("Please select a channel."); return; }
      const channelName = channels.find((c) => c.id === selectedChannel)?.name || "Channel";
      const chSkus = getSkusForChannel(selectedChannel);

      // Single mode: New Master SKU | M1 | M2 | M3
      const templateData = chSkus.map((sku) => ({
        "New Master SKU": sku.new_master_sku,
        [m1Label]: "",
        [m2Label]: "",
        [m3Label]: "",
      }));

      const ws = XLSX.utils.json_to_sheet(templateData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Forecast");
      ws["!cols"] = [{ wch: 18 }, { wch: 14 }, { wch: 14 }, { wch: 14 }];
      const cycleName = `${m1Label.replace(" ", "_")}_V${selectedCycleData?.version || 1}`;
      XLSX.writeFile(wb, `${channelName}_${cycleName}_Template.xlsx`);

    } else if (hasCombo) {
      // Multi + Combo: 2-row header pivoted format
      // Row 1: "" | M1 (spans N channels) | M2 (spans N) | M3 (spans N)
      // Row 2: "New Master SKU" | Chan1 | Chan2 | ... | Chan1 | Chan2 | ...
      if (selectedChannels.length === 0) { setError("Select at least one channel."); return; }
      const N = selectedChannels.length;
      const months = [m1Label, m2Label, m3Label];

      // Build all unique SKUs from selected channels
      const allSkuMap = new Map<string, string>();
      selectedChannels.forEach((ch) => {
        getSkusForChannel(ch.id).forEach((sku) => allSkuMap.set(sku.new_master_sku, sku.product_name));
      });

      // Header row 1: blank | M1 blank×(N-1) | M2 blank×(N-1) | M3 blank×(N-1)
      const headerRow1: any[] = [""];
      months.forEach((m) => {
        headerRow1.push(m);
        for (let i = 1; i < N; i++) headerRow1.push("");
      });

      // Header row 2: "New Master SKU" | Chan1..ChanN (repeated 3×)
      const headerRow2: any[] = ["New Master SKU"];
      months.forEach(() => selectedChannels.forEach((ch) => headerRow2.push(ch.name)));

      // Data rows
      const dataRows = [...allSkuMap.keys()].sort().map((skuCode) => {
        const row: any[] = [skuCode];
        months.forEach(() => selectedChannels.forEach(() => row.push("")));
        return row;
      });

      const aoa = [headerRow1, headerRow2, ...dataRows];
      const ws = XLSX.utils.aoa_to_sheet(aoa);

      // Merge cells: row 0 spans N cols for each month group
      const merges: XLSX.Range[] = [
        { s: { r: 0, c: 0 }, e: { r: 1, c: 0 } }, // "New Master SKU" spans 2 rows
      ];
      months.forEach((_, mi) => {
        const startCol = 1 + mi * N;
        if (N > 1) merges.push({ s: { r: 0, c: startCol }, e: { r: 0, c: startCol + N - 1 } });
      });
      ws["!merges"] = merges;
      ws["!cols"] = [{ wch: 22 }, ...Array(N * 3).fill({ wch: 13 })];

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Forecast");
      const cycleName = `${m1Label.replace(" ", "_")}_V${selectedCycleData?.version || 1}`;
      XLSX.writeFile(wb, `Multi_Channel_Combo_${cycleName}_Template.xlsx`);

    } else {
      // Multi mode (no combo): long format — New Master SKU | Channel | M1 | M2 | M3
      if (selectedChannels.length === 0) { setError("Select at least one channel."); return; }
      const templateData: any[] = [];
      selectedChannels.forEach((ch) => {
        const chSkus = getSkusForChannel(ch.id);
        chSkus.forEach((sku) => {
          templateData.push({
            "New Master SKU": sku.new_master_sku,
            "Channel": ch.name,
            [m1Label]: "",
            [m2Label]: "",
            [m3Label]: "",
          });
        });
      });

      const ws = XLSX.utils.json_to_sheet(templateData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Forecast");
      ws["!cols"] = [{ wch: 18 }, { wch: 20 }, { wch: 14 }, { wch: 14 }, { wch: 14 }];
      const cycleName = `${m1Label.replace(" ", "_")}_V${selectedCycleData?.version || 1}`;
      XLSX.writeFile(wb, `Multi_Channel_${cycleName}_Template.xlsx`);
    }
  }

  // ====== FILE PARSING ======
  function parseFile(file: File) {
    setError(null);
    if (!file.name.endsWith(".xlsx") && !file.name.endsWith(".xls") && !file.name.endsWith(".csv")) {
      setError("Please upload an Excel file (.xlsx, .xls) or CSV file.");
      return;
    }

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = evt.target?.result;
        const workbook = XLSX.read(data, { type: "binary" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json<any>(sheet);

        if (json.length === 0) { setError("The uploaded file is empty."); return; }

        // ── COMBO CONVERSION PATH ──────────────────────────────────────────
        if (hasCombo) {
          if (comboMapperRows.length === 0) {
            setError("Combo mapper not loaded. Select a mapper and wait for it to load.");
            return;
          }
          const headers = Object.keys(json[0]);
          const skuCol = headers.find(h =>
            h.toLowerCase().includes("master") || h.toLowerCase().includes("sku")
          ) || headers[0];

          const mapperForConversion: UploadMapperRow[] = comboMapperRows.map(r => ({
            master_sku: r.master_sku,
            combo: r.is_combo ? "Yes" : "No",
            products: r.products,
          }));

          // ── MULTI-CHANNEL COMBO: 2-row AOA header format ─────────────────
          // Row 0: "" | M1 | "" | "" | M2 | "" | "" | M3 | ...
          // Row 1: "New Master SKU" | Chan1 | Chan2 | Chan3 | Chan1 | ...
          // Row 2+: data
          if (uploadMode === "multi") {
            const aoa = XLSX.utils.sheet_to_json<any[]>(workbook.Sheets[workbook.SheetNames[0]], { header: 1 });
            if (aoa.length < 3) { setError("File is empty or missing data rows."); return; }

            const monthRow = aoa[0] as any[];
            const channelRow = aoa[1] as any[];

            // Build colMeta by fill-forwarding month labels in row 0
            type ColMeta2 = { colIdx: number; key: string; channelName: string; monthNum: 1 | 2 | 3 };
            const colMeta: ColMeta2[] = [];
            let currentMonth = "";
            for (let c = 1; c < channelRow.length; c++) {
              const monthCell = String(monthRow[c] || "").trim();
              if (monthCell) currentMonth = monthCell;
              const chanName = String(channelRow[c] || "").trim();
              if (!chanName) continue;
              let monthNum: 1 | 2 | 3 | null = null;
              if (currentMonth === m1Label) monthNum = 1;
              else if (currentMonth === m2Label) monthNum = 2;
              else if (currentMonth === m3Label) monthNum = 3;
              if (monthNum) colMeta.push({ colIdx: c, key: `${chanName}__M${monthNum}`, channelName: chanName, monthNum });
            }
            if (colMeta.length === 0) { setError(`No valid channel+month columns found. Make sure you downloaded the correct template.`); return; }

            // Parse data rows (from index 2 onwards)
            const comboInputRows: ComboInputRow[] = [];
            for (let r = 2; r < aoa.length; r++) {
              const row = aoa[r] as any[];
              const sku = String(row[0] || "").trim();
              if (!sku) continue;
              const quantities: Record<string, number> = {};
              for (const { colIdx, key } of colMeta) {
                const v = Number(row[colIdx]);
                quantities[key] = isNaN(v) ? 0 : v;
              }
              comboInputRows.push({ master_sku: sku, quantities });
            }
            if (comboInputRows.length === 0) { setError("No data rows found in file."); return; }

            const conv = runComboConversion(comboInputRows, mapperForConversion, colMeta.map(c => c.key));

            // Group converted quantities by (single_sku, channelName) → {m1, m2, m3}
            const rows: UploadRow[] = [];
            for (const single of conv.singles) {
              const matchedSku = skus.find(s =>
                s.new_master_sku.toLowerCase() === single.master_sku.toLowerCase()
              );
              const chanMap = new Map<string, { m1: number; m2: number; m3: number }>();
              for (const { key, channelName, monthNum } of colMeta) {
                const qty = Math.round((single.quantities[key] || 0) * 100) / 100;
                if (!chanMap.has(channelName)) chanMap.set(channelName, { m1: 0, m2: 0, m3: 0 });
                const entry = chanMap.get(channelName)!;
                if (monthNum === 1) entry.m1 = qty;
                else if (monthNum === 2) entry.m2 = qty;
                else entry.m3 = qty;
              }
              for (const [chanName, { m1, m2, m3 }] of chanMap) {
                if (m1 === 0 && m2 === 0 && m3 === 0) continue;
                const errors: string[] = [];
                if (!matchedSku) errors.push(`SKU "${single.master_sku}" not found in SKU master`);
                const matchedCh = channels.find(ch => ch.name.toLowerCase() === chanName.toLowerCase());
                if (!matchedCh) {
                  errors.push(`Channel "${chanName}" not found`);
                } else if (!allowedChannelIds.includes(matchedCh.id)) {
                  errors.push(`No access to "${chanName}"`);
                } else if (matchedSku) {
                  const chMapping = channelSkuMapping.get(matchedCh.id);
                  if (chMapping && chMapping.size > 0 && !chMapping.has(matchedSku.id))
                    errors.push("SKU not enabled for this channel");
                }
                rows.push({
                  sku_id: matchedSku?.id || "",
                  new_master_sku: single.master_sku,
                  product_name: matchedSku?.product_name || "Unknown",
                  channel_id: matchedCh?.id || "",
                  channel_name: matchedCh?.name || chanName,
                  qty_m1: m1, qty_m2: m2, qty_m3: m3,
                  isValid: errors.length === 0,
                  errors,
                  originalRow: rows.length + 1,
                });
              }
            }

            setConversionSummary({
              inputRows: comboInputRows.length,
              singlesOutput: conv.singles.length,
              combosResolved: conv.combosResolved,
              warnings: conv.warnings,
            });
            setUploadData(rows);
            setShowPreview(true);
            return;
          }
          // ── END MULTI-CHANNEL COMBO PATH ──────────────────────────────────

          // ── SINGLE-CHANNEL COMBO PATH ─────────────────────────────────────
          const qtyColumns = headers.filter(h => h !== skuCol && h.trim() !== "");

          // Parse input combo rows
          const comboInputRows: ComboInputRow[] = [];
          for (const row of json) {
            const sku = String(row[skuCol] || "").trim();
            if (!sku) continue;
            const quantities: Record<string, number> = {};
            for (const col of qtyColumns) {
              const v = Number(row[col]);
              quantities[col] = isNaN(v) ? 0 : v;
            }
            comboInputRows.push({ master_sku: sku, quantities });
          }
          if (comboInputRows.length === 0) { setError("No data rows found in file."); return; }

          // Run conversion
          const conv = runComboConversion(comboInputRows, mapperForConversion, qtyColumns);

          // Map singles → UploadRow (validate against SKU master + channel mapping)
          const rows: UploadRow[] = conv.singles.map((single, idx) => {
            const errors: string[] = [];
            const matchedSku = skus.find(s =>
              s.new_master_sku.toLowerCase() === single.master_sku.toLowerCase()
            );
            if (!matchedSku) errors.push(`SKU "${single.master_sku}" not found in SKU master`);

            const channelId = selectedChannel;
            const channelName = channels.find(c => c.id === channelId)?.name || "";

            if (matchedSku && channelId) {
              const chMapping = channelSkuMapping.get(channelId);
              if (chMapping && chMapping.size > 0 && !chMapping.has(matchedSku.id))
                errors.push("SKU not enabled for this channel");
            }

            // Map qty columns to m1/m2/m3 by label (fall back to positional)
            const q1 = Math.round((single.quantities[m1Label] ?? single.quantities[qtyColumns[0]] ?? 0) * 100) / 100;
            const q2 = Math.round((single.quantities[m2Label] ?? single.quantities[qtyColumns[1]] ?? 0) * 100) / 100;
            const q3 = Math.round((single.quantities[m3Label] ?? single.quantities[qtyColumns[2]] ?? 0) * 100) / 100;

            if (matchedSku && channelId && q1 === 0 && q2 === 0 && q3 === 0)
              errors.push("All quantities are zero");

            return {
              sku_id: matchedSku?.id || "",
              new_master_sku: single.master_sku,
              product_name: matchedSku?.product_name || "Unknown",
              channel_id: channelId,
              channel_name: channelName,
              qty_m1: q1, qty_m2: q2, qty_m3: q3,
              isValid: errors.length === 0,
              errors,
              originalRow: idx + 2,
            };
          });

          setConversionSummary({
            inputRows: comboInputRows.length,
            singlesOutput: conv.singles.length,
            combosResolved: conv.combosResolved,
            warnings: conv.warnings,
          });
          setUploadData(rows);
          setShowPreview(true);
          return;
        }
        // ── END COMBO PATH ─────────────────────────────────────────────────

        const headers = Object.keys(json[0]);

        // Auto-detect if file has a Channel/Platform column
        const hasChannelCol = headers.some((h) =>
          ["Channel", "channel", "Platform", "platform"].includes(h)
        );

        // If no channel column and no channel selected, error
        if (!hasChannelCol && !selectedChannel) {
          setError("File has no Channel column. Please select a channel in single-channel mode, or add a Channel column.");
          return;
        }

        // Detect month columns
        const m1Col = headers.find((h) => h === m1Label || h.includes(m1Label)) || headers.find((h) => /quantity|qty/i.test(h)) || m1Label;
        const m2Col = headers.find((h) => h === m2Label || h.includes(m2Label)) || m2Label;
        const m3Col = headers.find((h) => h === m3Label || h.includes(m3Label)) || m3Label;

        const rows: UploadRow[] = json.map((row: any, index: number) => {
          const errors: string[] = [];

          // SKU validation
          const skuCode = String(row["New Master SKU"] || row["new_master_sku"] || "").trim();
          const matchedSku = skus.find((s) => s.new_master_sku.toLowerCase() === skuCode.toLowerCase());
          if (!skuCode) errors.push("Missing SKU");
          else if (!matchedSku) errors.push(`SKU "${skuCode}" not found`);

          // Channel resolution
          let channelId = "";
          let channelName = "";

          if (hasChannelCol) {
            // Multi-channel file: read channel from row
            const platform = String(row["Channel"] || row["channel"] || row["Platform"] || row["platform"] || "").trim();
            if (!platform) {
              errors.push("Missing Channel");
            } else {
              const matchedCh = channels.find((ch) => ch.name.toLowerCase() === platform.toLowerCase());
              if (!matchedCh) {
                errors.push(`Channel "${platform}" not found`);
              } else if (!allowedChannelIds.includes(matchedCh.id)) {
                // ACCESS ENFORCEMENT: reject channels user doesn't have access to
                errors.push(`No access to "${platform}"`);
              } else {
                channelId = matchedCh.id;
                channelName = matchedCh.name;
              }
            }
          } else {
            // Single-channel file: use selected channel
            channelId = selectedChannel;
            channelName = channels.find((c) => c.id === selectedChannel)?.name || "";
          }

          // Validate SKU-channel mapping
          if (matchedSku && channelId) {
            const chMapping = channelSkuMapping.get(channelId);
            if (chMapping && chMapping.size > 0 && !chMapping.has(matchedSku.id)) {
              errors.push("SKU not enabled for this channel");
            }
          }

          // Parse 3 month quantities
          function parseQty(val: any, label: string): number {
            if (val === "" || val === null || val === undefined) return 0;
            const num = Number(val);
            if (isNaN(num)) { errors.push(`Invalid number in ${label}`); return 0; }
            if (num < 0) { errors.push(`Negative in ${label}`); return 0; }
            return num;
          }

          const q1 = parseQty(row[m1Col], m1Label);
          const q2 = parseQty(row[m2Col], m2Label);
          const q3 = parseQty(row[m3Col], m3Label);

          if (matchedSku && channelId && q1 === 0 && q2 === 0 && q3 === 0) {
            errors.push("All quantities are zero");
          }

          return {
            sku_id: matchedSku?.id || "",
            new_master_sku: skuCode || "-",
            product_name: matchedSku?.product_name || "Unknown",
            channel_id: channelId,
            channel_name: channelName || "-",
            qty_m1: q1, qty_m2: q2, qty_m3: q3,
            isValid: errors.length === 0,
            errors,
            originalRow: index + 2,
          };
        });

        setUploadData(rows);
        setShowPreview(true);
      } catch (err) {
        setError("Failed to parse the file. Please check the format.");
      }
    };
    reader.readAsBinaryString(file);
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) parseFile(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") setDragActive(true);
    else if (e.type === "dragleave") setDragActive(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) parseFile(file);
  }, [skus, channels, allowedChannelIds, selectedChannel, m1Label, uploadMode, hasCombo, comboMapperRows]);

  // ====== SAVE ======
  async function handleSave() {
    const validRows = uploadData.filter((r) => r.isValid);
    if (validRows.length === 0) { setError("No valid rows to save."); return; }

    setSaving(true);
    setError(null);

    const { data: { user } } = await supabase.auth.getUser();

    // Build inserts: up to 3 per row (one per month), skip zero qty
    const inserts: any[] = [];
    for (const row of validRows) {
      const base = {
        sku_id: row.sku_id,
        channel_id: row.channel_id,
        version: selectedCycleData?.version || 1,
        status: "draft",
        cycle_id: selectedCycle,
        uploaded_by: user?.id,
        uploaded_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      if (row.qty_m1 > 0) inserts.push({ ...base, forecast_month: month1, quantity: row.qty_m1 });
      if (row.qty_m2 > 0) inserts.push({ ...base, forecast_month: month2, quantity: row.qty_m2 });
      if (row.qty_m3 > 0) inserts.push({ ...base, forecast_month: month3, quantity: row.qty_m3 });
    }

    // Delete existing drafts for affected channels
    const channelIds = [...new Set(validRows.map((r) => r.channel_id))];
    for (const chId of channelIds) {
      await supabase.from("forecast_data").delete()
        .eq("channel_id", chId)
        .eq("cycle_id", selectedCycle)
        .eq("status", "draft")
        .eq("uploaded_by", user?.id);
    }

    const { error: insertError } = await supabase.from("forecast_data").insert(inserts);
    if (insertError) { setError(insertError.message); setSaving(false); return; }

    // Logs
    const channelNames = channelIds.map((id) => channels.find((c) => c.id === id)?.name).join(", ");
    for (const chId of channelIds) {
      const chRows = validRows.filter((r) => r.channel_id === chId);
      await supabase.from("upload_log").insert({
        user_id: user?.id, channel_id: chId,
        forecast_month: selectedCycleData?.forecast_month,
        file_name: `${channels.find((c) => c.id === chId)?.name}_upload`,
        rows_uploaded: chRows.length, status: "success",
      });
    }

    await supabase.from("audit_log").insert({
      user_id: user?.id, user_email: user?.email, action: "forecast_upload",
      table_name: "forecast_data", record_id: selectedCycle,
      new_values: {
        channels: channelNames, mode: uploadMode,
        cycle: `${m1Label} V${selectedCycleData?.version}`,
        sku_rows: validRows.length, db_rows: inserts.length,
        months: [m1Label, m2Label, m3Label],
      },
    });

    setSuccessMsg(
      `${validRows.length} SKU rows saved across ${channelIds.length} channel(s): ${channelNames}. (${inserts.length} forecast records created)`
    );
    setShowPreview(false);
    setUploadData([]);
    setSaving(false);
    setTimeout(() => setSuccessMsg(null), 6000);
  }

  function formatDeadline(dateStr: string | null) {
    if (!dateStr) return "No deadline";
    return new Date(dateStr).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  const validCount = uploadData.filter((r) => r.isValid).length;
  const errorCount = uploadData.filter((r) => !r.isValid).length;
  const totalM1 = uploadData.filter((r) => r.isValid).reduce((s, r) => s + r.qty_m1, 0);
  const totalM2 = uploadData.filter((r) => r.isValid).reduce((s, r) => s + r.qty_m2, 0);
  const totalM3 = uploadData.filter((r) => r.isValid).reduce((s, r) => s + r.qty_m3, 0);
  const uniqueChannels = [...new Set(uploadData.filter((r) => r.isValid).map((r) => r.channel_name))];

  // Ready to show upload zone?
  const readyToUpload = selectedCycle && (
    (uploadMode === "single" && selectedChannel) ||
    (uploadMode === "multi" && selectedChannelIds.length > 0)
  );

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 text-white">
        <nav className="border-b border-gray-800 bg-gray-900">
          <div className="max-w-7xl mx-auto px-6 py-4">
            <Link href="/dashboard" className="text-lg font-bold text-white">Demand Planning Module - Yogabars</Link>
          </div>
        </nav>
        <div className="flex items-center justify-center h-64"><p className="text-gray-400">Loading...</p></div>
      </div>
    );
  }

  if (!canUpload) {
    return (
      <div className="min-h-screen bg-gray-950 text-white">
        <nav className="border-b border-gray-800 bg-gray-900">
          <div className="max-w-7xl mx-auto px-6 py-4 flex items-center gap-6">
            <Link href="/dashboard" className="text-lg font-bold text-white">Demand Planning Module - Yogabars</Link>
            <Link href="/dashboard" className="text-sm text-gray-400 hover:text-white transition">Dashboard</Link>
          </div>
        </nav>
        <div className="max-w-7xl mx-auto px-6 py-16 text-center">
          <h2 className="text-2xl font-bold mb-4">Access Restricted</h2>
          <p className="text-gray-400">Your role does not have upload access.</p>
          <Link href="/dashboard" className="inline-block mt-6 px-6 py-2 bg-gray-800 rounded-lg text-sm hover:bg-gray-700 transition">Back to Dashboard</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <nav className="border-b border-gray-800 bg-gray-900">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/dashboard" className="text-lg font-bold text-white">Demand Planning Module - Yogabars</Link>
            <div className="hidden md:flex items-center gap-4">
              <Link href="/dashboard" className="text-sm text-gray-400 hover:text-white transition">Dashboard</Link>
              <span className="text-sm text-amber-400 font-medium">Upload</span>
              <Link href="/channels" className="text-sm text-gray-400 hover:text-white transition">Forecast View</Link>
              <Link href="/combo-converter" className="text-sm text-gray-400 hover:text-white transition">Combo → Singles</Link>
              {profile?.role === "admin" && <Link href="/admin" className="text-sm text-gray-400 hover:text-white transition">Admin</Link>}
            </div>
          </div>
        </div>
      </nav>

      <div className="max-w-6xl mx-auto px-6 py-8">
        <h2 className="text-2xl font-bold mb-2">Upload Forecast</h2>
        <p className="text-sm text-gray-400 mb-8">
          Upload forecast data with 3-month rolling quantities. Data is saved as draft until admin publishes.
        </p>

        {successMsg && (
          <div className="mb-6 p-4 bg-green-900/50 border border-green-500 rounded-xl">
            <p className="text-green-300 font-medium">{successMsg}</p>
            <p className="text-green-400/70 text-sm mt-1">Saved as draft. Admin will review and publish.</p>
          </div>
        )}

        {!showPreview && (
          <div className="space-y-6">

            {/* Upload Mode Toggle (Admin & Head KAM only) */}
            {canUseMultiMode && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
                <label className="block text-sm font-medium text-gray-300 mb-3">Upload Mode</label>
                <div className="flex gap-3">
                  <button
                    onClick={() => { setUploadMode("single"); setError(null); }}
                    className={`flex-1 px-4 py-3 rounded-lg text-sm text-left transition border ${
                      uploadMode === "single"
                        ? "bg-amber-500/10 text-amber-400 border-amber-500/30 ring-1 ring-amber-500"
                        : "bg-gray-800 text-gray-400 border-transparent hover:bg-gray-700"
                    }`}
                  >
                    <p className="font-medium">Single Channel</p>
                    <p className="text-xs mt-0.5 opacity-70">Upload for one channel at a time</p>
                  </button>
                  <button
                    onClick={() => { setUploadMode("multi"); setSelectedChannel(""); setError(null); }}
                    className={`flex-1 px-4 py-3 rounded-lg text-sm text-left transition border ${
                      uploadMode === "multi"
                        ? "bg-amber-500/10 text-amber-400 border-amber-500/30 ring-1 ring-amber-500"
                        : "bg-gray-800 text-gray-400 border-transparent hover:bg-gray-700"
                    }`}
                  >
                    <p className="font-medium">Multi-Channel</p>
                    <p className="text-xs mt-0.5 opacity-70">Upload for all your channels in one file</p>
                  </button>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

              {/* Channel Selection (Single mode only) */}
              {uploadMode === "single" && (
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
                  <label className="block text-sm font-medium text-gray-300 mb-3">
                    {canUseMultiMode ? "2" : "1"}. Select Channel
                  </label>
                  {allowedChannels.length === 0 ? (
                    <p className="text-sm text-red-400">No channels assigned to you. Contact admin.</p>
                  ) : (
                    <select value={selectedChannel} onChange={(e) => setSelectedChannel(e.target.value)}
                      className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-500">
                      <option value="">Choose a channel...</option>
                      {getChannelsByCluster().map((group) => (
                        <optgroup key={group.cluster.id} label={group.cluster.name}>
                          {group.channels.map((ch) => (
                            <option key={ch.id} value={ch.id}>{ch.name}</option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  )}
                </div>
              )}

              {/* Multi-channel channel selector */}
              {uploadMode === "multi" && (
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
                  <div className="flex items-center justify-between mb-3">
                    <label className="text-sm font-medium text-gray-300">
                      2. Select Channels
                      <span className="ml-2 text-xs text-gray-500">({selectedChannelIds.length}/{allowedChannels.length} selected)</span>
                    </label>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setSelectedChannelIds(allowedChannels.map(c => c.id))}
                        className="text-xs text-amber-400 hover:text-amber-300 transition"
                      >Select All</button>
                      <span className="text-gray-700 text-xs">|</span>
                      <button
                        onClick={() => setSelectedChannelIds([])}
                        className="text-xs text-gray-500 hover:text-gray-400 transition"
                      >Clear</button>
                    </div>
                  </div>
                  <div className="space-y-3">
                    {clusters.map((cl) => {
                      const clChannels = allowedChannels.filter(ch => ch.cluster_id === cl.id);
                      if (clChannels.length === 0) return null;
                      return (
                        <div key={cl.id}>
                          <p className="text-xs text-gray-500 mb-1.5 font-medium uppercase tracking-wide">{cl.name}</p>
                          <div className="flex flex-wrap gap-1.5">
                            {clChannels.map((ch) => {
                              const active = selectedChannelIds.includes(ch.id);
                              return (
                                <button
                                  key={ch.id}
                                  onClick={() => setSelectedChannelIds(prev =>
                                    active ? prev.filter(id => id !== ch.id) : [...prev, ch.id]
                                  )}
                                  className={`px-2.5 py-1 rounded-lg text-xs transition border ${
                                    active
                                      ? "bg-amber-500/15 text-amber-300 border-amber-500/40"
                                      : "bg-gray-800 text-gray-500 border-gray-700 hover:border-gray-600"
                                  }`}
                                >
                                  {ch.name}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {selectedChannelIds.length === 0 && (
                    <p className="text-xs text-red-400 mt-3">Select at least one channel to continue.</p>
                  )}
                </div>
              )}

              {/* Cycle Selection */}
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
                <label className="block text-sm font-medium text-gray-300 mb-3">
                  {canUseMultiMode ? "3" : "2"}. Select Forecast Cycle
                </label>
                {cycles.length === 0 ? (
                  <p className="text-sm text-red-400">
                    No open forecast cycles. {profile?.role === "admin" ? "Create one in Admin > Forecast Cycles." : "Contact admin."}
                  </p>
                ) : (
                  <select value={selectedCycle} onChange={(e) => setSelectedCycle(e.target.value)}
                    className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-500">
                    <option value="">Choose a cycle...</option>
                    {cycles.map((cycle) => (
                      <option key={cycle.id} value={cycle.id}>
                        {formatMonthShort(cycle.forecast_month)} - V{cycle.version}
                        {cycle.deadline ? ` (Due: ${formatDeadline(cycle.deadline)})` : ""}
                      </option>
                    ))}
                  </select>
                )}
                {isDeadlinePassed && (
                  <div className="mt-3 p-3 bg-red-900/50 border border-red-500 rounded-lg">
                    <p className="text-red-300 text-xs">Deadline passed. You may not be able to submit.</p>
                  </div>
                )}
              </div>
            </div>

            {/* Template Info + Download */}
            {readyToUpload && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-medium text-gray-300 mb-1">
                      {canUseMultiMode ? "4" : "3"}. Download Template & Upload
                    </h3>
                    <p className="text-xs text-gray-500">
                      {uploadMode === "single" ? (
                        <>Columns: <span className="text-white">New Master SKU</span>, <span className="text-amber-400">{m1Label}</span>, <span className="text-blue-400">{m2Label}</span>, <span className="text-purple-400">{m3Label}</span></>
                      ) : hasCombo ? (
                        <>
                          2-row header: <span className="text-amber-400">Row 1 = Months</span> (<span className="text-amber-400">{m1Label}</span>, <span className="text-blue-400">{m2Label}</span>, <span className="text-purple-400">{m3Label}</span>), <span className="text-amber-400">Row 2 = Channels</span> — {selectedChannelIds.length} channel(s) × 3 months
                          <br /><span className="text-gray-600">Each channel gets 3 columns. Fill combo SKU quantities; system converts to singles.</span>
                        </>
                      ) : (
                        <>Columns: <span className="text-white">New Master SKU</span>, <span className="text-white">Channel</span>, <span className="text-amber-400">{m1Label}</span>, <span className="text-blue-400">{m2Label}</span>, <span className="text-purple-400">{m3Label}</span></>
                      )}
                    </p>
                  </div>
                  <button onClick={downloadTemplate} className="px-4 py-2 text-sm bg-gray-800 text-gray-300 rounded-lg hover:bg-gray-700 transition whitespace-nowrap">
                    Download Template
                  </button>
                </div>
              </div>
            )}

            {/* Combo SKU checkbox */}
            {readyToUpload && (
              <div className={`bg-gray-900 border rounded-xl p-5 transition ${hasCombo ? "border-amber-500/40" : "border-gray-800"}`}>
                <label className="flex items-start gap-3 cursor-pointer group">
                  <div className="mt-0.5">
                    <input
                      type="checkbox"
                      checked={hasCombo}
                      onChange={(e) => {
                        setHasCombo(e.target.checked);
                        setConversionSummary(null);
                      }}
                      className="w-4 h-4 rounded border-gray-600 accent-amber-500 cursor-pointer"
                    />
                  </div>
                  <div>
                    <span className="text-sm font-medium text-gray-200">My file contains combo SKUs</span>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {uploadMode === "multi"
                        ? "Pivoted format: one column per channel (channels as columns, not rows). Combo SKUs are converted to singles per channel. M1 quantities only."
                        : "Automatically converts combo SKUs to their component singles before saving. Use the same download template — fill in combo SKU quantities as normal."}
                    </p>
                  </div>
                </label>

                {hasCombo && (
                  <div className="mt-4 pt-4 border-t border-gray-800">
                    {comboMapperSets.length === 0 ? (
                      <p className="text-xs text-red-400">No mappers available. Ask admin to upload one in Combo → Singles.</p>
                    ) : profile?.role === "admin" ? (
                      /* ── Admin: can pick mapper + set as default ── */
                      <div className="space-y-2">
                        <label className="block text-xs text-gray-400 font-medium">Combo Mapper (Admin)</label>
                        <div className="flex items-center gap-2">
                          <select
                            value={comboMapperId}
                            onChange={(e) => setComboMapperId(e.target.value)}
                            className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
                          >
                            <option value="">Choose mapper...</option>
                            {comboMapperSets.map(ms => (
                              <option key={ms.id} value={ms.id}>
                                {ms.name} ({ms.row_count} SKUs, P1–P{ms.product_column_count}){ms.is_default ? " ★ Default" : ""}
                              </option>
                            ))}
                          </select>
                          {/* Set as default button — only show when selected mapper is not already default */}
                          {comboMapperId && !comboMapperSets.find(ms => ms.id === comboMapperId)?.is_default && (
                            <button
                              onClick={async () => {
                                await supabase.from("combo_mapper_sets").update({ is_default: false }).neq("id", comboMapperId);
                                await supabase.from("combo_mapper_sets").update({ is_default: true }).eq("id", comboMapperId);
                                // Refresh mapper sets list to reflect new default
                                const { data } = await supabase
                                  .from("combo_mapper_sets").select("id, name, row_count, product_column_count, is_default")
                                  .order("created_at", { ascending: false });
                                if (data) setComboMapperSets(data);
                              }}
                              className="px-3 py-2 text-xs bg-amber-500/10 text-amber-400 border border-amber-500/30 rounded-lg hover:bg-amber-500/20 transition whitespace-nowrap"
                            >
                              Set as Default
                            </button>
                          )}
                          {comboMapperId && comboMapperSets.find(ms => ms.id === comboMapperId)?.is_default && (
                            <span className="px-3 py-2 text-xs text-green-400 border border-green-500/20 rounded-lg bg-green-500/10 whitespace-nowrap">★ Default</span>
                          )}
                        </div>
                        <div className="text-xs">
                          {comboLoadingMapper && <span className="text-gray-500">Loading mapper data...</span>}
                          {!comboLoadingMapper && comboMapperRows.length > 0 && (
                            <span className="text-green-400">✓ {comboMapperRows.length} SKUs loaded — ready for conversion</span>
                          )}
                          {!comboLoadingMapper && comboMapperId && comboMapperRows.length === 0 && (
                            <span className="text-red-400">Mapper has no data</span>
                          )}
                        </div>
                        <p className="text-xs text-gray-600">
                          To upload or update a mapper, go to{" "}
                          <a href="/combo-converter" className="text-amber-400 hover:underline">Combo → Singles</a>
                          {" "}→ Manage Mappers.
                        </p>
                      </div>
                    ) : (
                      /* ── KAM: read-only, shows active default mapper ── */
                      <div>
                        <label className="block text-xs text-gray-400 mb-1.5 font-medium">Combo Mapper</label>
                        {(() => {
                          const active = comboMapperSets.find(ms => ms.id === comboMapperId);
                          return active ? (
                            <div className="flex items-center gap-3 px-3 py-2 bg-gray-800/60 border border-gray-700 rounded-lg">
                              <span className="text-sm text-white font-medium">{active.name}</span>
                              <span className="text-xs text-gray-500">{active.row_count} SKUs · P1–P{active.product_column_count}</span>
                              <span className="ml-auto text-xs">
                                {comboLoadingMapper && <span className="text-gray-500">Loading...</span>}
                                {!comboLoadingMapper && comboMapperRows.length > 0 && (
                                  <span className="text-green-400">✓ Ready</span>
                                )}
                              </span>
                            </div>
                          ) : (
                            <p className="text-xs text-red-400">No default mapper set. Ask admin to configure one.</p>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Upload Zone */}
            {readyToUpload && !isDeadlinePassed && (
              <div onDragEnter={handleDrag} onDragLeave={handleDrag} onDragOver={handleDrag} onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition ${dragActive ? "border-amber-500 bg-amber-500/5" : "border-gray-700 hover:border-gray-600 hover:bg-gray-900/50"}`}>
                <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFileInput} />
                <div className="text-4xl mb-3">{"\uD83D\uDCC4"}</div>
                <p className="text-gray-300 font-medium mb-1">Drag & drop your Excel file here</p>
                <p className="text-gray-500 text-sm">or click to browse</p>
              </div>
            )}

            {error && (
              <div className="p-4 bg-red-900/50 border border-red-500 rounded-xl">
                <p className="text-red-300 text-sm">{error}</p>
              </div>
            )}
          </div>
        )}

        {/* ====== PREVIEW ====== */}
        {showPreview && (
          <div>
            {/* Combo conversion banner */}
            {conversionSummary && (
              <div className="mb-6 bg-amber-900/20 border border-amber-500/30 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-amber-400 font-semibold text-sm">Combo Conversion Applied</span>
                  <span className="text-xs text-gray-500">— review the converted singles below before saving</span>
                </div>
                <div className="grid grid-cols-4 gap-4 mb-3">
                  <div className="bg-gray-900/60 rounded-lg p-3 text-center">
                    <p className="text-xl font-bold text-white">{conversionSummary.inputRows}</p>
                    <p className="text-xs text-gray-400 mt-0.5">Input rows</p>
                  </div>
                  <div className="bg-green-900/30 border border-green-500/20 rounded-lg p-3 text-center">
                    <p className="text-xl font-bold text-green-400">{conversionSummary.singlesOutput}</p>
                    <p className="text-xs text-gray-400 mt-0.5">Singles out</p>
                  </div>
                  <div className="bg-amber-900/30 border border-amber-500/20 rounded-lg p-3 text-center">
                    <p className="text-xl font-bold text-amber-400">{conversionSummary.combosResolved}</p>
                    <p className="text-xs text-gray-400 mt-0.5">Combos resolved</p>
                  </div>
                  <div className={`rounded-lg p-3 text-center border ${conversionSummary.warnings.length > 0 ? "bg-red-900/30 border-red-500/20" : "bg-gray-900/60 border-transparent"}`}>
                    <p className={`text-xl font-bold ${conversionSummary.warnings.length > 0 ? "text-red-400" : "text-gray-600"}`}>{conversionSummary.warnings.length}</p>
                    <p className="text-xs text-gray-400 mt-0.5">Warnings</p>
                  </div>
                </div>
                {conversionSummary.warnings.length > 0 && (
                  <div className="pt-3 border-t border-amber-500/20">
                    <p className="text-xs text-amber-300 font-medium mb-1.5">Not-in-mapper SKUs (passed through as singles):</p>
                    <div className="max-h-[72px] overflow-y-auto space-y-0.5">
                      {conversionSummary.warnings.map((w, i) => (
                        <p key={i} className="text-xs text-amber-300/70 font-mono">{w}</p>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Summary */}
            <div className="grid grid-cols-3 md:grid-cols-7 gap-3 mb-6">
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 text-center">
                <p className="text-xl font-bold">{uploadData.length}</p>
                <p className="text-xs text-gray-400">Rows</p>
              </div>
              <div className="bg-gray-900 border border-green-800 rounded-xl p-3 text-center">
                <p className="text-xl font-bold text-green-400">{validCount}</p>
                <p className="text-xs text-gray-400">Valid</p>
              </div>
              <div className="bg-gray-900 border border-red-800 rounded-xl p-3 text-center">
                <p className="text-xl font-bold text-red-400">{errorCount}</p>
                <p className="text-xs text-gray-400">Errors</p>
              </div>
              <div className="bg-gray-900 border border-amber-800/50 rounded-xl p-3 text-center">
                <p className="text-xl font-bold text-amber-400">{totalM1.toLocaleString()}</p>
                <p className="text-xs text-gray-400">{m1Label}</p>
              </div>
              <div className="bg-gray-900 border border-blue-800/50 rounded-xl p-3 text-center">
                <p className="text-xl font-bold text-blue-400">{totalM2.toLocaleString()}</p>
                <p className="text-xs text-gray-400">{m2Label}</p>
              </div>
              <div className="bg-gray-900 border border-purple-800/50 rounded-xl p-3 text-center">
                <p className="text-xl font-bold text-purple-400">{totalM3.toLocaleString()}</p>
                <p className="text-xs text-gray-400">{m3Label}</p>
              </div>
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 text-center">
                <p className="text-xl font-bold text-cyan-400">{uniqueChannels.length}</p>
                <p className="text-xs text-gray-400">Channels</p>
              </div>
            </div>

            {/* Info bar */}
            <div className="flex items-center gap-4 mb-4 text-sm text-gray-400 flex-wrap">
              <span>Cycle: <span className="text-white font-medium">{m1Label} V{selectedCycleData?.version}</span></span>
              <span>&#8226;</span>
              <span>Rolling: <span className="text-amber-400">{m1Label}</span> + <span className="text-blue-400">{m2Label}</span> + <span className="text-purple-400">{m3Label}</span></span>
              {uniqueChannels.length <= 6 && (
                <>
                  <span>&#8226;</span>
                  <span>Channels: <span className="text-white font-medium">{uniqueChannels.join(", ")}</span></span>
                </>
              )}
            </div>

            {/* Table */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden mb-6">
              <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-gray-900 z-10">
                    <tr className="border-b border-gray-800">
                      <th className="text-left py-3 px-3 text-gray-400 font-medium w-10">Row</th>
                      <th className="text-left py-3 px-3 text-gray-400 font-medium">SKU</th>
                      <th className="text-left py-3 px-3 text-gray-400 font-medium">Channel</th>
                      <th className="text-right py-3 px-3 text-amber-400 font-medium">{m1Label}</th>
                      <th className="text-right py-3 px-3 text-blue-400 font-medium">{m2Label}</th>
                      <th className="text-right py-3 px-3 text-purple-400 font-medium">{m3Label}</th>
                      <th className="text-left py-3 px-3 text-gray-400 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {uploadData.map((row, i) => (
                      <tr key={i} className={`border-b border-gray-800/50 ${!row.isValid ? "bg-red-900/10" : ""}`}>
                        <td className="py-2 px-3 text-gray-500 text-xs">{row.originalRow}</td>
                        <td className="py-2 px-3 font-mono text-xs">{row.new_master_sku}</td>
                        <td className="py-2 px-3 text-xs text-gray-300">{row.channel_name}</td>
                        <td className="py-2 px-3 text-right font-mono text-xs">{row.isValid ? (row.qty_m1 > 0 ? row.qty_m1.toLocaleString() : "-") : "-"}</td>
                        <td className="py-2 px-3 text-right font-mono text-xs">{row.isValid ? (row.qty_m2 > 0 ? row.qty_m2.toLocaleString() : "-") : "-"}</td>
                        <td className="py-2 px-3 text-right font-mono text-xs">{row.isValid ? (row.qty_m3 > 0 ? row.qty_m3.toLocaleString() : "-") : "-"}</td>
                        <td className="py-2 px-3">
                          {row.isValid ? (
                            <span className="text-green-400 text-xs">{"\u2713"}</span>
                          ) : (
                            <div>{row.errors.map((err, j) => (<span key={j} className="block text-red-400 text-xs">{"\u2717"} {err}</span>))}</div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {error && (
              <div className="mb-6 p-4 bg-red-900/50 border border-red-500 rounded-xl">
                <p className="text-red-300 text-sm">{error}</p>
              </div>
            )}

            {/* Actions */}
            <div className="flex justify-between items-center">
              <button onClick={() => { setShowPreview(false); setUploadData([]); setError(null); setConversionSummary(null); }}
                className="px-6 py-2.5 bg-gray-800 text-gray-300 rounded-lg hover:bg-gray-700 transition">
                {"\u2190"} Back
              </button>
              <div className="flex items-center gap-4">
                {errorCount > 0 && <p className="text-xs text-gray-500">{errorCount} error rows skipped.</p>}
                <button onClick={handleSave} disabled={saving || validCount === 0}
                  className="px-6 py-2.5 bg-amber-500 text-black font-semibold rounded-lg hover:bg-amber-400 disabled:opacity-50 disabled:cursor-not-allowed transition">
                  {saving ? "Saving..." : `Save ${validCount} Rows as Draft`}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}