"use client";
import { useEffect, useState, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import * as XLSX from "xlsx";
import Link from "next/link";

type Profile = { id: string; email: string; full_name: string; role: string };
type CfaMapping = {
  id: string;
  cfa_name: string;
  channel: string;
  created_at: string;
};

const CHANNEL_OPTIONS = ["B2C", "B2B", "Qcom", "MT", "GT", "Growth", "CSD", "Sample"] as const;

export default function CfaMapperPage() {
  const supabase = createClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [profile, setProfile] = useState<Profile | null>(null);
  const [mappings, setMappings] = useState<CfaMapping[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Search
  const [search, setSearch] = useState("");

  // Add/Edit form
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<CfaMapping | null>(null);
  const [formCfa, setFormCfa] = useState("");
  const [formChannel, setFormChannel] = useState<string>(CHANNEL_OPTIONS[0]);
  const [saving, setSaving] = useState(false);

  // Bulk upload
  const [showBulkUpload, setShowBulkUpload] = useState(false);
  const [bulkData, setBulkData] = useState<{ cfa_name: string; channel: string }[]>([]);
  const [bulkErrors, setBulkErrors] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);

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
      .select("*")
      .eq("id", user.id)
      .single();
    setProfile(p);
    await loadData();
    setLoading(false);
  }

  async function loadData() {
    const { data, error: e } = await supabase
      .from("cfa_channel_mapper")
      .select("*")
      .order("cfa_name")
      .range(0, 999);
    if (e) {
      setError(e.message);
      return;
    }
    setMappings(data || []);
  }

  function flash(msg: string) {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(null), 3000);
  }

  // ====== FILTERED DATA ======

  const filtered = mappings.filter((m) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      m.cfa_name.toLowerCase().includes(q) ||
      m.channel.toLowerCase().includes(q)
    );
  });

  // ====== STATS ======

  const channelBreakdown: Record<string, number> = {};
  for (const m of mappings) {
    channelBreakdown[m.channel] = (channelBreakdown[m.channel] || 0) + 1;
  }

  // ====== FORM HANDLERS ======

  function openForm(mapping?: CfaMapping) {
    setEditing(mapping || null);
    setFormCfa(mapping?.cfa_name || "");
    setFormChannel(mapping?.channel || CHANNEL_OPTIONS[0]);
    setShowForm(true);
    setShowBulkUpload(false);
    setError(null);
  }

  function closeForm() {
    setShowForm(false);
    setEditing(null);
    setFormCfa("");
    setFormChannel(CHANNEL_OPTIONS[0]);
    setError(null);
  }

  async function saveMapping() {
    const name = formCfa.trim();
    if (!name) {
      setError("CFA/Warehouse name is required.");
      return;
    }
    if (!CHANNEL_OPTIONS.includes(formChannel as any)) {
      setError("Please select a valid channel.");
      return;
    }

    // Check for duplicate (case-insensitive) excluding current editing entry
    const duplicate = mappings.find(
      (m) =>
        m.cfa_name.toLowerCase() === name.toLowerCase() &&
        m.id !== editing?.id
    );
    if (duplicate) {
      setError(
        `"${name}" already exists mapped to ${duplicate.channel}. Edit that entry instead.`
      );
      return;
    }

    setSaving(true);
    setError(null);

    if (editing) {
      const { error: e } = await supabase
        .from("cfa_channel_mapper")
        .update({ cfa_name: name, channel: formChannel })
        .eq("id", editing.id);
      if (e) {
        setError(e.message);
        setSaving(false);
        return;
      }
      flash(`Updated "${name}" -> ${formChannel}`);
    } else {
      const { error: e } = await supabase
        .from("cfa_channel_mapper")
        .insert({ cfa_name: name, channel: formChannel });
      if (e) {
        setError(e.message);
        setSaving(false);
        return;
      }
      flash(`Added "${name}" -> ${formChannel}`);
    }

    closeForm();
    await loadData();
    setSaving(false);
  }

  async function deleteMapping(mapping: CfaMapping) {
    if (
      !confirm(
        `Delete mapping "${mapping.cfa_name}" -> ${mapping.channel}?`
      )
    )
      return;
    const { error: e } = await supabase
      .from("cfa_channel_mapper")
      .delete()
      .eq("id", mapping.id);
    if (e) {
      setError(e.message);
      return;
    }
    flash(`Deleted "${mapping.cfa_name}"`);
    await loadData();
  }

  // ====== BULK UPLOAD ======

  function openBulkUpload() {
    setShowBulkUpload(true);
    setShowForm(false);
    setBulkData([]);
    setBulkErrors([]);
    setError(null);
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = ev.target?.result;
        const workbook = XLSX.read(data, { type: "binary" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json<any>(sheet);

        const parsed: { cfa_name: string; channel: string }[] = [];
        const errors: string[] = [];

        json.forEach((row: any, idx: number) => {
          const cfaName = (
            row["CFA Name"] ||
            row["cfa_name"] ||
            row["CFA"] ||
            row["Warehouse"] ||
            row["warehouse"] ||
            ""
          )
            .toString()
            .trim();
          const channel = (
            row["Channel"] ||
            row["channel"] ||
            ""
          )
            .toString()
            .trim();

          if (!cfaName) {
            errors.push(`Row ${idx + 2}: Missing CFA Name`);
            return;
          }
          if (!channel) {
            errors.push(`Row ${idx + 2}: Missing Channel for "${cfaName}"`);
            return;
          }
          if (!CHANNEL_OPTIONS.includes(channel as any)) {
            errors.push(
              `Row ${idx + 2}: Invalid channel "${channel}" for "${cfaName}". Must be one of: ${CHANNEL_OPTIONS.join(", ")}`
            );
            return;
          }
          parsed.push({ cfa_name: cfaName, channel });
        });

        setBulkData(parsed);
        setBulkErrors(errors);
      } catch (err: any) {
        setError("Failed to parse Excel file: " + err.message);
      }
    };
    reader.readAsBinaryString(file);
  }

  async function executeBulkUpload() {
    if (bulkData.length === 0) return;
    setUploading(true);
    setError(null);

    let successCount = 0;
    let failCount = 0;
    const newErrors: string[] = [];

    for (const row of bulkData) {
      const { error: e } = await supabase
        .from("cfa_channel_mapper")
        .upsert(
          { cfa_name: row.cfa_name, channel: row.channel },
          { onConflict: "cfa_name" }
        );
      if (e) {
        failCount++;
        newErrors.push(`"${row.cfa_name}": ${e.message}`);
      } else {
        successCount++;
      }
    }

    if (newErrors.length > 0) {
      setBulkErrors(newErrors);
    }

    flash(
      `Bulk upload complete: ${successCount} succeeded${failCount > 0 ? `, ${failCount} failed` : ""}`
    );
    setShowBulkUpload(false);
    setBulkData([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
    await loadData();
    setUploading(false);
  }

  function downloadTemplate() {
    const templateData = [
      { "CFA Name": "Example Warehouse 1", Channel: "B2C" },
      { "CFA Name": "Example Warehouse 2", Channel: "GT" },
    ];
    const ws = XLSX.utils.json_to_sheet(templateData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "CFA Mapper");
    ws["!cols"] = [{ wch: 30 }, { wch: 12 }];
    XLSX.writeFile(wb, "CFA_Channel_Mapper_Template.xlsx");
  }

  function downloadExport() {
    if (mappings.length === 0) return;
    const rows = mappings.map((m) => ({
      "CFA Name": m.cfa_name,
      Channel: m.channel,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "CFA Mapper");
    ws["!cols"] = [{ wch: 30 }, { wch: 12 }];
    XLSX.writeFile(
      wb,
      `CFA_Channel_Mapper_Export_${new Date().toISOString().slice(0, 10)}.xlsx`
    );
  }

  // ====== RENDER ======

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <p style={{ color: "var(--text-secondary)" }}>Loading...</p>
      </div>
    );
  }

  if (profile?.role !== "admin") {
    return (
      <div className="py-16 text-center">
        <h2 className="text-2xl font-bold mb-4" style={{ color: "var(--text-primary)" }}>
          Access Restricted
        </h2>
        <p style={{ color: "var(--text-secondary)" }}>
          Admin access required.
        </p>
        <Link
          href="/dashboard"
          className="inline-block mt-6 px-6 py-2 rounded-lg text-sm transition"
          style={{
            background: "var(--bg-tertiary)",
            color: "var(--text-primary)",
          }}
        >
          Back to Dashboard
        </Link>
      </div>
    );
  }

  return (
    <div>
      <div className="max-w-5xl mx-auto">
        {/* HEADER */}
        <div className="flex items-start justify-between mb-6">
          <div>
            <h2
              className="text-2xl font-bold"
              style={{ color: "var(--text-primary)" }}
            >
              CFA / Warehouse Channel Mapper
            </h2>
            <p
              className="text-sm mt-1"
              style={{ color: "var(--text-secondary)" }}
            >
              {mappings.length} mappings total
              {Object.keys(channelBreakdown).length > 0 && (
                <span>
                  {" "}
                  &mdash;{" "}
                  {Object.entries(channelBreakdown)
                    .sort((a, b) => b[1] - a[1])
                    .map(([ch, count]) => `${ch}: ${count}`)
                    .join(", ")}
                </span>
              )}
            </p>
          </div>
          <div className="flex gap-3 flex-wrap justify-end">
            <button
              onClick={downloadExport}
              disabled={mappings.length === 0}
              className="px-4 py-2 text-sm rounded-lg transition disabled:opacity-50"
              style={{
                background: "var(--bg-tertiary)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-primary)",
              }}
            >
              Export
            </button>
            <button
              onClick={openBulkUpload}
              className="px-4 py-2 text-sm rounded-lg transition"
              style={{
                background: "var(--bg-tertiary)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-primary)",
              }}
            >
              Bulk Upload
            </button>
            <button
              onClick={() => openForm()}
              className="px-4 py-2 text-sm bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 transition"
            >
              + Add Mapping
            </button>
          </div>
        </div>

        {/* MESSAGES */}
        {successMsg && (
          <div className="mb-4 p-3 bg-green-900/50 border border-green-500 rounded-lg">
            <p className="text-green-300 text-sm">{successMsg}</p>
          </div>
        )}
        {error && (
          <div className="mb-4 p-3 bg-red-900/50 border border-red-500 rounded-lg">
            <p className="text-red-300 text-sm">{error}</p>
          </div>
        )}

        {/* ADD/EDIT FORM */}
        {showForm && (
          <div
            className="mb-6 rounded-xl p-6"
            style={{
              background: "var(--bg-secondary)",
              border: "1px solid rgba(59, 130, 246, 0.3)",
            }}
          >
            <h3 className="text-lg font-semibold text-blue-400 mb-4">
              {editing ? "Edit Mapping" : "New Mapping"}
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <label
                  className="block text-xs mb-1"
                  style={{ color: "var(--text-secondary)" }}
                >
                  CFA / Warehouse Name
                </label>
                <input
                  type="text"
                  value={formCfa}
                  onChange={(e) => setFormCfa(e.target.value)}
                  placeholder="e.g. ABC Logistics - Mumbai"
                  className="w-full px-4 py-2 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  style={{
                    background: "var(--bg-tertiary)",
                    border: "1px solid var(--border-primary)",
                    color: "var(--text-primary)",
                  }}
                />
              </div>
              <div>
                <label
                  className="block text-xs mb-1"
                  style={{ color: "var(--text-secondary)" }}
                >
                  Channel
                </label>
                <select
                  value={formChannel}
                  onChange={(e) => setFormChannel(e.target.value)}
                  className="w-full px-4 py-2 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  style={{
                    background: "var(--bg-tertiary)",
                    border: "1px solid var(--border-primary)",
                    color: "var(--text-primary)",
                  }}
                >
                  {CHANNEL_OPTIONS.map((ch) => (
                    <option key={ch} value={ch}>
                      {ch}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex gap-3">
              <button
                onClick={saveMapping}
                disabled={saving}
                className="px-5 py-2 text-sm bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50 transition"
              >
                {saving
                  ? "Saving..."
                  : editing
                    ? "Update Mapping"
                    : "Add Mapping"}
              </button>
              <button
                onClick={closeForm}
                className="px-5 py-2 text-sm rounded-lg transition"
                style={{
                  background: "var(--bg-tertiary)",
                  color: "var(--text-primary)",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* BULK UPLOAD */}
        {showBulkUpload && (
          <div
            className="mb-6 rounded-xl p-6"
            style={{
              background: "var(--bg-secondary)",
              border: "1px solid rgba(59, 130, 246, 0.3)",
            }}
          >
            <h3 className="text-lg font-semibold text-blue-400 mb-4">
              Bulk Upload
            </h3>
            <p
              className="text-sm mb-3"
              style={{ color: "var(--text-secondary)" }}
            >
              Upload an Excel file with columns: <strong>CFA Name</strong> and{" "}
              <strong>Channel</strong>. Existing entries with the same CFA name
              will be updated (upsert).
            </p>
            <p
              className="text-xs mb-4"
              style={{ color: "var(--text-secondary)" }}
            >
              Valid channels: {CHANNEL_OPTIONS.join(", ")}
            </p>

            <div className="flex gap-3 mb-4">
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls"
                onChange={handleFileUpload}
                className="text-sm file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-blue-600 file:text-white file:cursor-pointer hover:file:bg-blue-700"
                style={{ color: "var(--text-secondary)" }}
              />
              <button
                onClick={downloadTemplate}
                className="px-4 py-2 text-sm rounded-lg transition whitespace-nowrap"
                style={{
                  background: "var(--bg-tertiary)",
                  color: "var(--text-primary)",
                  border: "1px solid var(--border-primary)",
                }}
              >
                Download Template
              </button>
            </div>

            {/* Bulk errors */}
            {bulkErrors.length > 0 && (
              <div className="mb-4 p-3 bg-red-900/30 border border-red-500/50 rounded-lg max-h-40 overflow-auto">
                <p className="text-red-300 text-xs font-semibold mb-1">
                  {bulkErrors.length} error(s):
                </p>
                {bulkErrors.map((err, i) => (
                  <p key={i} className="text-red-300 text-xs">
                    {err}
                  </p>
                ))}
              </div>
            )}

            {/* Preview parsed data */}
            {bulkData.length > 0 && (
              <div className="mb-4">
                <p
                  className="text-sm font-medium mb-2"
                  style={{ color: "var(--text-primary)" }}
                >
                  Preview: {bulkData.length} rows ready to upload
                </p>
                <div
                  className="max-h-48 overflow-auto rounded-lg"
                  style={{ border: "1px solid var(--border-primary)" }}
                >
                  <table className="w-full text-sm">
                    <thead>
                      <tr style={{ background: "var(--bg-tertiary)" }}>
                        <th
                          className="px-3 py-2 text-left text-xs font-medium"
                          style={{ color: "var(--text-secondary)" }}
                        >
                          CFA Name
                        </th>
                        <th
                          className="px-3 py-2 text-left text-xs font-medium"
                          style={{ color: "var(--text-secondary)" }}
                        >
                          Channel
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {bulkData.map((row, i) => (
                        <tr
                          key={i}
                          style={{
                            borderTop: "1px solid var(--border-primary)",
                          }}
                        >
                          <td
                            className="px-3 py-1.5"
                            style={{ color: "var(--text-primary)" }}
                          >
                            {row.cfa_name}
                          </td>
                          <td
                            className="px-3 py-1.5"
                            style={{ color: "var(--text-primary)" }}
                          >
                            <span className="px-2 py-0.5 rounded text-xs font-medium bg-blue-600/20 text-blue-300">
                              {row.channel}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="flex gap-3">
              {bulkData.length > 0 && (
                <button
                  onClick={executeBulkUpload}
                  disabled={uploading}
                  className="px-5 py-2 text-sm bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50 transition"
                >
                  {uploading
                    ? "Uploading..."
                    : `Upload ${bulkData.length} Rows`}
                </button>
              )}
              <button
                onClick={() => {
                  setShowBulkUpload(false);
                  setBulkData([]);
                  setBulkErrors([]);
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }}
                className="px-5 py-2 text-sm rounded-lg transition"
                style={{
                  background: "var(--bg-tertiary)",
                  color: "var(--text-primary)",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* SEARCH */}
        <div className="mb-4">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search CFA name or channel..."
            className="w-full max-w-md px-4 py-2 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            style={{
              background: "var(--bg-tertiary)",
              border: "1px solid var(--border-primary)",
              color: "var(--text-primary)",
            }}
          />
        </div>

        {/* TABLE */}
        <div
          className="card rounded-xl overflow-hidden"
          style={{
            background: "var(--bg-secondary)",
            border: "1px solid var(--border-primary)",
          }}
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: "var(--bg-tertiary)" }}>
                  <th
                    className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    CFA / Warehouse Name
                  </th>
                  <th
                    className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    Channel
                  </th>
                  <th
                    className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td
                      colSpan={3}
                      className="px-4 py-8 text-center text-sm"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      {search
                        ? "No mappings match your search."
                        : "No CFA mappings yet. Add one to get started."}
                    </td>
                  </tr>
                ) : (
                  filtered.map((m) => (
                    <tr
                      key={m.id}
                      className="transition-colors hover:brightness-110"
                      style={{
                        borderTop: "1px solid var(--border-primary)",
                      }}
                    >
                      <td
                        className="px-4 py-3 font-medium"
                        style={{ color: "var(--text-primary)" }}
                      >
                        {m.cfa_name}
                      </td>
                      <td className="px-4 py-3">
                        <span className="px-2.5 py-1 rounded text-xs font-semibold bg-blue-600/20 text-blue-300">
                          {m.channel}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex gap-2 justify-end">
                          <button
                            onClick={() => openForm(m)}
                            className="px-3 py-1 text-xs rounded-lg transition"
                            style={{
                              background: "var(--bg-tertiary)",
                              color: "var(--text-primary)",
                              border: "1px solid var(--border-primary)",
                            }}
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => deleteMapping(m)}
                            className="px-3 py-1 text-xs rounded-lg bg-red-600/20 text-red-300 hover:bg-red-600/40 transition"
                            style={{
                              border: "1px solid rgba(239, 68, 68, 0.3)",
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* STATS CARD */}
        {mappings.length > 0 && (
          <div
            className="mt-6 rounded-xl p-5"
            style={{
              background: "var(--bg-secondary)",
              border: "1px solid var(--border-primary)",
            }}
          >
            <h3
              className="text-sm font-semibold mb-3"
              style={{ color: "var(--text-secondary)" }}
            >
              Channel Breakdown
            </h3>
            <div className="flex flex-wrap gap-3">
              {CHANNEL_OPTIONS.map((ch) => {
                const count = channelBreakdown[ch] || 0;
                if (count === 0) return null;
                return (
                  <div
                    key={ch}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg"
                    style={{
                      background: "var(--bg-tertiary)",
                      border: "1px solid var(--border-primary)",
                    }}
                  >
                    <span
                      className="text-sm font-medium"
                      style={{ color: "var(--text-primary)" }}
                    >
                      {ch}
                    </span>
                    <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-blue-600/20 text-blue-300">
                      {count}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
