import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const PAGE = 1000;

async function fetchAllRows(query: any) {
  const all: any[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await query.range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

/** Convert Excel serial date to YYYY-MM-DD */
function serialToDate(serial: number): string {
  const d = new Date((serial - 25569) * 86400000);
  return d.toISOString().slice(0, 10);
}

type MonthBlock = {
  forecast_month: string;
  channels: { col: number; name: string; channel_id: string }[];
};

type NewSkuInfo = {
  new_master_sku: string;
  new_fg_code: string;
  fg_code: string;
  product_name: string;
  category: string;
  product_category: string;
};

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const cycleId = formData.get("cycle_id") as string | null;
    const authToken = formData.get("auth_token") as string | null;
    const addNewSkus = formData.get("add_new_skus") === "true";

    if (!file || !cycleId) {
      return NextResponse.json(
        { error: "file and cycle_id are required" },
        { status: 400 }
      );
    }

    // Auth check — verify admin
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
      return NextResponse.json(
        { error: "Only admins can use bulk upload" },
        { status: 403 }
      );
    }

    // Fetch cycle
    const { data: cycle, error: cycleErr } = await supabase
      .from("forecast_cycles")
      .select("*")
      .eq("id", cycleId)
      .single();
    if (cycleErr || !cycle) {
      return NextResponse.json({ error: "Cycle not found" }, { status: 404 });
    }

    // Load SKU master: new_master_sku → id
    const allSkus = await fetchAllRows(
      supabase.from("sku_master").select("id, new_master_sku")
    );
    const skuMap = new Map<string, string>();
    for (const s of allSkus) {
      skuMap.set(s.new_master_sku, s.id);
    }

    // Load channels: name → id (case-insensitive)
    const { data: channels } = await supabase
      .from("channels")
      .select("id, name");
    const channelMap = new Map<string, string>();
    for (const c of channels || []) {
      channelMap.set(c.name.toLowerCase(), c.id);
    }

    // Parse Excel
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });

    // Find Channels sheet
    const sheetName =
      wb.SheetNames.find((n) => n.toLowerCase() === "channels") ||
      wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    if (!ws || !ws["!ref"]) {
      return NextResponse.json(
        { error: "No data found in the file" },
        { status: 400 }
      );
    }

    const range = XLSX.utils.decode_range(ws["!ref"]);
    const warnings: string[] = [];

    // Scan Row 6 (0-indexed: row 5) for headers
    const HEADER_ROW = 5;
    const headers: { col: number; val: string }[] = [];
    for (let c = 0; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r: HEADER_ROW, c })];
      if (cell && cell.v) headers.push({ col: c, val: String(cell.v) });
    }

    // Find Grand Total positions → month block boundaries
    const gtCols = headers
      .filter((h) => h.val === "Grand Total")
      .map((h) => h.col);
    if (gtCols.length === 0) {
      return NextResponse.json(
        { error: "Could not find 'Grand Total' headers in row 6" },
        { status: 400 }
      );
    }

    // Build month blocks
    const monthBlocks: MonthBlock[] = [];
    for (let i = 0; i < gtCols.length; i++) {
      const gtCol = gtCols[i];
      const nextBoundary =
        i + 1 < gtCols.length ? gtCols[i + 1] : range.e.c + 1;

      const dateCell = ws[XLSX.utils.encode_cell({ r: 2, c: gtCol + 1 })];
      let forecastMonth = "";
      if (dateCell) {
        if (typeof dateCell.v === "number") {
          forecastMonth = serialToDate(dateCell.v);
        } else if (typeof dateCell.v === "string") {
          forecastMonth = dateCell.v.slice(0, 10);
        }
      }
      if (!forecastMonth) {
        const gtDate = ws[XLSX.utils.encode_cell({ r: 2, c: gtCol })];
        if (gtDate && typeof gtDate.v === "number") {
          forecastMonth = serialToDate(gtDate.v);
        }
      }

      if (!forecastMonth) {
        warnings.push(`Could not determine month date for block ${i + 1}`);
        continue;
      }

      const blockChannels: MonthBlock["channels"] = [];
      for (let c = gtCol + 1; c < nextBoundary; c++) {
        const hdr = headers.find((h) => h.col === c);
        if (!hdr) continue;
        const chId = channelMap.get(hdr.val.toLowerCase());
        if (!chId) {
          if (!warnings.includes(`Channel not found in DB: "${hdr.val}"`)) {
            warnings.push(`Channel not found in DB: "${hdr.val}"`);
          }
          continue;
        }
        blockChannels.push({ col: c, name: hdr.val, channel_id: chId });
      }

      monthBlocks.push({
        forecast_month: forecastMonth,
        channels: blockChannels,
      });
    }

    if (monthBlocks.length === 0) {
      return NextResponse.json(
        { error: "Could not parse any month blocks from the file" },
        { status: 400 }
      );
    }

    // Column indices for SKU info
    const SKU_COL = 4; // New Master SKU
    const FG_NEW_COL = 6; // New FG Code
    const FG_OLD_COL = 9; // FG Code (legacy)
    const PRODUCT_NAME_COL = 10;
    const CATEGORY_COL = 11;
    const PRODUCT_CAT_COL = 12;
    const DATA_START = 6;

    // First pass: detect new SKUs
    const newSkus: NewSkuInfo[] = [];
    const newSkuSet = new Set<string>();

    for (let r = DATA_START; r <= range.e.r; r++) {
      const skuCell = ws[XLSX.utils.encode_cell({ r, c: SKU_COL })];
      if (!skuCell || !skuCell.v) continue;

      const masterSku = String(skuCell.v).trim();
      if (skuMap.has(masterSku) || newSkuSet.has(masterSku)) continue;

      newSkuSet.add(masterSku);

      const cellVal = (col: number) => {
        const cell = ws[XLSX.utils.encode_cell({ r, c: col })];
        return cell ? String(cell.v ?? "").trim() : "";
      };

      newSkus.push({
        new_master_sku: masterSku,
        new_fg_code: cellVal(FG_NEW_COL),
        fg_code: cellVal(FG_OLD_COL),
        product_name: cellVal(PRODUCT_NAME_COL),
        category: cellVal(CATEGORY_COL),
        product_category: cellVal(PRODUCT_CAT_COL),
      });
    }

    // If new SKUs found and confirmation not given, return for confirmation
    if (newSkus.length > 0 && !addNewSkus) {
      return NextResponse.json({
        needs_confirmation: true,
        new_skus: newSkus,
        message: `${newSkus.length} new SKU(s) found that are not in SKU Master. Confirm to add them and proceed with upload.`,
      });
    }

    // Add new SKUs to sku_master if confirmed
    if (newSkus.length > 0 && addNewSkus) {
      const skuInserts = newSkus.map((s) => ({
        new_master_sku: s.new_master_sku,
        new_fg_code: s.new_fg_code,
        fg_code: s.fg_code,
        product_name: s.product_name,
        category: s.category,
        product_category: s.product_category,
        is_active: true,
      }));

      const BATCH_SKU = 500;
      for (let i = 0; i < skuInserts.length; i += BATCH_SKU) {
        const batch = skuInserts.slice(i, i + BATCH_SKU);
        const { error: skuInsErr } = await supabase
          .from("sku_master")
          .insert(batch);
        if (skuInsErr) {
          return NextResponse.json(
            {
              error: `Failed to add new SKUs: ${skuInsErr.message}`,
            },
            { status: 500 }
          );
        }
      }

      // Reload SKU map with newly inserted SKUs
      const refreshedSkus = await fetchAllRows(
        supabase.from("sku_master").select("id, new_master_sku")
      );
      skuMap.clear();
      for (const s of refreshedSkus) {
        skuMap.set(s.new_master_sku, s.id);
      }

      warnings.push(
        `${newSkus.length} new SKU(s) added to SKU Master: ${newSkus.map((s) => s.new_master_sku).slice(0, 10).join(", ")}${newSkus.length > 10 ? "..." : ""}`
      );
    }

    // Build forecast rows — detect duplicates instead of aggregating
    const rows: { sku_id: string; channel_id: string; quantity: number; forecast_month: string }[] = [];
    const seenKeys = new Map<string, { sku: string; channel: string; month: string }>();
    const duplicates: string[] = [];
    const missedSkus = new Set<string>();
    const seenSkus = new Set<string>();

    for (let r = DATA_START; r <= range.e.r; r++) {
      const skuCell = ws[XLSX.utils.encode_cell({ r, c: SKU_COL })];
      if (!skuCell || !skuCell.v) continue;

      const masterSku = String(skuCell.v).trim();
      const skuId = skuMap.get(masterSku);
      if (!skuId) {
        missedSkus.add(masterSku);
        continue;
      }
      seenSkus.add(masterSku);

      for (const block of monthBlocks) {
        for (const ch of block.channels) {
          const qtyCell = ws[XLSX.utils.encode_cell({ r, c: ch.col })];
          if (!qtyCell) continue;
          const qty = Number(qtyCell.v);
          if (!qty || qty === 0) continue;

          const key = `${skuId}::${ch.channel_id}::${block.forecast_month}`;
          if (seenKeys.has(key)) {
            duplicates.push(`${masterSku} × ${ch.name} × ${block.forecast_month.slice(0, 7)}`);
            continue; // skip duplicate, don't insert
          }
          seenKeys.set(key, { sku: masterSku, channel: ch.name, month: block.forecast_month });

          rows.push({
            sku_id: skuId,
            channel_id: ch.channel_id,
            quantity: Math.round(qty),
            forecast_month: block.forecast_month,
          });
        }
      }
    }

    const skusFound = seenSkus.size;

    if (duplicates.length > 0) {
      warnings.push(
        `${duplicates.length} duplicate(s) found (skipped — kept first occurrence): ${duplicates.slice(0, 10).join("; ")}${duplicates.length > 10 ? "..." : ""}`
      );
    }

    if (missedSkus.size > 0) {
      warnings.push(
        `${missedSkus.size} SKU(s) still not found after additions: ${[...missedSkus].slice(0, 10).join(", ")}${missedSkus.size > 10 ? "..." : ""}`
      );
    }

    if (rows.length === 0) {
      return NextResponse.json(
        { error: "No valid forecast rows parsed from the file", warnings },
        { status: 400 }
      );
    }

    // Delete existing forecast_data for this cycle
    const { error: delErr } = await supabase
      .from("forecast_data")
      .delete()
      .eq("cycle_id", cycleId);

    if (delErr) {
      return NextResponse.json(
        { error: `Failed to clear existing data: ${delErr.message}` },
        { status: 500 }
      );
    }

    // Insert in batches
    const BATCH = 500;
    let inserted = 0;
    const now = new Date().toISOString();

    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH).map((r) => ({
        cycle_id: cycleId,
        sku_id: r.sku_id,
        channel_id: r.channel_id,
        quantity: r.quantity,
        forecast_month: r.forecast_month,
        version: cycle.version,
        status: "draft",
        uploaded_by: user.id,
        uploaded_at: now,
        updated_at: now,
      }));

      const { error: insErr } = await supabase
        .from("forecast_data")
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

    const channelsMatched = new Set(
      monthBlocks.flatMap((b) => b.channels.map((c) => c.name))
    ).size;

    return NextResponse.json({
      success: true,
      rows_inserted: inserted,
      skus_found: skusFound,
      skus_missing: missedSkus.size,
      skus_added: newSkus.length,
      channels_matched: channelsMatched,
      months: monthBlocks.map((b) => b.forecast_month.slice(0, 7)),
      warnings,
    });
  } catch (err: any) {
    console.error("Bulk upload error:", err);
    return NextResponse.json(
      { error: err.message || "Internal error" },
      { status: 500 }
    );
  }
}
