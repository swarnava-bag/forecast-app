/**
 * Build the downloadable workbook (values only):
 *   Dashboard · Pending Orders · Base (one row per order, key + calculated cols)
 *   Mapper · SLA & WH Calendar · Reasons & Settings
 */
import * as XLSX from "xlsx";
import type { Computed, Dashboard, FulfillmentConfig, PendingRow } from "./engine";
import { dayToIso, DAY } from "./engine";

type CellObj = { t: "n" | "s"; v: number | string; z?: string };
const dt = (sec: number | null, z = "yyyy-mm-dd hh:mm:ss"): CellObj | "" => (sec === null ? "" : { t: "n", v: sec / DAY + 25569, z });
const dOnly = (sec: number | null) => dt(sec, "dd-mmm-yy");
const num = (v: number | "NA" | null, z = "0.00"): CellObj | string => (v === null ? "" : v === "NA" ? "NA" : { t: "n", v, z });

function pendingSheet(pending: PendingRow[]) {
  const p: unknown[][] = [["Display Order Code", "Order Date", "Due Day (3 PM)", "Age (days)", "Facility", "Channel", "Sale Order Status", "Item Status", "Package Status", "Reason for Pending"]];
  for (const r of pending) {
    p.push([r.orderCode, dt(r.orderDate), dt(r.dueDay, "dd-mmm-yy hh:mm"), r.ageDays ?? "", r.facility, r.channel, r.saleOrderStatus, r.itemStatus, r.packageStatus, r.reason]);
  }
  const ws = XLSX.utils.aoa_to_sheet(p);
  ws["!cols"] = [{ wch: 24 }, { wch: 19 }, { wch: 15 }, { wch: 9 }, { wch: 24 }, { wch: 12 }, { wch: 16 }, { wch: 18 }, { wch: 16 }, { wch: 52 }];
  ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, p.length - 1), c: p[0].length - 1 } }) };
  return ws;
}

/** Generic export of a grid view: header labels + typed values (dates are seconds). */
export function buildGridWorkbook<R>(rows: R[], cols: { label: string; type: "text" | "enum" | "number" | "date" | "datetime"; value: (row: R) => string | number | null }[], sheet = "Orders") {
  const aoa: unknown[][] = [cols.map((c) => c.label)];
  for (const r of rows) {
    aoa.push(cols.map((c) => {
      const v = c.value(r);
      if (v === null || v === "") return "";
      if (c.type === "date" && typeof v === "number") return dOnly(v);
      if (c.type === "datetime" && typeof v === "number") return dt(v);
      if (c.type === "number" && typeof v === "number") return { t: "n", v, z: Number.isInteger(v) ? "0" : "0.00" };
      return v;
    }));
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = cols.map((c) => ({ wch: c.type === "datetime" ? 19 : c.type === "date" ? 11 : Math.min(40, Math.max(10, c.label.length + 2)) }));
  ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, aoa.length - 1), c: cols.length - 1 } }) };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheet);
  return XLSX.write(wb, { type: "array", bookType: "xlsx", compression: true }) as ArrayBuffer;
}

/** Excel sheet names: ≤ 31 chars, no []:*?/\ , unique. */
function sheetName(name: string, used: Set<string>) {
  const base = (name.replace(/[[\]:*?/\\]/g, " ").trim() || "Blank").slice(0, 31);
  let n = base, i = 2;
  while (used.has(n.toLowerCase())) { const s = ` (${i++})`; n = base.slice(0, 31 - s.length) + s; }
  used.add(n.toLowerCase());
  return n;
}

/**
 * Pending Orders workbook for sending to vendors.
 *   byFacility = true → "All Pending" sheet + one sheet per facility (warehouse / vendor).
 */
export function buildPendingWorkbook(pending: PendingRow[], byFacility: boolean) {
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();
  XLSX.utils.book_append_sheet(wb, pendingSheet(pending), sheetName(byFacility ? "All Pending" : "Pending Orders", used));
  if (byFacility) {
    const groups = new Map<string, PendingRow[]>();
    for (const p of pending) { const k = p.facility || "(no facility)"; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(p); }
    for (const [fac, rows] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
      XLSX.utils.book_append_sheet(wb, pendingSheet(rows), sheetName(fac, used));
    }
  }
  return XLSX.write(wb, { type: "array", bookType: "xlsx", compression: true }) as ArrayBuffer;
}

