import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { exec } from "child_process";
import { readFile, writeFile, unlink, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";

export async function GET(request: NextRequest) {
  const cycleId = request.nextUrl.searchParams.get("cycle_id");
  if (!cycleId) {
    return NextResponse.json({ error: "cycle_id required" }, { status: 400 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // 1. Get cycle info
  const { data: cycle } = await supabase
    .from("forecast_cycles")
    .select("*")
    .eq("id", cycleId)
    .single();

  if (!cycle) {
    return NextResponse.json({ error: "Cycle not found" }, { status: 404 });
  }

  // 2. Get all reference data — include fg_code and master_sku fields
  const { data: skus } = await supabase
    .from("sku_master")
    .select("id, new_master_sku, fg_code, product_name, category, product_category")
    .eq("is_active", true)
    .is("discontinued_at", null)
    .order("product_name");

  const { data: channels } = await supabase
    .from("channels")
    .select("id, name, cluster_id, display_order, clusters(name)")
    .eq("is_active", true)
    .order("display_order");

  const { data: clusters } = await supabase
    .from("clusters")
    .select("id, name, display_order")
    .order("display_order");

  // 3. Compute the 3 months
  const cycleMonth = new Date(cycle.forecast_month);
  const month1 = cycleMonth.toISOString().slice(0, 10);
  const m2 = new Date(cycleMonth);
  m2.setMonth(m2.getMonth() + 1);
  const month2 = m2.toISOString().slice(0, 10);
  const m3 = new Date(cycleMonth);
  m3.setMonth(m3.getMonth() + 2);
  const month3 = m3.toISOString().slice(0, 10);

  // 4. Get forecast data for this cycle
  const { data: forecastData } = await supabase
    .from("forecast_data")
    .select("sku_id, channel_id, quantity, forecast_month")
    .eq("cycle_id", cycleId);

  // 5. If this is V2+, also fetch published data from previous version as base
  let baseForecast: any[] = [];
  if (cycle.version > 1) {
    // Find the published cycle for the same month with version = current - 1
    const { data: prevCycle } = await supabase
      .from("forecast_cycles")
      .select("id")
      .eq("forecast_month", cycle.forecast_month)
      .eq("version", cycle.version - 1)
      .eq("status", "published")
      .single();

    if (prevCycle) {
      const { data: prevData } = await supabase
        .from("forecast_data")
        .select("sku_id, channel_id, quantity, forecast_month")
        .eq("cycle_id", prevCycle.id);
      if (prevData) baseForecast = prevData;
    }
  }

  // Build SKU id->data map
  const skuMap: Record<string, any> = {};
  (skus || []).forEach((s: any) => { skuMap[s.id] = s; });

  const channelMap: Record<string, any> = {};
  (channels || []).forEach((c: any) => { channelMap[c.id] = c; });

  // Merge forecasts: V2 data overrides V1 base
  // Key: sku_id::channel_id::month -> quantity
  const mergedForecast: Record<string, any> = {};

  // First, load base (V1 published) data
  for (const f of baseForecast) {
    const key = `${f.sku_id}::${f.channel_id}::${f.forecast_month}`;
    mergedForecast[key] = f;
  }

  // Then, overlay current cycle data (overrides base)
  for (const f of (forecastData || [])) {
    const key = `${f.sku_id}::${f.channel_id}::${f.forecast_month}`;
    mergedForecast[key] = f;
  }

  // Build forecast array for Python script
  const forecastForPython = Object.values(mergedForecast).map((f: any) => ({
    sku_master_sku: skuMap[f.sku_id]?.new_master_sku || "",
    channel_name: channelMap[f.channel_id]?.name || "",
    forecast_month: f.forecast_month,
    quantity: f.quantity,
  })).filter((f: any) => f.sku_master_sku && f.channel_name);

  // Build data JSON for Python — now includes fg_code
  const dataForPython = {
    cycle_month: month1,
    version: cycle.version,
    skus: (skus || []).map((s: any) => ({
      new_master_sku: s.new_master_sku,
      fg_code: s.fg_code || "",
      product_name: s.product_name,
      category: s.category,
      product_category: s.product_category,
    })),
    channels: (channels || []).map((c: any) => ({
      name: c.name,
      cluster_name: c.clusters?.name || "",
      display_order: c.display_order,
    })),
    clusters: (clusters || []).map((c: any) => ({
      name: c.name,
      display_order: c.display_order,
    })),
    forecast: forecastForPython,
  };

  // 6. Write JSON to temp file, run Python script
  const tmpDir = "/tmp/forecast";
  if (!existsSync(tmpDir)) await mkdir(tmpDir, { recursive: true });

  const fileId = uuidv4();
  const jsonPath = path.join(tmpDir, `${fileId}.json`);
  const xlsxPath = path.join(tmpDir, `${fileId}.xlsx`);

  await writeFile(jsonPath, JSON.stringify(dataForPython));

  const scriptPath = path.join(process.cwd(), "scripts", "generate_forecast.py");

  try {
    await new Promise<void>((resolve, reject) => {
      exec(
        `python "${scriptPath}" "${jsonPath}" "${xlsxPath}"`,
        { timeout: 30000 },
        (error, stdout, stderr) => {
          if (error) reject(new Error(`Python script failed: ${stderr || error.message}`));
          else resolve();
        }
      );
    });

    const fileBuffer = await readFile(xlsxPath);

    await unlink(jsonPath).catch(() => {});
    await unlink(xlsxPath).catch(() => {});

    const monthStr = cycleMonth.toLocaleDateString("en-US", { month: "short", year: "numeric" }).replace(" ", "_");
    const filename = `Forecast_${monthStr}_V${cycle.version}.xlsx`;

    return new NextResponse(fileBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err: any) {
    await unlink(jsonPath).catch(() => {});
    await unlink(xlsxPath).catch(() => {});
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}