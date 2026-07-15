"use client";
import { useMemo, useState } from "react";
import {
  planAddBatch, describeExistingSku, type DraftSku, type Plan, type LiveState,
} from "@/lib/mapper/ops";
import { preview, apply, StalePlanError } from "@/lib/mapper/client";
import { ISSUE_META, norm, type Row } from "@/lib/mapper/model";

// New Launch — add several singles AND their combos in one reviewed batch.
//
// Replaces the old one-at-a-time AddSkuModal. Two write paths for the same thing is
// how the tables drifted apart in the first place.
//
// The draft is validated by the same pure planner the server runs, so a combo can
// reference a single added two rows above: planAddBatch unions the draft onto live
// state before calling buildRows, and the reference simply resolves. The preview is
// then re-computed server-side and applied only if nothing moved underneath.

type Props = {
  live: LiveState;
  rows: Row[];
  mapperSetId: string;
  onClose: () => void;
  onDone: (msg: string) => void;
  /** Jump to an existing SKU in the grid so the admin can edit it instead of
   *  re-adding it. Typing an existing Master SKU here almost always means "I want
   *  to change that one" — a bare "already exists" rejection is a dead end. */
  onEditExisting: (sku: string) => void;
};

let uid = 0;
const blank = (kind: "single" | "combo" = "single"): DraftSku => ({
  tempId: `d${++uid}`, kind, masterSku: "", fgCode: "", productName: "", mrp: "",
  components: kind === "combo" ? [{ sku: "", qty: 1 }] : [],
});

