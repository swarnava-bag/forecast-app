"use client";
import { useEffect, useState, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";
import AppShell from "@/app/components/AppShell";
import * as XLSX from "xlsx";

type SKU = {
  id: string;
  new_master_sku: string;
  new_fg_code: string;
  master_sku: string;
  fg_code: string;
  product_name: string;
  category: string;
  product_category: string;
  mrp: number | null;
  is_active: boolean;
  discontinued_at: string | null;
};

type Profile = { role: string };

export default function MasterDataPage() {
  const [skus, setSkus] = useState<SKU[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [subCategoryFilter, setSubCategoryFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("active");
  const [profile, setProfile] = useState<Profile | null>(null);
  const supabase = createClient();

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setLoading(true);

    // Get user profile
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { data: p } = await supabase.from("profiles").select("role").eq("id", user.id).single();
      if (p) setProfile(p);
    }

    // Fetch all SKUs with pagination
    let allSkus: SKU[] = [];
    const PAGE = 1000;
    let from = 0;
    while (true) {
      const { data } = await supabase
        .from("sku_master")
        .select("*")
        .order("category")
        .order("product_name")
        .range(from, from + PAGE - 1);
      if (!data || data.length === 0) break;
      allSkus = allSkus.concat(data);
      if (data.length < PAGE) break;
      from += PAGE;
    }
    setSkus(allSkus);
    setLoading(false);
  }

  const categories = useMemo(() =>
    [...new Set(skus.map((s) => s.category).filter(Boolean))].sort()
  , [skus]);

  const subCategories = useMemo(() => {
    const filtered = categoryFilter
      ? skus.filter((s) => s.category === categoryFilter)
      : skus;
    return [...new Set(filtered.map((s) => s.product_category).filter(Boolean))].sort();
  }, [skus, categoryFilter]);

  const filteredSKUs = useMemo(() => skus.filter((sku) => {
    const term = searchTerm.toLowerCase();
    const matchesSearch =
      !searchTerm ||
      sku.product_name?.toLowerCase().includes(term) ||
      sku.new_master_sku?.toLowerCase().includes(term) ||
      sku.new_fg_code?.toLowerCase().includes(term) ||
      sku.fg_code?.toLowerCase().includes(term) ||
      sku.master_sku?.toLowerCase().includes(term);
    const matchesCategory = !categoryFilter || sku.category === categoryFilter;
    const matchesSubCategory = !subCategoryFilter || sku.product_category === subCategoryFilter;
    const matchesStatus =
      statusFilter === "all" ||
      (statusFilter === "active" && sku.is_active && !sku.discontinued_at) ||
      (statusFilter === "discontinued" && sku.discontinued_at);
    return matchesSearch && matchesCategory && matchesSubCategory && matchesStatus;
  }), [skus, searchTerm, categoryFilter, subCategoryFilter, statusFilter]);

  // Summary stats
  const stats = useMemo(() => ({
    total: skus.length,
    active: skus.filter((s) => s.is_active && !s.discontinued_at).length,
    discontinued: skus.filter((s) => s.discontinued_at).length,
    categories: categories.length,
    missingMrp: skus.filter((s) => s.is_active && !s.discontinued_at && (s.mrp == null || s.mrp === 0)).length,
  }), [skus, categories]);

  function downloadMasterList() {
    const rows = skus.map((s, i) => ({
      "#": i + 1,
      "New Master SKU": s.new_master_sku,
      "New FG Code": s.new_fg_code,
      "Master SKU": s.master_sku,
      "FG Code": s.fg_code,
      "Product Name": s.product_name,
      "Category": s.category,
      "Product Category": s.product_category,
      "MRP": s.mrp ?? "",
      "Status": s.discontinued_at ? "Discontinued" : "Active",
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [{ wch: 5 }, { wch: 18 }, { wch: 14 }, { wch: 18 }, { wch: 10 }, { wch: 45 }, { wch: 15 }, { wch: 20 }, { wch: 10 }, { wch: 12 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "SKU Master");
    XLSX.writeFile(wb, "SKU_Master_List.xlsx");
  }

  if (loading) {
    return (
      <AppShell>
        <div className="flex items-center justify-center h-64">
          <p style={{ color: "var(--atlas-ink-muted)" }}>Loading master data...</p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold">Master Data</h1>
            <p className="text-sm text-atlas-ink-muted mt-1">Product master reference — all SKUs, categories, and FG codes</p>
          </div>
          <button
            onClick={downloadMasterList}
            className="px-4 py-2 text-sm bg-atlas-surface-soft text-atlas-ink rounded-lg hover:bg-atlas-surface-soft transition flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
            Download Excel
          </button>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <div className="bg-atlas-surface border border-atlas-line rounded-xl p-4">
            <p className="text-xs text-atlas-ink-muted uppercase tracking-wider">Total SKUs</p>
            <p className="text-2xl font-bold mt-1">{stats.total}</p>
          </div>
          <div className="bg-atlas-surface border border-atlas-line rounded-xl p-4">
            <p className="text-xs text-atlas-ink-muted uppercase tracking-wider">Active</p>
            <p className="text-2xl font-bold mt-1 text-atlas-green">{stats.active}</p>
          </div>
          <div className="bg-atlas-surface border border-atlas-line rounded-xl p-4">
            <p className="text-xs text-atlas-ink-muted uppercase tracking-wider">Discontinued</p>
            <p className="text-2xl font-bold mt-1 text-atlas-red">{stats.discontinued}</p>
          </div>
          <div className="bg-atlas-surface border border-atlas-line rounded-xl p-4">
            <p className="text-xs text-atlas-ink-muted uppercase tracking-wider">Categories</p>
            <p className="text-2xl font-bold mt-1 text-atlas-blue">{stats.categories}</p>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-3 mb-4">
          <input
            type="text"
            placeholder="Search by name, SKU code, or FG code..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="flex-1 min-w-[250px] px-4 py-2 bg-atlas-surface border border-atlas-line rounded-lg text-atlas-ink text-sm placeholder-atlas-ink-muted focus:outline-none focus:ring-2 focus:ring-atlas-accent"
          />
          <select
            value={categoryFilter}
            onChange={(e) => { setCategoryFilter(e.target.value); setSubCategoryFilter(""); }}
            className="px-4 py-2 bg-atlas-surface border border-atlas-line rounded-lg text-atlas-ink text-sm focus:outline-none focus:ring-2 focus:ring-atlas-accent"
          >
            <option value="">All Categories</option>
            {categories.map((cat) => (<option key={cat} value={cat}>{cat}</option>))}
          </select>
          <select
            value={subCategoryFilter}
            onChange={(e) => setSubCategoryFilter(e.target.value)}
            className="px-4 py-2 bg-atlas-surface border border-atlas-line rounded-lg text-atlas-ink text-sm focus:outline-none focus:ring-2 focus:ring-atlas-accent"
          >
            <option value="">All Sub-Categories</option>
            {subCategories.map((sc) => (<option key={sc} value={sc}>{sc}</option>))}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-4 py-2 bg-atlas-surface border border-atlas-line rounded-lg text-atlas-ink text-sm focus:outline-none focus:ring-2 focus:ring-atlas-accent"
          >
            <option value="active">Active Only</option>
            <option value="discontinued">Discontinued</option>
            <option value="all">All</option>
          </select>
        </div>

        {/* Result count */}
        <p className="text-xs text-atlas-ink-muted mb-3">
          Showing {filteredSKUs.length} of {skus.length} SKUs
          {(searchTerm || categoryFilter || subCategoryFilter || statusFilter !== "active") && (
            <button onClick={() => { setSearchTerm(""); setCategoryFilter(""); setSubCategoryFilter(""); setStatusFilter("active"); }} className="ml-2 text-atlas-blue hover:text-atlas-blue/70">
              Clear filters
            </button>
          )}
        </p>

        {/* SKU Table */}
        <div className="bg-atlas-surface border border-atlas-line rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-atlas-line bg-atlas-surface/80">
                  <th className="text-left py-3 px-4 text-atlas-ink-muted font-medium w-8">#</th>
                  <th className="text-left py-3 px-4 text-atlas-ink-muted font-medium">New Master SKU</th>
                  <th className="text-left py-3 px-4 text-atlas-ink-muted font-medium">Product Name</th>
                  <th className="text-left py-3 px-4 text-atlas-ink-muted font-medium">Category</th>
                  <th className="text-left py-3 px-4 text-atlas-ink-muted font-medium">Sub-Category</th>
                  <th className="text-left py-3 px-4 text-atlas-ink-muted font-medium">New FG Code</th>
                  <th className="text-right py-3 px-4 text-atlas-ink-muted font-medium">MRP</th>
                  <th className="text-left py-3 px-4 text-atlas-ink-muted font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {filteredSKUs.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-12 text-center text-atlas-ink-muted">
                      {searchTerm || categoryFilter || subCategoryFilter ? "No SKUs match your filters." : "No SKUs found."}
                    </td>
                  </tr>
                ) : (
                  filteredSKUs.map((sku, idx) => (
                    <tr key={sku.id} className={`border-b border-atlas-line/50 hover:bg-atlas-surface-soft/30 transition ${sku.discontinued_at ? "opacity-60" : ""}`}>
                      <td className="py-3 px-4 text-atlas-ink-faint text-xs">{idx + 1}</td>
                      <td className="py-3 px-4 font-mono text-xs">{sku.new_master_sku}</td>
                      <td className="py-3 px-4">{sku.product_name}</td>
                      <td className="py-3 px-4 text-atlas-ink-muted">{sku.category}</td>
                      <td className="py-3 px-4 text-atlas-ink-muted">{sku.product_category}</td>
                      <td className="py-3 px-4 font-mono text-xs text-atlas-blue/80">{sku.new_fg_code}</td>
                      <td className="py-3 px-4 text-right font-mono text-xs">
                        {sku.mrp != null && sku.mrp > 0 ? (
                          <span className="text-atlas-ink">{sku.mrp.toLocaleString("en-IN")}</span>
                        ) : (
                          <span className="text-atlas-ink-faint">—</span>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        {sku.discontinued_at ? (
                          <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-atlas-red-bg text-atlas-red">Discontinued</span>
                        ) : (
                          <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-atlas-green-bg text-atlas-green">Active</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
