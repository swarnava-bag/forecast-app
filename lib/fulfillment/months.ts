/**
 * Month segregation for uploads — pure.
 *
 * Rule: an upload REPLACES the order dates it covers and KEEPS everything else.
 *   • a month is COVERED by an upload when the upload has real volume there
 *     (orders per active day ≥ COVER_SHARE of the busiest month in the file).
 *     Unicommerce exports also carry a trickle of older orders still being
 *     processed (e.g. ~150 October orders inside a November file) — those
 *     never create or overwrite a month.
 *   • covered days = first → last order day of the upload inside covered months
 *   • every touched month is rebuilt as
 *       stored orders outside the covered days  ∪  uploaded orders relevant to it
 *   so a month-to-date file replaces the month, a partial file only its days,
 *   and a past month (backfill) is simply created.
 *
 * An order is RELEVANT to month M — and kept in M's snapshot — when its order
 * date or its marketplace due date (Fulfillment TAT) falls in M or in the TAIL
 * of days before it: an order placed 30 Nov after 3 PM is due 1 Dec, and an
 * older Flipkart order due in November counts in November's 3 PM numbers. The
 * dashboard counts each order only where it belongs (order-day metrics by order
 * day, 3 PM metrics by due day), so carrying extra orders never double-counts.
 */
import { DAY, dayOf, isoToDay, dayToIso, type OrderRow } from "./engine";

export const TAIL_DAYS = 10;
/** a month counts as covered when its orders/active-day ≥ this share of the busiest month in the upload */
export const COVER_SHARE = 0.1;

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

/** Days an upload replaces: first → last order day inside the months it really covers. */
export type UploadSpan = { first: number; last: number; covered: string[]; stray: { monthKey: string; orders: number }[] };

export function uploadSpan(orders: OrderRow[]): UploadSpan | null {
  const per = new Map<string, { n: number; days: Set<number>; first: number; last: number }>();
  for (const o of orders) {
    if (o.orderDate === null) continue;
    const d = dayOf(o.orderDate), k = monthKeyOf(d);
    const m = per.get(k) ?? { n: 0, days: new Set<number>(), first: d, last: d };
    m.n++; m.days.add(d); m.first = Math.min(m.first, d); m.last = Math.max(m.last, d);
    per.set(k, m);
  }
  if (!per.size) return null;
  const density = (m: { n: number; days: Set<number> }) => m.n / m.days.size;
  const top = Math.max(...[...per.values()].map(density));
  const covered = [...per.keys()].filter((k) => density(per.get(k)!) >= COVER_SHARE * top).sort();
  const stray = [...per.keys()].filter((k) => !covered.includes(k)).sort().map((k) => ({ monthKey: k, orders: per.get(k)!.n }));
  return {
    first: Math.min(...covered.map((k) => per.get(k)!.first)),
    last: Math.max(...covered.map((k) => per.get(k)!.last)),
    covered, stray,
  };
}

/** Months whose snapshot changes: every covered month (and any month between),
 *  plus the next month if it already exists and its tail overlaps the upload. */
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

/** Is the order relevant to month M (placed, or marketplace-due, in M or its tail)? */
function relevant(o: OrderRow, fallbackDay: number, m: { start: number; end: number }) {
  const lo = m.start - TAIL_DAYS;
  const d = fileDay(o, fallbackDay);
  if (d >= lo && d <= m.end) return true;
  if (o.fulfillmentDue !== null) { const due = dayOf(o.fulfillmentDue); if (due >= lo && due <= m.end) return true; }
  return false;
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
    const m = monthBounds(key);
    const { start, end } = m;
    const byCode = new Map<string, OrderRow>();
    let kept = 0, fromUpload = 0;

    // stored orders outside the uploaded days (this month's snapshot first, then the previous month's for the tail)
    for (const src of [stored.get(key), stored.get(prevMonthKey(key))]) {
      for (const o of src ?? []) {
        const d = fileDay(o, end);
        if (!relevant(o, end, m) || inUpload(d) || byCode.has(o.orderCode)) continue;
        byCode.set(o.orderCode, o);
        if (d >= start && d <= end) kept++;
      }
    }
    // uploaded orders relevant to this month (placed or due in it, or its tail) — they win
    for (const o of upload) {
      if (!relevant(o, span.last, m)) continue;
      const d = fileDay(o, span.last);
      const had = byCode.get(o.orderCode);
      if (had) { const hd = fileDay(had, end); if (hd >= start && hd <= end) kept--; }
      byCode.set(o.orderCode, o);
      if (d >= start && d <= end) fromUpload++;
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
