"use client";
import { useEffect, useState } from "react";
import { preview, apply, StalePlanError, type ApplyIntent } from "@/lib/mapper/client";
import { ISSUE_META, type Row } from "@/lib/mapper/model";
import type { Plan, RefCounts } from "@/lib/mapper/ops";

// One preview→confirm dialog for every destructive action (purge / retire / delete).
//
// Nothing destructive happens without the admin seeing exactly what it does first,
// computed server-side from fresh data. The plan is authoritative: if it produces no
// writes, the reason is shown and the confirm button never enables. That is why
// "purge a ghost" can honestly say it will delete four combos — it lists them.

type Props = {
  intent: ApplyIntent;
  title: string;
  /** One line explaining the operation in the admin's terms, not the schema's. */
  blurb: string;
  confirmLabel: string;
  danger?: boolean;
  row?: Row;
  /**
   * For irreversible deletions: the admin must type this exactly before Confirm
   * enables.
   *
   * The delete button sits next to Retire, and a combo is almost never a component
   * of another combo — so usedIn is 0 for nearly every combo, which is what the
   * button's visibility keys off. The guard was right and the reach was wrong:
   * a permanent delete was one click from a harmless one. Typing the SKU costs a
   * deliberate person three seconds and stops a slip entirely.
   */
  requireTyping?: string;
  onClose: () => void;
  onDone: (msg: string) => void;
};

