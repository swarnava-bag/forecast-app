// Persist / list the raw movement upload files (Forecast · SO · STN · Shipsheet)
// per month, so an upload is never lost and past months can be re-processed or
// downloaded. Admin only; the actual storage I/O runs with the service role.
import { NextResponse } from "next/server";
import { createClient as createServer } from "@/lib/supabase/server";
import { createClient as createService, type SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
const BUCKET = "movement-files";

async function requireAdmin() {
  try {
    const sb = await createServer();
    const user = (await sb.auth.getUser()).data.user;
    if (!user) return null;
    const { data: p } = await sb.from("profiles").select("role").eq("id", user.id).single();
    return p?.role === "admin" ? user : null;
  } catch { return null; }
}
function service(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? createService(url, key) : null;
}

export async function POST(req: Request) {
  if (!(await requireAdmin())) return NextResponse.json({ error: "Admins only." }, { status: 403 });
  const sb = service(); if (!sb) return NextResponse.json({ error: "Server missing service-role key." }, { status: 500 });

  const form = await req.formData();
  const file = form.get("file") as File | null;
  const monthKey = String(form.get("monthKey") || "");
  const slot = String(form.get("slot") || "");
  if (!file || !/^\d{4}-\d{2}$/.test(monthKey) || !slot) return NextResponse.json({ error: "file, monthKey (YYYY-MM) and slot are required." }, { status: 400 });

  const name = file.name.replace(/[^\w.\- ]/g, "_");
  const path = `${monthKey}/${slot}-${name}`;
  // keep one file per slot: drop any earlier file for this slot with a different name
  const { data: existing } = await sb.storage.from(BUCKET).list(monthKey);
  const stale = (existing || []).filter((o) => o.name.startsWith(`${slot}-`) && o.name !== `${slot}-${name}`).map((o) => `${monthKey}/${o.name}`);
  if (stale.length) await sb.storage.from(BUCKET).remove(stale);

  const buf = Buffer.from(await file.arrayBuffer());
  const { error } = await sb.storage.from(BUCKET).upload(path, buf, { upsert: true, contentType: file.type || "application/octet-stream" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, path });
}

export async function GET(req: Request) {
  if (!(await requireAdmin())) return NextResponse.json({ error: "Admins only." }, { status: 403 });
  const sb = service(); if (!sb) return NextResponse.json({ error: "Server missing service-role key." }, { status: 500 });
  const monthKey = new URL(req.url).searchParams.get("month") || "";
  if (!/^\d{4}-\d{2}$/.test(monthKey)) return NextResponse.json({ error: "month (YYYY-MM) is required." }, { status: 400 });

  const { data, error } = await sb.storage.from(BUCKET).list(monthKey, { sortBy: { column: "name", order: "asc" } });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const files = await Promise.all((data || []).map(async (o) => {
    const path = `${monthKey}/${o.name}`;
    const { data: signed } = await sb.storage.from(BUCKET).createSignedUrl(path, 3600);
    return { name: o.name, path, size: (o.metadata?.size as number | undefined) ?? null, url: signed?.signedUrl ?? null, updated: o.updated_at ?? o.created_at ?? null };
  }));
  return NextResponse.json({ files });
}
