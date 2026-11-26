/**
 * Overview analytics — pure functions over computed orders (one row per order).
 * Definitions follow the workbook:
 *   • order-day metrics  (orders, dispatched, AZ/FK SLA, TATs) use Order Day (EP)
 *   • 3 PM metrics       (due / on time / late / pending) use Due Day (ER),
 *                        marketplace channels only (MARKETPLACE_3PM)
 * plus one new measure: Order → Dispatch hours (dispatch − order date).
 */
import { DAY, MARKETPLACE_3PM, type Computed, type PendingRow } from "./engine";

export type Scope = { channels: string[]; facilities: string[] }; // empty = all
export type Range = { start: number; end: number }; // inclusive day numbers

const MP = new Set(MARKETPLACE_3PM);

export function applyScope<T extends { channel: string | null; facility: string }>(rows: T[], s: Scope): T[] {
  const ch = s.channels.length ? new Set(s.channels) : null;
  const fa = s.facilities.length ? new Set(s.facilities) : null;
  if (!ch && !fa) return rows;
  return rows.filter((r) => (!ch || (r.channel !== null && ch.has(r.channel))) && (!fa || fa.has(r.facility)));
}
export function applyScopePending(rows: PendingRow[], s: Scope): PendingRow[] {
  const ch = s.channels.length ? new Set(s.channels) : null;
  const fa = s.facilities.length ? new Set(s.facilities) : null;
  return rows.filter((r) => (!ch || ch.has(r.channel)) && (!fa || fa.has(r.facility)));
}

const inOrderRange = (r: Computed, g: Range) => r.orderDay !== null && r.orderDay >= g.start && r.orderDay <= g.end;
const inDueRange = (r: Computed, g: Range) => r.dueDay !== null && r.dueDay >= g.start * DAY && r.dueDay < (g.end + 1) * DAY;
export const orderToDispatchHrs = (r: Computed) => (r.dispatched && r.orderDate !== null ? (r.dispatchDate! - r.orderDate) / 3600 : null);

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}
const rate = (a: number, b: number) => (b ? a / b : null);

export type Kpis = {
  orders: number; dispatched: number; dispatchRate: number | null;
  due3pm: number; onTime: number; late: number; pending3pm: number; onTimeRate: number | null;
  slaMet: number; slaBreached: number; slaRate: number | null;
  medianO2D: number | null; p90O2D: number | null;
};

export function kpis(rows: Computed[], g: Range): Kpis {
  let orders = 0, dispatched = 0, due = 0, on = 0, late = 0, pend = 0, met = 0, br = 0;
  const o2d: number[] = [];
  for (const r of rows) {
    if (inOrderRange(r, g)) {
      orders++;
      if (r.dispatched) { dispatched++; const h = orderToDispatchHrs(r); if (h !== null) o2d.push(h); }
      if (r.azfkSla === "Met") met++; else if (r.azfkSla === "Breached") br++;
    }
    if (r.channel !== null && MP.has(r.channel) && inDueRange(r, g)) {
      due++;
      if (r.status3pm === "On Time") on++; else if (r.status3pm === "Late") late++; else if (r.status3pm === "Pending") pend++;
    }
  }
  return {
    orders, dispatched, dispatchRate: rate(dispatched, orders),
    due3pm: due, onTime: on, late, pending3pm: pend, onTimeRate: rate(on, due),
    slaMet: met, slaBreached: br, slaRate: rate(met, met + br),
    medianO2D: median(o2d), p90O2D: quantile(o2d, 0.9),
  };
}

export type DayPoint = {
  day: number;
  // by due day (marketplaces)
  onTime: number; late: number; pending: number; due: number; onTimeRate: number | null;
  // by order day
  orders: number; dispatched: number; medianO2D: number | null;
};

export function daily(rows: Computed[], g: Range): DayPoint[] {
  const n = g.end - g.start + 1;
  const pts: DayPoint[] = Array.from({ length: Math.max(0, n) }, (_, i) => ({ day: g.start + i, onTime: 0, late: 0, pending: 0, due: 0, onTimeRate: null, orders: 0, dispatched: 0, medianO2D: null }));
  const o2d: number[][] = pts.map(() => []);
  for (const r of rows) {
    if (r.orderDay !== null && r.orderDay >= g.start && r.orderDay <= g.end) {
      const p = pts[r.orderDay - g.start];
      p.orders++;
      if (r.dispatched) { p.dispatched++; const h = orderToDispatchHrs(r); if (h !== null) o2d[r.orderDay - g.start].push(h); }
    }
    if (r.channel !== null && MP.has(r.channel) && inDueRange(r, g)) {
      const p = pts[Math.floor(r.dueDay! / DAY) - g.start];
      p.due++;
      if (r.status3pm === "On Time") p.onTime++; else if (r.status3pm === "Late") p.late++; else if (r.status3pm === "Pending") p.pending++;
    }
  }
  pts.forEach((p, i) => { p.onTimeRate = rate(p.onTime, p.due); p.medianO2D = median(o2d[i]); });
  return pts;
}

