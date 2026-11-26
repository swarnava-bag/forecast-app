/**
 * Fulfillment TAT engine — pure (no DOM / network). A line-for-line port of the
 * "Fulfillment Dashboard" workbook:
 *
 *   Base!EM..FC  → computeOrder()      (per-order calculated columns)
 *   Dashboard    → buildDashboard()    (MTD + daily, 4 sections)
 *   Pending      → buildPending()
 *
 * Time is held as integer SECONDS on a naive (timezone-less) clock, so
 * "2026-11-02 15:00:00" means exactly that wall-clock time, like an Excel
 * serial. day(x) = floor(x / 86400) mirrors INT().
 *
 * Only the first active line of each order matters to every dashboard figure
 * (Base!EO "Order Flag" = 1), so uploads are reduced to one OrderRow per order
 * by extractOrders() in ./parse.ts and everything here works on those.
 */

export const DAY = 86400;

/** One order = its first active (not cancelled / not alternate-accepted) line. */
export type OrderRow = {
  orderCode: string; // Display Order Code
  itemCode: string; // Sale Order Item Code of that line
  channelName: string; // Unicommerce Channel Name
  facility: string;
  orderDate: number | null; // seconds
  dispatchDate: number | null;
  fulfillmentDue: number | null; // Unicommerce "Fulfillment TAT" (a due datetime)
  saleOrderStatus: string;
  itemStatus: string;
  packageStatus: string;
  onHold: boolean;
  // reference-only fields (download / drill-down)
  sku: string;
  skuName: string;
  shippingProvider: string;
  trackingNumber: string;
  invoiceCreated: number | null;
  state: string;
  city: string;
  pincode: string;
  sellingPrice: number | null;
  lines: number; // active lines in the order
};

export type ChannelMapRow = { channelName: string; l1: string; l2: string };
export type ClosedDay = { date: string; warehouse: string | null; remarks: string }; // date YYYY-MM-DD
export type CredSla = { date: string; hours: number };
export type ReasonRow = { statusKey: string; reason: string };

export type FulfillmentConfig = {
  channelMap: ChannelMapRow[];
  closedDays: ClosedDay[];
  credSla: CredSla[];
  reasons: ReasonRow[];
  cutoff: string; // "HH:MM" (Dashboard!C5), default 15:00
  credDefaultHours: number | null; // Dashboard!C6 (blank = not tracked)
};

export const AZFK = new Set(["Amazon", "Flipkart"]);
export const DEFAULT_REASON = "Not dispatched – check in Uniware";

/** Base!EM..FC for one order. Strings mirror the sheet's outputs. */
export type Computed = OrderRow & {
  channel: string | null; // L1 (null = channel name not in mapper)
  l2: string | null;
  orderDay: number | null; // EP, day number
  dispatched: boolean; // EQ
  dueDay: number | null; // ER (seconds; may carry a time for non-AZ/FK before cutoff)
  fullTat: number | null; // ES hrs
  dispatchTat: number | null; // ET hrs
  procTat: number | "NA" | null; // EU hrs
  webProcTat: number | "NA" | null; // EV hrs
  azfkSla: "Cancelled" | "NA" | "Met" | "Breached" | "Pending"; // EW
  status3pm: "Cancelled" | "On Time" | "Late" | "Pending"; // EX
  cred72: "Cancelled" | "NA" | "Within" | "Beyond" | "Pending"; // EY
  credSlaHrs: number | null; // EZ
  effOrderDate: number | null; // FB seconds
  effDue: number | null; // FC seconds (AZ/FK only)
};

// ── date helpers ─────────────────────────────────────────────────────────────
const pad = (n: number) => String(n).padStart(2, "0");

