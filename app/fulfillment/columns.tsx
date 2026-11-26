"use client";
// Column definitions for the Orders explorer and the Pending Orders grid.
import type { Computed, PendingRow } from "@/lib/fulfillment/engine";
import { orderToDispatchHrs } from "@/lib/fulfillment/analytics";
import type { GridCol } from "./DataGrid";

const DAY = 86400;
const mono = { fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: 11.5 } as const;

const tone: Record<string, string> = {
  "On Time": "var(--atlas-green-bg)", Met: "var(--atlas-green-bg)", Within: "var(--atlas-green-bg)",
  Late: "var(--atlas-red-bg)", Breached: "var(--atlas-red-bg)", Beyond: "var(--atlas-red-bg)",
  Pending: "var(--atlas-amber-bg)",
};
/** Status as a labelled pill — the word carries the meaning, the tint is secondary. */
const pill = (s: string) => (tone[s]
  ? <span className="px-1.5 py-0.5 rounded" style={{ background: tone[s], color: "var(--atlas-ink)", fontSize: 11.5 }}>{s}</span>
  : <span style={{ color: "var(--atlas-ink-faint)" }}>{s}</span>);
const hrs = (v: number | "NA" | null) => (typeof v === "number" ? Math.round(v * 10) / 10 : v === "NA" ? "NA" : null);

export const ORDER_COLS: GridCol<Computed>[] = [
  { key: "orderCode", label: "Order", type: "text", value: (r) => r.orderCode, render: (r) => <span style={mono}>{r.orderCode}</span>, width: 170 },
  { key: "channel", label: "Channel", type: "enum", value: (r) => r.channel ?? `Unmapped: ${r.channelName}` },
  { key: "l2", label: "L2", type: "enum", value: (r) => r.l2, optional: true },
  { key: "channelName", label: "Channel Name (UC)", type: "enum", value: (r) => r.channelName, optional: true },
  { key: "facility", label: "Facility", type: "enum", value: (r) => r.facility },
  { key: "orderDate", label: "Ordered", type: "datetime", value: (r) => r.orderDate },
  { key: "orderDay", label: "Order Day", type: "date", value: (r) => (r.orderDay === null ? null : r.orderDay * DAY), optional: true },
  { key: "dueDay", label: "Due (3 PM)", type: "datetime", value: (r) => r.dueDay },
  { key: "dispatchDate", label: "Dispatched", type: "datetime", value: (r) => r.dispatchDate },
  { key: "dispatched", label: "Dispatched?", type: "enum", value: (r) => (r.dispatched ? "Yes" : "No"), optional: true },
  { key: "status3pm", label: "3 PM Status", type: "enum", value: (r) => r.status3pm, render: (r) => pill(r.status3pm) },
  { key: "azfkSla", label: "AZ/FK SLA", type: "enum", value: (r) => r.azfkSla, render: (r) => pill(r.azfkSla) },
  { key: "cred72", label: "CRED SLA", type: "enum", value: (r) => r.cred72, render: (r) => pill(r.cred72), optional: true },
  { key: "o2d", label: "Order→Dispatch (h)", type: "number", value: (r) => hrs(orderToDispatchHrs(r)) as number | null },
  { key: "fullTat", label: "Fulfillment TAT (h)", type: "number", value: (r) => hrs(r.fullTat) as number | null, optional: true },
  { key: "dispatchTat", label: "Dispatch TAT (h)", type: "number", value: (r) => hrs(r.dispatchTat) as number | null, optional: true },
  { key: "procTat", label: "Proc TAT (h)", type: "number", value: (r) => (typeof r.procTat === "number" ? hrs(r.procTat) as number : null), optional: true },
  { key: "webProcTat", label: "Web Proc TAT (h)", type: "number", value: (r) => (typeof r.webProcTat === "number" ? hrs(r.webProcTat) as number : null), optional: true },
  { key: "fulfillmentDue", label: "Fulfillment Due (UC)", type: "datetime", value: (r) => r.fulfillmentDue, optional: true },
  { key: "effDue", label: "Eff. Due AZ/FK", type: "datetime", value: (r) => r.effDue, optional: true },
  { key: "saleOrderStatus", label: "SO Status", type: "enum", value: (r) => r.saleOrderStatus },
  { key: "itemStatus", label: "Item Status", type: "enum", value: (r) => r.itemStatus, optional: true },
  { key: "packageStatus", label: "Package Status", type: "enum", value: (r) => r.packageStatus, optional: true },
  { key: "onHold", label: "On Hold", type: "enum", value: (r) => (r.onHold ? "Yes" : "No"), optional: true },
  { key: "sku", label: "SKU", type: "text", value: (r) => r.sku, optional: true },
  { key: "skuName", label: "SKU Name", type: "text", value: (r) => r.skuName, optional: true },
  { key: "lines", label: "Lines", type: "number", value: (r) => r.lines, optional: true },
  { key: "sellingPrice", label: "Selling Price", type: "number", value: (r) => r.sellingPrice, optional: true },
  { key: "state", label: "State", type: "enum", value: (r) => r.state, optional: true },
  { key: "city", label: "City", type: "text", value: (r) => r.city, optional: true },
  { key: "pincode", label: "Pincode", type: "text", value: (r) => r.pincode, optional: true },
  { key: "shippingProvider", label: "Courier", type: "enum", value: (r) => r.shippingProvider, optional: true },
  { key: "trackingNumber", label: "Tracking No.", type: "text", value: (r) => r.trackingNumber, optional: true },
  { key: "invoiceCreated", label: "Invoiced", type: "datetime", value: (r) => r.invoiceCreated, optional: true },
];

export const PENDING_COLS: GridCol<PendingRow>[] = [
  { key: "orderCode", label: "Order", type: "text", value: (r) => r.orderCode, render: (r) => <span style={mono}>{r.orderCode}</span>, width: 170 },
  { key: "orderDate", label: "Ordered", type: "datetime", value: (r) => r.orderDate },
  { key: "dueDay", label: "Due (3 PM)", type: "datetime", value: (r) => r.dueDay },
  { key: "ageDays", label: "Age (days)", type: "number", value: (r) => r.ageDays,
    render: (r) => <span style={{ fontWeight: (r.ageDays ?? 0) >= 3 ? 700 : 400 }}>{r.ageDays ?? "—"}</span> },
  { key: "channel", label: "Channel", type: "enum", value: (r) => r.channel },
  { key: "facility", label: "Facility", type: "enum", value: (r) => r.facility },
  { key: "saleOrderStatus", label: "SO Status", type: "enum", value: (r) => r.saleOrderStatus },
  { key: "itemStatus", label: "Item Status", type: "enum", value: (r) => r.itemStatus },
  { key: "packageStatus", label: "Package Status", type: "enum", value: (r) => r.packageStatus },
  { key: "reason", label: "Reason", type: "enum", value: (r) => r.reason, width: 260 },
];