export default function ActionPreview({ intent, title, blurb, confirmLabel, danger, row, requireTyping, onClose, onDone }: Props) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [refs, setRefs] = useState<RefCounts | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await preview(intent);
        if (cancelled) return;
        setPlan(res.plan);
        setRefs(res.refs ?? null);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function confirm() {
    if (!plan) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await apply(intent, plan.planHash);
      onDone(res.changes?.length ? `${res.changes.length} change(s) applied.` : `${res.applied} row(s) written.`);
    } catch (e) {
      if (e instanceof StalePlanError) {
        setPlan(e.plan ?? null);
        setErr("The mapper changed while you were reviewing. The preview has been refreshed — check it and confirm again.");
      } else {
        setErr(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  const hasWrites = !!plan && plan.writes.length > 0;
  const typingSatisfied = !requireTyping || typed.trim().toLowerCase() === requireTyping.trim().toLowerCase();
  const canApply = hasWrites && typingSatisfied;

  return (
    <div className="fixed inset-0 bg-black/70 z-[60] flex items-center justify-center p-4">
      <div className="bg-atlas-surface border border-atlas-line rounded-xl max-w-2xl w-full max-h-[85vh] flex flex-col">
        <div className="p-5 border-b border-atlas-line">
          <h3 className={`text-lg font-bold ${danger ? "text-atlas-red" : "text-atlas-ink"}`}>{title}</h3>
          <p className="text-sm text-atlas-ink-muted mt-1">{blurb}</p>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-2">
          {loading && <p className="text-sm text-atlas-ink-muted">Checking what this would do…</p>}

          {/* Reference counts — the reason a hard delete is refused. */}
          {refs && (
            <div className="mb-3 p-3 rounded-lg bg-atlas-surface-soft/60 border border-atlas-line">
              <p className="text-xs font-semibold text-atlas-ink mb-1.5">References to this SKU</p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                {(Object.entries(refs) as Array<[string, number]>).map(([t, n]) => (
                  <p key={t} className={`text-[11px] font-mono ${n > 0 ? "text-atlas-red" : "text-atlas-ink-faint"}`}>
                    {t}: {n}
                  </p>
                ))}
              </div>
            </div>
          )}

          {plan?.changes.map((c, i) => (
            <div key={i} className={`flex items-start gap-3 px-3 py-2 rounded-lg text-sm border ${
              c.action === "delete" ? "bg-atlas-red-bg border-atlas-red/30"
              : c.action === "add" ? "bg-atlas-green-bg border-atlas-green/30"
              : c.action === "retire" ? "bg-atlas-amber-bg border-atlas-amber-warn/30"
              : "bg-atlas-blue-bg border-atlas-blue/30"}`}>
              <span className={`text-xs font-bold uppercase mt-0.5 shrink-0 w-14 ${
                c.action === "delete" ? "text-atlas-red"
                : c.action === "add" ? "text-atlas-green"
                : c.action === "retire" ? "text-atlas-amber-warn" : "text-atlas-blue"}`}>
                {c.action}
              </span>
              <div className="min-w-0">
                <span className="font-mono text-atlas-ink">{c.sku}</span>
                <span className="text-atlas-ink-muted ml-2">— {c.details}</span>
              </div>
            </div>
          ))}

          {/* Rows that gain problems as a side effect. */}
          {plan && plan.impact.filter((d) => d.added.length).length > 0 && (
            <div className="mt-3 pt-3 border-t border-atlas-line">
              <p className="text-xs font-semibold text-atlas-amber-warn mb-1">Knock-on effects</p>
              {plan.impact.filter((d) => d.added.length).slice(0, 10).map((d) => (
                <p key={d.masterSku} className="text-xs text-atlas-ink-muted font-mono">
                  {d.masterSku} <span className="text-atlas-amber-warn">+{d.added.map((i) => ISSUE_META[i.code].label).join(", ")}</span>
                </p>
              ))}
            </div>
          )}

          {plan && plan.impact.filter((d) => d.removed.length && !d.added.length).length > 0 && (
            <p className="text-xs text-atlas-green mt-2">
              Resolves issues on {plan.impact.filter((d) => d.removed.length && !d.added.length).length} row(s).
            </p>
          )}

          {plan && plan.skipped.length > 0 && (
            <div className="mt-3 pt-3 border-t border-atlas-line">
              <p className="text-xs font-semibold text-atlas-red mb-1">
                {plan.writes.length === 0 ? "Refused" : "Skipped"}
              </p>
              {plan.skipped.map((s, i) => <p key={i} className="text-xs text-atlas-red/80">{s}</p>)}
            </div>
          )}

          {plan && plan.writes.length === 0 && plan.skipped.length === 0 && !loading && (
            <p className="text-sm text-atlas-ink-faint">Nothing to do.</p>
          )}
        </div>

        {/* Type-to-confirm, for deletions that cannot be undone from the UI. */}
        {hasWrites && requireTyping && (
          <div className="px-5 py-3 border-t border-atlas-line bg-atlas-red-bg/40">
            <label className="block text-xs text-atlas-ink-soft mb-1.5">
              This cannot be undone. Type <span className="font-mono font-bold text-atlas-ink">{requireTyping}</span> to confirm.
            </label>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus
              placeholder={requireTyping} spellCheck={false} autoComplete="off"
              className={`w-full max-w-sm px-3 py-2 bg-atlas-surface border rounded-lg text-atlas-ink text-sm font-mono focus:outline-none focus:ring-2 ${
                typingSatisfied ? "border-atlas-green focus:ring-atlas-green" : "border-atlas-line focus:ring-atlas-red"}`} />
          </div>
        )}

        {err && <p className="px-5 pb-2 text-xs text-atlas-red whitespace-pre-wrap">{err}</p>}

        <div className="p-5 border-t border-atlas-line flex items-center justify-between gap-3">
          <p className="text-[11px] text-atlas-ink-faint">
            {hasWrites ? "Recorded in the audit log with a full pre-change snapshot." : ""}
          </p>
          <div className="flex gap-2">
            <button onClick={onClose}
              className="px-4 py-2 bg-atlas-surface-soft text-atlas-ink text-sm rounded-lg hover:bg-atlas-surface transition">
              {hasWrites ? "Cancel" : "Close"}
            </button>
            {hasWrites && (
              <button onClick={confirm} disabled={busy || !canApply}
                title={!typingSatisfied ? `Type ${requireTyping} to enable` : undefined}
                className={`px-4 py-2 text-white text-sm font-semibold rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed ${
                  danger ? "bg-atlas-red hover:opacity-90" : "bg-atlas-accent hover:bg-atlas-accent-light"}`}>
                {busy ? "Applying…" : confirmLabel}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
