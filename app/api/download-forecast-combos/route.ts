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

  const { data: channels } = await supabase
    .from("channels")
    .select("id, name, cluster_id, display_order, clusters(name)")
    .eq("is_active", true)
    .order("display_order");

  const { data: comboData } = await supabase
    .from("forecast_data_combos")
    .select("master_sku, channel_id, quantity, forecast_month")
    .eq("cycle_id", cycleId);

  if (!comboData || comboData.length === 0)
    return NextResponse.json({ error: "No combo forecast data for this cycle" }, { status: 404 });

  const cycleMonth = new Date(cycle.forecast_month);
  const month1 = cycleMonth.toISOString().slice(0, 10);
  const d2 = new Date(cycleMonth); d2.setMonth(d2.getMonth() + 1);
  const month2 = d2.toISOString().slice(0, 10);
  const d3 = new Date(cycleMonth); d3.setMonth(d3.getMonth() + 2);
  const month3 = d3.toISOString().slice(0, 10);
  const months = [month1, month2, month3];

  const sortedCh = [...(channels || [])].sort((a, b) => a.display_order - b.display_order);
  const numCh = sortedCh.length;

  // Channel id → name and cluster name
  const chNameMap: Record<string, string> = {};
  const chCluster: Record<string, string> = {};
  for (const ch of sortedCh) {
    chNameMap[ch.id] = ch.name;
    chCluster[ch.name] = (ch.clusters as any)?.name || "";
  }

  // Forecast lookup: "master_sku::channel_name::YYYY-MM" → quantity
  const flookup: Record<string, number> = {};
  const masterSkuSet = new Set<string>();
  for (const f of comboData) {
    const chName = chNameMap[f.channel_id] || "";
    if (!chName) continue;
    const key = `${f.master_sku}::${chName}::${f.forecast_month.slice(0, 7)}`;
    flookup[key] = (flookup[key] || 0) + f.quantity;
    masterSkuSet.add(f.master_sku);
  }

  const masterSkus = [...masterSkuSet].sort();

  // ── BUILD EXCEL ──────────────────────────────────────────────────────────────
  const ws: WS = {};

  const HDR = 6;
  const D0  = 7;
  const DZ  = D0 + masterSkus.length - 1;

  // Column layout: col 1 = Master SKU, then 3 blocks of (GT + N channels)
  const SKU_COL = 1;
  const M1_GT   = 2;
  const M1_S    = 3;
  const M1_E    = M1_S + numCh - 1;
  const M2_GT   = M1_E + 2;
  const M2_S    = M2_GT + 1;
  const M2_E    = M2_S + numCh - 1;
  const M3_GT   = M2_E + 2;
  const M3_S    = M3_GT + 1;
  const M3_E    = M3_S + numCh - 1;

  const blocks = [
    { gt: M1_GT, s: M1_S, e: M1_E, m: months[0] },
    { gt: M2_GT, s: M2_S, e: M2_E, m: months[1] },
    { gt: M3_GT, s: M3_S, e: M3_E, m: months[2] },
  ];

  // Row 3: month date labels
  for (const b of blocks) wc(ws, b.s, 3, b.m);

  // Row 4: cluster names per channel
  for (const b of blocks)
    sortedCh.forEach((ch, i) => wc(ws, b.s + i, 4, chCluster[ch.name] || ""));

  // Row 5: SUBTOTAL formulas
  for (const b of blocks) {
    wc(ws, b.gt, 5, null, `SUBTOTAL(9,${col(b.gt)}${D0}:${col(b.gt)}${DZ})`);
    for (let i = 0; i < numCh; i++) {
      const c = b.s + i;
      wc(ws, c, 5, null, `SUBTOTAL(9,${col(c)}${D0}:${col(c)}${DZ})`);
    }
  }

  // Row 6: headers
  wc(ws, SKU_COL, HDR, "Master SKU");
  for (const b of blocks) {
    wc(ws, b.gt, HDR, "Grand Total");
    sortedCh.forEach((ch, i) => wc(ws, b.s + i, HDR, ch.name));
  }

  // Rows 7+: data
  masterSkus.forEach((sku, idx) => {
    const row = D0 + idx;
    wc(ws, SKU_COL, row, sku);
    blocks.forEach((b, mi) => {
      wc(ws, b.gt, row, null, `SUM(${col(b.s)}${row}:${col(b.e)}${row})`);
      sortedCh.forEach((ch, i) => {
        const qty = flookup[`${sku}::${ch.name}::${months[mi].slice(0, 7)}`];
        if (qty && qty > 0) wc(ws, b.s + i, row, qty);
      });
    });
  });

  // Column widths
  const wsCols: any[] = Array.from({ length: M3_E }, () => ({ wch: 12 }));
  wsCols[0] = { wch: 24 }; // Master SKU
  for (const b of blocks) {
    wsCols[b.gt - 1] = { wch: 14 };
    for (let i = 0; i < numCh; i++) wsCols[b.s - 1 + i] = { wch: 12 };
  }
  ws["!cols"] = wsCols;
  ws["!ref"]  = XLSX.utils.encode_range({ s: { r: 2, c: 0 }, e: { r: DZ - 1, c: M3_E - 1 } });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Combo Forecast");

  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

  const monthStr = cycleMonth
    .toLocaleDateString("en-US", { month: "short", year: "numeric" })
    .replace(" ", "_");
  const filename = `Forecast_Combos_${monthStr}_V${cycle.version}.xlsx`;

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
