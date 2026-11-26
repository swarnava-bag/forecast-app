// Fulfillment TAT — everything lives in the private Supabase Storage bucket
// "fulfillment-files" (created on first write; no SQL setup needed):
//   months/YYYY-MM.json.gz   monthly order snapshot (gzip JSON, ~2 MB / 50k orders)
//   settings/config.json     Channel Mapper, WH closed dates, CRED SLA, reasons, cutoff
//
//   GET  ?list=1            → { months: [{ monthKey, updatedAt }] }   (newest first)
//   GET  ?month=YYYY-MM     → packed snapshot JSON (served gzip-encoded)
//   GET  ?config=1          → { config, meta }
//   POST { kind: "snapshot", monthKey, fields, rows, … }       publish/replace a month (gzip body)
//   POST { kind: "config", section, value }                     replace one settings section
//   All methods: Supply Chain / admin only.
import { NextResponse } from "next/server";
import { gzipSync, gunzipSync } from "zlib";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient, type SupabaseClient } from "@supabase/supabase-js";
import { hasAccess } from "@/lib/fulfillment/snapshot";
import { DEFAULT_CONFIG } from "@/lib/fulfillment/defaults";
import type { FulfillmentConfig } from "@/lib/fulfillment/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DENIED = "The Fulfillment dashboard is available to the Supply Chain team only.";
const BUCKET = "fulfillment-files";
const DIR = "months";
const CONFIG_PATH = "settings/config.json";
const pathFor = (key: string) => `${DIR}/${key}.json.gz`;
const KEY_RE = /^\d{4}-\d{2}$/;
const SECTIONS = ["channelMap", "closedDays", "credSla", "reasons", "settings"] as const;
type Section = (typeof SECTIONS)[number];

type StoredConfig = { config: FulfillmentConfig; meta: Partial<Record<Section, { at: string; by: string }>> };

function service(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? createServiceClient(url, key, { auth: { persistSession: false } }) : null;
}

async function currentUser() {
  const sb = await createClient();
  const user = (await sb.auth.getUser()).data.user;
  if (!user) return null;
  const { data: p } = await sb.from("profiles").select("role, full_name, email").eq("id", user.id).single();
  return { id: user.id, role: (p?.role as string) ?? null, name: (p?.full_name as string) || (p?.email as string) || user.email || "" };
}

async function ensureBucket(svc: SupabaseClient) {
  const { error } = await svc.storage.getBucket(BUCKET);
  if (!error) return;
  const { error: cErr } = await svc.storage.createBucket(BUCKET, { public: false });
  if (cErr && !/exist/i.test(cErr.message)) throw new Error(`Could not create storage bucket: ${cErr.message}`);
}

async function readJson<T>(svc: SupabaseClient, path: string): Promise<T | null> {
  const { data, error } = await svc.storage.from(BUCKET).download(path);
  if (error || !data) return null;
  try { return JSON.parse(await data.text()) as T; } catch { return null; }
}
async function writeJson(svc: SupabaseClient, path: string, value: unknown) {
  await ensureBucket(svc);
  const { error } = await svc.storage.from(BUCKET).upload(path, Buffer.from(JSON.stringify(value)), { upsert: true, contentType: "application/json" });
  if (error) throw new Error(`Save failed: ${error.message}`);
}

/** Settings is a read-modify-write JSON file: serialise writes in this process. */
let writeChain: Promise<unknown> = Promise.resolve();
const serial = <T,>(fn: () => Promise<T>): Promise<T> => {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => undefined);
  return run;
};

const loadConfig = async (svc: SupabaseClient): Promise<StoredConfig> => {
  const s = await readJson<StoredConfig>(svc, CONFIG_PATH);
  return s?.config ? { config: { ...DEFAULT_CONFIG, ...s.config }, meta: s.meta ?? {} } : { config: DEFAULT_CONFIG, meta: {} };
};

/** Light validation of a settings section coming from the page. */
function validSection(section: Section, v: unknown): string | null {
  const arr = (x: unknown): x is Record<string, unknown>[] => Array.isArray(x) && x.every((r) => r && typeof r === "object");
  const str = (x: unknown) => typeof x === "string";
  const date = (x: unknown) => typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x);
  switch (section) {
    case "channelMap": return arr(v) && v.every((r) => str(r.channelName) && str(r.l1) && str(r.l2)) ? null : "Bad channel map";
    case "closedDays": return arr(v) && v.every((r) => date(r.date) && (r.warehouse === null || str(r.warehouse)) && str(r.remarks)) ? null : "Bad closed dates";
    case "credSla": return arr(v) && v.every((r) => date(r.date) && typeof r.hours === "number" && r.hours > 0) ? null : "Bad CRED SLA dates";
    case "reasons": return arr(v) && v.every((r) => str(r.statusKey) && str(r.reason)) ? null : "Bad reasons";
    case "settings": {
      const s = v as { cutoff?: unknown; credDefaultHours?: unknown };
      return s && typeof s.cutoff === "string" && /^\d{1,2}:\d{2}$/.test(s.cutoff) && (s.credDefaultHours === null || typeof s.credDefaultHours === "number") ? null : "Bad settings";
    }
  }
}

