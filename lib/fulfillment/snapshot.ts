/**
 * Monthly order snapshot — what an upload publishes and the dashboard loads.
 * Stored compactly (field list + row arrays) as gzip JSON in Supabase Storage.
 */
import type { OrderRow } from "./engine";

/** Roles allowed to see AND edit the Fulfillment section (view, upload, settings, remarks).
 *  Keep in sync with the RLS policies in supabase/sql/fulfillment.sql. */
export const ACCESS_ROLES = ["supply_chain", "admin"];
export const hasAccess = (role: string | null | undefined) => !!role && ACCESS_ROLES.includes(role);

export type SnapshotMeta = {
  monthKey: string; // YYYY-MM (month of the latest order day in the upload)
  uploadedAt: string; // ISO
  uploadedBy: string; // display name / email
  files: { name: string; rows: number }[];
  itemRows: number;
  inactiveOrders: number;
};
export type Snapshot = SnapshotMeta & { orders: OrderRow[] };
type Packed = SnapshotMeta & { v: 1; fields: (keyof OrderRow)[]; rows: unknown[][] };

const FIELDS: (keyof OrderRow)[] = [
  "orderCode", "itemCode", "channelName", "facility", "orderDate", "dispatchDate", "fulfillmentDue",
  "saleOrderStatus", "itemStatus", "packageStatus", "onHold", "sku", "skuName", "shippingProvider",
  "trackingNumber", "invoiceCreated", "state", "city", "pincode", "sellingPrice", "lines",
];

export function packSnapshot(s: Snapshot): Packed {
  const { orders, ...meta } = s;
  return { v: 1, ...meta, fields: FIELDS, rows: orders.map((o) => FIELDS.map((f) => o[f])) };
}

export function unpackSnapshot(p: Packed): Snapshot {
  const { rows, fields, v: _v, ...meta } = p;
  void _v;
  const orders = rows.map((r) => {
    const o = {} as Record<string, unknown>;
    fields.forEach((f, i) => { o[f] = r[i]; });
    return o as unknown as OrderRow;
  });
  return { ...meta, orders };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const monthLabel = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return m ? `${MONTHS[m - 1]} ${y}` : key;
};
