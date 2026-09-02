// Ingest AOP Sales rows (from the reconciled workbook) into aop_sales.
//   Body: { rows: AopRow[] }.  Admin only; service-role writes.
//   Re-uploading a month replaces that month (delete-by-month then insert), so
//   the monthly append is idempotent.
import { NextResponse } from "next/server";
import { createClient as createServer } from "@/lib/supabase/server";
import { createClient as createService, type SupabaseClient } from "@supabase/supabase-js";
import type { AopRow } from "@/app/sales/lib";

export const runtime = "nodejs";
const TABLE = "aop_sales";
const stripG = (s: string) => (s && s.endsWith("G") ? s.slice(0, -1) : s);

function service(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? createService(url, key) : null;
}

export async function POST(req: Request) {
  let userId: string;
  try {
    const sb = await createServer();
    const user = (await sb.auth.getUser()).data.user;
    if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    const { data: p } = await sb.from("profiles").select("role").eq("id", user.id).single();
    if (p?.role !== "admin") return NextResponse.json({ error: "Admins only." }, { status: 403 });
    userId = user.id;
  } catch { return NextResponse.json({ error: "Not authenticated" }, { status: 401 }); }

  let body: { rows?: AopRow[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const rows = body.rows;
  if (!Array.isArray(rows) || rows.length === 0) return NextResponse.json({ error: "No rows to ingest." }, { status: 400 });

  const svc = service();
  if (!svc) return NextResponse.json({ error: "Server missing service-role key." }, { status: 500 });

  // category from sku_master (match on the G-stripped master SKU)
  const cat = new Map<string, string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await svc.from("sku_master").select("new_master_sku,category").range(from, from + 999);
    if (error) break;
    for (const s of data ?? []) { const k = stripG(s.new_master_sku); if (k && s.category && !cat.has(k)) cat.set(k, s.category); }
    if (!data || data.length < 1000) break;
  }

  const months = [...new Set(rows.map((r) => r.month))];
  const { error: delErr } = await svc.from(TABLE).delete().in("forecast_month", months);
  if (delErr) return NextResponse.json({ error: `Clear months failed: ${delErr.message}` }, { status: 500 });

  // aggregate by the unique key (month × channel × sku × kind) so duplicate rows
  // in the file don't violate the unique constraint on insert.
  const now = new Date().toISOString();
  const byKey = new Map<string, { forecast_month: string; channel: string; master_sku: string; kind: string; qty: number; nto: number; gto: number }>();
  for (const r of rows) {
    const k = `${r.month}|${r.channel}|${r.masterSku}|${r.kind}`;
    const a = byKey.get(k) ?? { forecast_month: r.month, channel: r.channel, master_sku: r.masterSku, kind: r.kind, qty: 0, nto: 0, gto: 0 };
    a.qty += r.qty; a.nto += r.nto; a.gto += r.gto; byKey.set(k, a);
  }
  const recs = [...byKey.values()].map((a) => ({ ...a, category: cat.get(a.master_sku) ?? null, uploaded_at: now, uploaded_by: userId }));
  let inserted = 0;
  for (let i = 0; i < recs.length; i += 500) {
    const { error } = await svc.from(TABLE).insert(recs.slice(i, i + 500));
    if (error) return NextResponse.json({ error: `Insert failed at row ${i}: ${error.message}`, inserted }, { status: 500 });
    inserted += Math.min(500, recs.length - i);
  }
  return NextResponse.json({ ok: true, inserted, months: months.sort() });
}
