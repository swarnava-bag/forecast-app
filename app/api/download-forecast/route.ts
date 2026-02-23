import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";

// Convert 1-indexed column number to Excel letter(s): 1→A, 26→Z, 27→AA
function col(n: number): string {
  let r = "";
  while (n > 0) {
    r = String.fromCharCode(65 + ((n - 1) % 26)) + r;
    n = Math.floor((n - 1) / 26);
  }
  return r;
}

type WS = Record<string, any>;

// Write a cell: value or formula
function wc(ws: WS, c: number, r: number, value: any, formula?: string): void {
  const key = `${col(c)}${r}`;
  if (formula !== undefined) {
    ws[key] = { t: "n", f: formula, v: 0 };
  } else if (typeof value === "number") {
    ws[key] = { t: "n", v: value };
  } else {
    ws[key] = { t: "s", v: value == null ? "" : String(value) };
  }
}

function buildExcel(data: {
  cycle_month: string;
  version: number;
  skus: any[];
  channels: any[];
  clusters: any[];
  forecast: any[];
}): Buffer {
  const { cycle_month, skus, channels, clusters, forecast } = data;

  // Compute 3 months
  const base = new Date(cycle_month);
  const m2 = new Date(base); m2.setMonth(m2.getMonth() + 1);
  const m3 = new Date(base); m3.setMonth(m3.getMonth() + 2);
  const months = [base, m2, m3].map(d => d.toISOString().slice(0, 10));

  const sortedCh = [...channels].sort((a, b) => a.display_order - b.display_order);
  const sortedCl = [...clusters].sort((a, b) => a.display_order - b.display_order);
  const numCh = sortedCh.length;
  const numCl = sortedCl.length;

  // Forecast lookup: "sku::channel::YYYY-MM" → quantity
  const flookup: Record<string, number> = {};
  for (const f of forecast) {
    flookup[`${f.sku_master_sku}::${f.channel_name}::${f.forecast_month.slice(0, 7)}`] = f.quantity;
  }

  // Channel → cluster name
  const chCluster: Record<string, string> = {};
  for (const c of sortedCh) chCluster[c.name] = c.cluster_name;

  // ── CHANNELS SHEET ──────────────────────────────────────────────────────────
  const wsC: WS = {};

  const CH_HDR = 6;
  const CH_D0 = 7;
  const CH_DZ = CH_D0 + skus.length - 1;

  const CH_M1_GT = 13;
  const CH_M1_S  = 14;
  const CH_M1_E  = CH_M1_S + numCh - 1;
  const CH_M2_GT = CH_M1_E + 2;
  const CH_M2_S  = CH_M2_GT + 1;
  const CH_M2_E  = CH_M2_S + numCh - 1;
  const CH_M3_GT = CH_M2_E + 2;
  const CH_M3_S  = CH_M3_GT + 1;
  const CH_M3_E  = CH_M3_S + numCh - 1;

  const chBlocks = [
    { gt: CH_M1_GT, s: CH_M1_S, e: CH_M1_E, m: months[0] },
    { gt: CH_M2_GT, s: CH_M2_S, e: CH_M2_E, m: months[1] },
    { gt: CH_M3_GT, s: CH_M3_S, e: CH_M3_E, m: months[2] },
  ];

  // Row 3: month labels
  for (const b of chBlocks) wc(wsC, b.s, 3, b.m);

  // Row 4: cluster names per channel
  for (const b of chBlocks)
    sortedCh.forEach((ch, i) => wc(wsC, b.s + i, 4, chCluster[ch.name] || ""));

  // Row 5: SUBTOTAL formulas
  for (const b of chBlocks) {
    wc(wsC, b.gt, 5, null, `SUBTOTAL(9,${col(b.gt)}${CH_D0}:${col(b.gt)}${CH_DZ})`);
    for (let i = 0; i < numCh; i++) {
      const c = b.s + i;
      wc(wsC, c, 5, null, `SUBTOTAL(9,${col(c)}${CH_D0}:${col(c)}${CH_DZ})`);
    }
  }

  // Row 6: headers
  ["New Master SKU", "Active Status", "New FG Code", "Status", "Master SKU", "FG Code", "Product Name", "Category", "Product Category"]
    .forEach((h, i) => wc(wsC, 4 + i, CH_HDR, h));
  for (const b of chBlocks) {
    wc(wsC, b.gt, CH_HDR, "Grand Total");
    sortedCh.forEach((ch, i) => wc(wsC, b.s + i, CH_HDR, ch.name));
  }

  // Rows 7+: data
  skus.forEach((sku, idx) => {
    const row = CH_D0 + idx;
    const nm  = String(sku.new_master_sku || "");
    const fg  = String(sku.fg_code || "").trim();
    const ms  = nm.endsWith("G") ? nm.slice(0, -1) : nm;
    const nfg = fg ? `${fg}G` : "";
    const fgd = /^\d+$/.test(fg) ? Number(fg) : fg;

    wc(wsC, 4,  row, nm);
    wc(wsC, 5,  row, "Active");
    wc(wsC, 6,  row, nfg);
    wc(wsC, 7,  row, "");
    wc(wsC, 8,  row, ms);
    wc(wsC, 9,  row, fgd);
    wc(wsC, 10, row, sku.product_name || "");
    wc(wsC, 11, row, sku.category || "");
    wc(wsC, 12, row, sku.product_category || "");

    chBlocks.forEach((b, mi) => {
      wc(wsC, b.gt, row, null, `SUM(${col(b.s)}${row}:${col(b.e)}${row})`);
      sortedCh.forEach((ch, i) => {
        const qty = flookup[`${nm}::${ch.name}::${months[mi].slice(0, 7)}`];
        if (qty && qty > 0) wc(wsC, b.s + i, row, qty);
      });
    });
  });

  // Column widths
  const cCols: any[] = Array.from({ length: CH_M3_E }, () => ({ wch: 12 }));
  for (let i = 3; i <= 11; i++) cCols[i] = { wch: 14 };
  cCols[9] = { wch: 45 };
  for (const b of chBlocks) {
    cCols[b.gt - 1] = { wch: 14 };
    for (let i = 0; i < numCh; i++) cCols[b.s - 1 + i] = { wch: 12 };
  }
  wsC["!cols"] = cCols;
  wsC["!ref"]  = XLSX.utils.encode_range({ s: { r: 2, c: 0 }, e: { r: CH_DZ - 1, c: CH_M3_E - 1 } });

  // ── CONSOLIDATED SHEET ───────────────────────────────────────────────────────
  const wsN: WS = {};

  const CON_HDR = 5;
  const CON_D0  = 6;
  const CON_DZ  = CON_D0 + skus.length - 1;

  const CON_M1_GT = 13;
  const CON_M1_S  = 14;
  const CON_M1_E  = CON_M1_S + numCl - 1;
  const CON_M2_GT = CON_M1_E + 2;
  const CON_M2_S  = CON_M2_GT + 1;
  const CON_M2_E  = CON_M2_S + numCl - 1;
  const CON_M3_GT = CON_M2_E + 2;
  const CON_M3_S  = CON_M3_GT + 1;
  const CON_M3_E  = CON_M3_S + numCl - 1;

  const conBlocks = [
    { gt: CON_M1_GT, s: CON_M1_S, e: CON_M1_E, m: months[0] },
    { gt: CON_M2_GT, s: CON_M2_S, e: CON_M2_E, m: months[1] },
    { gt: CON_M3_GT, s: CON_M3_S, e: CON_M3_E, m: months[2] },
  ];

  // Row 3: month labels
  for (const cm of conBlocks) wc(wsN, cm.gt, 3, cm.m);

  // Row 4: SUBTOTAL formulas
  for (const cm of conBlocks) {
    wc(wsN, cm.gt, 4, null, `SUBTOTAL(9,${col(cm.gt)}${CON_D0}:${col(cm.gt)}${CON_DZ})`);
    for (let i = 0; i < numCl; i++) {
      const c = cm.s + i;
      wc(wsN, c, 4, null, `SUBTOTAL(9,${col(c)}${CON_D0}:${col(c)}${CON_DZ})`);
    }
  }

  // Row 5: headers
  ["New Master SKU", "New FG Code", "Master SKU", "FG Code", "Product Name", "Category", "Product Category"]
    .forEach((h, i) => wc(wsN, 6 + i, CON_HDR, h));
  for (const cm of conBlocks) {
    wc(wsN, cm.gt, CON_HDR, "Grand Total");
    sortedCl.forEach((cl, i) => wc(wsN, cm.s + i, CON_HDR, cl.name));
  }

  // Rows 6+: data with SUMIFS cross-sheet formulas
  skus.forEach((sku, idx) => {
    const conRow = CON_D0 + idx;
    const chRow  = CH_D0 + idx;
    const nm  = String(sku.new_master_sku || "");
    const fg  = String(sku.fg_code || "").trim();
    const ms  = nm.endsWith("G") ? nm.slice(0, -1) : nm;
    const nfg = fg ? `${fg}G` : "";
    const fgd = /^\d+$/.test(fg) ? Number(fg) : fg;

    wc(wsN, 6,  conRow, nm);
    wc(wsN, 7,  conRow, nfg);
    wc(wsN, 8,  conRow, ms);
    wc(wsN, 9,  conRow, fgd);
    wc(wsN, 10, conRow, sku.product_name || "");
    wc(wsN, 11, conRow, sku.category || "");
    wc(wsN, 12, conRow, sku.product_category || "");

    conBlocks.forEach((cm, mi) => {
      const b = chBlocks[mi];
      wc(wsN, cm.gt, conRow, null, `SUM(${col(cm.s)}${conRow}:${col(cm.e)}${conRow})`);
      sortedCl.forEach((_cl, i) => {
        const c = cm.s + i;
        const f = `SUMIFS(Channels!$${col(b.s)}${chRow}:$${col(b.e)}${chRow},Channels!$${col(b.s)}$4:$${col(b.e)}$4,Consolidated!${col(c)}$5)`;
        wc(wsN, c, conRow, null, f);
      });
    });
  });

  // Column widths
  const nCols: any[] = Array.from({ length: CON_M3_E }, () => ({ wch: 14 }));
  nCols[9] = { wch: 45 };
  for (const cm of conBlocks)
    for (let i = 0; i < numCl; i++) nCols[cm.s - 1 + i] = { wch: 16 };
  wsN["!cols"] = nCols;
  wsN["!ref"]  = XLSX.utils.encode_range({ s: { r: 2, c: 0 }, e: { r: CON_DZ - 1, c: CON_M3_E - 1 } });

  // Build workbook
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsC, "Channels");
  XLSX.utils.book_append_sheet(wb, wsN, "Consolidated");

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export async function GET(request: NextRequest) {
  const cycleId = request.nextUrl.searchParams.get("cycle_id");
  if (!cycleId)
    return NextResponse.json({ error: "cycle_id required" }, { status: 400 });

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: cycle } = await supabase
    .from("forecast_cycles")
    .select("*")
    .eq("id", cycleId)
    .single();

  if (!cycle)
    return NextResponse.json({ error: "Cycle not found" }, { status: 404 });

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

  // 3 months
  const cycleMonth = new Date(cycle.forecast_month);
  const month1 = cycleMonth.toISOString().slice(0, 10);

  const { data: forecastData } = await supabase
    .from("forecast_data")
    .select("sku_id, channel_id, quantity, forecast_month")
    .eq("cycle_id", cycleId);

  // V2+: merge with previous published version
  let baseForecast: any[] = [];
  if (cycle.version > 1) {
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

  const skuMap: Record<string, any> = {};
  (skus || []).forEach((s: any) => { skuMap[s.id] = s; });

  const channelMap: Record<string, any> = {};
  (channels || []).forEach((c: any) => { channelMap[c.id] = c; });

  // Merge: current cycle overrides base
  const merged: Record<string, any> = {};
  for (const f of baseForecast)
    merged[`${f.sku_id}::${f.channel_id}::${f.forecast_month}`] = f;
  for (const f of (forecastData || []))
    merged[`${f.sku_id}::${f.channel_id}::${f.forecast_month}`] = f;

  const forecastForExcel = Object.values(merged).map((f: any) => ({
    sku_master_sku: skuMap[f.sku_id]?.new_master_sku || "",
    channel_name:   channelMap[f.channel_id]?.name || "",
    forecast_month: f.forecast_month,
    quantity:       f.quantity,
  })).filter((f: any) => f.sku_master_sku && f.channel_name);

  try {
    const buffer = buildExcel({
      cycle_month: month1,
      version:     cycle.version,
      skus: (skus || []).map((s: any) => ({
        new_master_sku:   s.new_master_sku,
        fg_code:          s.fg_code || "",
        product_name:     s.product_name,
        category:         s.category,
        product_category: s.product_category,
      })),
      channels: (channels || []).map((c: any) => ({
        name:          c.name,
        cluster_name:  c.clusters?.name || "",
        display_order: c.display_order,
      })),
      clusters: (clusters || []).map((c: any) => ({
        name:          c.name,
        display_order: c.display_order,
      })),
      forecast: forecastForExcel,
    });

    const monthStr = cycleMonth
      .toLocaleDateString("en-US", { month: "short", year: "numeric" })
      .replace(" ", "_");
    const filename = `Forecast_${monthStr}_V${cycle.version}.xlsx`;

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
