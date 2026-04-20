import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const PAGE = 1000;

async function fetchAllRows(table: string, select: string) {
  const all: any[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

const VALID_CLUSTERS = ["B2C", "B2B", "Qcom", "MT", "GT", "Growth", "CSD"];

function normalizeCluster(raw: string): string | null {
  const map: Record<string, string> = {
    b2c: "B2C",
    b2b: "B2B",
    qcom: "Qcom",
    "q-com": "Qcom",
    "quick commerce": "Qcom",
    mt: "MT",
    "modern trade": "MT",
    gt: "GT",
    "general trade": "GT",
    growth: "Growth",
    csd: "CSD",
    "marketplace b2c": "B2C",
    "marketplace b2b": "B2B",
  };
  const key = raw.toLowerCase().trim();
  return map[key] || (VALID_CLUSTERS.includes(raw.trim()) ? raw.trim() : null);
}

type ExpandedRow = {
  master_sku: string;
  fg_code: string;
  product_name: string;
  category: string;
  product_category: string;
  cluster_name: string;
  channel_detail: string;
  quantity: number;
  original_master_sku: string | null;
  is_from_combo: boolean;
};

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const sourceType = formData.get("source_type") as string | null;
    const month = formData.get("month") as string | null;
    const authToken = formData.get("auth_token") as string | null;

    if (!file || !sourceType || !month) {
      return NextResponse.json(
        { error: "file, source_type, and month are required" },
        { status: 400 }
      );
    }

    if (!["SO", "STN", "Shipsheet"].includes(sourceType)) {
      return NextResponse.json(
        { error: "source_type must be SO, STN, or Shipsheet" },
        { status: 400 }
      );
    }

    // Auth — admin only
    if (!authToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const {
      data: { user },
    } = await supabase.auth.getUser(authToken);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();
    if (!profile || profile.role !== "admin") {
      return NextResponse.json({ error: "Admin only" }, { status: 403 });
    }

    // Load lookups
    const allSkus = await fetchAllRows(
      "sku_master",
      "id, new_master_sku, new_fg_code, fg_code, product_name, category, product_category"
    );
    const skuByFg = new Map<string, (typeof allSkus)[0]>();
    const skuByMaster = new Map<string, (typeof allSkus)[0]>();
    for (const s of allSkus) {
      if (s.new_fg_code) skuByFg.set(s.new_fg_code.toLowerCase(), s);
      // Also match without trailing G
      if (s.new_fg_code && s.new_fg_code.endsWith("G")) {
        skuByFg.set(s.new_fg_code.slice(0, -1).toLowerCase(), s);
      }
      if (s.new_master_sku) skuByMaster.set(s.new_master_sku, s);
    }

    // Load combo mapper for expansion
    const comboRows = await fetchAllRows(
      "combo_mapper_rows",
      "master_sku, is_combo, products, fg_code"
    );
    const comboMap = new Map<
      string,
      { is_combo: boolean; products: string[]; fg_code: string }
    >();
    for (const c of comboRows) {
      comboMap.set(c.master_sku, {
        is_combo: c.is_combo === true || c.is_combo === "true",
        products: c.products || [],
        fg_code: c.fg_code || "",
      });
    }

    // Load customer mapper
    const { data: customerMapperRows } = await supabase
      .from("customer_channel_mapper")
      .select("customer_name, customer_type");
    const customerMapper = new Map<string, string>();
    for (const r of customerMapperRows || []) {
      customerMapper.set(r.customer_name.toLowerCase(), r.customer_type);
    }

    // Load CFA mapper
    const { data: cfaMapperRows } = await supabase
      .from("cfa_channel_mapper")
      .select("cfa_name, channel");
    const cfaMapper = new Map<string, string>();
    for (const r of cfaMapperRows || []) {
      cfaMapper.set(r.cfa_name.toLowerCase(), r.channel);
    }

    // Parse Excel
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws || !ws["!ref"]) {
      return NextResponse.json(
        { error: "Empty file" },
        { status: 400 }
      );
    }

    const range = XLSX.utils.decode_range(ws["!ref"]);
    const warnings: string[] = [];
    const unmappedCustomers = new Set<string>();
    const unmappedSkus = new Set<string>();

    // Resolve FG Code → Master SKU, with combo expansion
    function resolveAndExpand(
      fgCode: string,
      qty: number,
      cluster: string,
      detail: string
    ): ExpandedRow[] {
      const fgClean = String(fgCode).trim();
      if (!fgClean) return [];

      // Try to find in sku_master by FG code
      let sku = skuByFg.get(fgClean.toLowerCase());

      // Also try with/without G suffix
      if (!sku && !fgClean.endsWith("G")) {
        sku = skuByFg.get((fgClean + "G").toLowerCase());
      }
      if (!sku && fgClean.endsWith("G")) {
        sku = skuByFg.get(fgClean.slice(0, -1).toLowerCase());
      }

      if (sku) {
        // Found as single in sku_master — no combo expansion needed
        return [
          {
            master_sku: sku.new_master_sku,
            fg_code: fgClean,
            product_name: sku.product_name || "",
            category: sku.category || "",
            product_category: sku.product_category || "",
            cluster_name: cluster,
            channel_detail: detail,
            quantity: qty,
            original_master_sku: null,
            is_from_combo: false,
          },
        ];
      }

      // Not in sku_master — check combo_mapper_rows by fg_code
      let comboEntry: { master_sku: string; is_combo: boolean; products: string[] } | null = null;
      for (const [msku, c] of comboMap) {
        if (
          c.fg_code &&
          (c.fg_code.toLowerCase() === fgClean.toLowerCase() ||
            c.fg_code.toLowerCase() === fgClean.toLowerCase().replace(/g$/, "") ||
            c.fg_code.toLowerCase() + "g" === fgClean.toLowerCase())
        ) {
          comboEntry = { master_sku: msku, ...c };
          break;
        }
      }

      if (!comboEntry) {
        // Also try matching by master_sku directly (sometimes FG code IS the master SKU)
        const byMaster = comboMap.get(fgClean);
        if (byMaster) {
          comboEntry = { master_sku: fgClean, ...byMaster };
        }
      }

      if (comboEntry && comboEntry.is_combo && comboEntry.products.length > 0) {
        // Combo — expand to singles
        return expandCombo(
          comboEntry.master_sku,
          comboEntry.products,
          qty,
          cluster,
          detail,
          fgClean,
          new Set()
        );
      }

      if (comboEntry && !comboEntry.is_combo) {
        // In combo mapper but not actually a combo — treat as single
        const singleSku = skuByMaster.get(comboEntry.master_sku);
        return [
          {
            master_sku: comboEntry.master_sku,
            fg_code: fgClean,
            product_name: singleSku?.product_name || "",
            category: singleSku?.category || "",
            product_category: singleSku?.product_category || "",
            cluster_name: cluster,
            channel_detail: detail,
            quantity: qty,
            original_master_sku: null,
            is_from_combo: false,
          },
        ];
      }

      // Truly unknown
      unmappedSkus.add(fgClean);
      return [];
    }

    function expandCombo(
      parentSku: string,
      products: string[],
      qty: number,
      cluster: string,
      detail: string,
      fgCode: string,
      visited: Set<string>
    ): ExpandedRow[] {
      if (visited.has(parentSku)) return []; // prevent infinite loops
      visited.add(parentSku);

      const results: ExpandedRow[] = [];
      for (const componentSku of products) {
        const trimmed = componentSku.trim();
        if (!trimmed) continue;

        // Check if component is itself a combo (nested)
        const nested = comboMap.get(trimmed);
        if (nested && nested.is_combo && nested.products.length > 0) {
          results.push(
            ...expandCombo(trimmed, nested.products, qty, cluster, detail, fgCode, visited)
          );
        } else {
          // Final single
          const singleSku = skuByMaster.get(trimmed);
          results.push({
            master_sku: trimmed,
            fg_code: fgCode,
            product_name: singleSku?.product_name || "",
            category: singleSku?.category || "",
            product_category: singleSku?.product_category || "",
            cluster_name: cluster,
            channel_detail: detail,
            quantity: qty,
            original_master_sku: parentSku,
            is_from_combo: true,
          });
        }
      }
      return results;
    }

    // Cell reader helper
    function cellVal(r: number, c: number): string {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      return cell ? String(cell.v ?? "").trim() : "";
    }
    function cellNum(r: number, c: number): number {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (!cell) return 0;
      const n = Number(cell.v);
      return isNaN(n) ? 0 : n;
    }

    // Parse based on source type
    const expanded: ExpandedRow[] = [];
    let rawRowCount = 0;
    let combosExpanded = 0;

    if (sourceType === "SO") {
      // SO: header at row 2 (index 1), data from row 3 (index 2)
      // FG Code: col AA (26), Party Name: col J (9), Order Qty: col P (15)
      // Customer Type: col AB (27), Shipsheet Qty: col AD (29)
      const DATA_START = 2;
      const FG_COL = 26;
      const PARTY_COL = 9;
      const QTY_COL = 15;
      const CUST_TYPE_COL = 27;
      const SHIP_QTY_COL = 29;

      // We insert both SO and Shipsheet source_type from the same file
      for (let r = DATA_START; r <= range.e.r; r++) {
        const fgCode = cellVal(r, FG_COL);
        if (!fgCode) continue;

        const orderQty = cellNum(r, QTY_COL);
        const shipQty = cellNum(r, SHIP_QTY_COL);
        const partyName = cellVal(r, PARTY_COL);
        const custType = cellVal(r, CUST_TYPE_COL);

        // Classify channel
        let cluster = normalizeCluster(custType);
        if (!cluster && partyName) {
          const mapped = customerMapper.get(partyName.toLowerCase());
          if (mapped) cluster = normalizeCluster(mapped);
        }
        if (!cluster) {
          unmappedCustomers.add(partyName || `Row ${r + 1}`);
          cluster = "Unknown";
        }

        rawRowCount++;

        // SO rows (Order Qty)
        if (orderQty > 0) {
          const rows = resolveAndExpand(fgCode, Math.round(orderQty), cluster, partyName);
          if (rows.some((r) => r.is_from_combo)) combosExpanded++;
          expanded.push(...rows);
        }

        // Shipsheet rows (from same file, Shipsheet Qty column)
        if (shipQty > 0) {
          const rows = resolveAndExpand(fgCode, Math.round(shipQty), cluster, partyName);
          // Mark these as Shipsheet source
          for (const row of rows) {
            (row as any)._sourceOverride = "Shipsheet";
          }
          expanded.push(...rows);
        }
      }
    } else if (sourceType === "STN") {
      // STN: header at row 2 (index 1), data from row 3 (index 2)
      // FG Code: col K (10), To Warehouse: col F (5), Qty: col P (15)
      const DATA_START = 2;
      const FG_COL = 10;
      const TO_WH_COL = 5;
      const QTY_COL = 15;

      for (let r = DATA_START; r <= range.e.r; r++) {
        const fgRaw = cellVal(r, FG_COL);
        if (!fgRaw) continue;

        // FG code in STN might have prefix like "YB/EB/14051G" — extract last part
        const parts = fgRaw.split("/");
        const fgCode = parts[parts.length - 1].trim();
        if (!fgCode) continue;

        const qty = cellNum(r, QTY_COL);
        if (qty <= 0) continue;

        const toWarehouse = cellVal(r, TO_WH_COL);

        // Classify channel via CFA mapper
        let cluster: string | null = null;
        if (toWarehouse) {
          const mapped = cfaMapper.get(toWarehouse.toLowerCase());
          if (mapped) cluster = normalizeCluster(mapped);
        }
        if (!cluster) {
          unmappedCustomers.add(toWarehouse || `Row ${r + 1}`);
          cluster = "Unknown";
        }

        rawRowCount++;
        const rows = resolveAndExpand(fgCode, Math.round(qty), cluster, toWarehouse);
        if (rows.some((r) => r.is_from_combo)) combosExpanded++;
        expanded.push(...rows);
      }
    } else if (sourceType === "Shipsheet") {
      // Shipsheet: simple template — FG Code | Qty | Channel
      // Or: PO Number matching against stored SO data (future)
      // For now: expect headers in first row with data
      // Try to find headers
      let fgCol = -1,
        qtyCol = -1,
        chCol = -1;

      // Scan first 10 rows for headers
      for (let r = 0; r <= Math.min(9, range.e.r); r++) {
        for (let c = 0; c <= range.e.c; c++) {
          const v = cellVal(r, c).toLowerCase();
          if (v.includes("fg") || v.includes("sku") || v.includes("code"))
            fgCol = c;
          if (v === "qty" || v === "quantity" || v.includes("qty")) qtyCol = c;
          if (v === "channel" || v.includes("channel")) chCol = c;
        }
        if (fgCol >= 0 && qtyCol >= 0) {
          // Found headers at this row — data starts next row
          const DATA_START = r + 1;
          for (let dr = DATA_START; dr <= range.e.r; dr++) {
            const fgCode = cellVal(dr, fgCol);
            const qty = cellNum(dr, qtyCol);
            const channel = chCol >= 0 ? cellVal(dr, chCol) : "";

            if (!fgCode || qty <= 0) continue;

            let cluster = normalizeCluster(channel);
            if (!cluster) cluster = "Unknown";

            rawRowCount++;
            const rows = resolveAndExpand(fgCode, Math.round(qty), cluster, channel);
            if (rows.some((r) => r.is_from_combo)) combosExpanded++;
            expanded.push(...rows);
          }
          break;
        }
      }

      if (fgCol < 0 || qtyCol < 0) {
        return NextResponse.json(
          {
            error:
              "Could not find FG Code and Qty columns in Shipsheet. Expected columns: FG Code, Qty, Channel (optional).",
          },
          { status: 400 }
        );
      }
    }

    if (expanded.length === 0) {
      return NextResponse.json(
        {
          error: "No valid rows parsed from the file",
          warnings: [...warnings],
          unmapped_skus: [...unmappedSkus],
          unmapped_customers: [...unmappedCustomers],
        },
        { status: 400 }
      );
    }

    // Build warnings
    if (unmappedSkus.size > 0) {
      warnings.push(
        `${unmappedSkus.size} FG code(s) not found: ${[...unmappedSkus].slice(0, 15).join(", ")}${unmappedSkus.size > 15 ? "..." : ""}`
      );
    }
    if (unmappedCustomers.size > 0) {
      warnings.push(
        `${unmappedCustomers.size} customer/warehouse(s) not mapped to channel: ${[...unmappedCustomers].slice(0, 10).join(", ")}${unmappedCustomers.size > 10 ? "..." : ""}`
      );
    }

    // Determine which source_types to delete
    const sourceTypesToDelete = new Set<string>();
    sourceTypesToDelete.add(sourceType);
    if (sourceType === "SO") {
      // SO upload also writes Shipsheet rows from Shipsheet Qty column
      sourceTypesToDelete.add("Shipsheet");
    }

    // Delete existing data for this month + source_type(s)
    for (const st of sourceTypesToDelete) {
      const { error: delErr } = await supabase
        .from("supply_movement_data")
        .delete()
        .eq("month", month)
        .eq("source_type", st);
      if (delErr) {
        return NextResponse.json(
          { error: `Failed to clear existing ${st} data: ${delErr.message}` },
          { status: 500 }
        );
      }
    }

    // Insert in batches
    const BATCH = 500;
    let inserted = 0;
    const now = new Date().toISOString();

    for (let i = 0; i < expanded.length; i += BATCH) {
      const batch = expanded.slice(i, i + BATCH).map((r) => ({
        month,
        source_type: (r as any)._sourceOverride || sourceType,
        master_sku: r.master_sku,
        fg_code: r.fg_code,
        product_name: r.product_name,
        category: r.category,
        product_category: r.product_category,
        cluster_name: r.cluster_name,
        channel_detail: r.channel_detail,
        quantity: r.quantity,
        original_master_sku: r.original_master_sku,
        is_from_combo: r.is_from_combo,
        uploaded_by: user.id,
        uploaded_at: now,
      }));

      const { error: insErr } = await supabase
        .from("supply_movement_data")
        .insert(batch);

      if (insErr) {
        return NextResponse.json(
          {
            error: `Insert failed at batch ${Math.floor(i / BATCH) + 1}: ${insErr.message}`,
            rows_inserted_so_far: inserted,
          },
          { status: 500 }
        );
      }
      inserted += batch.length;
    }

    // Cluster breakdown
    const clusterBreakdown: Record<string, number> = {};
    for (const r of expanded) {
      clusterBreakdown[r.cluster_name] =
        (clusterBreakdown[r.cluster_name] || 0) + r.quantity;
    }

    // Log upload
    await supabase.from("supply_upload_log").insert({
      month,
      source_type: sourceType,
      file_name: file.name,
      row_count: rawRowCount,
      combos_expanded: combosExpanded,
      rows_after_expansion: expanded.length,
      unmapped_count: unmappedSkus.size + unmappedCustomers.size,
      warnings,
      uploaded_by: user.id,
    });

    return NextResponse.json({
      success: true,
      source_type: sourceType,
      month,
      rows_parsed: rawRowCount,
      rows_after_expansion: expanded.length,
      rows_inserted: inserted,
      combos_expanded: combosExpanded,
      unmapped_skus: unmappedSkus.size,
      unmapped_customers: unmappedCustomers.size,
      cluster_breakdown: clusterBreakdown,
      warnings,
    });
  } catch (err: any) {
    console.error("Supply upload error:", err);
    return NextResponse.json(
      { error: err.message || "Internal error" },
      { status: 500 }
    );
  }
}