export default function NewLaunchPanel({ live, rows, mapperSetId, onClose, onDone, onEditExisting }: Props) {
  const [draft, setDraft] = useState<DraftSku[]>([blank("single")]);
  const [serverPlan, setServerPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Local plan for instant feedback. Advisory only — the server re-plans before writing.
  const localPlan = useMemo(
    () => planAddBatch(live, draft, mapperSetId),
    [live, draft, mapperSetId]
  );

  const filled = draft.filter((d) => d.masterSku.trim());
  const singleNames = useMemo(() => rows.filter((r) => !r.isCombo).map((r) => r.masterSku), [rows]);

  // Every SKU a combo may reference: existing singles + singles being created here.
  const draftSingles = draft.filter((d) => d.kind === "single" && d.masterSku.trim()).map((d) => d.masterSku.trim());
  const knownForComponents = useMemo(
    () => new Set([...rows.map((r) => norm(r.masterSku)), ...draftSingles.map(norm)]),
    [rows, draftSingles.join("|")] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const patch = (i: number, p: Partial<DraftSku>) =>
    setDraft((d) => d.map((x, j) => (j === i ? { ...x, ...p } : x)));

  function setKind(i: number, kind: "single" | "combo") {
    patch(i, { kind, components: kind === "combo" && draft[i].components.length === 0 ? [{ sku: "", qty: 1 }] : draft[i].components });
  }

  async function review() {
    setErr(null);
    setBusy(true);
    try {
      // Re-plan server-side: the returned planHash is bound to state the server
      // just read, so applying it is conditional on nothing having changed.
      const { plan } = await preview({ intent: "add_batch", mapperSetId, draft });
      if (plan.writes.length === 0) {
        setErr(plan.skipped.length ? `Nothing can be added:\n${plan.skipped.join("\n")}` : "Nothing to add.");
        return;
      }
      setServerPlan(plan);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!serverPlan) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await apply({ intent: "add_batch", mapperSetId, draft }, serverPlan.planHash);
      onDone(`Launched ${res.applied / 2} SKU(s) into SKU Master and the mapper.${res.skipped?.length ? ` ${res.skipped.length} skipped.` : ""}`);
    } catch (e) {
      if (e instanceof StalePlanError) {
        setServerPlan(e.plan ?? null);
        setErr("The mapper changed while you were reviewing. The preview below has been refreshed — check it and confirm again.");
      } else {
        setErr(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div className="bg-atlas-surface border border-atlas-line rounded-xl w-full max-w-6xl max-h-[92vh] flex flex-col">
        <div className="p-5 border-b border-atlas-line flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-bold text-atlas-ink">New Launch</h3>
            <p className="text-xs text-atlas-ink-muted mt-1">
              Add the singles and their combos together. Each SKU is written to SKU Master
              <span className="text-atlas-ink-soft"> and </span>the mapper in one action — a combo here can
              reference a single added above it.
            </p>
          </div>
          <button onClick={onClose} className="text-atlas-ink-muted hover:text-atlas-ink text-xl leading-none px-2">✕</button>
        </div>

        {/* ── Draft rows ── */}
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {draft.map((d, i) => {
            const sku = d.masterSku.trim();
            // A Master SKU that already exists is not an error — it means the admin
            // wants to edit that row. Show what's there and offer the edit.
            const existing = sku ? describeExistingSku(live, sku, d) : null;
            const problem = !existing && localPlan.skipped.find((s) => s.startsWith(`${sku}:`));
            return (
              <div key={d.tempId}
                className={`rounded-xl border p-3 ${
                  existing ? "border-atlas-amber-warn/60 bg-atlas-amber-bg/40"
                  : problem ? "border-atlas-red/50 bg-atlas-red-bg/40"
                  : "border-atlas-line bg-atlas-surface-soft/40"}`}>
                <div className="flex gap-2 items-start">
                  <div className="flex rounded-lg overflow-hidden border border-atlas-line shrink-0">
                    {(["single", "combo"] as const).map((k) => (
                      <button key={k} onClick={() => setKind(i, k)}
                        className={`px-3 py-2 text-xs font-semibold transition ${
                          d.kind === k ? "bg-atlas-accent text-white" : "bg-atlas-surface text-atlas-ink-muted hover:bg-atlas-surface-soft"}`}>
                        {k === "single" ? "Single" : "Combo"}
                      </button>
                    ))}
                  </div>
                  <input value={d.masterSku} onChange={(e) => patch(i, { masterSku: e.target.value })}
                    placeholder="Master SKU *"
                    className="flex-1 min-w-[150px] px-3 py-2 bg-atlas-surface border border-atlas-line rounded-lg text-atlas-ink text-sm font-mono focus:outline-none focus:ring-2 focus:ring-atlas-accent" />
                  <input value={d.fgCode} onChange={(e) => patch(i, { fgCode: e.target.value })}
                    placeholder="FG Code"
                    className="w-28 px-3 py-2 bg-atlas-surface border border-atlas-line rounded-lg text-atlas-ink text-sm font-mono focus:outline-none focus:ring-2 focus:ring-atlas-accent" />
                  <input value={d.productName} onChange={(e) => patch(i, { productName: e.target.value })}
                    placeholder="Product name"
                    className="flex-1 min-w-[140px] px-3 py-2 bg-atlas-surface border border-atlas-line rounded-lg text-atlas-ink text-sm focus:outline-none focus:ring-2 focus:ring-atlas-accent" />
                  <input value={d.mrp} onChange={(e) => patch(i, { mrp: e.target.value })}
                    placeholder="MRP" inputMode="decimal"
                    className="w-24 px-3 py-2 bg-atlas-surface border border-atlas-line rounded-lg text-atlas-ink text-sm font-mono text-right focus:outline-none focus:ring-2 focus:ring-atlas-accent" />
                  <button onClick={() => setDraft(draft.filter((_, j) => j !== i))}
                    disabled={draft.length === 1}
                    className="px-2 py-2 text-atlas-red hover:opacity-70 disabled:opacity-25 text-sm shrink-0">✕</button>
                </div>

                {d.kind === "combo" && (
                  <div className="mt-3 pl-2 border-l-2 border-atlas-accent/30 ml-1">
                    <p className="text-[11px] text-atlas-ink-muted mb-1.5">Components — repeat quantity with ×</p>
                    <div className="space-y-1.5">
                      {d.components.map((c, ci) => {
                        const cs = c.sku.trim();
                        const unknown = cs && !knownForComponents.has(norm(cs));
                        const fromBatch = cs && draftSingles.some((s) => norm(s) === norm(cs));
                        return (
                          <div key={ci} className="flex gap-2 items-center">
                            <input value={c.sku} list="launch-skus" placeholder="Component Master SKU"
                              onChange={(e) => patch(i, { components: d.components.map((x, j) => j === ci ? { ...x, sku: e.target.value } : x) })}
                              className={`flex-1 px-3 py-1.5 bg-atlas-surface border rounded-lg text-atlas-ink text-xs font-mono focus:outline-none focus:ring-1 focus:ring-atlas-accent ${
                                unknown ? "border-atlas-red" : "border-atlas-line"}`} />
                            <span className="text-xs text-atlas-ink-faint">×</span>
                            <input type="number" min={1} value={c.qty}
                              onChange={(e) => patch(i, { components: d.components.map((x, j) => j === ci ? { ...x, qty: Math.max(1, parseInt(e.target.value) || 1) } : x) })}
                              className="w-14 px-2 py-1.5 bg-atlas-surface border border-atlas-line rounded-lg text-atlas-ink text-xs text-center focus:outline-none focus:ring-1 focus:ring-atlas-accent" />
                            {fromBatch && <span className="text-[10px] text-atlas-accent whitespace-nowrap">from this launch</span>}
                            {unknown && <span className="text-[10px] text-atlas-red whitespace-nowrap">not defined anywhere</span>}
                            <button onClick={() => patch(i, { components: d.components.filter((_, j) => j !== ci) })}
                              className="px-1.5 text-atlas-red hover:opacity-70 text-xs">✕</button>
                          </div>
                        );
                      })}
                      <button onClick={() => patch(i, { components: [...d.components, { sku: "", qty: 1 }] })}
                        className="text-[11px] text-atlas-accent hover:opacity-70">+ component</button>
                    </div>
                  </div>
                )}

                {problem && <p className="text-[11px] text-atlas-red mt-2">{problem.replace(`${sku}: `, "")}</p>}

                {/* ── Already exists → edit it ──
                    The Master SKU is the key, so there is no "add anyway": a second
                    row under the same one is a duplicate the converter resolves
                    arbitrarily. Typing an existing SKU means an edit was intended. */}
                {existing && (
                  <div className="mt-3 rounded-lg border border-atlas-amber-warn/40 bg-atlas-surface p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-xs font-bold text-atlas-amber-warn uppercase tracking-wide">
                          {existing.masterSku} already exists
                        </p>
                        <p className="text-[11px] text-atlas-ink-muted mt-1">
                          Currently a <span className="font-semibold">{existing.isCombo ? "combo" : "single"}</span>
                          {existing.isCombo && <> of <span className="font-mono">[{existing.products.join(", ")}]</span></>}
                          {" · FG "}<span className="font-mono">{existing.fgCode || "(none)"}</span>
                          {!existing.inSkuMaster && <span className="text-atlas-blue"> · no SKU Master row (unenriched)</span>}
                        </p>
                      </div>
                      <button onClick={() => { onClose(); onEditExisting(existing.masterSku); }}
                        className="px-3 py-1.5 bg-atlas-accent text-white text-xs font-semibold rounded-lg hover:bg-atlas-accent-light transition shrink-0">
                        Edit the original →
                      </button>
                    </div>

                    {existing.diffs.length === 0 ? (
                      <p className="text-[11px] text-atlas-ink-muted mt-2">
                        Identical to what you entered — nothing would change.
                      </p>
                    ) : (
                      <>
                        <p className="text-[11px] text-atlas-ink-soft mt-2 mb-1">You are proposing an edit:</p>
                        <div className="space-y-0.5">
                          {existing.diffs.map((x) => (
                            <p key={x.field} className="text-[11px] font-mono">
                              <span className="text-atlas-ink-muted">{x.field}: </span>
                              <span className="text-atlas-ink-faint line-through">{x.current}</span>
                              <span className="text-atlas-ink-muted"> → </span>
                              <span className="text-atlas-green font-semibold">{x.proposed}</span>
                            </p>
                          ))}
                        </div>
                        {existing.isCombo && existing.sameComponents && (
                          <p className="text-[11px] text-atlas-green mt-1.5">
                            Components already match — only the details above differ.
                          </p>
                        )}
                      </>
                    )}
                    <p className="text-[11px] text-atlas-ink-faint mt-2">
                      This row is skipped. If it is genuinely a different product, give it its own Master SKU.
                    </p>
                  </div>
                )}
              </div>
            );
          })}

          <datalist id="launch-skus">
            {[...singleNames, ...draftSingles].slice(0, 900).map((s) => <option key={s} value={s} />)}
          </datalist>

          <div className="flex gap-2">
            <button onClick={() => setDraft([...draft, blank("single")])}
              className="px-3 py-2 bg-atlas-surface-soft border border-atlas-line text-atlas-ink text-xs rounded-lg hover:bg-atlas-surface transition">
              + Single
            </button>
            <button onClick={() => setDraft([...draft, blank("combo")])}
              className="px-3 py-2 bg-atlas-surface-soft border border-atlas-line text-atlas-ink text-xs rounded-lg hover:bg-atlas-surface transition">
              + Combo
            </button>
          </div>
        </div>

        {/* ── Live summary ── */}
        <div className="px-5 py-3 border-t border-atlas-line bg-atlas-surface-soft/30 space-y-1.5">
          {err && <p className="text-xs text-atlas-red whitespace-pre-wrap">{err}</p>}
          {localPlan.newBlocking.length > 0 && (
            <p className="text-xs text-atlas-red">
              Would introduce blocking issues: {localPlan.newBlocking.map((b) => `${b.masterSku} (${b.issues.map((i) => i.code).join(", ")})`).join("; ")}
            </p>
          )}
          {localPlan.impact.filter((d) => d.added.length && !filled.some((f) => norm(f.masterSku) === norm(d.masterSku))).length > 0 && (
            <p className="text-xs text-atlas-amber-warn">
              Affects existing SKUs:{" "}
              {localPlan.impact
                .filter((d) => d.added.length && !filled.some((f) => norm(f.masterSku) === norm(d.masterSku)))
                .slice(0, 4)
                .map((d) => `${d.masterSku} +${d.added.map((i) => ISSUE_META[i.code].label).join("/")}`)
                .join("; ")}
            </p>
          )}
          <p className="text-xs text-atlas-ink-muted">
            {filled.length} SKU(s) drafted · {localPlan.changes.filter((c) => c.action === "add").length} will be added
            {localPlan.skipped.length > 0 && <span className="text-atlas-red"> · {localPlan.skipped.length} blocked</span>}
          </p>
        </div>

        <div className="p-4 border-t border-atlas-line flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 bg-atlas-surface-soft text-atlas-ink-muted text-sm rounded-lg hover:bg-atlas-surface transition">Cancel</button>
          <button onClick={review} disabled={busy || filled.length === 0}
            className="px-4 py-2 bg-atlas-accent text-white text-sm font-semibold rounded-lg hover:bg-atlas-accent-light transition disabled:opacity-50">
            {busy ? "Checking…" : `Review ${filled.length} SKU(s)`}
          </button>
        </div>
      </div>

      {/* ── Preview → confirm ── */}
      {serverPlan && (
        <div className="fixed inset-0 bg-black/70 z-[60] flex items-center justify-center p-4">
          <div className="bg-atlas-surface border border-atlas-line rounded-xl max-w-2xl w-full max-h-[80vh] flex flex-col">
            <div className="p-5 border-b border-atlas-line">
              <h3 className="text-lg font-bold text-atlas-ink">Confirm Launch</h3>
              <p className="text-sm text-atlas-ink-muted mt-1">
                {serverPlan.changes.filter((c) => c.action === "add").length} SKU(s) to add
                {serverPlan.skipped.length > 0 && `, ${serverPlan.skipped.length} skipped`}
                {" · "}{serverPlan.writes.length} row(s) across both tables
              </p>
            </div>
            <div className="flex-1 overflow-y-auto p-5 space-y-2">
              {serverPlan.changes.map((c, i) => (
                <div key={i} className={`flex items-start gap-3 px-3 py-2 rounded-lg text-sm border ${
                  c.action === "add" ? "bg-atlas-green-bg border-atlas-green/30"
                  : c.action === "update" ? "bg-atlas-blue-bg border-atlas-blue/30"
                  : "bg-atlas-surface-soft/50 border-atlas-line"}`}>
                  <span className={`text-xs font-bold uppercase mt-0.5 shrink-0 w-16 ${
                    c.action === "add" ? "text-atlas-green" : c.action === "update" ? "text-atlas-blue" : "text-atlas-ink-faint"}`}>
                    {c.action}
                  </span>
                  <div className="min-w-0">
                    <span className="font-mono text-atlas-ink">{c.sku}</span>
                    <span className="text-atlas-ink-muted ml-2">— {c.details}</span>
                  </div>
                </div>
              ))}
              {serverPlan.newBlocking.length > 0 && (
                <div className="mt-3 pt-3 border-t border-atlas-line">
                  <p className="text-xs font-semibold text-atlas-red mb-1">Would introduce blocking issues:</p>
                  {serverPlan.newBlocking.map((b) => (
                    <p key={b.masterSku} className="text-xs text-atlas-red/80 font-mono">{b.masterSku}: {b.issues.map((i) => i.detail).join(" ")}</p>
                  ))}
                </div>
              )}
              {serverPlan.skipped.length > 0 && (
                <div className="mt-3 pt-3 border-t border-atlas-line">
                  <p className="text-xs font-semibold text-atlas-red mb-1">Skipped:</p>
                  {serverPlan.skipped.map((s, i) => <p key={i} className="text-xs text-atlas-red/70">{s}</p>)}
                </div>
              )}
            </div>
            {err && <p className="px-5 pb-2 text-xs text-atlas-red whitespace-pre-wrap">{err}</p>}
            <div className="p-5 border-t border-atlas-line flex justify-end gap-3">
              <button onClick={() => setServerPlan(null)}
                className="px-4 py-2 bg-atlas-surface-soft text-atlas-ink text-sm rounded-lg hover:bg-atlas-surface transition">Back</button>
              <button onClick={confirm} disabled={busy}
                className="px-4 py-2 bg-atlas-accent text-white text-sm font-semibold rounded-lg hover:bg-atlas-accent-light transition disabled:opacity-50">
                {busy ? "Applying…" : `Confirm ${serverPlan.changes.filter((c) => c.action === "add").length} SKU(s)`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