/** Parse "YYYY-MM-DD[ HH:MM[:SS]]", "DD/MM/YYYY[ HH:MM[:SS]]" or an Excel serial → seconds. */
export function parseDateTime(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? excelSerialToSec(v) : null;
  const s = v.trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) / 1000;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) / 1000;
  if (/^\d+(\.\d+)?$/.test(s)) return excelSerialToSec(Number(s));
  return null;
}
function excelSerialToSec(serial: number): number {
  // Excel day 25569 = 1970-01-01; round to whole seconds
  return Math.round((serial - 25569) * DAY);
}
export const dayOf = (sec: number) => Math.floor(sec / DAY);
export const dayToIso = (d: number) => {
  const t = new Date(d * DAY * 1000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};
export const isoToDay = (iso: string) => {
  const s = parseDateTime(iso);
  return s === null ? null : dayOf(s);
};
export function fmtDateTime(sec: number | null): string {
  if (sec === null) return "";
  const t = new Date(sec * 1000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`;
}
export const monthStartDay = (d: number) => {
  const t = new Date(d * DAY * 1000);
  return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1) / 1000 / DAY;
};
export const monthKeyOfDay = (d: number) => dayToIso(d).slice(0, 7);

const norm = (s: string) => s.trim().toLowerCase();
const isCancelled = (o: OrderRow) => o.saleOrderStatus === "CANCELLED" || o.itemStatus === "CANCELLED";

// ── config preparation ───────────────────────────────────────────────────────
export type PreparedConfig = {
  channel: Map<string, ChannelMapRow>;
  /** closed days applying to a facility (all-warehouse + that facility) */
  closedFor: (facility: string) => Set<number>;
  credSla: Map<number, number>;
  credDefault: number | null;
  cutoffSec: number;
  reasons: Map<string, string>;
};

export function prepareConfig(cfg: FulfillmentConfig): PreparedConfig {
  const channel = new Map(cfg.channelMap.map((r) => [r.channelName, r]));
  const all = new Set<number>();
  const byWh = new Map<string, Set<number>>();
  for (const c of cfg.closedDays) {
    const d = isoToDay(c.date);
    if (d === null) continue;
    const wh = c.warehouse?.trim();
    if (!wh) all.add(d);
    else {
      const k = norm(wh);
      if (!byWh.has(k)) byWh.set(k, new Set());
      byWh.get(k)!.add(d);
    }
  }
  const cache = new Map<string, Set<number>>();
  const closedFor = (facility: string) => {
    const k = norm(facility);
    let s = cache.get(k);
    if (!s) {
      s = new Set([...all, ...(byWh.get(k) ?? [])]);
      cache.set(k, s);
    }
    return s;
  };
  const credSla = new Map<number, number>();
  for (const r of cfg.credSla) {
    const d = isoToDay(r.date);
    if (d !== null && Number.isFinite(r.hours)) credSla.set(d, r.hours);
  }
  const [hh, mm] = (cfg.cutoff || "15:00").split(":").map(Number);
  return {
    channel,
    closedFor,
    credSla,
    credDefault: cfg.credDefaultHours,
    cutoffSec: (hh || 0) * 3600 + (mm || 0) * 60,
    reasons: new Map(cfg.reasons.map((r) => [r.statusKey, r.reason])),
  };
}

/** WORKDAY.INTL(day, 1, "0000000", closed): the next day after `day` not closed. */
function nextOpenDay(day: number, closed: Set<number>): number {
  let d = day + 1;
  while (closed.has(d)) d++;
  return d;
}
const countClosed = (closed: Set<number>, from: number, to: number, inclusiveFrom: boolean) => {
  let n = 0;
  for (const d of closed) if ((inclusiveFrom ? d >= from : d > from) && d <= to) n++;
  return n;
};

// ── Base!EM..FC ──────────────────────────────────────────────────────────────
export function computeOrder(o: OrderRow, pc: PreparedConfig): Computed {
  const map = pc.channel.get(o.channelName);
  const channel = map ? map.l1 : null;
  const l2 = map ? map.l2 : null;
  const azfk = channel !== null && AZFK.has(channel);
  const h = pc.closedFor(o.facility);
  const cancelled = isCancelled(o);
  const CF = o.orderDate, DA = o.dispatchDate, DR = o.fulfillmentDue;
  const dispatched = DA !== null; // EQ

  // FB — order date shifted to next open day if the WH was closed that day
  let FB: number | null = null;
  if (CF !== null) FB = h.has(dayOf(CF)) ? nextOpenDay(dayOf(CF), h) * DAY : CF;

  // FC — AZ/FK fulfillment due + 1 day per WH-closed day in [INT(CF), INT(DR)]
  let FC: number | null = null;
  if (azfk && DR !== null && CF !== null) FC = DR + countClosed(h, dayOf(CF), dayOf(DR), true) * DAY;

  // ER — 3 PM due day
  let ER: number | null = null;
  if (azfk) ER = FC !== null ? dayOf(FC) * DAY : null;
  else if (FB !== null) ER = FB - dayOf(FB) * DAY >= pc.cutoffSec ? nextOpenDay(dayOf(FB), h) * DAY : FB;

  const hrs = (a: number, b: number) => (a - b) / 3600;
  // ES / ET / EU / EV
  let fullTat: number | null = null, dispatchTat: number | null = null;
  let procTat: number | "NA" | null = null, webProcTat: number | "NA" | null = null;
  if (azfk) {
    fullTat = DR !== null && CF !== null ? hrs(DR, CF) : null;
    if (dispatched && FC !== null) {
      dispatchTat = Math.max(0, hrs(DA!, FC));
      procTat = hrs(FC, DA!);
    }
    webProcTat = "NA";
  } else {
    if (dispatched && ER !== null) {
      fullTat = hrs(DA!, ER);
      dispatchTat = Math.max(0, hrs(DA!, ER));
      webProcTat = hrs(DA!, ER);
    }
    procTat = "NA";
  }

  // EW — AZ/FK SLA status
  const azfkSla: Computed["azfkSla"] = cancelled ? "Cancelled" : !azfk ? "NA"
    : dispatched ? (FC !== null && DA! <= FC ? "Met" : "Breached") : "Pending";
  // EX — 3 PM status
  const status3pm: Computed["status3pm"] = cancelled ? "Cancelled"
    : dispatched ? (ER !== null && dayOf(DA!) * DAY <= ER ? "On Time" : "Late") : "Pending";
  // EZ — CRED SLA hours (by effective order day, else default)
  const credSlaHrs = FB !== null ? pc.credSla.get(dayOf(FB)) ?? pc.credDefault : pc.credDefault;
  // EY — CRED status
  let cred72: Computed["cred72"];
  if (cancelled) cred72 = "Cancelled";
  else if (credSlaHrs === null || credSlaHrs === undefined) cred72 = "NA";
  else if (!dispatched || FB === null) cred72 = dispatched ? "Beyond" : "Pending";
  else {
    const net = hrs(DA!, FB) - 24 * countClosed(h, dayOf(FB), dayOf(DA!), false);
    cred72 = net <= credSlaHrs ? "Within" : "Beyond";
  }

  return {
    ...o, channel, l2,
    orderDay: FB !== null ? dayOf(FB) : null,
    dispatched, dueDay: ER, fullTat, dispatchTat, procTat, webProcTat,
    azfkSla, status3pm, cred72, credSlaHrs: credSlaHrs ?? null,
    effOrderDate: FB, effDue: FC,
  };
}

export const computeAll = (orders: OrderRow[], cfg: FulfillmentConfig) => {
  const pc = prepareConfig(cfg);
  return orders.map((o) => computeOrder(o, pc));
};

// ── Dashboard ────────────────────────────────────────────────────────────────
/** Channels in the 3 PM section, in sheet order. */
export const MARKETPLACE_3PM = ["JioMart", "Amazon", "Flipkart", "Meesho", "PopClub", "Smytten", "Hyugalife", "HealthKart", "Kindlife", "Pharmeasy"];

export type Cell = number | null; // null = "-" (no data)
export type MetricRow = { channel: string; metric: string; kind: "count" | "pct" | "hrs"; mtd: Cell; days: Cell[] };
export type Section = { key: string; title: string; note: string; rows: MetricRow[] };
export type Dashboard = { startDay: number; endDay: number; days: number[]; sections: Section[]; unmapped: { channelName: string; orders: number }[]; missingOrderDate: number };

/** Report window: Dashboard!C3 = MIN(TODAY, max order day); C4 = month start. */
export function reportWindow(orders: { orderDate: number | null }[], todayDay: number, monthKey?: string) {
  let max = -Infinity;
  for (const o of orders) if (o.orderDate !== null) max = Math.max(max, dayOf(o.orderDate));
  let end = Number.isFinite(max) ? Math.min(todayDay, max) : todayDay;
  if (monthKey) {
    // a past month: clamp to that month's last day
    const first = isoToDay(`${monthKey}-01`)!;
    const nextFirst = isoToDay(dayToIso(first + 32).slice(0, 7) + "-01")!;
    if (end >= nextFirst || end < first) end = Math.min(nextFirst - 1, Math.max(first, end));
  }
  return { startDay: monthStartDay(end), endDay: end };
}

export function buildDashboard(rows: Computed[], startDay: number, endDay: number): Dashboard {
  const days: number[] = [];
  for (let d = startDay; d <= endDay; d++) days.push(d);
  const flag = rows; // already one row per order (EO = 1)

  const byOrderDay = (ch: string, d: number | null, extra?: (r: Computed) => boolean) =>
    flag.filter((r) => r.channel === ch && r.orderDay !== null && (d === null ? r.orderDay >= startDay && r.orderDay <= endDay : r.orderDay === d) && (!extra || extra(r)));
  const byDueDay = (ch: string, d: number | null, extra?: (r: Computed) => boolean) =>
    flag.filter((r) => {
      if (r.channel !== ch || r.dueDay === null) return false;
      const lo = (d === null ? startDay : d) * DAY, hi = ((d === null ? endDay : d) + 1) * DAY;
      return r.dueDay >= lo && r.dueDay < hi && (!extra || extra(r));
    });
  const avg = (rs: Computed[], f: (r: Computed) => number | "NA" | null): Cell => {
    let s = 0, n = 0;
    for (const r of rs) { const v = f(r); if (typeof v === "number") { s += v; n++; } }
    return n ? s / n : null;
  };
  const ratio = (a: Cell, b: Cell): Cell => (a !== null && b ? a / b : null);

  const countRow = (channel: string, metric: string, sel: (ch: string, d: number | null) => Computed[]): MetricRow =>
    ({ channel, metric, kind: "count", mtd: sel(channel, null).length, days: days.map((d) => sel(channel, d).length) });
  const avgRow = (channel: string, metric: string, f: (r: Computed) => number | "NA" | null): MetricRow =>
    ({ channel, metric, kind: "hrs", mtd: avg(byOrderDay(channel, null), f), days: days.map((d) => avg(byOrderDay(channel, d), f)) });
  const pctRow = (channel: string, metric: string, num: MetricRow, a: MetricRow, b?: MetricRow): MetricRow => ({
    channel, metric, kind: "pct",
    mtd: b ? ratio(num.mtd, (a.mtd ?? 0) + (b.mtd ?? 0)) : ratio(num.mtd, a.mtd),
    days: days.map((_, i) => (b ? ratio(num.days[i], (a.days[i] ?? 0) + (b.days[i] ?? 0)) : ratio(num.days[i], a.days[i]))),
  });
  const sumRow = (metric: string, rs: MetricRow[]): MetricRow => ({
    channel: "Total", metric, kind: "count",
    mtd: rs.reduce((s, r) => s + (r.mtd ?? 0), 0),
    days: days.map((_, i) => rs.reduce((s, r) => s + (r.days[i] ?? 0), 0)),
  });

  // 1. Amazon & Flipkart
  const s1: MetricRow[] = [];
  for (const ch of ["Amazon", "Flipkart"]) {
    const orders = countRow(ch, "Orders", (c, d) => byOrderDay(c, d));
    const disp = countRow(ch, "Dispatched", (c, d) => byOrderDay(c, d, (r) => r.dispatched));
    const met = countRow(ch, "SLA Met", (c, d) => byOrderDay(c, d, (r) => r.azfkSla === "Met"));
    const br = countRow(ch, "SLA Breached", (c, d) => byOrderDay(c, d, (r) => r.azfkSla === "Breached"));
    const pend = countRow(ch, "Pending Dispatch", (c, d) => byOrderDay(c, d, (r) => r.azfkSla === "Pending"));
    s1.push(orders, disp, met, br, pend, pctRow(ch, "SLA Met %", met, met, br),
      avgRow(ch, "Avg Fulfillment TAT (Hrs)", (r) => r.fullTat),
      avgRow(ch, "Avg Dispatch TAT (Hrs)", (r) => r.dispatchTat),
      avgRow(ch, "Avg Proc TAT (Hrs) = Full − Dispatch", (r) => r.procTat));
  }

  // 2. Marketplace 3 PM
  const due = MARKETPLACE_3PM.map((ch) => countRow(ch, "Orders Due", (c, d) => byDueDay(c, d)));
  const onTime = MARKETPLACE_3PM.map((ch) => countRow(ch, "On Time", (c, d) => byDueDay(c, d, (r) => r.status3pm === "On Time")));
  const late = MARKETPLACE_3PM.map((ch) => countRow(ch, "Late", (c, d) => byDueDay(c, d, (r) => r.status3pm === "Late")));
  const pend3 = MARKETPLACE_3PM.map((ch) => countRow(ch, "Pending", (c, d) => byDueDay(c, d, (r) => r.status3pm === "Pending")));
  const dueT = sumRow("Orders Due", due), onT = sumRow("On Time", onTime), lateT = sumRow("Late", late), pendT = sumRow("Pending", pend3);
  const pct3 = [...MARKETPLACE_3PM.map((ch, i) => pctRow(ch, "On-Time %", onTime[i], due[i])), pctRow("Total", "On-Time %", onT, dueT)];

  // 3. CRED
  const cOrders = countRow("CRED", "Orders", (c, d) => byOrderDay(c, d));
  const cWithin = countRow("CRED", "Dispatched ≤ SLA Hrs", (c, d) => byOrderDay(c, d, (r) => r.cred72 === "Within"));
  const cBeyond = countRow("CRED", "Dispatched > SLA Hrs", (c, d) => byOrderDay(c, d, (r) => r.cred72 === "Beyond"));
  const cPend = countRow("CRED", "Pending Dispatch", (c, d) => byOrderDay(c, d, (r) => r.cred72 === "Pending"));

  // 4. Website
  const wOrders = countRow("Website", "Orders", (c, d) => byOrderDay(c, d));
  const wDisp = countRow("Website", "Dispatched", (c, d) => byOrderDay(c, d, (r) => r.dispatched));
  const wPend = countRow("Website", "Pending Dispatch", (c, d) => byOrderDay(c, d, (r) => !r.dispatched));

  const unmappedCount = new Map<string, number>();
  let missingOrderDate = 0;
  for (const r of rows) {
    if (r.channel === null) unmappedCount.set(r.channelName, (unmappedCount.get(r.channelName) ?? 0) + 1);
    if (r.orderDate === null) missingOrderDate++;
  }

  return {
    startDay, endDay, days, missingOrderDate,
    unmapped: [...unmappedCount].map(([channelName, orders]) => ({ channelName, orders })).sort((a, b) => b.orders - a.orders),
    sections: [
      { key: "azfk", title: "1. Amazon & Flipkart – Fulfillment, Dispatch & Processing TAT", note: "By order date", rows: s1 },
      { key: "due", title: "2a. Marketplace 3 PM – Orders Due", note: "By due day: orders 3 PM D-1 to 3 PM D must dispatch on D", rows: [...due, dueT] },
      { key: "ontime", title: "2b. Dispatched On Time", note: "By due day", rows: [...onTime, onT] },
      { key: "late", title: "2c. Dispatched Late", note: "By due day", rows: [...late, lateT] },
      { key: "pending3pm", title: "2d. Pending Dispatch", note: "By due day", rows: [...pend3, pendT] },
      { key: "pct3pm", title: "2e. On-Time %", note: "On time ÷ orders due", rows: pct3 },
      {
        key: "cred", title: "3. CRED – SLA Dispatch", note: "Dispatch − order date; SLA hrs per order date (NA = not tracked)",
        rows: [cOrders, cWithin, cBeyond, cPend, pctRow("CRED", "Within SLA %", cWithin, cWithin, cBeyond), avgRow("CRED", "Avg Dispatch TAT (Hrs)", (r) => r.dispatchTat)],
      },
      {
        key: "web", title: "4. Website – Processing & Dispatch TAT", note: "By order date",
        rows: [wOrders, wDisp, wPend, avgRow("Website", "Avg Processing TAT (Hrs)", (r) => r.webProcTat), avgRow("Website", "Avg Dispatch TAT (Hrs)", (r) => r.dispatchTat)],
      },
    ],
  };
}

// ── Pending Orders ───────────────────────────────────────────────────────────
export type PendingRow = {
  orderCode: string; orderDate: number | null; dueDay: number | null; facility: string; channel: string;
  saleOrderStatus: string; itemStatus: string; packageStatus: string; reason: string; statusKey: string; ageDays: number | null;
};

export function buildPending(rows: Computed[], startDay: number, endDay: number, reasons: Map<string, string>): PendingRow[] {
  const out: PendingRow[] = [];
  for (const r of rows) {
    if (r.status3pm !== "Pending") continue;
    const inOrder = r.orderDay !== null && r.orderDay >= startDay && r.orderDay <= endDay;
    const inDue = r.dueDay !== null && r.dueDay >= startDay * DAY && r.dueDay < (endDay + 1) * DAY;
    if (!inOrder && !inDue) continue;
    const statusKey = r.onHold ? "ON_HOLD" : r.packageStatus ? r.packageStatus : r.itemStatus;
    out.push({
      orderCode: r.orderCode, orderDate: r.orderDate, dueDay: r.dueDay, facility: r.facility, channel: r.channel ?? `Unmapped: ${r.channelName}`,
      saleOrderStatus: r.saleOrderStatus, itemStatus: r.itemStatus, packageStatus: r.packageStatus,
      statusKey, reason: reasons.get(statusKey) ?? DEFAULT_REASON,
      ageDays: r.orderDate !== null ? endDay + 1 - dayOf(r.orderDate) : null,
    });
  }
  return out.sort((a, b) => (a.orderDate ?? 0) - (b.orderDate ?? 0));
}
