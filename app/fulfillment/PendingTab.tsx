"use client";
import { useMemo, useState } from "react";
import type { PendingRow } from "@/lib/fulfillment/engine";
import { buildPendingWorkbook, saveFile } from "@/lib/fulfillment/download";
import DataGrid, { type Filters } from "./DataGrid";
import { PENDING_COLS } from "./columns";
import { Btn, fmtInt } from "./ui";

export default function PendingTab({ fileTag, pending, preset }: {
  fileTag: string; // e.g. "Nov 2026 till 2026-11-23" for download names
  pending: PendingRow[];
  preset?: Filters; // filters handed over from an Overview drill-down
}) {
  // chips set a Reason filter; re-key the grid so it starts from that filter
  const [chip, setChip] = useState<{ filters?: Filters; n: number }>({ filters: preset, n: 0 });
  const reasonCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of pending) m.set(p.reason, (m.get(p.reason) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  }, [pending]);
  const activeReason = chip.filters?.reason?.kind === "enum" && chip.filters.reason.values.length === 1 ? chip.filters.reason.values[0] : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {reasonCounts.map(([r, n]) => (
          <button key={r} onClick={() => setChip((c) => ({ filters: activeReason === r ? {} : ({ reason: { kind: "enum", values: [r] } } as Filters), n: c.n + 1 }))}
            className="px-2.5 py-1 rounded-full"
            style={{ fontSize: 12, cursor: "pointer", border: "1px solid var(--atlas-line)", background: activeReason === r ? "var(--atlas-accent-bg, var(--atlas-blue-bg))" : "var(--atlas-surface)", color: "var(--atlas-ink-soft)" }}>
            <b style={{ color: "var(--atlas-ink)" }}>{fmtInt(n)}</b> · {r}
          </button>
        ))}
      </div>

      <DataGrid<PendingRow>
        key={chip.n}
        rows={pending}
        cols={PENDING_COLS}
        rowKey={(r) => r.orderCode}
        initialFilters={chip.filters}
        initialSort={{ key: "orderDate", dir: 1 }}
        exportName={`Pending Orders (filtered) ${fileTag}`}
        storageKey="pending"
        emptyText="No pending orders match."
        toolbar={() => (
          <Btn small primary disabled={pending.length === 0} title="All pending orders: an 'All Pending' sheet + one sheet per facility, ready to send to each vendor"
            onClick={() => saveFile(buildPendingWorkbook(pending, true), `Pending Orders ${fileTag}.xlsx`)}>↓ All pending (sheet per facility)</Btn>
        )}
      />
    </div>
  );
}
