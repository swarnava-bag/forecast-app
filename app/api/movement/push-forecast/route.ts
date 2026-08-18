// Push the movement forecast to the platform's forecast_data (admin only).
//   Body: { monthKey: "YYYY-MM", rows: [{ master, platform, cluster, forecast }] }
// Auth comes from the session cookie; the writes run with the service role so
// channel/cycle creation isn't blocked by RLS. The forecast the ops team uploads
// in Forecast-vs-Movement becomes the platform's forecast for that month.
import { NextResponse } from "next/server";
import { createClient as createServer } from "@/lib/supabase/server";
import { createClient as createService } from "@supabase/supabase-js";
import { pushForecastToPlatform, type ForecastRow } from "@/app/movement/pushForecast";

export const runtime = "nodejs";

export async function POST(req: Request) {
  // authenticate + authorize (admin) via the session
  let user;
  try {
    const sb = await createServer();
    user = (await sb.auth.getUser()).data.user;
    if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    const { data: profile } = await sb.from("profiles").select("role").eq("id", user.id).single();
    if (profile?.role !== "admin") return NextResponse.json({ error: "Only admins can push the forecast to the platform." }, { status: 403 });
  } catch {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: { monthKey?: string; rows?: ForecastRow[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const { monthKey, rows } = body;
  if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) return NextResponse.json({ error: "monthKey (YYYY-MM) is required" }, { status: 400 });
  if (!Array.isArray(rows) || rows.length === 0) return NextResponse.json({ error: "No forecast rows to push." }, { status: 400 });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ error: "Server is missing the Supabase service-role key." }, { status: 500 });
  const service = createService(url, key);

  try {
    const result = await pushForecastToPlatform(service, monthKey, rows, user.id);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
