/**
 * Tests for the pure mapper core. No network, no DB — fixtures only.
 *
 *   npm test
 *
 * (Live-data assertions live in the doctor: `npm run doctor`. These two are
 *  complements — the doctor tells you what production looks like, this tells you
 *  the logic reading it is right.)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { buildRows, diffIssues, isBlocking, type SkuMasterRow, type MapperDbRow } from "../lib/mapper/model";
import { findNestedCombos, findCycles, flattenOne } from "../lib/mapper/nesting";

// ── fixture builders ─────────────────────────────────────────────────────────
let seq = 0;
const sm = (o: Partial<SkuMasterRow> & { new_master_sku: string }): SkuMasterRow => ({
  id: `sm-${++seq}`, new_fg_code: null, product_name: null, mrp: null,
  is_active: true, discontinued_at: null, ...o,
});
const mr = (o: Partial<MapperDbRow> & { master_sku: string }): MapperDbRow => ({
  id: `mr-${++seq}`, mapper_set_id: "set-1", is_combo: false, products: [],
  fg_code: null, product_name: null, ...o,
});
/** Issue codes for one row, sorted. Returns string[] rather than IssueCode[] so the
 *  "row missing" sentinel doesn't collapse .includes() to never. */
const codes = (rows: ReturnType<typeof buildRows>, sku: string): string[] => {
  const row = rows.find((r) => r.masterSku === sku);
  if (!row) return ["<<ROW MISSING>>"];
  return row.issues.map((i) => String(i.code)).sort();
};

// ── buildRows: the union ─────────────────────────────────────────────────────

