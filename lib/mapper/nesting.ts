// Nested-combo flattening. Pure — no React, no Supabase.
//
// Extracted from app/combo-converter/page.tsx findNestedCombos (~1511), which was
// the only copy with a cycle guard (fg-codes has two other copies: one that loops
// forever on A→B→A, one that only resolves a single level).
//
// Why this matters: runConversion expands ONE level only. A combo whose products
// reference another combo silently loses units. Every incremental write path
// (row editor, add combo, bulk confirm, suggestion approve, Studio) writes
// `products` verbatim and never flattens — so nesting can be introduced at any time.
//
// FIXED vs the original: the original shared one `visited` Set across sibling
// components, so products ["A","A"] with A a combo expanded the first A and left
// the second as a literal "A" — silent quantity loss. Cycle detection must track
// the ancestor PATH (who am I nested inside), not "everything seen anywhere".

export type NestRow = { master_sku: string; is_combo: boolean; products: string[] };
export type NestFix = { master_sku: string; resolved: string[]; expanded: string[] };

const norm = (s: string) => (s || "").trim().toLowerCase();

/** Multiset equality — component order is meaningless, but multiplicity is not
 *  (["A","A"] means 2×A, so we cannot compare Sets). */
function sameMultiset(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((v, i) => v === y[i]);
}

/**
 * Flatten a combo's components until every entry is a non-combo SKU.
 * `path` is the ancestor chain; a component already in it is a cycle and is
 * emitted verbatim rather than followed.
 */
function flattenProducts(
  products: string[],
  combos: Map<string, NestRow>,
  path: string[]
): { out: string[]; expanded: string[] } {
  const out: string[] = [];
  const expanded: string[] = [];
  for (const p of products) {
    if (!p || !p.trim()) continue;
    const key = norm(p);
    const nested = combos.get(key);
    // Not a combo, or following it would close a cycle -> emit as-is.
    if (!nested || path.includes(key)) {
      out.push(p);
      continue;
    }
    expanded.push(p);
    // Fresh path per branch: a SKU may legitimately appear under two different
    // parents, and it must expand under each.
    const child = flattenProducts(nested.products || [], combos, [...path, key]);
    out.push(...child.out);
    expanded.push(...child.expanded);
  }
  return { out, expanded };
}

/** Combos whose stored `products` differ from their fully-flattened form. */
export function findNestedCombos(rows: NestRow[]): NestFix[] {
  const combos = new Map<string, NestRow>();
  for (const r of rows) {
    const k = norm(r.master_sku);
    // Duplicate master_sku rows exist; prefer the one carrying components.
    const prev = combos.get(k);
    if (r.is_combo && (!prev || (r.products?.length || 0) > (prev.products?.length || 0))) combos.set(k, r);
  }

  const fixes: NestFix[] = [];
  for (const r of rows) {
    if (!r.is_combo) continue;
    const current = (r.products || []).filter((p) => p && p.trim());
    const { out, expanded } = flattenProducts(current, combos, [norm(r.master_sku)]);
    if (!sameMultiset(current, out)) {
      fixes.push({ master_sku: r.master_sku, resolved: out, expanded: [...new Set(expanded)] });
    }
  }
  return fixes;
}

/** Flatten one draft combo against known combos — for previewing a launch before
 *  anything is written. `extra` lets combos created in the same session resolve. */
export function flattenOne(products: string[], rows: NestRow[], selfSku = ""): { resolved: string[]; expanded: string[] } {
  const combos = new Map<string, NestRow>();
  for (const r of rows) if (r.is_combo) combos.set(norm(r.master_sku), r);
  const { out, expanded } = flattenProducts(products, combos, selfSku ? [norm(selfSku)] : []);
  return { resolved: out, expanded: [...new Set(expanded)] };
}

/** Reference cycles among combos (A→B→A). Any cycle is unresolvable data. */
export function findCycles(rows: NestRow[]): string[][] {
  const combos = new Map<string, NestRow>();
  for (const r of rows) if (r.is_combo) combos.set(norm(r.master_sku), r);
  const cycles: string[][] = [];
  const state = new Map<string, 1 | 2>(); // 1 = on stack, 2 = fully explored
  function walk(k: string, stack: string[]) {
    if (state.get(k) === 1) { cycles.push([...stack.slice(stack.indexOf(k)), k]); return; }
    if (state.get(k) === 2) return;
    state.set(k, 1);
    for (const p of combos.get(k)?.products || []) if (p && combos.has(norm(p))) walk(norm(p), [...stack, k]);
    state.set(k, 2);
  }
  for (const k of combos.keys()) walk(k, []);
  return cycles;
}
