// ============================================================================
// Push the movement forecast into the platform's forecast_data.
//
//   The movement forecast file is long-format:
//       New Master SKU | Platform | Channel | Forecast
//   where "Platform" is the granular channel (Amazon, Blinkit, MT…) that maps
//   to the platform's `channels` table, and "Channel" is its cluster.
//
//   extractForecastRows()      — parse those rows in the browser (no Supabase).
//   pushForecastToPlatform()   — write them to a published forecast cycle,
//                                creating any channel the file introduces.
//   Kept mapper-adjacent so the platform stays the single forecast source of
//   truth without touching the shared combo mapper.
// ============================================================================
import type * as XLSXNS from "xlsx";
import type { SupabaseClient } from "@supabase/supabase-js";

export type ForecastRow = { master: string; platform: string; cluster: string; forecast: number };

const txt = (v: unknown) => String(v ?? "").trim();

/** Parse a long-format forecast workbook into rows (qty > 0). Throws if the
 *  expected columns aren't present. */
export function extractForecastRows(wb: XLSXNS.WorkBook, XLSX: typeof XLSXNS): ForecastRow[] {
  const ws = wb.Sheets[wb.SheetNames[0]];
  const g = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }) as unknown[][];
  const H: Record<string, number> = {};
  (g[0] || []).forEach((h, j) => { const k = txt(h).toLowerCase(); if (k) H[k] = j; });
  for (const need of ["new master sku", "platform", "channel", "forecast"]) {
    if (!(need in H)) throw new Error(`Forecast file must be long-format with columns: New Master SKU · Platform · Channel · Forecast (missing "${need}").`);
  }
  const out: ForecastRow[] = [];
  for (let i = 1; i < g.length; i++) {
    const r = g[i]; if (!r) continue;
    const master = txt(r[H["new master sku"]]);
    const platform = txt(r[H["platform"]]);
    const cluster = txt(r[H["channel"]]);
    const forecast = Number(r[H["forecast"]]) || 0;
    if (!master || !platform || forecast <= 0) continue;
    out.push({ master, platform, cluster, forecast });
  }
  return out;
}

export type PushResult = {
  month: string; cycleId: string; version: number; inserted: number; totalQty: number;
  channelsCreated: string[]; skusSkipped: string[]; clustersMissing: string[];
};

/** Write the movement forecast rows into a published forecast cycle for the
 *  month, creating any missing channel under its cluster. Idempotent: re-pushing
 *  a month replaces that month's movement-push cycle data (other cycles are
 *  untouched). `actorId` must be a valid auth user id (FK on the audit columns). */
export async function pushForecastToPlatform(
  sb: SupabaseClient, monthKey: string, rows: ForecastRow[], actorId: string,
): Promise<PushResult> {
  if (!/^\d{4}-\d{2}$/.test(monthKey)) throw new Error(`Bad month "${monthKey}" (expected YYYY-MM).`);
  const fm = `${monthKey}-01`;
  const norm = (s: string) => s.trim();

  // masters
  const skuMap = new Map<string, string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("sku_master").select("id,new_master_sku").range(from, from + 999);
    if (error) throw new Error(`sku_master: ${error.message}`);
    for (const s of data ?? []) skuMap.set(norm(s.new_master_sku), s.id);
    if (!data || data.length < 1000) break;
  }
  const { data: chRows, error: chErr } = await sb.from("channels").select("id,name,display_order");
  if (chErr) throw new Error(`channels: ${chErr.message}`);
  const chMap = new Map<string, string>(); let maxOrd = 0;
  for (const c of chRows ?? []) { chMap.set(c.name.toLowerCase(), c.id); if (c.display_order > maxOrd) maxOrd = c.display_order; }
  const { data: clRows, error: clErr } = await sb.from("clusters").select("id,name");
  if (clErr) throw new Error(`clusters: ${clErr.message}`);
  const clMap = new Map<string, string>();
  for (const c of clRows ?? []) clMap.set(c.name.toLowerCase(), c.id);

  // create channels the file introduces
  const channelsCreated: string[] = []; const clustersMissing = new Set<string>();
  const needChannel = new Map<string, string>();
  for (const r of rows) if (!chMap.has(r.platform.toLowerCase())) needChannel.set(r.platform, r.cluster);
  for (const [platform, cluster] of needChannel) {
    const clId = clMap.get(cluster.toLowerCase());
    if (!clId) { clustersMissing.add(cluster); continue; }
    const { data, error } = await sb.from("channels")
      .insert({ name: platform, cluster_id: clId, is_active: true, display_order: ++maxOrd })
      .select("id").single();
    if (error) throw new Error(`create channel "${platform}": ${error.message}`);
    chMap.set(platform.toLowerCase(), data.id); channelsCreated.push(platform);
  }

  // aggregate → sku_id × channel_id
  const agg = new Map<string, number>(); const skusSkipped = new Set<string>();
  for (const r of rows) {
    const skuId = skuMap.get(r.master); if (!skuId) { skusSkipped.add(r.master); continue; }
    const chId = chMap.get(r.platform.toLowerCase()); if (!chId) continue;   // cluster missing
    const k = `${skuId}::${chId}`; agg.set(k, (agg.get(k) ?? 0) + r.forecast);
  }

  // cycle: reuse this month's movement-push cycle, else create the next version (published)
  const tag = `Movement forecast push`;
  const { data: existing } = await sb.from("forecast_cycles").select("id,version,notes")
    .eq("forecast_month", fm).order("version", { ascending: false });
  let cycleId: string; let version: number;
  const pushed = (existing ?? []).find((c) => typeof c.notes === "string" && c.notes.includes(tag));
  const now = new Date().toISOString();
  if (pushed) {
    cycleId = pushed.id; version = pushed.version;
    await sb.from("forecast_data").delete().eq("cycle_id", cycleId);
  } else {
    // forecast_data is unique on (sku, channel, month, version) ACROSS cycles, so
    // the new version must clear any version already present for this month —
    // whether it lives in a cycle or nested inside an older multi-month cycle.
    const { data: dv } = await sb.from("forecast_data").select("version").eq("forecast_month", fm).order("version", { ascending: false }).limit(1);
    const maxData = dv?.[0]?.version ?? 0;
    const maxCycle = (existing ?? [])[0]?.version ?? 0;
    version = Math.max(maxData, maxCycle) + 1;
    const { data, error } = await sb.from("forecast_cycles").insert({
      forecast_month: fm, version, status: "published",
      opened_at: now, locked_at: now, published_at: now, published_by: actorId, created_by: actorId,
      notes: `${tag} (${monthKey})`,
    }).select("id").single();
    if (error) throw new Error(`create cycle: ${error.message}`);
    cycleId = data.id;
  }

  // insert forecast_data (version matches the cycle so the unique key never clashes)
  const all = [...agg].map(([k, q]) => {
    const [sku_id, channel_id] = k.split("::");
    return { cycle_id: cycleId, sku_id, channel_id, quantity: Math.round(q), forecast_month: fm, version, status: "published", uploaded_by: actorId, uploaded_at: now, updated_at: now };
  });
  let inserted = 0;
  for (let i = 0; i < all.length; i += 500) {
    const { error } = await sb.from("forecast_data").insert(all.slice(i, i + 500));
    if (error) throw new Error(`insert forecast_data: ${error.message}`);
    inserted += Math.min(500, all.length - i);
  }
  const totalQty = [...agg.values()].reduce((a, b) => a + b, 0);
  return { month: monthKey, cycleId, version, inserted, totalQty, channelsCreated, skusSkipped: [...skusSkipped], clustersMissing: [...clustersMissing] };
}
