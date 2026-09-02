// Granular AOP Sales for the dashboard — one request. Returns rows at
// month × channel × category × master_sku × kind, so the client can slice by any
// month range (incl. Category and Top-SKUs) without another round-trip.
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET() {
  let sb;
  try { sb = await createClient(); } catch { return NextResponse.json({ error: "Not authenticated" }, { status: 401 }); }
  if (!(await sb.auth.getUser()).data.user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const raw: { forecast_month: string; channel: string; category: string | null; kind: string; master_sku: string; qty: number; nto: number; gto: number }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("aop_sales").select("forecast_month,channel,category,kind,master_sku,qty,nto,gto").range(from, from + 999);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    raw.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }

  const months = new Set<string>(), channels = new Set<string>(), categories = new Set<string>();
  const rows = raw.map((r) => {
    const month = r.forecast_month.slice(0, 7), category = r.category || "Uncategorised";
    months.add(month); channels.add(r.channel); categories.add(category);
    return { month, channel: r.channel, category, kind: r.kind, masterSku: r.master_sku, qty: r.qty, nto: r.nto, gto: r.gto };
  });
  return NextResponse.json({
    rows, months: [...months].sort(), channels: [...channels].sort(), categories: [...categories].sort(), rowCount: rows.length,
  });
}
