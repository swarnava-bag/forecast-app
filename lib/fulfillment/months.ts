/**
 * Month segregation for uploads — pure.
 *
 * Rule: an upload REPLACES the order dates it covers and KEEPS everything else.
 *   • upload covers [a, b] (first → last raw order day in the files)
 *   • every month the upload touches is rebuilt as
 *       stored orders of that month outside [a, b]  ∪  uploaded orders inside it
 *   so a month-to-date file replaces the month, a partial file only its days,
 *   and a past month (backfill) is simply created.
 *
 * Each month snapshot also carries a TAIL of the previous month's last days:
 * an order placed 30 Nov after 3 PM is due 1 Dec and belongs to December's
 * 3 PM numbers. The dashboard counts each order only where it belongs (order-day
 * metrics by order day, 3 PM metrics by due day), so the tail never double-counts.
 */
import { DAY, dayOf, isoToDay, dayToIso, type OrderRow } from "./engine";

export const TAIL_DAYS = 10;

export const monthKeyOf = (day: number) => dayToIso(day).slice(0, 7);
export function monthBounds(key: string): { start: number; end: number } {
  const start = isoToDay(`${key}-01`)!;
  const next = isoToDay(dayToIso(start + 32).slice(0, 7) + "-01")!;
  return { start, end: next - 1 };
}
export const prevMonthKey = (key: string) => monthKeyOf(monthBounds(key).start - 1);
export const nextMonthKey = (key: string) => monthKeyOf(monthBounds(key).end + 1);

/** Day an order is filed under (raw order date). Orders without a date are filed on the upload's last day. */
const fileDay = (o: OrderRow, fallback: number) => (o.orderDate === null ? fallback : dayOf(o.orderDate));

export type UploadSpan = { first: number; last: number };
export function uploadSpan(orders: OrderRow[]): UploadSpan | null {
  let first = Infinity, last = -Infinity;
  for (const o of orders) if (o.orderDate !== null) { const d = dayOf(o.orderDate); if (d < first) first = d; if (d > last) last = d; }
  return Number.isFinite(first) ? { first, last } : null;
}

/** Months whose snapshot changes: every month in [first, last], plus the next
 *  month if it already exists and its tail overlaps the upload. */
export function touchedMonths(span: UploadSpan, existing: string[]): string[] {
  const out: string[] = [];
  for (let k = monthKeyOf(span.first); ; k = nextMonthKey(k)) {
    out.push(k);
    if (k === monthKeyOf(span.last)) break;
  }
  const after = nextMonthKey(out[out.length - 1]);
  if (existing.includes(after) && span.last >= monthBounds(after).start - TAIL_DAYS) out.push(after);
  return out;
}

/** Months whose stored orders are needed to plan: each touched month and the one before it. */
export function monthsToLoad(touched: string[], existing: string[]): string[] {
  const need = new Set<string>();
  for (const k of touched) { need.add(k); need.add(prevMonthKey(k)); }
  return [...need].filter((k) => existing.includes(k));
}

export type MonthPlan = {
  monthKey: string;
  orders: OrderRow[];
  isNew: boolean;
  fromUpload: number; // orders in the month proper taken from this upload
  kept: number; // orders in the month proper kept from what was stored
  replacedDays: { first: number; last: number } | null; // upload days within the month proper
};

/**
 * Build every touched month's new snapshot.
 * @param stored month → orders currently stored (need: touched months + their previous months)
 */
export function planMonths(upload: OrderRow[], stored: Map<string, OrderRow[]>, existing: string[]): MonthPlan[] {
  const span = uploadSpan(upload);
  if (!span) return [];
  const inUpload = (d: number) => d >= span.first && d <= span.last;
  const plans: MonthPlan[] = [];

  for (const key of touchedMonths(span, existing)) {
    const { start, end } = monthBounds(key);
    const lo = start - TAIL_DAYS;
    const byCode = new Map<string, OrderRow>();
    let kept = 0, fromUpload = 0;

    // stored orders outside the uploaded days (this month's snapshot first, then the previous month's for the tail)
    for (const src of [stored.get(key), stored.get(prevMonthKey(key))]) {
      for (const o of src ?? []) {
        const d = fileDay(o, end);
        if (d < lo || d > end || inUpload(d) || byCode.has(o.orderCode)) continue;
        byCode.set(o.orderCode, o);
        if (d >= start) kept++;
      }
    }
    // uploaded orders for this month (+ tail) — they win
    for (const o of upload) {
      const d = fileDay(o, span.last);
      if (d < lo || d > end) continue;
      const had = byCode.get(o.orderCode);
      if (had && fileDay(had, end) >= start) kept--;
      byCode.set(o.orderCode, o);
      if (d >= start) fromUpload++;
    }

    const rFirst = Math.max(start, span.first), rLast = Math.min(end, span.last);
    plans.push({
      monthKey: key,
      orders: [...byCode.values()].sort((a, b) => (a.orderDate ?? 0) - (b.orderDate ?? 0)),
      isNew: !existing.includes(key),
      fromUpload, kept,
      replacedDays: rFirst <= rLast ? { first: rFirst, last: rLast } : null,
    });
  }
  return plans;
}

/** Orders that belong to a month's views: placed in the month, or due in it. */
export const inMonth = (orderDay: number | null, dueSec: number | null, m: { start: number; end: number }) =>
  (orderDay !== null && orderDay >= m.start && orderDay <= m.end) ||
  (dueSec !== null && dueSec >= m.start * DAY && dueSec < (m.end + 1) * DAY);