export async function GET(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!hasAccess(me.role)) return NextResponse.json({ error: DENIED }, { status: 403 });
  const svc = service();
  if (!svc) return NextResponse.json({ error: "Server missing SUPABASE_SERVICE_ROLE_KEY." }, { status: 500 });
  const url = new URL(req.url);

  if (url.searchParams.get("config")) {
    return NextResponse.json(await loadConfig(svc), { headers: { "Cache-Control": "no-store" } });
  }

  if (url.searchParams.get("list")) {
    const { data, error } = await svc.storage.from(BUCKET).list(DIR, { limit: 200 });
    if (error) return NextResponse.json({ months: [] }); // bucket not created yet
    const months = (data ?? [])
      .map((f) => ({ monthKey: f.name.replace(/\.json\.gz$/, ""), updatedAt: f.updated_at ?? f.created_at ?? null }))
      .filter((m) => KEY_RE.test(m.monthKey))
      .sort((a, b) => b.monthKey.localeCompare(a.monthKey));
    return NextResponse.json({ months });
  }

  const key = url.searchParams.get("month") ?? "";
  if (!KEY_RE.test(key)) return NextResponse.json({ error: "month=YYYY-MM required" }, { status: 400 });
  const { data, error } = await svc.storage.from(BUCKET).download(pathFor(key));
  if (error || !data) return NextResponse.json({ error: `No data uploaded for ${key}.` }, { status: 404 });
  return new Response(await data.arrayBuffer(), {
    headers: { "Content-Type": "application/json", "Content-Encoding": "gzip", "Cache-Control": "no-store" },
  });
}

export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!hasAccess(me.role)) return NextResponse.json({ error: DENIED }, { status: 403 });
  const svc = service();
  if (!svc) return NextResponse.json({ error: "Server missing SUPABASE_SERVICE_ROLE_KEY." }, { status: 500 });

  // Month snapshots arrive gzipped (application/gzip) to stay well under the
  // proxy's 10 MB request limit; settings arrive as plain JSON.
  let body: Record<string, unknown>;
  try {
    if ((req.headers.get("content-type") ?? "").includes("application/gzip")) {
      body = JSON.parse(gunzipSync(Buffer.from(await req.arrayBuffer())).toString("utf8"));
    } else {
      body = await req.json();
    }
  } catch {
    return NextResponse.json({ error: "Could not read the upload (invalid or incomplete data). If this repeats, the file may be too large for one month." }, { status: 400 });
  }
  const now = new Date().toISOString();

  try {
    // ── settings section ──
    if (body.kind === "config") {
      const section = body.section as Section;
      if (!SECTIONS.includes(section)) return NextResponse.json({ error: "Unknown settings section" }, { status: 400 });
      const bad = validSection(section, body.value);
      if (bad) return NextResponse.json({ error: bad }, { status: 400 });
      const saved = await serial(async () => {
        const cur = await loadConfig(svc);
        const config: FulfillmentConfig = section === "settings"
          ? { ...cur.config, ...(body.value as Pick<FulfillmentConfig, "cutoff" | "credDefaultHours">) }
          : { ...cur.config, [section]: body.value };
        const next: StoredConfig = { config, meta: { ...cur.meta, [section]: { at: now, by: me.name } } };
        await writeJson(svc, CONFIG_PATH, next);
        return next;
      });
      return NextResponse.json(saved);
    }

    // ── month snapshot ──
    const key = typeof body.monthKey === "string" ? body.monthKey : "";
    if (!KEY_RE.test(key) || !Array.isArray(body.rows) || !Array.isArray(body.fields)) {
      return NextResponse.json({ error: "Expected a packed snapshot with monthKey, fields and rows." }, { status: 400 });
    }
    body.uploadedBy = me.name; // server-stamped publisher + time
    body.uploadedAt = now;
    delete body.kind;
    await ensureBucket(svc);
    const gz = gzipSync(Buffer.from(JSON.stringify(body)));
    const { error } = await svc.storage.from(BUCKET).upload(pathFor(key), gz, { upsert: true, contentType: "application/gzip" });
    if (error) return NextResponse.json({ error: `Upload failed: ${error.message}` }, { status: 500 });
    return NextResponse.json({ ok: true, monthKey: key, orders: body.rows.length, bytes: gz.length, uploadedAt: now, uploadedBy: me.name });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
