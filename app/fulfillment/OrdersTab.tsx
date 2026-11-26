"use client";
// Orders explorer — every order in the month with a filter on every column.
// The "find me the orders where…" view that Metabase was used for.
import type { Computed } from "@/lib/fulfillment/engine";
import DataGrid, { type Filters } from "./DataGrid";
import { ORDER_COLS } from "./columns";
import { muted } from "./ui";

export default function OrdersTab({ rows, fileTag, preset, presetKey }: { rows: Computed[]; fileTag: string; preset?: Filters; presetKey: number }) {
  return (
    <div className="space-y-2">
      <p style={{ fontSize: 12.5, ...muted }}>
        One row per order (its first active line). Filter any column with ▾, sort by clicking a header, add columns (SKU, courier, pincode, TATs…) under <b>Columns</b>, and export exactly what you see.
      </p>
      <DataGrid<Computed>
        key={presetKey}
        rows={rows}
        cols={ORDER_COLS}
        rowKey={(r) => r.orderCode}
        initialFilters={preset}
        initialSort={{ key: "orderDate", dir: -1 }}
        exportName={`Orders ${fileTag}`}
        storageKey="orders"
      />
    </div>
  );
}
