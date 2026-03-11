"use client";
import { useEffect, useState, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";
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
      "Status": s.discontinued_at ? "Discontinued" : "Active",
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [{ wch: 5 }, { wch: 18 }, { wch: 14 }, { wch: 18 }, { wch: 10 }, { wch: 45 }, { wch: 15 }, { wch: 20 }, { wch: 12 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "SKU Master");
    XLSX.writeFile(wb, "SKU_Master_List.xlsx");
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 text-white">
        <nav className="border-b border-gray-800 bg-gray-900">
          <div className="max-w-7xl mx-auto px-6 py-4">
            <span className="text-lg font-bold text-white">Demand Planning Module - Yogabars</span>
          </div>
        </nav>
        <div className="flex items-center justify-center h-64">
          <p className="text-gray-400">Loading master data...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* Top Navigation Bar */}
      <nav className="border-b border-gray-800 bg-gray-900">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/dashboard" className="text-lg font-bold text-white">
              Demand Planning Module - Yogabars
            </Link>
            <div className="hidden md:flex items-center gap-4">
              <Link href="/dashboard" className="text-sm text-gray-400 hover:text-white transition">Dashboard</Link>
              <Link href="/upload" className="text-sm text-gray-400 hover:text-white transition">Upload</Link>
              <Link href="/channels" className="text-sm text-gray-400 hover:text-white transition">Forecast View</Link>
              <Link href="/combo-converter" className="text-sm text-gray-400 hover:text-white transition">Combo → Singles</Link>
              <span className="text-sm text-amber-400 font-medium">Master Data</span>
              {profile?.role === "admin" && <Link href="/admin" className="text-sm text-gray-400 hover:text-white transition">Admin</Link>}
            </div>
          </div>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold">Master Data</h1>
            <p className="text-sm text-gray-400 mt-1">Product master reference — all SKUs, categories, and FG codes</p>
          </div>
          <button
            onClick={downloadMasterList}
            className="px-4 py-2 text-sm bg-gray-800 text-gray-300 rounded-lg hover:bg-gray-700 transition flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
            Download Excel
          </button>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Total SKUs</p>
            <p className="text-2xl font-bold mt-1">{stats.total}</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Active</p>
            <p className="text-2xl font-bold mt-1 text-green-400">{stats.active}</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Discontinued</p>
            <p className="text-2xl font-bold mt-1 text-orange-400">{stats.discontinued}</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Categories</p>
            <p className="text-2xl font-bold mt-1 text-amber-400">{stats.categories}</p>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-3 mb-4">
          <input
            type="text"
            placeholder="Search by name, SKU code, or FG code..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="flex-1 min-w-[250px] px-4 py-2 bg-gray-900 border border-gray-800 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-amber-500"
          />
          <select
            value={categoryFilter}
            onChange={(e) => { setCategoryFilter(e.target.value); setSubCategoryFilter(""); }}
            className="px-4 py-2 bg-gray-900 border border-gray-800 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
          >
            <option value="">All Categories</option>
            {categories.map((cat) => (<option key={cat} value={cat}>{cat}</option>))}
          </select>
          <select
            value={subCategoryFilter}
            onChange={(e) => setSubCategoryFilter(e.target.value)}
            className="px-4 py-2 bg-gray-900 border border-gray-800 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
          >
            <option value="">All Sub-Categories</option>
            {subCategories.map((sc) => (<option key={sc} value={sc}>{sc}</option>))}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-4 py-2 bg-gray-900 border border-gray-800 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
          >
            <option value="active">Active Only</option>
            <option value="discontinued">Discontinued</option>
            <option value="all">All</option>
          </select>
        </div>

        {/* Result count */}
        <p className="text-xs text-gray-500 mb-3">
          Showing {filteredSKUs.length} of {skus.length} SKUs
          {(searchTerm || categoryFilter || subCategoryFilter || statusFilter !== "active") && (
            <button onClick={() => { setSearchTerm(""); setCategoryFilter(""); setSubCategoryFilter(""); setStatusFilter("active"); }} className="ml-2 text-amber-400 hover:text-amber-300">
              Clear filters
            </button>
          )}
        </p>

        {/* SKU Table */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 bg-gray-900/80">
                  <th className="text-left py-3 px-4 text-gray-400 font-medium w-8">#</th>
                  <th className="text-left py-3 px-4 text-gray-400 font-medium">New Master SKU</th>
                  <th className="text-left py-3 px-4 text-gray-400 font-medium">Product Name</th>
                  <th className="text-left py-3 px-4 text-gray-400 font-medium">Category</th>
                  <th className="text-left py-3 px-4 text-gray-400 font-medium">Sub-Category</th>
                  <th className="text-left py-3 px-4 text-gray-400 font-medium">New FG Code</th>
                  <th className="text-left py-3 px-4 text-gray-400 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {filteredSKUs.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-gray-500">
                      {searchTerm || categoryFilter || subCategoryFilter ? "No SKUs match your filters." : "No SKUs found."}
                    </td>
                  </tr>
                ) : (
                  filteredSKUs.map((sku, idx) => (
                    <tr key={sku.id} className={`border-b border-gray-800/50 hover:bg-gray-800/30 transition ${sku.discontinued_at ? "opacity-60" : ""}`}>
                      <td className="py-3 px-4 text-gray-600 text-xs">{idx + 1}</td>
                      <td className="py-3 px-4 font-mono text-xs">{sku.new_master_sku}</td>
                      <td className="py-3 px-4">{sku.product_name}</td>
                      <td className="py-3 px-4 text-gray-400">{sku.category}</td>
                      <td className="py-3 px-4 text-gray-400">{sku.product_category}</td>
                      <td className="py-3 px-4 font-mono text-xs text-amber-400/80">{sku.new_fg_code}</td>
                      <td className="py-3 px-4">
                        {sku.discontinued_at ? (
                          <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-orange-500/20 text-orange-400">Discontinued</span>
                        ) : (
                          <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-green-500/20 text-green-400">Active</span>
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
    </div>
  );
}
