"use client";
import { useEffect, useState, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import * as XLSX from "xlsx";

type ComboRow = {
  id: string;
  mapper_set_id: string;
  master_sku: string;
  is_combo: boolean;
  products: string[];
  fg_code: string | null;
  product_name: string | null;
};

type SingleSku = {
  id: string;
  new_master_sku: string;
  new_fg_code: string;
  product_name: string;
};

type MapperSet = { id: string; name: string; is_default: boolean };

type Suggestion = {
  id: string;
  master_sku: string;
  is_combo: boolean;
  products: string[];
  suggested_fg_code: string | null;
  notes: string | null;
  submitted_by_email: string;
  status: string;
  created_at: string;
};

type UniqueCombo = {
  master_sku: string;
  fg_code: string | null;
  product_name: string | null;
  is_combo: boolean;
  products: string[];
  setName: string;
  mapper_set_id: string;
  componentNames: string[];
};

type AddComponent = { sku: string; qty: number; resolved: string | null };

export default function FGCodeManagerPage() {
  const [tab, setTab] = useState<"combos" | "singles" | "suggestions">("combos");
  const [comboRows, setComboRows] = useState<ComboRow[]>([]);
  const [singles, setSingles] = useState<SingleSku[]>([]);
  const [mapperSets, setMapperSets] = useState<MapperSet[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [editingRow, setEditingRow] = useState<Record<string, { fg_code: string; product_name: string; components: string }>>({});
  const [saving, setSaving] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Add combo form state
  const [showAddForm, setShowAddForm] = useState(false);
  const [addMasterSku, setAddMasterSku] = useState("");
  const [addFgCode, setAddFgCode] = useState("");
  const [addProductName, setAddProductName] = useState("");
  const [addComponents, setAddComponents] = useState<AddComponent[]>([{ sku: "", qty: 1, resolved: null }]);
  const [statusFilter, setStatusFilter] = useState<"all" | "complete" | "incomplete">("all");
  const [bulkPreview, setBulkPreview] = useState<BulkPreview | null>(null);

  type BulkChange = {
    sku: string;
    action: "update" | "add" | "delete" | "no_change";
    details: string;
    fg?: string;
    name?: string;
    components?: string[];
  };
  type BulkPreview = {
    changes: BulkChange[];
    skipped: string[];
    rawRows: any[];
  };
  const fileInputRef = useRef<HTMLInputElement>(null);
  const supabase = createClient();

  useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    setLoading(true);
    const [combosRes, singlesRes, setsRes, suggestionsRes] = await Promise.all([
      fetchAllPaginated("combo_mapper_rows", "id, mapper_set_id, master_sku, is_combo, products, fg_code, product_name"),
      fetchAllPaginated("sku_master", "id, new_master_sku, new_fg_code, product_name"),
      supabase.from("combo_mapper_sets").select("id, name, is_default").order("name"),
      supabase.from("mapper_suggestions").select("*").eq("status", "pending").order("created_at", { ascending: false }),
    ]);
    setComboRows(combosRes);
    setSingles(singlesRes);
    setMapperSets(setsRes.data || []);
    setSuggestions(suggestionsRes.data || []);
    setLoading(false);
  }

  async function fetchAllPaginated(table: string, select: string) {
    const PAGE = 1000;
    let all: any[] = [];
    let from = 0;
    while (true) {
      const { data } = await supabase.from(table).select(select).range(from, from + PAGE - 1);
      if (!data || data.length === 0) break;
      all = all.concat(data);
      if (data.length < PAGE) break;
      from += PAGE;
    }
    return all;
  }

  // Build single name lookup
  const singleNameMap = new Map<string, string>();
  for (const s of singles) singleNameMap.set(s.new_master_sku.toLowerCase(), s.product_name);

  // Build combo lookup (for nested resolution)
  const comboLookup = new Map<string, ComboRow>();
  for (const r of comboRows) {
    if (r.is_combo && !comboLookup.has(r.master_sku.toLowerCase())) {
      comboLookup.set(r.master_sku.toLowerCase(), r);
    }
  }

  // Resolve a list of component SKUs — if any component is itself a combo, expand it to its singles
  function resolveComponents(products: string[], parentSku?: string): string[] {
    const resolved: string[] = [];
    for (const p of products) {
      const combo = comboLookup.get(p.toLowerCase());
      if (combo && combo.master_sku.toLowerCase() !== parentSku?.toLowerCase()) {
        // It's a combo — expand to its singles (recursive, but guard against self-reference)
        resolved.push(...resolveComponents(combo.products || [], combo.master_sku));
      } else {
        resolved.push(p);
      }
    }
    return resolved;
  }

  // Get unique combos (deduplicate by master_sku, prefer combos)
  function getUniqueCombos(): UniqueCombo[] {
    const map = new Map<string, UniqueCombo>();
    for (const r of comboRows) {
      if (!r.is_combo) continue; // Only show combos
      if (!map.has(r.master_sku)) {
        const set = mapperSets.find(s => s.id === r.mapper_set_id);
        // Auto-resolve nested combo components to their singles
        const resolvedProducts = resolveComponents(r.products || [], r.master_sku);
        const componentNames = resolvedProducts.map(p =>
          singleNameMap.get(p.toLowerCase()) || p
        );
        map.set(r.master_sku, {
          master_sku: r.master_sku,
          fg_code: r.fg_code,
          product_name: r.product_name,
          is_combo: r.is_combo,
          products: resolvedProducts,
          setName: set?.name || "",
          mapper_set_id: r.mapper_set_id,
          componentNames,
        });
      }
    }
    return [...map.values()].sort((a, b) => a.master_sku.localeCompare(b.master_sku));
  }

  // Check if a component SKU exists in singles master OR is a known combo
  function isValidComponent(sku: string): boolean {
    return singleNameMap.has(sku.toLowerCase()) || comboLookup.has(sku.toLowerCase());
  }

  // Get components that are neither in singles nor in combos — truly unknown SKUs
  function getInvalidComponents(products: string[]): string[] {
    return [...new Set(products)].filter(p => !isValidComponent(p));
  }


  function getComboStatus(c: UniqueCombo): "complete" | "partial" | "missing" {
    const hasFg = !!c.fg_code;
    const hasName = !!c.product_name;
    if (hasFg && hasName) return "complete";
    if (hasFg || hasName) return "partial";
    return "missing";
  }

  // Priority: CRITICAL rows (Combo=Yes + no components) first, then invalid components, then incomplete.
  function getComboSortPriority(c: UniqueCombo): number {
    if (c.is_combo && (!c.products || c.products.length === 0)) return -1; // CRITICAL — top
    const invalid = getInvalidComponents(c.products);
    if (invalid.length > 0) return 0;
    const status = getComboStatus(c);
    if (status === "missing") return 1;
    if (status === "partial") return 2;
    return 3;
  }

  // Validate FG code: must not belong to a single SKU, and must not be used by a different Master SKU
  function validateFgCode(fgCode: string, forMasterSku: string): string | null {
    if (!fgCode) return null; // Empty is OK (optional)
    const lower = fgCode.toLowerCase();
    // Check if this FG code belongs to a single SKU
    const matchedSingle = singles.find(s => (s.new_fg_code || "").toLowerCase() === lower);
    if (matchedSingle) {
      return `FG Code "${fgCode}" belongs to single SKU "${matchedSingle.new_master_sku}" (${matchedSingle.product_name}). Cannot use a single's FG code for a combo.`;
    }
    // Check if this FG code is already used by a different combo Master SKU
    const existingCombo = comboRows.find(r =>
      r.fg_code && r.fg_code.toLowerCase() === lower && r.master_sku.toLowerCase() !== forMasterSku.toLowerCase()
    );
    if (existingCombo) {
      return `FG Code "${fgCode}" is already assigned to combo "${existingCombo.master_sku}". The same FG Code cannot belong to different Master SKUs.`;
    }
    return null;
  }

  async function saveInlineEdit(masterSku: string) {
    const edit = editingRow[masterSku];
    if (!edit) return;
    // Validate FG code
    const fgError = validateFgCode(edit.fg_code, masterSku);
    if (fgError) { setError(fgError); return; }
    setSaving(true);
    setError(null);
    const newProducts = edit.components.split(",").map(p => p.trim()).filter(p => p);

    // Auto-correct SAFE direction only: products exist → force is_combo = true (silent fix, logged to audit).
    // DANGEROUS direction (Combo=Yes + no products) is BLOCKED — admin must resolve explicitly.
    const existingRow = comboRows.find(r => r.master_sku === masterSku);
    const currentIsCombo = existingRow?.is_combo ?? false;
    let correctedIsCombo = currentIsCombo;
    let correction: string | null = null;
    if (newProducts.length > 0 && !currentIsCombo) {
      correctedIsCombo = true;
      correction = `Combo: No → Yes (has ${newProducts.length} component(s))`;
    } else if (newProducts.length === 0 && currentIsCombo) {
      setError(`CRITICAL: "${masterSku}" is marked Combo=Yes but has no components. Add components, or explicitly uncheck Combo before saving.`);
      setSaving(false);
      return;
    }

    const { error: err } = await supabase
      .from("combo_mapper_rows")
      .update({ fg_code: edit.fg_code || null, product_name: edit.product_name || null, products: newProducts, is_combo: correctedIsCombo })
      .eq("master_sku", masterSku);
    if (err) {
      setError(`Failed to save: ${err.message}`);
    } else {
      // Audit log (includes any auto-correction)
      const { data: { user } } = await supabase.auth.getUser();
      await supabase.from("audit_log").insert({
        user_id: user?.id,
        user_email: user?.email,
        action: "mapper_row_update",
        table_name: "combo_mapper_rows",
        new_values: { master_sku: masterSku, is_combo: correctedIsCombo, products: newProducts, fg_code: edit.fg_code || null, auto_correction: correction },
      });
      setSuccessMsg(correction ? `Updated ${masterSku} · auto-corrected ${correction}` : `Updated ${masterSku}`);
      setEditingRow(prev => { const next = { ...prev }; delete next[masterSku]; return next; });
      setComboRows(prev => prev.map(r =>
        r.master_sku === masterSku ? { ...r, fg_code: edit.fg_code || null, product_name: edit.product_name || null, products: newProducts, is_combo: correctedIsCombo } : r
      ));
      setTimeout(() => setSuccessMsg(null), 4000);
    }
    setSaving(false);
  }

  async function deleteCombo(masterSku: string) {
    if (!confirm(`Delete combo "${masterSku}" from the mapper? This cannot be undone.`)) return;
    setSaving(true);
    setError(null);
    const { error: err } = await supabase
      .from("combo_mapper_rows")
      .delete()
      .eq("master_sku", masterSku);
    if (err) {
      setError(`Failed to delete: ${err.message}`);
    } else {
      setSuccessMsg(`Combo "${masterSku}" deleted.`);
      setComboRows(prev => prev.filter(r => r.master_sku !== masterSku));
      setTimeout(() => setSuccessMsg(null), 3000);
    }
    setSaving(false);
  }

  // Resolve nested combos in components
  function resolveComponent(sku: string, qty: number): { resolvedProducts: string[]; note: string | null } {
    const lower = sku.toLowerCase().trim();
    const combo = comboLookup.get(lower);
    if (combo && combo.products.length > 0) {
      // It's a combo — expand to its singles, multiply qty
      const expanded: string[] = [];
      for (let i = 0; i < qty; i++) {
        expanded.push(...combo.products);
      }
      return {
        resolvedProducts: expanded,
        note: `${sku} is a combo (${combo.products.length} singles) x${qty} = ${expanded.length} total components`,
      };
    }
    // It's a single — repeat qty times
    const repeated: string[] = [];
    for (let i = 0; i < qty; i++) repeated.push(sku);
    return { resolvedProducts: repeated, note: null };
  }

  async function handleAddCombo() {
    const sku = addMasterSku.trim();
    const fg = addFgCode.trim();
    const name = addProductName.trim();
    if (!sku) { setError("Master SKU is required."); return; }
    if (addComponents.every(c => !c.sku.trim())) { setError("At least one component SKU is required."); return; }
    // Validate FG code
    if (fg) {
      const fgError = validateFgCode(fg, sku);
      if (fgError) { setError(fgError); return; }
    }

    setSaving(true);
    setError(null);

    // Resolve all components (handle nested combos)
    const allProducts: string[] = [];
    for (const comp of addComponents) {
      if (!comp.sku.trim()) continue;
      const { resolvedProducts } = resolveComponent(comp.sku.trim(), comp.qty);
      allProducts.push(...resolvedProducts);
    }

    // Find default mapper set
    const defaultSet = mapperSets.find(s => s.is_default) || mapperSets[0];
    if (!defaultSet) { setError("No mapper set found. Upload a mapper first in Combo Converter."); setSaving(false); return; }

    const { error: err } = await supabase.from("combo_mapper_rows").insert({
      mapper_set_id: defaultSet.id,
      master_sku: sku,
      is_combo: true,
      products: allProducts,
      fg_code: fg || null,
      product_name: name || null,
    });

    if (err) {
      setError(`Failed: ${err.message}`);
    } else {
      setSuccessMsg(`Combo "${sku}" added with ${allProducts.length} component(s).`);
      setAddMasterSku("");
      setAddFgCode("");
      setAddProductName("");
      setAddComponents([{ sku: "", qty: 1, resolved: null }]);
      setShowAddForm(false);
      await loadAll();
      setTimeout(() => setSuccessMsg(null), 3000);
    }
    setSaving(false);
  }

  function downloadBulkTemplate() {
    const wb = XLSX.utils.book_new();
    const combos = getUniqueCombos();
    const rows: any[][] = [["Master SKU", "FG Code", "Product Name", "Components (comma-separated)", "Action"]];
    for (const c of combos) {
      rows.push([c.master_sku, c.fg_code || "", c.product_name || "", c.products.join(", "), ""]);
    }
    // Add 10 empty rows for new entries
    for (let i = 0; i < 10; i++) rows.push(["", "", "", "", ""]);
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{ wch: 24 }, { wch: 16 }, { wch: 36 }, { wch: 60 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws, "Combo FG Codes");
    XLSX.writeFile(wb, "Combo_FG_Code_Template.xlsx");
  }

  function downloadIncompleteRows() {
    const wb = XLSX.utils.book_new();
    const combos = getUniqueCombos();
    const incomplete = combos.filter(c => getComboStatus(c) !== "complete" || getInvalidComponents(c.products).length > 0);
    const rows: any[][] = [["Master SKU", "FG Code", "Product Name", "Components", "Action", "Issues"]];
    for (const c of incomplete) {
      const issues: string[] = [];
      if (!c.fg_code) issues.push("Missing FG Code");
      if (!c.product_name) issues.push("Missing Product Name");
      const invalid = getInvalidComponents(c.products);
      if (invalid.length > 0) issues.push(`Not in SKU Master: ${invalid.join(", ")}`);
      rows.push([c.master_sku, c.fg_code || "", c.product_name || "", c.products.join(", "), "", issues.join("; ")]);
    }
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{ wch: 24 }, { wch: 16 }, { wch: 36 }, { wch: 60 }, { wch: 12 }, { wch: 40 }];
    XLSX.utils.book_append_sheet(wb, ws, "Incomplete Combos");
    XLSX.writeFile(wb, "Incomplete_Combos.xlsx");
  }

  // Phase 1: Parse file and show preview
  function handleBulkUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const wb = XLSX.read(ev.target?.result, { type: "binary" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows: any[] = XLSX.utils.sheet_to_json(ws, { defval: "" });
        const changes: BulkChange[] = [];
        const skipped: string[] = [];

        for (const row of rows) {
          const sku = String(row["Master SKU"] || row["master_sku"] || "").trim();
          const fg = String(row["FG Code"] || row["fg_code"] || "").trim();
          const name = String(row["Product Name"] || row["product_name"] || "").trim();
          const componentsStr = String(row["Components (comma-separated)"] || row["Components"] || "").trim();
          const action = String(row["Action"] || row["action"] || "").trim().toLowerCase();
          if (!sku) continue;

          if (action === "delete") {
            const existing = comboRows.find(r => r.master_sku.toLowerCase() === sku.toLowerCase() && r.is_combo);
            if (existing) {
              changes.push({ sku, action: "delete", details: `Delete combo "${sku}"` });
            }
            continue;
          }

          if (fg) {
            const fgErr = validateFgCode(fg, sku);
            if (fgErr) { skipped.push(`${sku}: ${fgErr}`); continue; }
          }

          const existing = comboRows.find(r => r.master_sku.toLowerCase() === sku.toLowerCase() && r.is_combo);
          if (existing) {
            const parts: string[] = [];
            if (fg && fg !== (existing.fg_code || "")) parts.push(`FG: ${existing.fg_code || "(empty)"} → ${fg}`);
            if (name && name !== (existing.product_name || "")) parts.push(`Name: ${existing.product_name || "(empty)"} → ${name}`);
            if (parts.length > 0) {
              changes.push({ sku, action: "update", details: parts.join(", "), fg, name });
            } else {
              changes.push({ sku, action: "no_change", details: "No edits" });
            }
          } else if (componentsStr) {
            const products = componentsStr.split(",").map(p => p.trim()).filter(p => p);
            if (products.length > 0) {
              changes.push({ sku, action: "add", details: `New combo with ${products.length} components${fg ? `, FG: ${fg}` : ""}${name ? `, Name: ${name}` : ""}`, fg, name, components: products });
            }
          }
        }

        const actionableChanges = changes.filter(c => c.action !== "no_change");
        if (actionableChanges.length === 0 && skipped.length === 0) {
          setError("No changes detected in the uploaded file.");
          return;
        }

        setBulkPreview({ changes, skipped, rawRows: rows });
      } catch {
        setError("Failed to parse the uploaded file.");
      }
    };
    reader.readAsBinaryString(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // Phase 2: Execute confirmed changes
  async function confirmBulkUpload() {
    if (!bulkPreview) return;
    setSaving(true);
    setError(null);
    const defaultSet = mapperSets.find(s => s.is_default) || mapperSets[0];
    let updated = 0, added = 0, deleted = 0;

    for (const change of bulkPreview.changes) {
      if (change.action === "delete") {
        const { error: err } = await supabase.from("combo_mapper_rows").delete().eq("master_sku", change.sku);
        if (!err) deleted++;
      } else if (change.action === "update") {
        const existing = comboRows.find(r => r.master_sku.toLowerCase() === change.sku.toLowerCase() && r.is_combo);
        if (existing) {
          const updates: any = {};
          if (change.fg) updates.fg_code = change.fg;
          if (change.name) updates.product_name = change.name;
          if (Object.keys(updates).length > 0) {
            const { error: err } = await supabase.from("combo_mapper_rows").update(updates).eq("master_sku", existing.master_sku);
            if (!err) updated++;
          }
        }
      } else if (change.action === "add" && change.components && defaultSet) {
        const { error: err } = await supabase.from("combo_mapper_rows").insert({
          mapper_set_id: defaultSet.id,
          master_sku: change.sku,
          is_combo: true,
          products: change.components,
          fg_code: change.fg || null,
          product_name: change.name || null,
        });
        if (!err) added++;
      }
    }

    const msg = `Bulk import complete: ${updated} updated, ${added} added, ${deleted} deleted.${bulkPreview.skipped.length > 0 ? ` ${bulkPreview.skipped.length} skipped.` : ""}`;
    setSuccessMsg(msg);
    if (bulkPreview.skipped.length > 0) setError(`Skipped rows:\n${bulkPreview.skipped.join("\n")}`);
    setTimeout(() => setSuccessMsg(null), 4000);
    setBulkPreview(null);
    setSaving(false);
    await loadAll();
  }

  async function approveSuggestion(id: string) {
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from("mapper_suggestions").update({
      status: "approved",
      reviewed_by: user?.id,
      reviewed_at: new Date().toISOString(),
    }).eq("id", id);
    setSuggestions(prev => prev.filter(s => s.id !== id));
    setSuccessMsg("Suggestion approved.");
    setTimeout(() => setSuccessMsg(null), 3000);
  }

  async function rejectSuggestion(id: string) {
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from("mapper_suggestions").update({
      status: "rejected",
      reviewed_by: user?.id,
      reviewed_at: new Date().toISOString(),
    }).eq("id", id);
    setSuggestions(prev => prev.filter(s => s.id !== id));
    setSuccessMsg("Suggestion rejected.");
    setTimeout(() => setSuccessMsg(null), 3000);
  }

  const uniqueCombos = getUniqueCombos();
  const filteredCombos = uniqueCombos.filter(c => {
    const matchesSearch = !searchTerm ||
      c.master_sku.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (c.fg_code || "").toLowerCase().includes(searchTerm.toLowerCase()) ||
      (c.product_name || "").toLowerCase().includes(searchTerm.toLowerCase()) ||
      c.componentNames.some(n => n.toLowerCase().includes(searchTerm.toLowerCase()));
    if (!matchesSearch) return false;
    if (statusFilter === "complete") return getComboStatus(c) === "complete";
    if (statusFilter === "incomplete") return getComboStatus(c) !== "complete";
    return true;
  }).sort((a, b) => getComboSortPriority(a) - getComboSortPriority(b));
  const invalidComponentCount = uniqueCombos.filter(c => getInvalidComponents(c.products).length > 0).length;
  const filteredSingles = singles.filter(s =>
    s.new_master_sku.toLowerCase().includes(searchTerm.toLowerCase()) ||
    s.new_fg_code.toLowerCase().includes(searchTerm.toLowerCase()) ||
    s.product_name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const completeCount = uniqueCombos.filter(c => getComboStatus(c) === "complete").length;
  const incompleteCount = uniqueCombos.length - completeCount;
  // CRITICAL: combos flagged is_combo=true but with no component SKUs (data integrity failure).
  const criticalCombos = uniqueCombos.filter(c => c.is_combo && (!c.products || c.products.length === 0));

  if (loading) {
    return <div className="flex items-center justify-center h-64"><p className="text-atlas-ink-muted">Loading...</p></div>;
  }

  return (
    <div>
      {/* Bulk Upload Confirmation Modal */}
      {bulkPreview && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
          <div className="bg-atlas-surface border border-atlas-line rounded-xl max-w-2xl w-full max-h-[80vh] flex flex-col">
            <div className="p-5 border-b border-atlas-line">
              <h3 className="text-lg font-bold text-atlas-ink">Confirm Bulk Upload</h3>
              <p className="text-sm text-atlas-ink-muted mt-1">
                {bulkPreview.changes.filter(c => c.action !== "no_change").length} change(s) detected
                {bulkPreview.changes.filter(c => c.action === "no_change").length > 0 && `, ${bulkPreview.changes.filter(c => c.action === "no_change").length} row(s) with no edits`}
                {bulkPreview.skipped.length > 0 && `, ${bulkPreview.skipped.length} skipped`}
              </p>
            </div>
            <div className="flex-1 overflow-y-auto p-5 space-y-2">
              {bulkPreview.changes.map((c, i) => (
                <div key={i} className={`flex items-start gap-3 px-3 py-2 rounded-lg text-sm ${
                  c.action === "delete" ? "bg-red-900/20 border border-red-800/30" :
                  c.action === "add" ? "bg-green-900/20 border border-green-800/30" :
                  c.action === "update" ? "bg-amber-900/20 border border-amber-800/30" :
                  "bg-atlas-surface-soft/50 border border-atlas-line"
                }`}>
                  <span className={`text-xs font-bold uppercase mt-0.5 shrink-0 w-16 ${
                    c.action === "delete" ? "text-red-400" :
                    c.action === "add" ? "text-green-400" :
                    c.action === "update" ? "text-amber-400" :
                    "text-atlas-ink-faint"
                  }`}>
                    {c.action === "no_change" ? "No Edit" : c.action}
                  </span>
                  <div>
                    <span className="font-mono text-atlas-ink">{c.sku}</span>
                    <span className="text-atlas-ink-muted ml-2">— {c.details}</span>
                  </div>
                </div>
              ))}
              {bulkPreview.skipped.length > 0 && (
                <div className="mt-3 pt-3 border-t border-atlas-line">
                  <p className="text-xs font-semibold text-red-400 mb-1">Skipped (FG code conflicts):</p>
                  {bulkPreview.skipped.map((s, i) => (
                    <p key={i} className="text-xs text-red-300/70 font-mono">{s}</p>
                  ))}
                </div>
              )}
            </div>
            <div className="p-5 border-t border-atlas-line flex items-center justify-end gap-3">
              <button onClick={() => setBulkPreview(null)}
                className="px-4 py-2 bg-atlas-surface-soft text-atlas-ink text-sm rounded-lg hover:bg-atlas-surface-soft transition">
                Cancel
              </button>
              <button onClick={confirmBulkUpload} disabled={saving || bulkPreview.changes.filter(c => c.action !== "no_change").length === 0}
                className="px-4 py-2 bg-amber-500 text-black text-sm font-semibold rounded-lg hover:bg-amber-400 transition disabled:opacity-50">
                {saving ? "Processing..." : `Confirm ${bulkPreview.changes.filter(c => c.action !== "no_change").length} Change(s)`}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">FG Code Manager</h2>
          <p className="text-sm text-atlas-ink-muted mt-1">Manage FG codes and product names for combos and singles</p>
        </div>
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="px-4 py-2 bg-amber-500 text-black text-sm font-semibold rounded-lg hover:bg-amber-400 transition"
        >
          {showAddForm ? "Close Form" : "+ Add New Combo"}
        </button>
      </div>

      {/* ── Add New Combo Form ── */}
      {showAddForm && (
        <div className="mb-6 bg-atlas-surface border border-atlas-line rounded-xl p-5 space-y-4">
          <p className="text-sm font-medium text-atlas-ink">Add New Combo to Mapper</p>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-xs text-atlas-ink-muted mb-1">Master SKU *</label>
              <input type="text" value={addMasterSku} onChange={(e) => setAddMasterSku(e.target.value)}
                placeholder="e.g. BB_AFG_P12" className="w-full px-3 py-2 bg-atlas-surface-soft border border-atlas-line rounded-lg text-atlas-ink text-sm font-mono focus:outline-none focus:ring-2 focus:ring-amber-500" />
            </div>
            <div>
              <label className="block text-xs text-atlas-ink-muted mb-1">FG Code</label>
              <input type="text" value={addFgCode} onChange={(e) => setAddFgCode(e.target.value)}
                placeholder="e.g. 14244G" className="w-full px-3 py-2 bg-atlas-surface-soft border border-atlas-line rounded-lg text-atlas-ink text-sm font-mono focus:outline-none focus:ring-2 focus:ring-amber-500" />
            </div>
            <div>
              <label className="block text-xs text-atlas-ink-muted mb-1">Product Name</label>
              <input type="text" value={addProductName} onChange={(e) => setAddProductName(e.target.value)}
                placeholder="e.g. Protein Bar Almond 12-Pack" className="w-full px-3 py-2 bg-atlas-surface-soft border border-atlas-line rounded-lg text-atlas-ink text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />
            </div>
          </div>

          {/* Components */}
          <div>
            <label className="block text-xs text-atlas-ink-muted mb-2">Components (Single Master SKUs) *</label>
            <div className="space-y-2">
              {addComponents.map((comp, i) => {
                const resolved = comp.sku.trim() ? resolveComponent(comp.sku.trim(), comp.qty) : null;
                return (
                  <div key={i} className="flex gap-3 items-start">
                    <input type="text" value={comp.sku} placeholder="Master SKU"
                      onChange={(e) => {
                        const updated = [...addComponents];
                        updated[i] = { ...updated[i], sku: e.target.value };
                        setAddComponents(updated);
                      }}
                      className="flex-1 px-3 py-2 bg-atlas-surface-soft border border-atlas-line rounded-lg text-atlas-ink text-sm font-mono focus:outline-none focus:ring-1 focus:ring-amber-500" />
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-atlas-ink-faint">x</span>
                      <input type="number" min={1} value={comp.qty}
                        onChange={(e) => {
                          const updated = [...addComponents];
                          updated[i] = { ...updated[i], qty: Math.max(1, parseInt(e.target.value) || 1) };
                          setAddComponents(updated);
                        }}
                        className="w-16 px-2 py-2 bg-atlas-surface-soft border border-atlas-line rounded-lg text-atlas-ink text-sm text-center focus:outline-none focus:ring-1 focus:ring-amber-500" />
                    </div>
                    <button onClick={() => setAddComponents(addComponents.filter((_, j) => j !== i))}
                      className="px-2 py-2 text-red-400 hover:text-red-300 text-sm">{"\u2715"}</button>
                    {resolved?.note && (
                      <p className="text-xs text-amber-400 py-2">{resolved.note}</p>
                    )}
                  </div>
                );
              })}
              <button onClick={() => setAddComponents([...addComponents, { sku: "", qty: 1, resolved: null }])}
                className="text-xs text-amber-400 hover:text-amber-300">+ Add Component</button>
            </div>
          </div>

          <div className="flex gap-3 pt-2">
            <button onClick={handleAddCombo} disabled={saving}
              className="px-4 py-2 bg-green-600/20 border border-green-600/40 text-green-400 text-sm rounded-lg hover:bg-green-600/30 transition disabled:opacity-50">
              {saving ? "Saving..." : "Save Combo"}
            </button>
            <button onClick={() => { setShowAddForm(false); setAddMasterSku(""); setAddFgCode(""); setAddProductName(""); setAddComponents([{ sku: "", qty: 1, resolved: null }]); }}
              className="px-4 py-2 bg-atlas-surface-soft text-atlas-ink-muted text-sm rounded-lg hover:bg-atlas-surface-soft transition">Cancel</button>
          </div>
        </div>
      )}

      {successMsg && (
        <div className="mb-4 p-3 bg-green-900/50 border border-green-500 rounded-xl">
          <p className="text-green-300 text-sm">{successMsg}</p>
        </div>
      )}
      {error && (
        <div className="mb-4 p-3 bg-red-900/50 border border-red-500 rounded-xl">
          <p className="text-red-300 text-sm">{error}</p>
          <button onClick={() => setError(null)} className="text-xs text-red-400 underline mt-1">Dismiss</button>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-2 mb-6">
        {(["combos", "singles", "suggestions"] as const).map(t => (
          <button key={t} onClick={() => { setTab(t); setSearchTerm(""); }}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
              tab === t ? "bg-amber-500/10 text-amber-400 border border-amber-500/30" : "bg-atlas-surface-soft text-atlas-ink-muted border border-transparent hover:bg-atlas-surface-soft"
            }`}>
            {t === "combos" ? "Combo FG Codes" : t === "singles" ? "Single FG Codes" : `Pending Suggestions (${suggestions.length})`}
          </button>
        ))}
      </div>

      {/* Search + Filter */}
      {tab !== "suggestions" && (
        <div className="flex gap-3 mb-4 items-center">
          <input type="text" placeholder="Search SKU, FG Code, name, or components..."
            value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
            className="flex-1 max-w-md px-4 py-2 bg-atlas-surface-soft border border-atlas-line rounded-lg text-atlas-ink text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />
          {tab === "combos" && (
            <div className="flex gap-2">
              {(["all", "incomplete", "complete"] as const).map(f => (
                <button key={f} onClick={() => setStatusFilter(f)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                    statusFilter === f ? "bg-amber-500/10 text-amber-400 border border-amber-500/30" : "bg-atlas-surface-soft text-atlas-ink-muted border border-transparent hover:bg-atlas-surface-soft"
                  }`}>
                  {f === "all" ? `All (${uniqueCombos.length})` : f === "incomplete" ? `Incomplete (${incompleteCount})` : `Complete (${completeCount})`}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ═══════ COMBOS TAB ═══════ */}
      {tab === "combos" && (
        <div>
          {criticalCombos.length > 0 && (
            <div className="mb-4 p-4 bg-red-950/60 border border-red-500/50 rounded-xl">
              <div className="flex items-start gap-3">
                <span className="text-red-300 text-xl leading-none">⚠</span>
                <div className="flex-1">
                  <div className="text-red-200 font-bold uppercase tracking-wider text-sm">
                    {criticalCombos.length} Critical combo{criticalCombos.length > 1 ? "s" : ""} — Admin action required
                  </div>
                  <div className="text-red-300/80 text-xs mt-1">
                    These combos are flagged <span className="font-mono">is_combo=Yes</span> but have no component SKUs. They will silently drop from conversions. Add component SKUs, or uncheck Combo if the SKU is actually a single.
                  </div>
                  <div className="text-red-300/90 text-xs mt-2 font-mono">
                    {criticalCombos.slice(0, 10).map(c => c.master_sku).join(", ")}{criticalCombos.length > 10 ? `, +${criticalCombos.length - 10} more` : ""}
                  </div>
                </div>
              </div>
            </div>
          )}
          <div className="flex items-center gap-3 mb-4 flex-wrap">
            <button onClick={downloadBulkTemplate}
              className="px-3 py-1.5 bg-atlas-surface-soft border border-atlas-line text-atlas-ink text-xs rounded-lg hover:bg-atlas-surface-soft transition">
              Download Template
            </button>
            <label className="px-3 py-1.5 bg-amber-600/20 border border-amber-600/40 text-amber-300 text-xs rounded-lg hover:bg-amber-600/30 transition cursor-pointer">
              Upload Filled Template
              <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleBulkUpload} />
            </label>
            {(incompleteCount > 0 || invalidComponentCount > 0) && (
              <button onClick={downloadIncompleteRows}
                className="px-3 py-1.5 bg-red-900/20 border border-red-700/40 text-red-300 text-xs rounded-lg hover:bg-red-900/30 transition">
                Download Incomplete ({incompleteCount + invalidComponentCount} rows)
              </button>
            )}
            {invalidComponentCount > 0 && (
              <span className="text-xs text-red-400">{invalidComponentCount} combo(s) have components not in SKU Master</span>
            )}
          </div>

          <div className="bg-atlas-surface border border-atlas-line rounded-xl overflow-hidden">
            <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-atlas-surface z-10">
                  <tr className="border-b border-atlas-line">
                    <th className="text-center py-3 px-2 text-atlas-ink-muted font-medium w-10"></th>
                    <th className="text-left py-3 px-3 text-atlas-ink-muted font-medium">Master SKU</th>
                    <th className="text-left py-3 px-3 text-atlas-ink-muted font-medium">FG Code</th>
                    <th className="text-left py-3 px-3 text-atlas-ink-muted font-medium">Product Name</th>
                    <th className="text-left py-3 px-3 text-atlas-ink-muted font-medium">Components</th>
                    <th className="text-left py-3 px-3 text-atlas-ink-muted font-medium w-28">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCombos.map((combo) => {
                    const status = getComboStatus(combo);
                    const isEditing = !!editingRow[combo.master_sku];
                    const isCritical = combo.is_combo && (!combo.products || combo.products.length === 0);
                    return (
                      <tr key={combo.master_sku} className={`border-b border-atlas-line/50 hover:bg-atlas-surface-soft/30 ${
                        isCritical ? "bg-red-900/25 hover:bg-red-900/35" : status === "missing" ? "bg-red-900/5" : status === "partial" ? "bg-amber-900/5" : ""
                      }`}>
                        <td className="py-2 px-2 text-center">
                          <span className={`inline-block w-2.5 h-2.5 rounded-full ${
                            status === "complete" ? "bg-green-500" : status === "partial" ? "bg-amber-500" : "bg-red-500/60"
                          }`} title={status === "complete" ? "Complete" : status === "partial" ? "Partially filled" : "Missing FG Code & Name"} />
                        </td>
                        <td className="py-2 px-3 font-mono text-xs">
                          {combo.master_sku}
                          {isCritical && (
                            <span className="ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-500/30 text-red-200 font-bold text-[10px] uppercase ring-1 ring-red-500/60" title="CRITICAL: Combo=Yes but no components — cannot expand">⚠ Crit</span>
                          )}
                        </td>
                        <td className="py-2 px-3">
                          {isEditing ? (
                            <input type="text" value={editingRow[combo.master_sku].fg_code}
                              onChange={(e) => setEditingRow(prev => ({ ...prev, [combo.master_sku]: { ...prev[combo.master_sku], fg_code: e.target.value } }))}
                              className="w-28 px-2 py-1 bg-atlas-surface-soft border border-atlas-line rounded text-atlas-ink text-xs font-mono focus:outline-none focus:ring-1 focus:ring-amber-500"
                              placeholder="e.g. 14244G" />
                          ) : (
                            <span className={`font-mono text-xs ${combo.fg_code ? "text-atlas-ink" : "text-atlas-ink-faint"}`}>
                              {combo.fg_code || "\u2014"}
                            </span>
                          )}
                        </td>
                        <td className="py-2 px-3">
                          {isEditing ? (
                            <input type="text" value={editingRow[combo.master_sku].product_name}
                              onChange={(e) => setEditingRow(prev => ({ ...prev, [combo.master_sku]: { ...prev[combo.master_sku], product_name: e.target.value } }))}
                              className="w-48 px-2 py-1 bg-atlas-surface-soft border border-atlas-line rounded text-atlas-ink text-xs focus:outline-none focus:ring-1 focus:ring-amber-500"
                              placeholder="Product name" />
                          ) : (
                            <span className={`text-xs ${combo.product_name ? "text-atlas-ink" : "text-atlas-ink-faint"}`}>
                              {combo.product_name || "\u2014"}
                            </span>
                          )}
                        </td>
                        <td className="py-2 px-3 text-xs max-w-[300px]">
                          {isEditing ? (
                            <input type="text" value={editingRow[combo.master_sku].components}
                              onChange={(e) => setEditingRow(prev => ({ ...prev, [combo.master_sku]: { ...prev[combo.master_sku], components: e.target.value } }))}
                              className="w-full px-2 py-1 bg-atlas-surface-soft border border-atlas-line rounded text-atlas-ink text-xs font-mono focus:outline-none focus:ring-1 focus:ring-amber-500"
                              placeholder="SKU_A, SKU_B, SKU_C" />
                          ) : (() => {
                            const invalid = getInvalidComponents(combo.products);
                            return combo.products.length > 0 ? (
                              <div className="space-y-0.5">
                                <div className="font-mono truncate" title={combo.products.join(", ")}>
                                  {combo.products.join(", ")}
                                </div>
                                {invalid.length > 0 && (
                                  <div className="text-red-400 font-medium">
                                    Not in SKU Master: {invalid.join(", ")}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <span className="text-atlas-ink-faint">No components</span>
                            );
                          })()}
                        </td>
                        <td className="py-2 px-3">
                          {isEditing ? (
                            <div className="flex gap-1">
                              <button onClick={() => saveInlineEdit(combo.master_sku)} disabled={saving}
                                className="px-2 py-1 bg-green-600/20 border border-green-600/40 text-green-400 text-xs rounded hover:bg-green-600/30 transition">Save</button>
                              <button onClick={() => setEditingRow(prev => { const n = { ...prev }; delete n[combo.master_sku]; return n; })}
                                className="px-2 py-1 bg-atlas-surface-soft text-atlas-ink-muted text-xs rounded hover:bg-atlas-surface-soft transition">Cancel</button>
                            </div>
                          ) : (
                            <div className="flex gap-1">
                              <button onClick={() => setEditingRow(prev => ({ ...prev, [combo.master_sku]: { fg_code: combo.fg_code || "", product_name: combo.product_name || "", components: combo.products.join(", ") } }))}
                                className="px-2 py-1 bg-atlas-surface-soft border border-atlas-line text-atlas-ink text-xs rounded hover:bg-atlas-surface-soft transition">Edit</button>
                              <button onClick={() => deleteCombo(combo.master_sku)} disabled={saving}
                                className="px-2 py-1 bg-red-900/20 border border-red-700/30 text-red-400 text-xs rounded hover:bg-red-900/40 transition">{"\u2715"}</button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {filteredCombos.length === 0 && (
                    <tr><td colSpan={6} className="py-8 text-center text-atlas-ink-faint">No combo SKUs found.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ═══════ SINGLES TAB ═══════ */}
      {tab === "singles" && (
        <div>
          <p className="text-sm text-atlas-ink-muted mb-4">{filteredSingles.length} single SKUs (edit in SKU Master page)</p>
          <div className="bg-atlas-surface border border-atlas-line rounded-xl overflow-hidden">
            <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-atlas-surface z-10">
                  <tr className="border-b border-atlas-line">
                    <th className="text-left py-3 px-4 text-atlas-ink-muted font-medium">New Master SKU</th>
                    <th className="text-left py-3 px-4 text-atlas-ink-muted font-medium">New FG Code</th>
                    <th className="text-left py-3 px-4 text-atlas-ink-muted font-medium">Product Name</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSingles.map((s) => (
                    <tr key={s.id} className="border-b border-atlas-line/50 hover:bg-atlas-surface-soft/30">
                      <td className="py-2 px-4 font-mono text-xs">{s.new_master_sku}</td>
                      <td className={`py-2 px-4 font-mono text-xs ${s.new_fg_code ? "text-atlas-ink" : "text-atlas-ink-faint"}`}>
                        {s.new_fg_code || "\u2014"}
                      </td>
                      <td className="py-2 px-4 text-xs text-atlas-ink">{s.product_name}</td>
                    </tr>
                  ))}
                  {filteredSingles.length === 0 && (
                    <tr><td colSpan={3} className="py-8 text-center text-atlas-ink-faint">No singles found.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ═══════ SUGGESTIONS TAB ═══════ */}
      {tab === "suggestions" && (
        <div>
          {suggestions.length === 0 ? (
            <div className="bg-atlas-surface border border-atlas-line rounded-xl p-8 text-center">
              <p className="text-atlas-ink-faint">No pending suggestions.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {suggestions.map((s) => {
                const isFgChange = !!s.suggested_fg_code;
                const currentSku = singles.find(sk => sk.new_master_sku.toLowerCase() === s.master_sku.toLowerCase());
                return (
                  <div key={s.id} className={`bg-atlas-surface border rounded-xl p-4 flex items-center justify-between ${isFgChange ? "border-amber-700/40" : "border-atlas-line"}`}>
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="font-mono text-sm text-atlas-ink">{s.master_sku}</p>
                        {isFgChange && <span className="px-1.5 py-0.5 bg-amber-500/10 text-amber-400 text-[10px] rounded font-medium">FG CODE CHANGE</span>}
                        {s.is_combo && <span className="px-1.5 py-0.5 bg-blue-500/10 text-blue-400 text-[10px] rounded">COMBO</span>}
                      </div>
                      {isFgChange && (
                        <div className="mt-1.5 flex items-center gap-2 text-sm">
                          <span className="text-atlas-ink-faint font-mono">{currentSku?.new_fg_code || "(no current FG)"}</span>
                          <span className="text-atlas-ink-faint">→</span>
                          <span className="text-amber-400 font-mono font-medium">{s.suggested_fg_code}</span>
                          {currentSku && <span className="text-xs text-atlas-ink-faint ml-2">({currentSku.product_name})</span>}
                        </div>
                      )}
                      {s.notes && <p className="text-xs text-atlas-ink-muted mt-1">Reason: {s.notes}</p>}
                      <p className="text-xs text-atlas-ink-faint mt-1">
                        Submitted by {s.submitted_by_email} on {new Date(s.created_at).toLocaleDateString()}
                      </p>
                      {s.products.length > 0 && (
                        <p className="text-xs text-atlas-ink-faint mt-1">Components: {s.products.join(", ")}</p>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => approveSuggestion(s.id)}
                        className="px-3 py-1.5 bg-green-600/20 border border-green-600/40 text-green-400 text-xs rounded-lg hover:bg-green-600/30 transition">Approve</button>
                      <button onClick={() => rejectSuggestion(s.id)}
                        className="px-3 py-1.5 bg-red-600/20 border border-red-600/40 text-red-400 text-xs rounded-lg hover:bg-red-600/30 transition">Reject</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