export type ChannelRow = Kpis & { channel: string; is3pm: boolean; isAzfk: boolean };

export function byChannel(rows: Computed[], g: Range): ChannelRow[] {
  const groups = new Map<string, Computed[]>();
  for (const r of rows) {
    const k = r.channel ?? `Unmapped: ${r.channelName}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  return [...groups].map(([channel, rs]) => ({ channel, is3pm: MP.has(channel), isAzfk: channel === "Amazon" || channel === "Flipkart", ...kpis(rs, g) }))
    .filter((c) => c.orders > 0 || c.due3pm > 0)
    .sort((a, b) => b.orders - a.orders);
}

export type MatrixCell = { due: number; onTime: number; late: number; pending: number; rate: number | null };
export type Matrix = { channels: string[]; facilities: string[]; cell: (ch: string, fa: string) => MatrixCell | undefined; facilityTotal: (fa: string) => MatrixCell; channelTotal: (ch: string) => MatrixCell };

/** 3 PM on-time by channel × facility, for due days in range (marketplaces only). */
export function onTimeMatrix(rows: Computed[], g: Range): Matrix {
  const cells = new Map<string, MatrixCell>();
  const add = (key: string, r: Computed) => {
    const c = cells.get(key) ?? { due: 0, onTime: 0, late: 0, pending: 0, rate: null };
    c.due++;
    if (r.status3pm === "On Time") c.onTime++; else if (r.status3pm === "Late") c.late++; else if (r.status3pm === "Pending") c.pending++;
    cells.set(key, c);
  };
  const chs = new Set<string>(), fas = new Set<string>();
  for (const r of rows) {
    if (r.channel === null || !MP.has(r.channel) || !inDueRange(r, g)) continue;
    chs.add(r.channel); fas.add(r.facility);
    add(`${r.channel}\u0001${r.facility}`, r); add(`${r.channel}\u0001*`, r); add(`*\u0001${r.facility}`, r);
  }
  for (const c of cells.values()) c.rate = rate(c.onTime, c.due);
  const empty: MatrixCell = { due: 0, onTime: 0, late: 0, pending: 0, rate: null };
  return {
    channels: MARKETPLACE_3PM.filter((c) => chs.has(c)),
    facilities: [...fas].sort(),
    cell: (ch, fa) => cells.get(`${ch}\u0001${fa}`),
    facilityTotal: (fa) => cells.get(`*\u0001${fa}`) ?? empty,
    channelTotal: (ch) => cells.get(`${ch}\u0001*`) ?? empty,
  };
}

export const AGE_BUCKETS = [
  { key: "0-1", label: "0–1 days", min: 0, max: 1 },
  { key: "2-3", label: "2–3 days", min: 2, max: 3 },
  { key: "4-7", label: "4–7 days", min: 4, max: 7 },
  { key: "8+", label: "8+ days", min: 8, max: Infinity },
] as const;
export type AgeKey = (typeof AGE_BUCKETS)[number]["key"];
export const ageBucket = (age: number | null): AgeKey => (AGE_BUCKETS.find((b) => (age ?? 0) >= b.min && (age ?? 0) <= b.max) ?? AGE_BUCKETS[0]).key;

export type AgingRow = { facility: string; total: number } & Record<AgeKey, number>;
export function pendingAging(pending: PendingRow[]): AgingRow[] {
  const m = new Map<string, AgingRow>();
  for (const p of pending) {
    const r = m.get(p.facility) ?? { facility: p.facility, total: 0, "0-1": 0, "2-3": 0, "4-7": 0, "8+": 0 };
    r[ageBucket(p.ageDays)]++; r.total++;
    m.set(p.facility, r);
  }
  return [...m.values()].sort((a, b) => b.total - a.total);
}

/** Previous period of equal length, if it lies inside [minDay, ∞). */
export function priorRange(g: Range, minDay: number): Range | null {
  const len = g.end - g.start + 1;
  const p = { start: g.start - len, end: g.start - 1 };
  return p.start >= minDay ? p : null;
}
