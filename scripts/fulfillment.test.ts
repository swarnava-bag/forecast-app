/**
 * Fulfillment engine tests — synthetic orders covering the workbook rules.
 * (Validated separately against the Nov-26 workbook: 49,670 orders, 2,016
 *  dashboard cells and 535 pending orders all matched.)   npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { computeAll, buildDashboard, buildPending, parseDateTime, prepareConfig, dayOf, fmtDateTime, isoToDay, reportWindow, type OrderRow, type FulfillmentConfig } from "../lib/fulfillment/engine";
import { csvToTable, extractOrders } from "../lib/fulfillment/parse";
import { kpis, daily, applyScope, pendingAging, priorRange, median } from "../lib/fulfillment/analytics";

const cfg: FulfillmentConfig = {
  cutoff: "15:00",
  credDefaultHours: null,
  channelMap: [
    { channelName: "AMAZON_X", l1: "Amazon", l2: "AZ" },
    { channelName: "WEB", l1: "Website", l2: "Website" },
    { channelName: "JIO", l1: "JioMart", l2: "Jio" },
    { channelName: "CRED", l1: "CRED", l2: "CRED" },
  ],
  closedDays: [{ date: "2026-11-08", warehouse: null, remarks: "Diwali" }, { date: "2026-11-10", warehouse: "WH2", remarks: "WH2 only" }],
  credSla: [{ date: "2026-11-03", hours: 72 }],
  reasons: [{ statusKey: "PICKED", reason: "Picked" }, { statusKey: "ON_HOLD", reason: "On hold" }],
};

const base: OrderRow = {
  orderCode: "O", itemCode: "O-1", channelName: "WEB", facility: "WH1", orderDate: null, dispatchDate: null, fulfillmentDue: null,
  saleOrderStatus: "PROCESSING", itemStatus: "FULFILLABLE", packageStatus: "", onHold: false, sku: "", skuName: "", shippingProvider: "",
  trackingNumber: "", invoiceCreated: null, state: "", city: "", pincode: "", sellingPrice: null, lines: 1,
};
const o = (p: Partial<OrderRow> & { od?: string; dd?: string; due?: string }): OrderRow => ({
  ...base, ...p, orderDate: p.od ? parseDateTime(p.od) : null, dispatchDate: p.dd ? parseDateTime(p.dd) : null, fulfillmentDue: p.due ? parseDateTime(p.due) : null,
});

test("parseDateTime handles ISO, dd/mm/yyyy, Excel serial and blanks", () => {
  assert.equal(fmtDateTime(parseDateTime("2026-11-02 17:26:11")), "2026-11-02 17:26:11");
  assert.equal(fmtDateTime(parseDateTime("2026-11-02T17:26:11")), "2026-11-02 17:26:11");
  assert.equal(fmtDateTime(parseDateTime("02/11/2026 17:26:11")), "2026-11-02 17:26:11");
  assert.equal(fmtDateTime(parseDateTime(46328.5)), "2026-11-02 12:00:00");
  assert.equal(parseDateTime(""), null);
});

test("non-marketplace: before cutoff due same day, after cutoff due next open day", () => {
  const [a, b] = computeAll([o({ orderCode: "A", od: "2026-11-03 11:00:00", dd: "2026-11-03 18:00:00" }), o({ orderCode: "B", od: "2026-11-03 15:00:00", dd: "2026-11-05 10:00:00" })], cfg);
  assert.equal(fmtDateTime(a.dueDay), "2026-11-03 11:00:00"); // ER keeps the time
  assert.equal(a.status3pm, "On Time");
  assert.equal(a.webProcTat, 7);
  assert.equal(fmtDateTime(b.dueDay), "2026-11-04 00:00:00");
  assert.equal(b.status3pm, "Late");
});

test("closed day: order shifts to next open day; due skips closed days; per-warehouse closures", () => {
  const [a, b, c] = computeAll([
    o({ orderCode: "A", od: "2026-11-08 10:00:00" }), // Diwali (all WH) → effective 9th 00:00
    o({ orderCode: "B", od: "2026-11-09 16:00:00", facility: "WH2" }), // after cutoff → 10th closed for WH2 → 11th
    o({ orderCode: "C", od: "2026-11-09 16:00:00", facility: "WH1" }), // WH1 open on 10th
  ], cfg);
  assert.equal(fmtDateTime(a.effOrderDate), "2026-11-09 00:00:00");
  assert.equal(a.orderDay, isoToDay("2026-11-09"));
  assert.equal(fmtDateTime(b.dueDay), "2026-11-11 00:00:00");
  assert.equal(fmtDateTime(c.dueDay), "2026-11-10 00:00:00");
});

test("Amazon: due = Fulfillment TAT + closed days in window; SLA met/breached; TATs", () => {
  const [met, br, pend] = computeAll([
    o({ orderCode: "M", channelName: "AMAZON_X", od: "2026-11-07 10:00:00", due: "2026-11-08 14:00:00", dd: "2026-11-09 12:00:00" }),
    o({ orderCode: "B", channelName: "AMAZON_X", od: "2026-11-02 10:00:00", due: "2026-11-03 14:00:00", dd: "2026-11-03 20:00:00" }),
    o({ orderCode: "P", channelName: "AMAZON_X", od: "2026-11-02 10:00:00", due: "2026-11-03 14:00:00" }),
  ], cfg);
  assert.equal(fmtDateTime(met.effDue), "2026-11-09 14:00:00"); // +1 for Diwali
  assert.equal(met.azfkSla, "Met");
  assert.equal(met.procTat, 2);
  assert.equal(met.dispatchTat, 0);
  assert.equal(met.fullTat, 28);
  assert.equal(br.azfkSla, "Breached");
  assert.equal(br.dispatchTat, 6);
  assert.equal(pend.azfkSla, "Pending");
  assert.equal(pend.fullTat, 28); // AZ/FK full TAT even when not dispatched
  assert.equal(pend.procTat, null);
});

test("CRED: SLA hours by order day, closed days excluded; NA when untracked", () => {
  const [w, nt] = computeAll([
    o({ orderCode: "W", channelName: "CRED", od: "2026-11-03 10:00:00", dd: "2026-11-06 12:00:00" }), // 74h raw
    o({ orderCode: "N", channelName: "CRED", od: "2026-11-04 10:00:00", dd: "2026-11-05 12:00:00" }),
  ], { ...cfg, closedDays: [...cfg.closedDays, { date: "2026-11-05", warehouse: null, remarks: "" }] });
  assert.equal(w.credSlaHrs, 72);
  assert.equal(w.cred72, "Within"); // 74h − 24h closed = 50h
  assert.equal(nt.cred72, "NA");
});

test("extractOrders picks the first active line per order and counts lines", () => {
  const H = "Sale Order Item Code,Display Order Code,Channel Name,Facility,Order Date as dd/mm/yyyy hh:MM:ss,Dispatch Date,Fulfillment TAT,Sale Order Status,Sale Order Item Status,Shipping Package Status Code,On Hold";
  const csv = [H,
    "1-0,X,WEB,WH1,2026-11-03 10:00:00,,,PROCESSING,CANCELLED,,false",
    "1-1,X,WEB,WH1,2026-11-03 10:00:00,2026-11-03 18:00:00,,PROCESSING,DISPATCHED,DISPATCHED,false",
    "1-2,X,WEB,WH1,2026-11-03 10:00:00,2026-11-03 18:00:00,,PROCESSING,DISPATCHED,DISPATCHED,false",
    "2-0,Y,WEB,WH1,2026-11-03 10:00:00,,,CANCELLED,CANCELLED,,false",
    "3-0,`Z,JIO,WH1,2026-11-03 16:00:00,,,PROCESSING,FULFILLABLE,PICKED,TRUE",
  ].join("\n");
  const p = extractOrders([csvToTable("f.csv", csv)]);
  assert.equal(p.itemRows, 5);
  assert.equal(p.orders.length, 2);
  assert.equal(p.inactiveOrders, 1);
  assert.equal(p.orders[0].itemCode, "1-1");
  assert.equal(p.orders[0].lines, 2);
  assert.equal(p.orders[1].orderCode, "Z"); // backtick stripped
  assert.equal(p.orders[1].onHold, true);
});

test("dashboard + pending: counts by order day / due day, on-hold reason, window", () => {
  const orders = [
    o({ orderCode: "A", channelName: "JIO", od: "2026-11-03 10:00:00", dd: "2026-11-03 18:00:00" }),
    o({ orderCode: "B", channelName: "JIO", od: "2026-11-03 16:00:00", packageStatus: "PICKED" }),
    o({ orderCode: "C", channelName: "JIO", od: "2026-11-04 09:00:00", onHold: true }),
    o({ orderCode: "D", channelName: "UNKNOWN", od: "2026-11-04 09:00:00" }),
  ];
  const rows = computeAll(orders, cfg);
  const win = reportWindow(orders, dayOf(parseDateTime("2026-11-26")!));
  assert.equal(win.startDay, isoToDay("2026-11-01"));
  assert.equal(win.endDay, isoToDay("2026-11-04"));
  const d = buildDashboard(rows, win.startDay, win.endDay);
  const due = d.sections.find((s) => s.key === "due")!.rows.find((r) => r.channel === "JioMart")!;
  assert.equal(due.mtd, 3);
  assert.deepEqual(due.days, [0, 0, 1, 2]); // A due 3rd; B (after 3 PM) + C due 4th
  assert.deepEqual(d.unmapped, [{ channelName: "UNKNOWN", orders: 1 }]);
  const pend = buildPending(rows, win.startDay, win.endDay, prepareConfig(cfg).reasons);
  assert.deepEqual(pend.map((p) => [p.orderCode, p.reason]), [["B", "Picked"], ["C", "On hold"], ["D", "Not dispatched – check in Uniware"]]);
});

test("analytics: kpis, daily, scope, ageing and prior period", () => {
  const orders = [
    o({ orderCode: "A", channelName: "JIO", od: "2026-11-03 10:00:00", dd: "2026-11-03 18:00:00" }), // due 3rd, on time, 8h
    o({ orderCode: "B", channelName: "JIO", od: "2026-11-03 16:00:00", dd: "2026-11-05 10:00:00" }), // due 4th, late, 42h
    o({ orderCode: "C", channelName: "WEB", od: "2026-11-04 09:00:00", dd: "2026-11-04 19:00:00" }), // website: not in 3 PM
    o({ orderCode: "D", channelName: "AMAZON_X", od: "2026-11-04 09:00:00", due: "2026-11-05 14:00:00" }), // pending AZ
  ];
  const rows = computeAll(orders, cfg);
  const g = { start: isoToDay("2026-11-03")!, end: isoToDay("2026-11-05")! };
  const k = kpis(rows, g);
  assert.equal(k.orders, 4);
  assert.equal(k.dispatched, 3);
  assert.equal(k.due3pm, 3); // A (3rd), B (4th), D (AZ due 5th) — website excluded
  assert.equal(k.onTime, 1);
  assert.equal(k.late, 1);
  assert.equal(k.pending3pm, 1);
  assert.equal(k.medianO2D, 10); // 8h, 10h, 42h
  const d = daily(rows, g);
  assert.deepEqual(d.map((x) => x.due), [1, 1, 1]);
  assert.deepEqual(d.map((x) => x.orders), [2, 2, 0]);
  assert.equal(kpis(applyScope(rows, { channels: ["JioMart"], facilities: [] }), g).orders, 2);
  assert.equal(median([]), null);
  const pend = buildPending(rows, g.start, g.end, prepareConfig(cfg).reasons);
  assert.deepEqual(pendingAging(pend).map((a) => [a.facility, a.total]), [["WH1", 1]]);
  assert.deepEqual(priorRange({ start: 10, end: 16 }, 3), { start: 3, end: 9 });
  assert.equal(priorRange({ start: 5, end: 16 }, 3), null);
});

test("months: upload spanning months is segregated; partial uploads keep other days; tails carried", async () => {
  const { planMonths, touchedMonths, uploadSpan, monthsToLoad } = await import("../lib/fulfillment/months");
  const mk = (code: string, od: string) => o({ orderCode: code, od });
  // stored November: 1st..23rd
  const nov = [mk("N1", "2026-11-01 10:00:00"), mk("N15", "2026-11-15 10:00:00"), mk("N23", "2026-11-23 10:00:00"), mk("N25old", "2026-11-25 10:00:00")];
  const stored = new Map([["2026-11", nov]]);
  // upload: 20 Nov → 2 Dec (re-sends N23 with a dispatch, drops N25old as cancelled)
  const up = [o({ orderCode: "N23", od: "2026-11-23 10:00:00", dd: "2026-11-24 10:00:00" }), mk("N30", "2026-11-30 16:00:00"), mk("D2", "2026-12-02 09:00:00")];
  const span = uploadSpan(up)!;
  assert.deepEqual(touchedMonths(span, ["2026-11"]), ["2026-11", "2026-12"]);
  assert.deepEqual(monthsToLoad(["2026-11", "2026-12"], ["2026-11"]), ["2026-11"]);
  const [p11, p12] = planMonths(up, stored, ["2026-11"]);
  // November: 1st & 15th kept (outside uploaded days), 23rd & 30th from upload, N25old gone (inside uploaded days, not re-sent)
  assert.deepEqual(p11.orders.map((x) => x.orderCode), ["N1", "N15", "N23", "N30"]);
  assert.equal(p11.orders.find((x) => x.orderCode === "N23")!.dispatchDate !== null, true);
  assert.equal(p11.isNew, false);
  assert.equal(p11.kept, 2);
  assert.equal(p11.fromUpload, 2);
  // December: new; carries the November tail (last 10 days) so 30 Nov after-3 PM orders count as due 1 Dec
  assert.equal(p12.isNew, true);
  assert.deepEqual(p12.orders.map((x) => x.orderCode), ["N23", "N30", "D2"]);
  assert.equal(p12.fromUpload, 1);
  // backfill of an older month only creates that month
  const oct = planMonths([mk("O5", "2026-10-05 10:00:00")], stored, ["2026-11"]);
  assert.deepEqual(oct.map((x) => x.monthKey), ["2026-10"]);
  // late-October upload also refreshes November's tail when November exists
  const lateOct = planMonths([mk("O28", "2026-10-28 10:00:00")], stored, ["2026-11"]);
  assert.deepEqual(lateOct.map((x) => x.monthKey), ["2026-10", "2026-11"]);
  assert.deepEqual(lateOct[1].orders.map((x) => x.orderCode), ["O28", "N1", "N15", "N23", "N25old"]);
});

test("months: stray older orders in an export never create/overwrite a month but still count where due", async () => {
  const { planMonths, uploadSpan } = await import("../lib/fulfillment/months");
  // November file: 40 orders/day on 1-3 Nov, plus 2 stray October orders (one Flipkart due 2 Nov)
  const up: OrderRow[] = [];
  for (const d of ["01", "02", "03"]) for (let i = 0; i < 40; i++) up.push(o({ orderCode: `N${d}-${i}`, od: `2026-11-${d} 10:00:00` }));
  up.push(o({ orderCode: "OCT10-FK", channelName: "AMAZON_X", od: "2026-10-10 10:00:00", due: "2026-11-02 14:00:00" }));
  up.push(o({ orderCode: "OCT12", od: "2026-10-12 10:00:00" }));
  const span = uploadSpan(up)!;
  assert.deepEqual(span.covered, ["2026-11"]);
  assert.deepEqual(span.stray, [{ monthKey: "2026-10", orders: 2 }]);
  assert.equal(span.first, isoToDay("2026-11-01"));
  // a real October is stored — it must survive untouched
  const realOct = [o({ orderCode: "REAL-OCT10", od: "2026-10-10 11:00:00" }), o({ orderCode: "REAL-OCT31", od: "2026-10-31 11:00:00" })];
  const plans = planMonths(up, new Map([["2026-10", realOct]]), ["2026-10"]);
  assert.deepEqual(plans.map((p) => p.monthKey), ["2026-11"]); // October not touched
  const nov = plans[0].orders.map((x) => x.orderCode);
  assert.ok(nov.includes("OCT10-FK"), "older order due in Nov is carried into Nov");
  assert.ok(!nov.includes("OCT12"), "older order not due in Nov is not");
  assert.ok(nov.includes("REAL-OCT31"), "stored tail of October is carried");
  assert.equal(plans[0].fromUpload, 120);
});