export function saveFile(buf: ArrayBuffer, name: string) {
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function buildWorkbook(args: {
  dash: Dashboard; pending: PendingRow[]; rows: Computed[]; config: FulfillmentConfig; monthLabel: string; uploadedAt: string;
}) {
  const { dash, pending, rows, config, monthLabel, uploadedAt } = args;
  const wb = XLSX.utils.book_new();

  // Dashboard
  const d: unknown[][] = [
    [`Fulfillment TAT Dashboard — ${monthLabel}`],
    ["Order-level (unique Display Order Code, cancelled excluded). Report window:", `${dayToIso(dash.startDay)} → ${dayToIso(dash.endDay)}`, "", "Data uploaded:", uploadedAt],
    ["Marketplace cutoff", config.cutoff, "", "CRED SLA – non-listed dates (hrs)", config.credDefaultHours ?? "not tracked"],
  ];
  for (const s of dash.sections) {
    d.push([], [s.title], [s.note], ["Channel", "Metric", "MTD Total", ...dash.days.map((x) => dOnly(x * DAY))]);
    for (const r of s.rows) {
      const fmt = (v: number | null) => (v === null ? "-" : r.kind === "pct" ? { t: "n", v, z: "0.0%" } : r.kind === "hrs" ? { t: "n", v, z: "0.0" } : v);
      d.push([r.channel, r.metric, fmt(r.mtd), ...r.days.map(fmt)]);
    }
  }
  const wsD = XLSX.utils.aoa_to_sheet(d);
  wsD["!cols"] = [{ wch: 12 }, { wch: 34 }, { wch: 11 }, ...dash.days.map(() => ({ wch: 10 }))];
  XLSX.utils.book_append_sheet(wb, wsD, "Dashboard");

  XLSX.utils.book_append_sheet(wb, pendingSheet(pending), "Pending Orders");

  // Base (slim, one row per order)
  const b: unknown[][] = [[
    "Display Order Code", "Sale Order Item Code", "Active Lines", "Channel Name", "Facility", "Order Date", "Dispatch Date", "Fulfillment TAT", "Invoice Created",
    "Sale Order Status", "Item Status", "Package Status", "On Hold", "Item SKU Code", "SKU Name", "Shipping provider", "Tracking Number",
    "State", "City", "Pincode", "Selling Price",
    "Channel", "L2", "Order Day", "Dispatched Flag", "3PM Due Day", "Fullfillment TAT (Hrs)", "Dispatch TAT (Hrs)", "Proc TAT (Hrs)", "Web Processing TAT (Hrs)",
    "AZ/FK SLA Status", "3PM Status", "CRED 72H Status", "CRED SLA (Hrs)", "Effective Order Date", "Effective Fulfillment Due (AZ/FK)",
  ]];
  for (const r of rows) {
    b.push([
      r.orderCode, r.itemCode, r.lines, r.channelName, r.facility, dt(r.orderDate), dt(r.dispatchDate), dt(r.fulfillmentDue), dt(r.invoiceCreated),
      r.saleOrderStatus, r.itemStatus, r.packageStatus, r.onHold ? "TRUE" : "FALSE", r.sku, r.skuName, r.shippingProvider, r.trackingNumber,
      r.state, r.city, r.pincode, r.sellingPrice ?? "",
      r.channel ?? "#UNMAPPED", r.l2 ?? "", r.orderDay === null ? "" : dOnly(r.orderDay * DAY), r.dispatched ? 1 : 0, dt(r.dueDay),
      num(r.fullTat), num(r.dispatchTat), num(r.procTat), num(r.webProcTat),
      r.azfkSla, r.status3pm, r.cred72, r.credSlaHrs ?? "", dt(r.effOrderDate), dt(r.effDue),
    ]);
  }
  const wsB = XLSX.utils.aoa_to_sheet(b);
  wsB["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: b.length - 1, c: b[0].length - 1 } }) };
  XLSX.utils.book_append_sheet(wb, wsB, "Base");

  // Mapper
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Channel Name Report", "L1", "L2"], ...config.channelMap.map((r) => [r.channelName, r.l1, r.l2])]), "Mapper");

  // SLA & WH Calendar
  const cal: unknown[][] = [["WH Closed Date", "Warehouse (blank = All)", "Remarks", "", "CRED SLA Order Date", "SLA (Hrs)"]];
  const n = Math.max(config.closedDays.length, config.credSla.length);
  for (let i = 0; i < n; i++) {
    const c = config.closedDays[i], s = config.credSla[i];
    cal.push([c?.date ?? "", c?.warehouse ?? "", c?.remarks ?? "", "", s?.date ?? "", s?.hours ?? ""]);
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(cal), "SLA & WH Calendar");

  // Reasons & Settings
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ["Status Key", "Reason"], ...config.reasons.map((r) => [r.statusKey, r.reason]), [],
    ["Setting", "Value"], ["Marketplace Cutoff Time", config.cutoff], ["CRED SLA – Non-Listed Dates (Hrs)", config.credDefaultHours ?? ""],
  ]), "Reasons & Settings");

  return XLSX.write(wb, { type: "array", bookType: "xlsx", compression: true }) as ArrayBuffer;
}
