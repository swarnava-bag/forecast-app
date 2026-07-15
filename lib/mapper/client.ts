// Client-side access to the mapper write path.
//
// Pages must not call supabase.from("sku_master") / .from("combo_mapper_rows") to
// mutate. Every write goes through /api/admin/mapper/apply so that validation,
// row_count maintenance, audit and the stale-plan check happen in exactly one place.
// Reads are still direct — they can't corrupt anything.

import type { Plan, DraftSku, CellField, RefCounts } from "./ops";

export type ApplyIntent =
  | { intent: "add_batch"; mapperSetId: string; draft: DraftSku[] }
  | { intent: "fix"; mapperSetId: string; sku: string }
  | { intent: "cell_edit"; mapperSetId: string; sku: string; field: CellField; value: string }
  | { intent: "purge_ghost"; sku: string }
  | { intent: "retire"; sku: string; retire?: boolean }
  | { intent: "hard_delete"; sku: string };

export type ApplyOk = { applied: number; changes?: string[]; skipped?: string[]; batchId?: string; plan?: Plan; message?: string };
export type ApplyErr = { error: string; code?: "STALE_PLAN" | "PARTIAL"; plan?: Plan; refs?: RefCounts; failures?: string[] };

async function post(body: unknown): Promise<Response> {
  return fetch("/api/admin/mapper/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Compute a plan WITHOUT writing. The returned planHash is bound to state the
 * server just read, so passing it to apply() makes the write conditional on
 * nothing having changed since the admin looked at the preview.
 */
export async function preview(intent: ApplyIntent): Promise<{ plan: Plan; refs?: RefCounts }> {
  const res = await post({ ...intent, dryRun: true });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `Preview failed (${res.status})`);
  return json;
}

/** Apply a previously previewed plan. Pass the planHash from preview(). */
export async function apply(intent: ApplyIntent, planHash: string): Promise<ApplyOk> {
  const res = await post({ ...intent, planHash });
  const json = await res.json();
  if (res.status === 409) {
    const err = new StalePlanError(json.error || "The mapper changed while you were reviewing.");
    err.plan = json.plan;
    throw err;
  }
  if (!res.ok) throw new Error(json.error || `Apply failed (${res.status})`);
  return json;
}

/** preview + apply in one call, for edits with no preview UI (a single cell). */
export async function applyDirect(intent: ApplyIntent): Promise<ApplyOk> {
  const { plan } = await preview(intent);
  if (plan.skipped.length > 0 && plan.writes.length === 0) throw new Error(plan.skipped.join("\n"));
  return apply(intent, plan.planHash);
}

export class StalePlanError extends Error {
  plan?: Plan;
  constructor(message: string) {
    super(message);
    this.name = "StalePlanError";
  }
}
