"use client";
import { useEffect, useState, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import * as XLSX from "xlsx";

const CUSTOMER_TYPES = ["B2C", "B2B", "Qcom", "MT", "GT", "Growth", "CSD"] as const;
type CustomerType = (typeof CUSTOMER_TYPES)[number];

type MapperEntry = {
  id: string;
  customer_name: string;
  customer_type: CustomerType;
  platform_name: string | null;
  created_at: string;
  updated_at: string;
};

type Profile = { id: string; role: string };

const PAGE_SIZE = 1000;

const TYPE_COLORS: Record<string, string> = {
  B2C: "bg-blue-500/20 text-blue-400",
  B2B: "bg-purple-500/20 text-purple-400",
  Qcom: "bg-orange-500/20 text-orange-400",
  MT: "bg-green-500/20 text-green-400",
  GT: "bg-yellow-500/20 text-yellow-400",
  Growth: "bg-cyan-500/20 text-cyan-400",
  CSD: "bg-red-500/20 text-red-400",
};

export default function CustomerMapperPage() {
  const supabase = createClient();

  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [entries, setEntries] = useState<MapperEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Filters
  const [searchTerm, setSearchTerm] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("");

  // Form state
  const [showForm, setShowForm] = useState(false);
  const [editingEntry, setEditingEntry] = useState<MapperEntry | null>(null);
  const [formName, setFormName] = useState("");
  const [formType, setFormType] = useState<CustomerType>("B2C");
  const [formPlatform, setFormPlatform] = useState("");
  const [saving, setSaving] = useState(false);

  // Bulk upload
  const [showUpload, setShowUpload] = useState(false);
  const [uploadPreview, setUploadPreview] = useState<
    { customer_name: string; customer_type: string; platform_name: string }[]
  >([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    init();
  }, []);

  async function init() {
    setLoading(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setLoading(false);
      return;
    }
    const { data: p } = await supabase
      .from("profiles")
      .select("id, role")
      .eq("id", user.id)
      .single();
    setProfile(p);
    await loadEntries();
    setLoading(false);
  }

  async function loadEntries() {
    let allData: MapperEntry[] = [];
    let from = 0;
    let hasMore = true;
    while (hasMore) {
      const { data, error: fetchErr } = await supabase
        .from("customer_channel_mapper")
        .select("*")
        .order("customer_name")
        .range(from, from + PAGE_SIZE - 1);
      if (fetchErr) {
        setError(fetchErr.message);
        return;
      }
      if (data) {
        allData = [...allData, ...data];
        if (data.length < PAGE_SIZE) {
          hasMore = false;
        } else {
          from += PAGE_SIZE;
        }
      } else {
        hasMore = false;
      }
    }
    setEntries(allData);
  }

  function flash(msg: string) {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(null), 4000);
  }

  // ====== FILTERING ======

  const filtered = entries.filter((e) => {
    const matchesSearch =
      !searchTerm ||
      e.customer_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (e.platform_name &&
        e.platform_name.toLowerCase().includes(searchTerm.toLowerCase()));
    const matchesType = !typeFilter || e.customer_type === typeFilter;
    return matchesSearch && matchesType;
  });

  // ====== STATS ======

  const typeCounts: Record<string, number> = {};
  for (const e of entries) {
    typeCounts[e.customer_type] = (typeCounts[e.customer_type] || 0) + 1;
  }

  // ====== FORM ======

  function openForm(entry?: MapperEntry) {
    setEditingEntry(entry || null);
    setFormName(entry?.customer_name || "");
    setFormType((entry?.customer_type as CustomerType) || "B2C");
    setFormPlatform(entry?.platform_name || "");
    setShowForm(true);
    setShowUpload(false);
    setError(null);
  }

  function closeForm() {
    setShowForm(false);
    setEditingEntry(null);
    setError(null);
  }

  async function saveEntry() {
    const name = formName.trim();
    if (!name) {
      setError("Customer name is required.");
      return;
    }
    if (!CUSTOMER_TYPES.includes(formType)) {
      setError("Select a valid customer type.");
      return;
    }
    setSaving(true);
    setError(null);

    const payload: {
      customer_name: string;
      customer_type: string;
      platform_name: string | null;
      updated_at?: string;
    } = {
      customer_name: name,
      customer_type: formType,
      platform_name: formPlatform.trim() || null,
    };

    if (editingEntry) {
      payload.updated_at = new Date().toISOString();
      const { error: e } = await supabase
        .from("customer_channel_mapper")
        .update(payload)
        .eq("id", editingEntry.id);
      if (e) {
        setError(e.message);
        setSaving(false);
        return;
      }
      flash(`"${name}" updated.`);
    } else {
      const { error: e } = await supabase
        .from("customer_channel_mapper")
        .insert(payload);
      if (e) {
        if (e.message.includes("duplicate") || e.message.includes("unique")) {
          setError(
            `Customer "${name}" already exists. Use edit instead.`
          );
        } else {
          setError(e.message);
        }
        setSaving(false);
        return;
      }
      flash(`"${name}" added.`);
    }
    closeForm();
    await loadEntries();
    setSaving(false);
  }

  // ====== DELETE ======

  async function deleteEntry(entry: MapperEntry) {
    if (
      !confirm(
        `Delete mapping for "${entry.customer_name}"? This cannot be undone.`
      )
    )
      return;
    const { error: e } = await supabase
      .from("customer_channel_mapper")
      .delete()
      .eq("id", entry.id);
    if (e) {
      setError(e.message);
      return;
    }
    flash(`"${entry.customer_name}" deleted.`);
    await loadEntries();
  }

  // ====== BULK UPLOAD ======

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = new Uint8Array(evt.target?.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<Record<string, any>>(ws);

        if (rows.length === 0) {
          setError("Excel file has no data rows.");
          return;
        }

        const preview: {
          customer_name: string;
          customer_type: string;
          platform_name: string;
        }[] = [];
        const errors: string[] = [];

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const customerName = (
            row["Customer Name"] ||
            row["customer_name"] ||
            row["CustomerName"] ||
            row["CUSTOMER NAME"] ||
            ""
          )
            .toString()
            .trim();
          const customerType = (
            row["Customer Type"] ||
            row["customer_type"] ||
            row["CustomerType"] ||
            row["CUSTOMER TYPE"] ||
            ""
          )
            .toString()
            .trim();
          const platformName = (
            row["Platform Name"] ||
            row["platform_name"] ||
            row["PlatformName"] ||
            row["PLATFORM NAME"] ||
            row["Platform"] ||
            ""
          )
            .toString()
            .trim();

          if (!customerName) {
            errors.push(`Row ${i + 2}: Missing customer name.`);
            continue;
          }
          if (!CUSTOMER_TYPES.includes(customerType as CustomerType)) {
            errors.push(
              `Row ${i + 2}: Invalid customer type "${customerType}". Must be one of: ${CUSTOMER_TYPES.join(", ")}.`
            );
            continue;
          }
          preview.push({
            customer_name: customerName,
            customer_type: customerType,
            platform_name: platformName,
          });
        }

        if (errors.length > 0) {
          setError(errors.slice(0, 10).join("\n") + (errors.length > 10 ? `\n...and ${errors.length - 10} more errors.` : ""));
        }

        setUploadPreview(preview);
        setShowUpload(true);
        setShowForm(false);
      } catch (err: any) {
        setError("Failed to parse Excel file: " + err.message);
      }
    };
    reader.readAsArrayBuffer(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function executeBulkUpload() {
    if (uploadPreview.length === 0) return;
    setUploading(true);
    setError(null);

    // Upsert in batches of 200
    const batchSize = 200;
    let inserted = 0;
    let errors: string[] = [];

    for (let i = 0; i < uploadPreview.length; i += batchSize) {
      const batch = uploadPreview.slice(i, i + batchSize).map((r) => ({
        customer_name: r.customer_name,
        customer_type: r.customer_type,
        platform_name: r.platform_name || null,
        updated_at: new Date().toISOString(),
      }));

      const { error: e } = await supabase
        .from("customer_channel_mapper")
        .upsert(batch, {
          onConflict: "customer_name",
          ignoreDuplicates: false,
        });

      if (e) {
        errors.push(`Batch ${Math.floor(i / batchSize) + 1}: ${e.message}`);
      } else {
        inserted += batch.length;
      }
    }

    if (errors.length > 0) {
      setError(errors.join("\n"));
    }

    flash(`Bulk upload complete: ${inserted} entries processed.`);
    setShowUpload(false);
    setUploadPreview([]);
    await loadEntries();
    setUploading(false);
  }

  function downloadTemplate() {
    const headers = [
      { "Customer Name": "Example Customer Pvt Ltd", "Customer Type": "B2C", "Platform Name": "Amazon" },
      { "Customer Name": "Retail Mart", "Customer Type": "GT", "Platform Name": "" },
    ];
    const ws = XLSX.utils.json_to_sheet(headers);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Customer Mapper");
    XLSX.writeFile(wb, "customer_mapper_template.xlsx");
  }

  function downloadCurrentData() {
    if (entries.length === 0) return;
    const data = entries.map((e) => ({
      "Customer Name": e.customer_name,
      "Customer Type": e.customer_type,
      "Platform Name": e.platform_name || "",
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Customer Mapper");
    XLSX.writeFile(wb, "customer_mapper_export.xlsx");
  }

  // ====== RENDER ======

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-[var(--text-secondary)]">Loading...</p>
      </div>
    );
  }

  if (profile?.role !== "admin") {
    return (
      <div className="py-16 text-center">
        <h2 className="text-2xl font-bold text-[var(--text-primary)] mb-4">
          Access Restricted
        </h2>
        <p className="text-[var(--text-secondary)]">
          Admin access required to manage the customer mapper.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-start justify-between mb-6">
          <div>
            <h2 className="text-2xl font-bold text-[var(--text-primary)]">
              Customer Channel Mapper
            </h2>
            <p className="text-sm text-[var(--text-secondary)] mt-1">
              {entries.length} customer{entries.length !== 1 ? "s" : ""} mapped
              across {Object.keys(typeCounts).length} channel types
            </p>
          </div>
          <div className="flex gap-3">
            <button
              onClick={downloadCurrentData}
              className="px-4 py-2 text-sm bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg hover:opacity-80 transition"
            >
              Export
            </button>
            <label className="px-4 py-2 text-sm bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg hover:opacity-80 transition cursor-pointer">
              Upload Excel
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={handleFileSelect}
              />
            </label>
            <button
              onClick={() => openForm()}
              className="px-4 py-2 text-sm bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 transition"
            >
              + Add Customer
            </button>
          </div>
        </div>

        {/* Stats Breakdown */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 mb-6">
          {CUSTOMER_TYPES.map((t) => (
            <div
              key={t}
              className="card p-3 text-center cursor-pointer hover:opacity-80 transition"
              onClick={() => setTypeFilter(typeFilter === t ? "" : t)}
              style={{
                borderColor: typeFilter === t ? "var(--border-primary)" : undefined,
                borderWidth: typeFilter === t ? 2 : undefined,
              }}
            >
              <div className="text-lg font-bold text-[var(--text-primary)]">
                {typeCounts[t] || 0}
              </div>
              <div className="text-xs text-[var(--text-secondary)]">{t}</div>
            </div>
          ))}
        </div>

        {/* Messages */}
        {successMsg && (
          <div className="mb-4 p-3 bg-green-900/50 border border-green-500 rounded-lg">
            <p className="text-green-300 text-sm">{successMsg}</p>
          </div>
        )}
        {error && (
          <div className="mb-4 p-3 bg-red-900/50 border border-red-500 rounded-lg">
            <p className="text-red-300 text-sm whitespace-pre-line">{error}</p>
            <button
              onClick={() => setError(null)}
              className="text-red-400 text-xs mt-1 hover:underline"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Add/Edit Form */}
        {showForm && (
          <div className="mb-6 card p-6 border border-blue-500/30">
            <h3 className="text-lg font-semibold text-blue-400 mb-4">
              {editingEntry ? "Edit Customer Mapping" : "Add New Customer Mapping"}
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
              <div>
                <label className="block text-xs text-[var(--text-secondary)] mb-1">
                  Customer Name
                </label>
                <input
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="e.g. Cloudtail India Pvt Ltd"
                  className="w-full px-4 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-primary)] rounded-lg text-[var(--text-primary)] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs text-[var(--text-secondary)] mb-1">
                  Customer Type
                </label>
                <select
                  value={formType}
                  onChange={(e) => setFormType(e.target.value as CustomerType)}
                  className="w-full px-4 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-primary)] rounded-lg text-[var(--text-primary)] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {CUSTOMER_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-[var(--text-secondary)] mb-1">
                  Platform Name (optional)
                </label>
                <input
                  type="text"
                  value={formPlatform}
                  onChange={(e) => setFormPlatform(e.target.value)}
                  placeholder="e.g. Amazon, Flipkart"
                  className="w-full px-4 py-2 bg-[var(--bg-tertiary)] border border-[var(--border-primary)] rounded-lg text-[var(--text-primary)] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
            <div className="flex gap-3">
              <button
                onClick={saveEntry}
                disabled={saving}
                className="px-5 py-2 text-sm bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50 transition"
              >
                {saving
                  ? "Saving..."
                  : editingEntry
                  ? "Update Mapping"
                  : "Add Mapping"}
              </button>
              <button
                onClick={closeForm}
                className="px-5 py-2 text-sm bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg hover:opacity-80 transition"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Bulk Upload Preview */}
        {showUpload && uploadPreview.length > 0 && (
          <div className="mb-6 card p-6 border border-blue-500/30">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-blue-400">
                Bulk Upload Preview
              </h3>
              <div className="flex gap-3">
                <button
                  onClick={downloadTemplate}
                  className="text-xs text-blue-400 hover:underline"
                >
                  Download Template
                </button>
              </div>
            </div>
            <p className="text-sm text-[var(--text-secondary)] mb-3">
              {uploadPreview.length} row{uploadPreview.length !== 1 ? "s" : ""}{" "}
              parsed. Existing customer names will be updated (upsert).
            </p>
            <div className="max-h-64 overflow-y-auto border border-[var(--border-primary)] rounded-lg mb-4">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-[var(--bg-secondary)]">
                  <tr>
                    <th className="text-left py-2 px-4 text-[var(--text-secondary)] font-medium text-xs">
                      #
                    </th>
                    <th className="text-left py-2 px-4 text-[var(--text-secondary)] font-medium text-xs">
                      Customer Name
                    </th>
                    <th className="text-left py-2 px-4 text-[var(--text-secondary)] font-medium text-xs">
                      Customer Type
                    </th>
                    <th className="text-left py-2 px-4 text-[var(--text-secondary)] font-medium text-xs">
                      Platform
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {uploadPreview.slice(0, 100).map((row, idx) => (
                    <tr
                      key={idx}
                      className="border-t border-[var(--border-primary)] hover:bg-[var(--bg-tertiary)] transition"
                    >
                      <td className="py-2 px-4 text-[var(--text-secondary)]">
                        {idx + 1}
                      </td>
                      <td className="py-2 px-4 text-[var(--text-primary)]">
                        {row.customer_name}
                      </td>
                      <td className="py-2 px-4">
                        <span
                          className={`px-2 py-0.5 rounded-full text-xs font-medium ${TYPE_COLORS[row.customer_type] || "bg-gray-500/20 text-gray-400"}`}
                        >
                          {row.customer_type}
                        </span>
                      </td>
                      <td className="py-2 px-4 text-[var(--text-secondary)]">
                        {row.platform_name || "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {uploadPreview.length > 100 && (
                <div className="py-2 px-4 text-center text-[var(--text-secondary)] text-xs">
                  Showing first 100 of {uploadPreview.length} rows
                </div>
              )}
            </div>
            <div className="flex gap-3">
              <button
                onClick={executeBulkUpload}
                disabled={uploading}
                className="px-5 py-2 text-sm bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50 transition"
              >
                {uploading
                  ? `Uploading... (${uploadPreview.length} rows)`
                  : `Upload ${uploadPreview.length} Rows`}
              </button>
              <button
                onClick={() => {
                  setShowUpload(false);
                  setUploadPreview([]);
                }}
                className="px-5 py-2 text-sm bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg hover:opacity-80 transition"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Search & Filter Bar */}
        <div className="flex flex-col sm:flex-row gap-3 mb-4">
          <div className="flex-1">
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search by customer name or platform..."
              className="w-full px-4 py-2 bg-[var(--bg-secondary)] border border-[var(--border-primary)] rounded-lg text-[var(--text-primary)] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="px-4 py-2 bg-[var(--bg-secondary)] border border-[var(--border-primary)] rounded-lg text-[var(--text-primary)] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All Types</option>
            {CUSTOMER_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <button
            onClick={downloadTemplate}
            className="px-4 py-2 text-sm bg-[var(--bg-tertiary)] text-[var(--text-secondary)] rounded-lg hover:opacity-80 transition whitespace-nowrap"
          >
            Download Template
          </button>
        </div>

        {/* Showing X of Y */}
        <div className="text-xs text-[var(--text-secondary)] mb-2">
          Showing {filtered.length} of {entries.length} entries
          {typeFilter && (
            <button
              onClick={() => setTypeFilter("")}
              className="ml-2 text-blue-400 hover:underline"
            >
              Clear filter
            </button>
          )}
        </div>

        {/* Table */}
        <div className="card overflow-hidden">
          {filtered.length === 0 ? (
            <div className="p-12 text-center">
              <p className="text-[var(--text-secondary)] mb-4">
                {entries.length === 0
                  ? "No customer mappings yet. Add your first one or upload an Excel file."
                  : "No results matching your filters."}
              </p>
              {entries.length === 0 && (
                <div className="flex gap-3 justify-center">
                  <button
                    onClick={() => openForm()}
                    className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
                  >
                    + Add Customer
                  </button>
                  <label className="px-4 py-2 text-sm bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg hover:opacity-80 transition cursor-pointer">
                    Upload Excel
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".xlsx,.xls,.csv"
                      className="hidden"
                      onChange={handleFileSelect}
                    />
                  </label>
                </div>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-[var(--bg-tertiary)]">
                    <th className="text-left py-3 px-4 text-[var(--text-secondary)] font-medium text-xs">
                      Customer Name
                    </th>
                    <th className="text-left py-3 px-4 text-[var(--text-secondary)] font-medium text-xs">
                      Customer Type
                    </th>
                    <th className="text-left py-3 px-4 text-[var(--text-secondary)] font-medium text-xs">
                      Platform
                    </th>
                    <th className="text-right py-3 px-4 text-[var(--text-secondary)] font-medium text-xs">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((entry) => (
                    <tr
                      key={entry.id}
                      className="border-t border-[var(--border-primary)] hover:bg-[var(--bg-tertiary)] transition"
                    >
                      <td className="py-3 px-4 text-[var(--text-primary)] font-medium">
                        {entry.customer_name}
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${TYPE_COLORS[entry.customer_type] || "bg-gray-500/20 text-gray-400"}`}
                        >
                          {entry.customer_type}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-[var(--text-secondary)]">
                        {entry.platform_name || "-"}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <div className="flex items-center justify-end gap-3">
                          <button
                            onClick={() => openForm(entry)}
                            className="text-xs text-blue-400 hover:text-blue-300 transition"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => deleteEntry(entry)}
                            className="text-xs text-red-400 hover:text-red-300 transition"
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
