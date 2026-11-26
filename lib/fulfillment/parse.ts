/**
 * Read Unicommerce Sale Order exports (all 141 columns, any number of facility
 * files) and reduce them to one OrderRow per order — the first ACTIVE line,
 * exactly as Base!FA "Active Order Key" + Base!EO "Order Flag" pick it:
 *   a line is inactive when Sale Order Status = CANCELLED or Item Status is
 *   CANCELLED / ALTERNATE_ACCEPTED; the first remaining line of each Display
 *   Order Code (in file order) represents the order.
 */
import { splitRecords, parseRecord, colKey } from "../consolidate";
import { parseDateTime, type OrderRow } from "./engine";

/** Column header (as exported by Unicommerce) for each field. */
export const COLUMNS = {
  orderCode: "Display Order Code",
  itemCode: "Sale Order Item Code",
  channelName: "Channel Name",
  facility: "Facility",
  orderDate: "Order Date as dd/mm/yyyy hh:MM:ss",
  dispatchDate: "Dispatch Date",
  fulfillmentDue: "Fulfillment TAT",
  saleOrderStatus: "Sale Order Status",
  itemStatus: "Sale Order Item Status",
  packageStatus: "Shipping Package Status Code",
  onHold: "On Hold",
  sku: "Item SKU Code",
  skuName: "SKU Name",
  shippingProvider: "Shipping provider",
  trackingNumber: "Tracking Number",
  invoiceCreated: "Invoice Created",
  state: "Shipping Address State",
  city: "Shipping Address City",
  pincode: "Shipping Address Pincode",
  sellingPrice: "Selling Price",
} as const;
type Field = keyof typeof COLUMNS;
const REQUIRED: Field[] = ["orderCode", "channelName", "facility", "orderDate", "dispatchDate", "fulfillmentDue", "saleOrderStatus", "itemStatus"];

export type ParsedUpload = {
  orders: OrderRow[];
  itemRows: number;
  inactiveOrders: number; // orders whose every line is cancelled
  files: { name: string; rows: number }[];
};

/** A table = header row + data rows, already split into cells. */
export type Table = { name: string; rows: string[][] };

export function csvToTable(name: string, text: string): Table {
  return { name, rows: splitRecords(text).map(parseRecord) };
}

const clean = (v: string | undefined) => (v ?? "").trim().replace(/^`/, "");
const isTrue = (v: string) => /^(true|1|yes)$/i.test(v.trim());

export function extractOrders(tables: Table[]): ParsedUpload {
  const first = new Map<string, OrderRow>();
  const lines = new Map<string, number>();
  const seenAny = new Set<string>();
  let itemRows = 0;
  const files: ParsedUpload["files"] = [];

  for (const t of tables) {
    if (t.rows.length === 0) throw new Error(`"${t.name}" is empty.`);
    // header = first of the top 10 rows that has "Display Order Code" (the
    // workbook's Base sheet carries a notes row above the header)
    const key = colKey(COLUMNS.orderCode);
    const hr = Math.max(0, t.rows.slice(0, 10).findIndex((r) => r.some((c) => colKey(c) === key)));
    const header = t.rows[hr].map(colKey);
    const idx = {} as Record<Field, number>;
    for (const f of Object.keys(COLUMNS) as Field[]) idx[f] = header.indexOf(colKey(COLUMNS[f]));
    const missing = REQUIRED.filter((f) => idx[f] < 0).map((f) => COLUMNS[f]);
    if (missing.length) throw new Error(`"${t.name}" is missing column(s): ${missing.join(", ")}. Is this a Unicommerce Sale Order export?`);
    const get = (r: string[], f: Field) => (idx[f] < 0 ? "" : clean(r[idx[f]]));

    let n = 0;
    for (let i = hr + 1; i < t.rows.length; i++) {
      const r = t.rows[i];
      const code = get(r, "orderCode");
      if (!code) continue;
      n++;
      seenAny.add(code);
      const sos = get(r, "saleOrderStatus"), its = get(r, "itemStatus");
      if (sos === "CANCELLED" || its === "CANCELLED" || its === "ALTERNATE_ACCEPTED") continue;
      lines.set(code, (lines.get(code) ?? 0) + 1);
      if (first.has(code)) continue;
      const price = parseFloat(get(r, "sellingPrice"));
      first.set(code, {
        orderCode: code,
        itemCode: get(r, "itemCode"),
        channelName: get(r, "channelName"),
        facility: get(r, "facility"),
        orderDate: parseDateTime(get(r, "orderDate")),
        dispatchDate: parseDateTime(get(r, "dispatchDate")),
        fulfillmentDue: parseDateTime(get(r, "fulfillmentDue")),
        saleOrderStatus: sos,
        itemStatus: its,
        packageStatus: get(r, "packageStatus"),
        onHold: isTrue(get(r, "onHold")),
        sku: get(r, "sku"),
        skuName: get(r, "skuName"),
        shippingProvider: get(r, "shippingProvider"),
        trackingNumber: get(r, "trackingNumber"),
        invoiceCreated: parseDateTime(get(r, "invoiceCreated")),
        state: get(r, "state"),
        city: get(r, "city"),
        pincode: get(r, "pincode"),
        sellingPrice: Number.isFinite(price) ? price : null,
        lines: 0,
      });
    }
    itemRows += n;
    files.push({ name: t.name, rows: n });
  }
  const orders = [...first.values()];
  for (const o of orders) o.lines = lines.get(o.orderCode) ?? 1;
  return { orders, itemRows, inactiveOrders: seenAny.size - orders.length, files };
}
