/**
 * Tests for the write planner. Pure fixtures — no network, no DB.
 *
 *   npm test
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { SkuMasterRow, MapperDbRow } from "../lib/mapper/model";
import {
  planAddBatch, planFix, planCellEdit, planPurgeGhost, planRetire, planHardDelete,
  expandComponents, parseMrp, type LiveState, type DraftSku, type RefCounts,
} from "../lib/mapper/ops";

const SET = "set-1";
let seq = 0;
const sm = (o: Partial<SkuMasterRow> & { new_master_sku: string }): SkuMasterRow => ({
  id: `sm-${++seq}`, new_fg_code: null, product_name: null, mrp: null,
  is_active: true, discontinued_at: null, ...o,
});
const mr = (o: Partial<MapperDbRow> & { master_sku: string }): MapperDbRow => ({
  id: `mr-${++seq}`, mapper_set_id: SET, is_combo: false, products: [],
  fg_code: null, product_name: null, ...o,
});
const draft = (o: Partial<DraftSku> & { masterSku: string }): DraftSku => ({
  tempId: `t-${++seq}`, kind: "single", fgCode: "", productName: "", mrp: "", components: [], ...o,
});
const NO_REFS: RefCounts = {
  forecast_data: 0, forecast_data_combos: 0, historical_forecast_data: 0,
  supply_plan: 0, mapper_suggestions: 0, channel_sku_mapping: 0,
};

// ── helpers ──────────────────────────────────────────────────────────────────

test("component quantity is encoded as repetition", () => {
  assert.deepEqual(expandComponents([{ sku: "A", qty: 3 }, { sku: "B", qty: 1 }]), ["A", "A", "A", "B"]);
  assert.deepEqual(expandComponents([{ sku: "  ", qty: 2 }]), [], "blank rows are ignored, not expanded");
});

test("MRP parsing accepts blanks and thousands separators, rejects junk", () => {
  assert.deepEqual(parseMrp(""), { ok: true, value: null });
  assert.deepEqual(parseMrp("2,099"), { ok: true, value: 2099 });
  assert.equal(parseMrp("abc").ok, false);
  assert.equal(parseMrp("-5").ok, false);
});

// ── planAddBatch — the New Launch path ───────────────────────────────────────

test("a new single writes BOTH tables — the orphan bug, prevented by construction", () => {
  const live: LiveState = { skuMaster: [], mapperRows: [] };
  const plan = planAddBatch(live, [draft({ masterSku: "NEW", fgCode: "1G", mrp: "100" })], SET);
  const ops = plan.writes.map((w) => w.op).sort();
  assert.deepEqual(ops, ["insert_mapper", "insert_sku_master"],
    "writing only sku_master is exactly what created 28 orphans");
  assert.equal(plan.skipped.length, 0);
});

test("a combo may reference a single created in the SAME batch", () => {
  const live: LiveState = { skuMaster: [], mapperRows: [] };
  const plan = planAddBatch(live, [
    draft({ masterSku: "S", fgCode: "1G", mrp: "100" }),
    draft({ masterSku: "P2", kind: "combo", fgCode: "2G", components: [{ sku: "S", qty: 2 }] }),
  ], SET);
  assert.equal(plan.skipped.length, 0, `unexpected: ${plan.skipped.join("; ")}`);
  assert.equal(plan.newBlocking.length, 0, "S exists in the same batch — it must not read as UNKNOWN_COMPONENT");
  const insert = plan.writes.find((w) => w.op === "insert_mapper" && w.row.master_sku === "P2");
  assert.ok(insert && insert.op === "insert_mapper");
  assert.deepEqual(insert.row.products, ["S", "S"]);
});

test("two drafts claiming the same FG code: the second is skipped", () => {
  const plan = planAddBatch({ skuMaster: [], mapperRows: [] }, [
    draft({ masterSku: "A", fgCode: "DUP" }),
    draft({ masterSku: "B", fgCode: "DUP" }),
  ], SET);
  assert.equal(plan.changes.filter((c) => c.action === "add" && c.target === "both").length, 1);
  assert.match(plan.skipped.join(), /B: FG code "DUP" is also claimed by "A"/,
    "per-row validation only checked the DB, so both would have passed");
});

test("an FG code already in the DB is skipped", () => {
  const live: LiveState = { skuMaster: [sm({ new_master_sku: "OLD", new_fg_code: "X1" })], mapperRows: [] };
  const plan = planAddBatch(live, [draft({ masterSku: "NEW", fgCode: "x1" })], SET);
  assert.match(plan.skipped.join(), /already belongs to "OLD"/, "FG comparison must be case-insensitive");
});

test("an existing SKU is skipped, not duplicated", () => {
  const live: LiveState = { skuMaster: [], mapperRows: [mr({ master_sku: "A" })] };
  assert.match(planAddBatch(live, [draft({ masterSku: "a" })], SET).skipped.join(), /already exists/);
});

test("the same SKU twice in one batch is skipped", () => {
  const plan = planAddBatch({ skuMaster: [], mapperRows: [] }, [draft({ masterSku: "A" }), draft({ masterSku: "A" })], SET);
  assert.match(plan.skipped.join(), /listed twice/);
});

test("a combo with no components is skipped; blank rows are ignored", () => {
  const plan = planAddBatch({ skuMaster: [], mapperRows: [] }, [
    draft({ masterSku: "C", kind: "combo", components: [] }),
    draft({ masterSku: "" }),
  ], SET);
  assert.match(plan.skipped.join(), /at least one component/);
  assert.equal(plan.writes.length, 0);
  assert.equal(plan.skipped.length, 1, "an untouched blank row is not an error");
});

test("a self-referencing combo is skipped", () => {
  const plan = planAddBatch({ skuMaster: [], mapperRows: [] },
    [draft({ masterSku: "C", kind: "combo", components: [{ sku: "C", qty: 1 }] })], SET);
  assert.match(plan.skipped.join(), /cannot contain itself/);
});

test("nested draft combos are flattened, and the flattening is reported", () => {
  const live: LiveState = { skuMaster: [], mapperRows: [mr({ master_sku: "A" })] };
  const plan = planAddBatch(live, [
    draft({ masterSku: "INNER", kind: "combo", components: [{ sku: "A", qty: 2 }] }),
    draft({ masterSku: "OUTER", kind: "combo", components: [{ sku: "INNER", qty: 2 }] }),
  ], SET);
  const w = plan.writes.find((x) => x.op === "insert_mapper" && x.row.master_sku === "OUTER");
  assert.ok(w && w.op === "insert_mapper");
  assert.deepEqual(w.row.products, ["A", "A", "A", "A"], "2 x INNER x (2 x A); runConversion expands one level only");
  assert.match(plan.changes.map((c) => c.details).join(), /flattened/, "silent flattening would hide unit loss");
});

test("blast radius: adding a combo warns about an untouched MRP-less single", () => {
  const live: LiveState = {
    skuMaster: [sm({ new_master_sku: "S", new_fg_code: "1G" })], // no MRP
    mapperRows: [mr({ master_sku: "S", fg_code: "1G" })],
  };
  const plan = planAddBatch(live, [draft({ masterSku: "C", kind: "combo", fgCode: "2G", components: [{ sku: "S", qty: 1 }] })], SET);
  const hit = plan.impact.find((d) => d.masterSku === "S");
  assert.ok(hit, "S is not in the draft, but the draft breaks it — the admin must see that");
  assert.deepEqual(hit!.added.map((i) => i.code), ["NO_MRP"]);
});

test("planHash: REGRESSION — an all-new batch is not hashed as empty", () => {
  // Hashing only the live rows matching the touched keys gave every all-new launch
  // the hash of the empty string (FNV offset basis 811c9dc5), so the staleness
  // check silently did nothing for additions — the exact case it exists for.
  const empty: LiveState = { skuMaster: [], mapperRows: [] };
  const d = [draft({ masterSku: "NEW_A", fgCode: "1G" })];
  const h1 = planAddBatch(empty, d, SET).planHash;
  assert.notEqual(h1, "811c9dc5", "hash of the empty string — absence must be hashed explicitly");

  // Two different all-new batches must not collide.
  const h2 = planAddBatch(empty, [draft({ masterSku: "NEW_B", fgCode: "2G" })], SET).planHash;
  assert.notEqual(h1, h2);

  // Someone else creating the SKU between preview and apply MUST move the hash.
  const raced: LiveState = { skuMaster: [sm({ new_master_sku: "NEW_A" })], mapperRows: [mr({ master_sku: "NEW_A" })] };
  assert.notEqual(planAddBatch(raced, d, SET).planHash, h1, "absent -> present must invalidate the plan");
});

test("planHash tracks only the rows the plan depends on", () => {
  const base: LiveState = { skuMaster: [sm({ new_master_sku: "S", new_fg_code: "1G", mrp: 10 })], mapperRows: [mr({ master_sku: "S" })] };
  const d = [draft({ masterSku: "C", kind: "combo", components: [{ sku: "S", qty: 1 }] })];
  const h1 = planAddBatch(base, d, SET).planHash;

  const unrelated: LiveState = { skuMaster: [...base.skuMaster, sm({ new_master_sku: "ZZZ", mrp: 5 })], mapperRows: [...base.mapperRows, mr({ master_sku: "ZZZ" })] };
  assert.equal(planAddBatch(unrelated, d, SET).planHash, h1, "an unrelated SKU must not invalidate the plan, or admins learn to ignore 409s");

  const touchedChanged: LiveState = { skuMaster: [sm({ new_master_sku: "S", new_fg_code: "1G", mrp: 999 })], mapperRows: base.mapperRows };
  assert.notEqual(planAddBatch(touchedChanged, d, SET).planHash, h1, "S's MRP changed and the plan depends on S");
});

// ── planFix ──────────────────────────────────────────────────────────────────

test("Fix on an orphan creates the missing mapper row only", () => {
  const live: LiveState = { skuMaster: [sm({ new_master_sku: "A", new_fg_code: "1G" })], mapperRows: [] };
  const plan = planFix(live, "A", SET);
  assert.deepEqual(plan.writes.map((w) => w.op), ["insert_mapper"]);
  assert.equal(plan.impact.find((d) => d.masterSku === "A")?.removed[0].code, "ORPHAN");
});

test("Fix on a mapper-only single creates the missing SKU Master row", () => {
  const live: LiveState = { skuMaster: [], mapperRows: [mr({ master_sku: "A", fg_code: "1G" })] };
  assert.deepEqual(planFix(live, "A", SET).writes.map((w) => w.op), ["insert_sku_master"]);
});

test("Fix on a healthy row is a no-op", () => {
  const live: LiveState = { skuMaster: [sm({ new_master_sku: "A" })], mapperRows: [mr({ master_sku: "A" })] };
  const plan = planFix(live, "A", SET);
  assert.equal(plan.writes.length, 0);
  assert.match(plan.skipped.join(), /already present in both/);
});

// ── planCellEdit ─────────────────────────────────────────────────────────────

test("editing FG code writes every copy that exists", () => {
  const live: LiveState = { skuMaster: [sm({ new_master_sku: "A", new_fg_code: "OLD" })], mapperRows: [mr({ master_sku: "A", fg_code: "OLD" })] };
  const ops = planCellEdit(live, "A", "fgCode", "NEW", SET).writes.map((w) => w.op).sort();
  assert.deepEqual(ops, ["update_mapper", "update_sku_master"],
    "FG code is denormalised across both tables; updating one leaves the grid and the converter disagreeing");
});

test("an FG code owned by another SKU is refused", () => {
  const live: LiveState = { skuMaster: [sm({ new_master_sku: "A" }), sm({ new_master_sku: "B", new_fg_code: "TAKEN" })], mapperRows: [] };
  const plan = planCellEdit(live, "A", "fgCode", "taken", SET);
  assert.equal(plan.writes.length, 0);
  assert.match(plan.skipped.join(), /already belongs to "B"/);
});

test("MRP without a SKU Master row is refused, not silently dropped", () => {
  const live: LiveState = { skuMaster: [], mapperRows: [mr({ master_sku: "A" })] };
  const plan = planCellEdit(live, "A", "mrp", "500", SET);
  assert.equal(plan.writes.length, 0);
  assert.match(plan.skipped.join(), /MRP lives in SKU Master/);
});

test("adding components auto-promotes a single to a combo", () => {
  const live: LiveState = { skuMaster: [], mapperRows: [mr({ master_sku: "C" }), mr({ master_sku: "A" })] };
  const w = planCellEdit(live, "C", "components", "A, A", SET).writes[0];
  assert.ok(w.op === "update_mapper");
  assert.equal(w.patch.is_combo, true);
  assert.deepEqual(w.patch.products, ["A", "A"]);
});

test("clearing components demotes a combo back to a single", () => {
  const live: LiveState = { skuMaster: [], mapperRows: [mr({ master_sku: "C", is_combo: true, products: ["A"] })] };
  const w = planCellEdit(live, "C", "components", "", SET).writes[0];
  assert.ok(w.op === "update_mapper");
  assert.equal(w.patch.is_combo, false, "a combo flag with no components is CRITICAL — never leave that state behind");
});

// ── planPurgeGhost ───────────────────────────────────────────────────────────

test("purging a ghost deletes its parent combos (the real production shape)", () => {
  // Mirrors Oats_NS_400G: a ghost with no row anywhere, used by parents that each
  // retain another component.
  const live: LiveState = {
    skuMaster: [],
    mapperRows: [
      mr({ master_sku: "Oats_Rolled_400G" }),
      mr({ master_sku: "P1", is_combo: true, products: ["GHOST", "Oats_Rolled_400G"] }),
      mr({ master_sku: "P2", is_combo: true, products: ["GHOST"] }),
    ],
  };
  const plan = planPurgeGhost(live, "GHOST");
  assert.deepEqual(plan.writes.map((w) => w.op), ["delete_mapper", "delete_mapper"]);
  assert.match(plan.changes.map((c) => c.details).join(), /survive independently/);
  const survivor = plan.impact.find((d) => d.masterSku === "Oats_Rolled_400G");
  assert.ok(!survivor?.added.length, "the surviving component must not gain a new issue");
});

test("purging deletes a parent's sku_master row too — never leaves an orphan", () => {
  const live: LiveState = {
    skuMaster: [sm({ new_master_sku: "P1", new_fg_code: "1G" })],
    mapperRows: [mr({ master_sku: "P1", is_combo: true, products: ["GHOST"] })],
  };
  const plan = planPurgeGhost(live, "GHOST");
  assert.deepEqual(plan.writes.map((w) => w.op).sort(), ["delete_mapper", "delete_sku_master"],
    "deleting only the mapper row would leave P1 in sku_master as a fresh orphan");
  assert.equal(plan.newBlocking.length, 0);
});

test("purging a non-existent ghost is a safe no-op", () => {
  const plan = planPurgeGhost({ skuMaster: [], mapperRows: [] }, "NOPE");
  assert.equal(plan.writes.length, 0);
  assert.match(plan.skipped.join(), /nothing references it/);
});

// ── planRetire ───────────────────────────────────────────────────────────────

test("retire is soft and KEEPS the mapper row", () => {
  const live: LiveState = {
    skuMaster: [sm({ new_master_sku: "A", new_fg_code: "1G", mrp: 5 })],
    mapperRows: [mr({ master_sku: "A" }), mr({ master_sku: "C", is_combo: true, products: ["A"] })],
  };
  const plan = planRetire(live, "A");
  assert.deepEqual(plan.writes.map((w) => w.op), ["retire_sku_master"],
    "removing the mapper row would re-create the orphan invisibility this work closed");
  assert.match(plan.changes[0].details, /1 combo\(s\) consume it: C/, "blast radius must be shown before confirming");
  assert.match(plan.changes[0].details, /forecast downloads silently omit inactive SKUs/);
});

test("retiring a SKU with no SKU Master row is refused", () => {
  const live: LiveState = { skuMaster: [], mapperRows: [mr({ master_sku: "A" })] };
  assert.match(planRetire(live, "A").skipped.join(), /no SKU Master row/);
});

// ── planHardDelete ───────────────────────────────────────────────────────────

test("hard delete is refused while any combo consumes the SKU", () => {
  const live: LiveState = {
    skuMaster: [sm({ new_master_sku: "A" })],
    mapperRows: [mr({ master_sku: "A" }), mr({ master_sku: "C", is_combo: true, products: ["A"] })],
  };
  const plan = planHardDelete(live, "A", NO_REFS);
  assert.equal(plan.writes.length, 0);
  assert.match(plan.skipped.join(), /consumed by 1 combo/);
});

test("hard delete is refused while ANY table references the SKU", () => {
  const live: LiveState = { skuMaster: [sm({ new_master_sku: "A" })], mapperRows: [mr({ master_sku: "A" })] };
  const plan = planHardDelete(live, "A", { ...NO_REFS, historical_forecast_data: 12 });
  assert.equal(plan.writes.length, 0);
  assert.match(plan.skipped.join(), /historical_forecast_data \(12\)/);
  assert.match(plan.skipped.join(), /Retire it instead/);
});

test("an unreferenced SKU deletes from both tables", () => {
  const live: LiveState = { skuMaster: [sm({ new_master_sku: "A" })], mapperRows: [mr({ master_sku: "A" })] };
  const plan = planHardDelete(live, "A", NO_REFS);
  assert.deepEqual(plan.writes.map((w) => w.op).sort(), ["delete_mapper", "delete_sku_master"]);
});

test("hard delete removes duplicates and spans every set", () => {
  const live: LiveState = {
    skuMaster: [],
    mapperRows: [
      mr({ master_sku: "A", mapper_set_id: "s1" }),
      mr({ master_sku: "A", mapper_set_id: "s1" }), // buildRows hides this one
      mr({ master_sku: "A", mapper_set_id: "s2" }),
    ],
  };
  const plan = planHardDelete(live, "A", NO_REFS);
  const sets = plan.writes.filter((w) => w.op === "delete_mapper").map((w) => (w as { mapperSetId: string }).mapperSetId).sort();
  assert.deepEqual(sets, ["s1", "s2"], "deleting by the id the grid holds would leave the duplicate and the other set behind");
  assert.deepEqual(plan.mapperSetIds.sort(), ["s1", "s2"], "both sets must be recounted");
});
