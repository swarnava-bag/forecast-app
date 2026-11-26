/**
 * Browser-side data access for the Fulfillment section. Everything goes
 * through /api/fulfillment (Supabase Storage; Supply Chain / admin only):
 * monthly order snapshots and the editable settings.
 */
import type { ChannelMapRow, ClosedDay, CredSla, FulfillmentConfig, ReasonRow } from "./engine";
import { packSnapshot, unpackSnapshot, type Snapshot } from "./snapshot";

export type SectionMeta = Partial<Record<"channelMap" | "closedDays" | "credSla" | "reasons" | "settings", { at: string; by: string }>>;
export type LoadedSettings = { config: FulfillmentConfig; meta: SectionMeta };

const API = "/api/fulfillment";

async function jsonOrThrow(r: Response) {
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
  return d;
}
const post = async (body: unknown) =>
  jsonOrThrow(await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

// ── settings ─────────────────────────────────────────────────────────────────
export async function loadSettings(): Promise<LoadedSettings> {
  const d = await jsonOrThrow(await fetch(`${API}?config=1`, { cache: "no-store" }));
  return { config: d.config, meta: d.meta ?? {} };
}

type Saved = { config: FulfillmentConfig; meta: SectionMeta };
const saveSection = (section: string, value: unknown): Promise<Saved> => post({ kind: "config", section, value });

export const saveChannelMap = (rows: ChannelMapRow[]) =>
  saveSection("channelMap", rows.map((r) => ({ channelName: r.channelName.trim(), l1: r.l1.trim(), l2: r.l2.trim() })));
export const saveClosedDays = (rows: ClosedDay[]) =>
  saveSection("closedDays", [...rows].sort((a, b) => a.date.localeCompare(b.date)).map((r) => ({ date: r.date, warehouse: r.warehouse?.trim() || null, remarks: r.remarks.trim() })));
export const saveCredSla = (rows: CredSla[]) =>
  saveSection("credSla", [...rows].sort((a, b) => a.date.localeCompare(b.date)));
export const saveReasons = (rows: ReasonRow[]) =>
  saveSection("reasons", rows.map((r) => ({ statusKey: r.statusKey.trim(), reason: r.reason.trim() })));
export const saveSettings = (s: { cutoff: string; credDefaultHours: number | null }) => saveSection("settings", s);

// ── snapshots ────────────────────────────────────────────────────────────────
export async function listMonths(): Promise<{ monthKey: string; updatedAt: string | null }[]> {
  return (await jsonOrThrow(await fetch(`${API}?list=1`, { cache: "no-store" }))).months ?? [];
}
export async function loadMonth(key: string): Promise<Snapshot> {
  return unpackSnapshot(await jsonOrThrow(await fetch(`${API}?month=${key}`, { cache: "no-store" })));
}
/**
 * Publish a month. The packed JSON (~14 MB for 50k orders) is gzipped in the
 * browser first (~2.3 MB): requests pass through the Next.js proxy, which
 * truncates bodies over 10 MB (proxyClientMaxBodySize).
 */
export async function publishMonth(s: Snapshot): Promise<{ orders: number; bytes: number; uploadedAt: string; uploadedBy: string }> {
  const json = JSON.stringify({ kind: "snapshot", ...packSnapshot(s) });
  const gz = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
  return jsonOrThrow(await fetch(API, { method: "POST", headers: { "Content-Type": "application/gzip" }, body: gz }));
}
