import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const PAGE = 1000;

async function fetchAll(query: any) {
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

/**
 * GET /api/historical-forecast/trend
 *
 * Returns how a forecast for a target month evolved across source files.
 * Shows the prediction from each source file that covered the target month.
 *
 * Query params:
 *  - target_month (required): YYYY-MM
 *  - master_sku (optional): filter to specific SKU
 *  - channel (optional): filter to specific channel
 *  - cluster (optional): filter to specific cluster
 */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const targetMonth = sp.get("target_month");
  const masterSku = sp.get("master_sku");
  const channel = sp.get("channel");
  const cluster = sp.get("cluster");
  const version = sp.get("version"); // optional: filter to specific version

  if (!targetMonth) {
    return NextResponse.json({ error: "target_month is required" }, { status: 400 });
  }

  const targetDate = `${targetMonth}-01`;

  let query = supabase
    .from("historical_forecast_data")
    .select("source_month, source_file, rolling_offset, version, master_sku, channel_name, cluster_name, quantity")
    .eq("forecast_month", targetDate)
    .order("source_month");

  if (masterSku) query = query.eq("master_sku", masterSku);
  if (channel) query = query.eq("channel_name", channel);
  if (cluster) query = query.eq("cluster_name", cluster);
  if (version) query = query.eq("version", parseInt(version));

  const allData = await fetchAll(query);

  // Group by source_month and sum quantities
  const monthMap = new Map<string, { source_month: string; source_file: string; rolling_offset: number; total: number }>();

  for (const r of allData) {
    const key = r.source_month as string;
    if (!monthMap.has(key)) {
      monthMap.set(key, {
        source_month: key,
        source_file: r.source_file,
        rolling_offset: r.rolling_offset,
        total: 0,
      });
    }
    monthMap.get(key)!.total += Number(r.quantity) || 0;
  }

  const MONTH_LABELS: Record<string, string> = {
    "2025-04-01": "Apr'25", "2025-05-01": "May'25", "2025-06-01": "Jun'25",
    "2025-07-01": "Jul'25", "2025-08-01": "Aug'25", "2025-09-01": "Sep'25",
    "2025-10-01": "Oct'25", "2025-11-01": "Nov'25", "2025-12-01": "Dec'25",
    "2026-01-01": "Jan'26", "2026-02-01": "Feb'26", "2026-03-01": "Mar'26",
    "2026-04-01": "Apr'26",
  };

  const trend = [...monthMap.values()]
    .sort((a, b) => a.source_month.localeCompare(b.source_month))
    .map((entry) => ({
      source_month: entry.source_month.substring(0, 7),
      source_label: MONTH_LABELS[entry.source_month] || entry.source_month.substring(0, 7),
      rolling_offset: entry.rolling_offset,
      offset_label: entry.rolling_offset === 0 ? "Actual (M0)" : `M-${entry.rolling_offset}`,
      quantity: Math.round(entry.total),
    }));

  return NextResponse.json({
    target_month: targetMonth,
    filters: { master_sku: masterSku, channel, cluster },
    trend,
  });
}
