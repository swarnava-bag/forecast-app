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

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const targetMonth = sp.get("target_month"); // YYYY-MM
  const view = sp.get("view") || "cluster";
  const category = sp.get("category");
  const productCategory = sp.get("product_category");
  const search = sp.get("search");
  const drilldown = sp.get("drilldown");
  const mode = sp.get("mode") || "cross_month"; // cross_month | version

  // Get available months + versions
  const { data: fileRows } = await supabase
    .from("historical_forecast_files")
    .select("source_month, version")
    .order("source_month");

  const monthSet = new Set<string>();
  const versionsByMonth: Record<string, number[]> = {};
  for (const r of fileRows || []) {
    const ym = (r.source_month as string).substring(0, 7);
    monthSet.add(ym);
    if (!versionsByMonth[ym]) versionsByMonth[ym] = [];
    if (!versionsByMonth[ym].includes(r.version)) {
      versionsByMonth[ym].push(r.version);
    }
  }
  // Sort versions within each month
  for (const ym of Object.keys(versionsByMonth)) {
    versionsByMonth[ym].sort((a, b) => a - b);
  }
  const availableMonths = [...monthSet].sort();

  if (!targetMonth) {
    return NextResponse.json({ available_months: availableMonths, versions_by_month: versionsByMonth });
  }

  const targetDate = `${targetMonth}-01`;

  // ════════════════════════════════════════════════════════════════════════════
  // MODE: VERSION COMPARISON — compare V1 vs V2 vs V3 for the same month
  // ════════════════════════════════════════════════════════════════════════════
  if (mode === "version") {
    const versions = versionsByMonth[targetMonth] || [1];

    // Fetch all data for this source_month at rolling_offset=0 (current month only)
    let query = supabase
      .from("historical_forecast_data")
      .select("version, master_sku, fg_code, product_name, category, product_category, channel_name, cluster_name, quantity")
      .eq("source_month", targetDate)
      .eq("rolling_offset", 0);

    if (category) query = query.eq("category", category);
    if (productCategory) query = query.eq("product_category", productCategory);
    if (search) query = query.or(`master_sku.ilike.%${search}%,product_name.ilike.%${search}%`);

    const allData = await fetchAll(query);
    const groupKey = view === "channel" ? "channel_name" : "cluster_name";

    // Drilldown: SKU-level for a specific channel/cluster
    if (drilldown) {
      const filtered = allData.filter((r: any) =>
        view === "channel" ? r.channel_name === drilldown : r.cluster_name === drilldown
      );

      const skuMap = new Map<string, { master_sku: string; product_name: string; category: string; quantities: Record<number, number> }>();
      for (const r of filtered) {
        if (!skuMap.has(r.master_sku)) {
          skuMap.set(r.master_sku, { master_sku: r.master_sku, product_name: r.product_name || "", category: r.category || "", quantities: {} });
        }
        const entry = skuMap.get(r.master_sku)!;
        entry.quantities[r.version] = (entry.quantities[r.version] || 0) + (Number(r.quantity) || 0);
      }

      const skuRows = [...skuMap.values()].map((s) => {
        const qtys: Record<number, number> = {};
        for (const v of versions) qtys[v] = Math.round(s.quantities[v] || 0);
        const latest = qtys[versions[versions.length - 1]] || 0;
        const prev = versions.length >= 2 ? (qtys[versions[versions.length - 2]] || 0) : 0;
        return {
          ...s,
          quantities: qtys,
          delta: latest - prev,
          delta_pct: prev > 0 ? Math.round(((latest - prev) / prev) * 1000) / 10 : null,
        };
      }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

      return NextResponse.json({ source_month: targetMonth, versions, drilldown, view, sku_rows: skuRows });
    }

    // Aggregate by channel/cluster per version
    const aggMap = new Map<string, Record<number, number>>();
    for (const r of allData) {
      const key = r[groupKey];
      if (!aggMap.has(key)) aggMap.set(key, {});
      const entry = aggMap.get(key)!;
      entry[r.version] = (entry[r.version] || 0) + (Number(r.quantity) || 0);
    }

    const rows = [...aggMap.entries()].map(([name, qtys]) => {
      const quantities: Record<number, number> = {};
      for (const v of versions) quantities[v] = Math.round(qtys[v] || 0);
      const latest = quantities[versions[versions.length - 1]] || 0;
      const prev = versions.length >= 2 ? (quantities[versions[versions.length - 2]] || 0) : 0;
      return {
        name,
        quantities,
        delta: latest - prev,
        delta_pct: prev > 0 ? Math.round(((latest - prev) / prev) * 1000) / 10 : null,
      };
    }).sort((a, b) => (b.quantities[versions[versions.length - 1]] || 0) - (a.quantities[versions[versions.length - 1]] || 0));

    // Summary totals per version
    const summary: Record<number, number> = {};
    for (const v of versions) {
      summary[v] = rows.reduce((s, r) => s + (r.quantities[v] || 0), 0);
    }

    const categories_list = [...new Set(allData.map((r: any) => r.category).filter(Boolean))].sort();
    const product_categories = [...new Set(allData.map((r: any) => r.product_category).filter(Boolean))].sort();

    return NextResponse.json({
      mode: "version",
      source_month: targetMonth,
      versions,
      available_months: availableMonths,
      versions_by_month: versionsByMonth,
      filters: { categories: categories_list, product_categories },
      summary,
      rows,
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // MODE: CROSS-MONTH FIDELITY (existing) — M0 vs M-1 vs M-2
  // Uses latest version per source_month for accuracy
  // ════════════════════════════════════════════════════════════════════════════

  // Determine latest version per source_month
  const latestVersions: Record<string, number> = {};
  for (const ym of Object.keys(versionsByMonth)) {
    const vers = versionsByMonth[ym];
    latestVersions[`${ym}-01`] = vers[vers.length - 1];
  }

  // Fetch all data for this forecast_month
  let query = supabase
    .from("historical_forecast_data")
    .select(
      "source_month, rolling_offset, version, master_sku, fg_code, product_name, category, product_category, channel_name, cluster_name, quantity"
    )
    .eq("forecast_month", targetDate);

  if (category) query = query.eq("category", category);
  if (productCategory) query = query.eq("product_category", productCategory);
  if (search) {
    query = query.or(`master_sku.ilike.%${search}%,product_name.ilike.%${search}%`);
  }

  let allData = await fetchAll(query);

  // Filter to latest version per source_month
  allData = allData.filter((r: any) => {
    const sm = (r.source_month as string).substring(0, 10);
    const latestV = latestVersions[sm];
    return !latestV || r.version === latestV;
  });

  const m0Rows = allData.filter((r: any) => r.rolling_offset === 0);
  const m1Rows = allData.filter((r: any) => r.rolling_offset === 1);
  const m2Rows = allData.filter((r: any) => r.rolling_offset === 2);

  // Drilldown: SKU-level detail
  if (drilldown) {
    const filterFn = (r: any) =>
      view === "channel" ? r.channel_name === drilldown : r.cluster_name === drilldown;

    const m0F = m0Rows.filter(filterFn);
    const m1F = m1Rows.filter(filterFn);
    const m2F = m2Rows.filter(filterFn);

    const skuMap = new Map<string, { master_sku: string; product_name: string; category: string; m0: number; m1: number; m2: number }>();

    for (const r of m0F) {
      if (!skuMap.has(r.master_sku)) skuMap.set(r.master_sku, { master_sku: r.master_sku, product_name: r.product_name || "", category: r.category || "", m0: 0, m1: 0, m2: 0 });
      skuMap.get(r.master_sku)!.m0 += Number(r.quantity) || 0;
    }
    for (const r of m1F) {
      if (!skuMap.has(r.master_sku)) skuMap.set(r.master_sku, { master_sku: r.master_sku, product_name: r.product_name || "", category: r.category || "", m0: 0, m1: 0, m2: 0 });
      skuMap.get(r.master_sku)!.m1 += Number(r.quantity) || 0;
    }
    for (const r of m2F) {
      if (!skuMap.has(r.master_sku)) skuMap.set(r.master_sku, { master_sku: r.master_sku, product_name: r.product_name || "", category: r.category || "", m0: 0, m1: 0, m2: 0 });
      skuMap.get(r.master_sku)!.m2 += Number(r.quantity) || 0;
    }

    const skuRows = [...skuMap.values()].map((s) => {
      const m0 = Math.round(s.m0), m1 = Math.round(s.m1), m2 = Math.round(s.m2);
      return {
        ...s, m0_qty: m0, m1_qty: m1, m2_qty: m2,
        delta_m1: m0 - m1,
        delta_m1_pct: m0 > 0 && m1 > 0 ? Math.round(((m0 - m1) / m0) * 1000) / 10 : null,
        delta_m2: m0 - m2,
        delta_m2_pct: m0 > 0 && m2 > 0 ? Math.round(((m0 - m2) / m0) * 1000) / 10 : null,
        fidelity_m1: m0 > 0 && m1 > 0 ? Math.round((100 - Math.abs((m0 - m1) / m0) * 100) * 10) / 10 : null,
        fidelity_m2: m0 > 0 && m2 > 0 ? Math.round((100 - Math.abs((m0 - m2) / m0) * 100) * 10) / 10 : null,
      };
    }).sort((a, b) => Math.abs(b.delta_m2) - Math.abs(a.delta_m2));

    return NextResponse.json({ target_month: targetMonth, drilldown, view, sku_rows: skuRows });
  }

  // Aggregate by channel or cluster
  const groupKey = view === "channel" ? "channel_name" : "cluster_name";

  function aggregate(rows: any[]) {
    const map = new Map<string, number>();
    for (const r of rows) {
      const key = r[groupKey];
      map.set(key, (map.get(key) || 0) + (Number(r.quantity) || 0));
    }
    return map;
  }

  const m0Agg = aggregate(m0Rows);
  const m1Agg = aggregate(m1Rows);
  const m2Agg = aggregate(m2Rows);

  const allKeys = new Set([...m0Agg.keys(), ...m1Agg.keys(), ...m2Agg.keys()]);

  const rows = [...allKeys].map((name) => {
    const m0 = Math.round(m0Agg.get(name) || 0);
    const m1 = Math.round(m1Agg.get(name) || 0);
    const m2 = Math.round(m2Agg.get(name) || 0);
    return {
      name, m0_qty: m0, m1_qty: m1, m2_qty: m2,
      delta_m1: m0 - m1,
      delta_m1_pct: m0 > 0 && m1 > 0 ? Math.round(((m0 - m1) / m0) * 1000) / 10 : null,
      delta_m2: m0 - m2,
      delta_m2_pct: m0 > 0 && m2 > 0 ? Math.round(((m0 - m2) / m0) * 1000) / 10 : null,
      fidelity_m1: m0 > 0 && m1 > 0 ? Math.round((100 - Math.abs((m0 - m1) / m0) * 100) * 10) / 10 : null,
      fidelity_m2: m0 > 0 && m2 > 0 ? Math.round((100 - Math.abs((m0 - m2) / m0) * 100) * 10) / 10 : null,
    };
  }).sort((a, b) => b.m0_qty - a.m0_qty);

  // Summary
  const m0Total = rows.reduce((s, r) => s + r.m0_qty, 0);
  const m1Total = rows.reduce((s, r) => s + r.m1_qty, 0);
  const m2Total = rows.reduce((s, r) => s + r.m2_qty, 0);

  // Fidelity (WAPE-based, per-row)
  let m1AbsErr = 0, m1Wt = 0, m2AbsErr = 0, m2Wt = 0;
  for (const r of rows) {
    if (r.m0_qty > 0 && r.m1_qty > 0) { m1AbsErr += Math.abs(r.m0_qty - r.m1_qty); m1Wt += r.m0_qty; }
    if (r.m0_qty > 0 && r.m2_qty > 0) { m2AbsErr += Math.abs(r.m0_qty - r.m2_qty); m2Wt += r.m0_qty; }
  }

  const categories_list = [...new Set(allData.map((r: any) => r.category).filter(Boolean))].sort();
  const product_categories = [...new Set(allData.map((r: any) => r.product_category).filter(Boolean))].sort();

  return NextResponse.json({
    target_month: targetMonth,
    available_months: availableMonths,
    versions_by_month: versionsByMonth,
    filters: { categories: categories_list, product_categories: product_categories },
    summary: {
      m0_total: m0Total, m1_total: m1Total, m2_total: m2Total,
      m1_fidelity: m1Wt > 0 ? Math.round((100 - (m1AbsErr / m1Wt) * 100) * 10) / 10 : null,
      m2_fidelity: m2Wt > 0 ? Math.round((100 - (m2AbsErr / m2Wt) * 100) * 10) / 10 : null,
    },
    rows,
    has_m1: m1Rows.length > 0,
    has_m2: m2Rows.length > 0,
  });
}
