// Multi-month store for the Forecast-vs-Movement snapshots.
//
//   Storage is Supabase-first, filesystem-fallback:
//     • If the `movement_snapshots` table exists (see
//       supabase/sql/movement_snapshots.sql), snapshots live there — works on
//       any host, including read-only serverless.
//     • Otherwise they are written to public/data/movement-<monthKey>.json,
//       which works on a self-hosted / `next start` server.
//   The bundled June file (movement-2026-06.json / movement-jun26.json) is
//   always available as a floor so the dashboard never comes up empty.
//
//   GET  ?list=1            → { months: [{monthKey, month, publishedAt}], latest }
//   GET  ?month=YYYY-MM     → the snapshot for that month
//   POST { monthKey, month, snapshot }  → upsert (auth required)
import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const DIR = path.join(process.cwd(), "public", "data");
const TABLE = "movement_snapshots";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const label = (key: string) => { const [y, m] = key.split("-").map(Number); return m ? `${MONTHS[m - 1]} ${y}` : key; };
const fileFor = (key: string) => path.join(DIR, `movement-${key}.json`);

async function supa() {
  try { return await createClient(); } catch { return null; }
}

// ── list ──────────────────────────────────────────────────────────────────────
async function listMonths() {
  const seen = new Map<string, { monthKey: string; month: string; publishedAt: string | null }>();
  const sb = await supa();
  if (sb) {
    const { data, error } = await sb.from(TABLE).select("month_key, month_label, published_at");
    if (!error && data) for (const r of data) seen.set(r.month_key, { monthKey: r.month_key, month: r.month_label || label(r.month_key), publishedAt: r.published_at ?? null });
  }
  try {
    for (const f of await fs.readdir(DIR)) {
      const m = f.match(/^movement-(\d{4}-\d{2})\.json$/);
      if (m && !seen.has(m[1])) { const st = await fs.stat(path.join(DIR, f)); seen.set(m[1], { monthKey: m[1], month: label(m[1]), publishedAt: st.mtime.toISOString() }); }
    }
  } catch { /* dir may not exist */ }
  if (!seen.has("2026-06")) seen.set("2026-06", { monthKey: "2026-06", month: "Jun 2026", publishedAt: null });
  const months = [...seen.values()].sort((a, b) => b.monthKey.localeCompare(a.monthKey));
  return { months, latest: months[0]?.monthKey ?? "2026-06" };
}

async function readMonth(key: string) {
  const sb = await supa();
  if (sb) {
    const { data, error } = await sb.from(TABLE).select("data").eq("month_key", key).maybeSingle();
    if (!error && data?.data) return data.data;
  }
  try { return JSON.parse(await fs.readFile(fileFor(key), "utf-8")); } catch { /* fall through */ }
  if (key === "2026-06") { try { return JSON.parse(await fs.readFile(path.join(DIR, "movement-jun26.json"), "utf-8")); } catch { /* */ } }
  return null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get("list")) return NextResponse.json(await listMonths());
  const month = url.searchParams.get("month");
  if (month) {
    const d = await readMonth(month);
    return d ? NextResponse.json(d) : NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(await listMonths());
}

export async function POST(req: Request) {
  const sb = await supa();
  const user = sb ? (await sb.auth.getUser()).data.user : null;
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  let body: { monthKey?: string; month?: string; snapshot?: { overall?: unknown[]; meta?: { monthKey?: string; month?: string } } };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const snap = body.snapshot;
  const monthKey = body.monthKey || snap?.meta?.monthKey;
  const monthLabel = body.month || snap?.meta?.month || (monthKey ? label(monthKey) : "");
  if (!snap || !Array.isArray(snap.overall) || !snap.meta || !monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) {
    return NextResponse.json({ error: "Body must be { monthKey, snapshot } with a valid YYYY-MM month" }, { status: 400 });
  }

  // try Supabase first
  const { error: upErr } = await sb!.from(TABLE).upsert({ month_key: monthKey, month_label: monthLabel, data: snap, published_at: new Date().toISOString(), published_by: user.id });
  if (!upErr) return NextResponse.json({ ok: true, monthKey, storage: "supabase", publishedAt: new Date().toISOString() });

  // fall back to the filesystem (self-hosted)
  try {
    await fs.mkdir(DIR, { recursive: true });
    await fs.writeFile(fileFor(monthKey), JSON.stringify(snap), "utf-8");
    return NextResponse.json({ ok: true, monthKey, storage: "file", publishedAt: new Date().toISOString(), note: `Supabase unavailable (${upErr.message}); wrote a local file. Apply supabase/sql/movement_snapshots.sql to persist across a hosted deploy.` });
  } catch (e) {
    return NextResponse.json({ error: `Could not persist snapshot to Supabase or filesystem: ${upErr.message} / ${String(e)}` }, { status: 500 });
  }
}
