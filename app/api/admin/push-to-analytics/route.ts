import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const PAGE = 1000;

async function fetchAll(table: string, query: any) {
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

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { cycle_id } = body;

    if (!cycle_id) {
      return NextResponse.json({ error: "cycle_id is required" }, { status: 400 });
    }

    // 1. Fetch the cycle — must be published
    const { data: cycle, error: cycleErr } = await supabase
      .from("forecast_cycles")
      .select("*")
      .eq("id", cycle_id)
      .single();

    if (cycleErr || !cycle) {
      return NextResponse.json({ error: "Cycle not found" }, { status: 404 });
    }

    if (cycle.status !== "published") {
      return NextResponse.json(
        { error: "Only published cycles can be pushed to analytics" },
        { status: 400 }
      );
    }

    // 2. Compute the 3 forecast months covered by this cycle
    const baseDate = new Date(cycle.forecast_month);
    const sourceMonth = cycle.forecast_month; // YYYY-MM-DD format
    const months = [0, 1, 2].map((offset) => {
      const d = new Date(baseDate);
      d.setMonth(d.getMonth() + offset);
      return d.toISOString().slice(0, 10);
    });

    // 3. Fetch all forecast_data for this cycle (paginated)
    const forecastData = await fetchAll(
      "forecast_data",
      supabase
        .from("forecast_data")
        .select("sku_id, channel_id, quantity, forecast_month")
        .eq("cycle_id", cycle_id)
    );

    if (forecastData.length === 0) {
      return NextResponse.json({ error: "No forecast data found for this cycle" }, { status: 400 });
    }

    // 4. Fetch SKU master for denormalization
    const { data: skus } = await supabase
      .from("sku_master")
      .select("id, new_master_sku, new_fg_code, fg_code, product_name, category, product_category");

    const skuMap: Record<string, any> = {};
    (skus || []).forEach((s: any) => { skuMap[s.id] = s; });

    // 5. Fetch channels + clusters for denormalization
    const { data: channels } = await supabase
      .from("channels")
      .select("id, name, cluster_id, clusters(name)");

    const channelMap: Record<string, any> = {};
    (channels || []).forEach((c: any) => { channelMap[c.id] = c; });

    // 6. Build historical_forecast_data rows
    const historicalRows: any[] = [];
    for (const fd of forecastData) {
      const sku = skuMap[fd.sku_id];
      const channel = channelMap[fd.channel_id];
      if (!sku || !channel) continue;

      const forecastMonth = fd.forecast_month; // YYYY-MM-DD
      // Compute rolling_offset: how many months ahead from source_month
      const srcDate = new Date(sourceMonth);
      const fmDate = new Date(forecastMonth);
      const rollingOffset = (fmDate.getFullYear() - srcDate.getFullYear()) * 12 +
        (fmDate.getMonth() - srcDate.getMonth());

      if (rollingOffset < 0 || rollingOffset > 2) continue; // skip unexpected months

      const clusterName = (channel.clusters as any)?.name || "Unknown";

      historicalRows.push({
        source_file: `Published Cycle V${cycle.version}`,
        source_month: sourceMonth,
        forecast_month: forecastMonth,
        rolling_offset: rollingOffset,
        version: cycle.version,
        master_sku: sku.new_master_sku,
        fg_code: sku.new_fg_code || sku.fg_code || "",
        product_name: sku.product_name || "",
        category: sku.category || "",
        product_category: sku.product_category || "",
        channel_name: channel.name,
        cluster_name: clusterName,
        quantity: Number(fd.quantity) || 0,
      });
    }

    if (historicalRows.length === 0) {
      return NextResponse.json({ error: "No mappable rows found (SKU/channel mismatch)" }, { status: 400 });
    }

    // 7. Delete existing rows for this source_month + version (idempotent re-push, preserves other versions)
    const { error: delErr } = await supabase
      .from("historical_forecast_data")
      .delete()
      .eq("source_month", sourceMonth)
      .eq("version", cycle.version);

    if (delErr) {
      return NextResponse.json({ error: `Failed to clear existing data: ${delErr.message}` }, { status: 500 });
    }

    // 8. Insert in batches of 500
    const BATCH = 500;
    let inserted = 0;
    for (let i = 0; i < historicalRows.length; i += BATCH) {
      const batch = historicalRows.slice(i, i + BATCH);
      const { error: insErr } = await supabase
        .from("historical_forecast_data")
        .insert(batch);

      if (insErr) {
        return NextResponse.json(
          { error: `Insert failed at batch ${Math.floor(i / BATCH) + 1}: ${insErr.message}` },
          { status: 500 }
        );
      }
      inserted += batch.length;
    }

    // 9. Upsert historical_forecast_files entry
    const { error: fileErr } = await supabase
      .from("historical_forecast_files")
      .upsert(
        {
          file_name: `Published Cycle V${cycle.version}`,
          source_month: sourceMonth,
          version: cycle.version,
          months_covered: 3,
          row_count: inserted,
          schema_version: "live",
          imported_at: new Date().toISOString(),
        },
        { onConflict: "source_month,version" }
      );

    if (fileErr) {
      console.error("Failed to upsert historical_forecast_files:", fileErr);
      // Non-fatal — data is already inserted
    }

    return NextResponse.json({
      success: true,
      source_month: sourceMonth,
      rows_inserted: inserted,
      months_covered: months.map((m) => m.slice(0, 7)),
    });
  } catch (err: any) {
    console.error("Push to analytics error:", err);
    return NextResponse.json({ error: err.message || "Internal error" }, { status: 500 });
  }
}