test("a SKU in both tables is healthy", () => {
  const rows = buildRows(
    [sm({ new_master_sku: "A", new_fg_code: "1G", mrp: 100 })],
    [mr({ master_sku: "A" })]
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(codes(rows, "A"), []);
  assert.equal(isBlocking(rows[0]), false);
});

test("ORPHAN: in sku_master but not in the mapper — the reported bug", () => {
  const rows = buildRows([sm({ new_master_sku: "A", new_fg_code: "1G" })], []);
  assert.deepEqual(codes(rows, "A"), ["ORPHAN"]);
  assert.equal(isBlocking(rows[0]), true, "an orphan is invisible to the converter — must block");
});

test("GHOST: referenced by a combo but defined in neither table", () => {
  const rows = buildRows([], [mr({ master_sku: "C", is_combo: true, products: ["X"] })]);
  assert.deepEqual(codes(rows, "X"), ["GHOST"],
    "a ghost has no row anywhere — telling the admin it also lacks an FG code is noise");
  const ghost = rows.find((r) => r.masterSku === "X")!;
  assert.equal(ghost.inMapper, false);
  assert.equal(ghost.inSkuMaster, false);
  assert.equal(ghost.skuMasterId, null, "a ghost has no row to delete — deletion must target its parents");
});

test("CRITICAL: is_combo with no components cannot expand", () => {
  const rows = buildRows([sm({ new_master_sku: "C", new_fg_code: "9G" })], [mr({ master_sku: "C", is_combo: true, products: [] })]);
  assert.ok(codes(rows, "C").includes("CRITICAL"));
});

test("no row is ever both ORPHAN and GHOST", () => {
  const rows = buildRows(
    [sm({ new_master_sku: "A" })],
    [mr({ master_sku: "C", is_combo: true, products: ["X"] })]
  );
  for (const r of rows) {
    const c = r.issues.map((i) => i.code);
    assert.ok(!(c.includes("ORPHAN") && c.includes("GHOST")), `${r.masterSku} is both`);
  }
});

test("mapper-only singles are UNENRICHED, never orphans", () => {
  const rows = buildRows([], [mr({ master_sku: "A", fg_code: "1G" })]);
  assert.deepEqual(codes(rows, "A"), ["UNENRICHED"], "sku_master is not the existence table; absence from it is not a defect");
  assert.equal(isBlocking(rows[0]), false);
});

test("UNENRICHED replaces NO_FG + NO_MRP, it does not stack with them", () => {
  // ~484 legacy mapper rows have no sku_master row. They have no FG and no MRP by
  // construction — one fact. Reporting three badges made the grid unreadable.
  const rows = buildRows([], [mr({ master_sku: "A" }), mr({ master_sku: "C", is_combo: true, products: ["A"] })]);
  assert.deepEqual(codes(rows, "A"), ["UNENRICHED"]);
});

test("NO_MRP fires only for an enriched single a combo consumes", () => {
  const live = [sm({ new_master_sku: "S", new_fg_code: "1G" })]; // has a row, lacks MRP
  const rows = buildRows(live, [mr({ master_sku: "S", fg_code: "1G" }), mr({ master_sku: "C", is_combo: true, products: ["S"], fg_code: "2G" })]);
  assert.deepEqual(codes(rows, "S"), ["NO_MRP"]);
  // Export-only SKUs never reach NTO, so the detail must say the flag is conditional
  const detail = rows.find((r) => r.masterSku === "S")!.issues[0].detail;
  assert.match(detail, /Qty conversion and exports are unaffected/);
});

// ── usedIn: the reverse index ────────────────────────────────────────────────

test("usedIn counts multiplicity — products ['A','A'] means 2xA", () => {
  const rows = buildRows(
    [sm({ new_master_sku: "A", mrp: 10 })],
    [mr({ master_sku: "A" }), mr({ master_sku: "P2", is_combo: true, products: ["A", "A"] })]
  );
  const a = rows.find((r) => r.masterSku === "A")!;
  assert.deepEqual(a.usedIn, [{ sku: "P2", qty: 2 }]);
});

test("usedIn: REGRESSION — duplicate combo rows do not double-count", () => {
  // The real EB_VP_30G: two identical mapper rows, each 3 x EB_VP_10G. Truth is x3.
  // Iterating the raw row list counted both copies and reported x6 — which would
  // have inflated the grid, the retire blast radius and the delete gate.
  const rows = buildRows([], [
    mr({ master_sku: "EB_VP_10G" }),
    mr({ master_sku: "EB_VP_30G", is_combo: true, products: ["EB_VP_10G", "EB_VP_10G", "EB_VP_10G"] }),
    mr({ master_sku: "EB_VP_30G", is_combo: true, products: ["EB_VP_10G", "EB_VP_10G", "EB_VP_10G"] }),
  ]);
  assert.deepEqual(rows.find((r) => r.masterSku === "EB_VP_10G")!.usedIn, [{ sku: "EB_VP_30G", qty: 3 }]);
});

test("usedIn aggregates across parents — the real UW_Plain_500G shape", () => {
  const rows = buildRows(
    [sm({ new_master_sku: "UW", new_fg_code: "21101N", mrp: 2099 })],
    [
      mr({ master_sku: "UW" }),
      mr({ master_sku: "P2", is_combo: true, products: ["UW", "UW"] }),
      mr({ master_sku: "P3", is_combo: true, products: ["UW", "UW", "UW"] }),
      mr({ master_sku: "MIX", is_combo: true, products: ["UW", "OTHER"] }),
    ]
  );
  const uw = rows.find((r) => r.masterSku === "UW")!;
  assert.deepEqual(uw.usedIn, [{ sku: "MIX", qty: 1 }, { sku: "P2", qty: 2 }, { sku: "P3", qty: 3 }]);
});

test("NO_MRP only fires for singles a combo actually consumes", () => {
  const rows = buildRows(
    [sm({ new_master_sku: "LONE", new_fg_code: "1G" }), sm({ new_master_sku: "USED", new_fg_code: "2G" })],
    [mr({ master_sku: "LONE" }), mr({ master_sku: "USED" }), mr({ master_sku: "C", is_combo: true, products: ["USED"], fg_code: "3G" })]
  );
  assert.ok(!codes(rows, "LONE").includes("NO_MRP"), "an unused single needs no MRP");
  assert.ok(codes(rows, "USED").includes("NO_MRP"), "NTO splits by MRP ratio — a consumed single without one blocks its combos");
});

test("discontinued components warn but never block", () => {
  const rows = buildRows(
    [sm({ new_master_sku: "OLD", new_fg_code: "1G", mrp: 5, is_active: false, discontinued_at: "2026-01-01" })],
    [mr({ master_sku: "OLD" }), mr({ master_sku: "C", is_combo: true, products: ["OLD"], fg_code: "2G" })]
  );
  assert.ok(codes(rows, "C").includes("DISCONTINUED_IN_COMBO"));
  assert.equal(isBlocking(rows.find((r) => r.masterSku === "C")!), false);
  assert.ok(!codes(rows, "OLD").includes("NO_FG"), "a discontinued SKU is not nagged for an FG code");
});

test("REGRESSION — one issue per distinct component, not per unit", () => {
  // products carries multiplicity, so a 3-pack of a discontinued single used to
  // raise DISCONTINUED_IN_COMBO three times: three identical badges, and every
  // count reading issues was inflated.
  const rows = buildRows(
    [
      sm({ new_master_sku: "OLD", new_fg_code: "1G", mrp: 5, is_active: false, discontinued_at: "2026-01-01" }),
      sm({ new_master_sku: "P3", new_fg_code: "2G", mrp: 15 }), // enriched, so UNENRICHED doesn't mask the assertion
    ],
    [mr({ master_sku: "OLD" }), mr({ master_sku: "P3", is_combo: true, products: ["OLD", "OLD", "OLD"], fg_code: "2G" })]
  );
  assert.deepEqual(codes(rows, "P3"), ["DISCONTINUED_IN_COMBO"]);
});

test("duplicate master_sku rows collapse, preferring the one with components", () => {
  const rows = buildRows([], [
    mr({ master_sku: "D", is_combo: true, products: [] }),
    mr({ master_sku: "D", is_combo: true, products: ["A", "B"] }),
  ]);
  const d = rows.filter((r) => r.masterSku === "D");
  assert.equal(d.length, 1, "165 duplicates exist in production; the grid must show one row");
  assert.deepEqual(d[0].products, ["A", "B"]);
});

test("SKU matching is case-insensitive across tables", () => {
  const rows = buildRows([sm({ new_master_sku: "Abc", new_fg_code: "1G", mrp: 1 })], [mr({ master_sku: "aBC" })]);
  assert.equal(rows.length, 1);
  assert.deepEqual(codes(rows, "aBC"), [], "differing case must not manufacture an orphan + a ghost");
});

// ── diffIssues: the blast radius ─────────────────────────────────────────────

test("diffIssues surfaces harm to rows the change never touched", () => {
  const master = [sm({ new_master_sku: "S", new_fg_code: "1G" })]; // no MRP
  const before = buildRows(master, [mr({ master_sku: "S" })]);
  const after = buildRows(master, [mr({ master_sku: "S" }), mr({ master_sku: "NEW", is_combo: true, products: ["S"], fg_code: "2G" })]);

  assert.ok(!codes(before, "S").includes("NO_MRP"));
  const delta = diffIssues(before, after).find((d) => d.masterSku === "S");
  assert.ok(delta, "adding NEW gave the untouched single S a new problem — the admin must see this");
  assert.deepEqual(delta!.added.map((i) => i.code), ["NO_MRP"]);
});

test("diffIssues reports issues cleared by a fix", () => {
  const master = [sm({ new_master_sku: "A", new_fg_code: "1G" })];
  const before = buildRows(master, []);
  const after = buildRows(master, [mr({ master_sku: "A" })]);
  const delta = diffIssues(before, after).find((d) => d.masterSku === "A")!;
  assert.deepEqual(delta.removed.map((i) => i.code), ["ORPHAN"]);
});

test("diffIssues counts a deleted row's issues as removed", () => {
  const before = buildRows([], [mr({ master_sku: "C", is_combo: true, products: [] })]);
  const after = buildRows([], []);
  const delta = diffIssues(before, after).find((d) => d.masterSku === "C")!;
  assert.ok(delta.removed.map((i) => i.code).includes("CRITICAL"));
});

// ── nesting ──────────────────────────────────────────────────────────────────

test("nesting: a combo of combos flattens to leaf singles", () => {
  const fixes = findNestedCombos([
    { master_sku: "A", is_combo: false, products: [] },
    { master_sku: "B", is_combo: false, products: [] },
    { master_sku: "INNER", is_combo: true, products: ["A", "B"] },
    { master_sku: "OUTER", is_combo: true, products: ["INNER"] },
  ]);
  const outer = fixes.find((f) => f.master_sku === "OUTER")!;
  assert.deepEqual(outer.resolved.sort(), ["A", "B"]);
  assert.deepEqual(outer.expanded, ["INNER"]);
});

test("nesting: REGRESSION — repeated nested combo expands every time", () => {
  // The original shared one `visited` Set across siblings, so the 2nd INNER was
  // emitted as a literal "INNER" instead of expanding: silent quantity loss.
  const fixes = findNestedCombos([
    { master_sku: "A", is_combo: false, products: [] },
    { master_sku: "INNER", is_combo: true, products: ["A", "A"] },
    { master_sku: "OUTER", is_combo: true, products: ["INNER", "INNER"] },
  ]);
  const outer = fixes.find((f) => f.master_sku === "OUTER")!;
  assert.deepEqual(outer.resolved, ["A", "A", "A", "A"], "2 x INNER x (2 x A) = 4 x A");
  assert.ok(!outer.resolved.includes("INNER"), "no literal combo SKU may survive flattening");
});

test("nesting: a SKU under two different parents expands under both", () => {
  const { resolved } = flattenOne(["I1", "I2"], [
    { master_sku: "I1", is_combo: true, products: ["A"] },
    { master_sku: "I2", is_combo: true, products: ["A"] },
  ]);
  assert.deepEqual(resolved, ["A", "A"], "per-branch paths, not one global visited set");
});

test("nesting: flat combos are left alone", () => {
  const fixes = findNestedCombos([
    { master_sku: "A", is_combo: false, products: [] },
    { master_sku: "C", is_combo: true, products: ["A", "A"] },
  ]);
  assert.deepEqual(fixes, [], "production has 0 nested combos — this must stay a no-op");
});

test("nesting: a cycle terminates instead of hanging", () => {
  const rows = [
    { master_sku: "A", is_combo: true, products: ["B"] },
    { master_sku: "B", is_combo: true, products: ["A"] },
  ];
  const cycles = findCycles(rows);
  assert.ok(cycles.length > 0, "A->B->A must be reported");
  findNestedCombos(rows); // must return, not stack-overflow
});

test("nesting: self-reference terminates", () => {
  const rows = [{ master_sku: "S", is_combo: true, products: ["S", "A"] }];
  const fixes = findNestedCombos(rows);
  assert.ok(Array.isArray(fixes));
});
