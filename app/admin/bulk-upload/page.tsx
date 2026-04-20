"use client";
import { useEffect, useState, useRef, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";

type Profile = { id: string; role: string };
type Cycle = {
  id: string;
  forecast_month: string;
  version: number;
  status: string;
};

type NewSkuInfo = {
  new_master_sku: string;
  new_fg_code: string;
  fg_code: string;
  product_name: string;
  category: string;
  product_category: string;
};

type UploadResult = {
  success: boolean;
  rows_inserted: number;
  skus_found: number;
  skus_missing: number;
  skus_added?: number;
  channels_matched: number;
  months: string[];
  warnings: string[];
};

export default function BulkUploadPage() {
  const supabase = createClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const [profile, setProfile] = useState<Profile | null>(null);
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCycle, setSelectedCycle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // New SKU confirmation
  const [newSkus, setNewSkus] = useState<NewSkuInfo[]>([]);
  const [showSkuConfirm, setShowSkuConfirm] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    const { data: p } = await supabase
      .from("profiles")
      .select("id, role")
      .eq("id", user.id)
      .single();
    setProfile(p);

    const { data: cyc } = await supabase
      .from("forecast_cycles")
      .select("id, forecast_month, version, status")
      .in("status", ["open", "locked"])
      .order("forecast_month", { ascending: false });
    setCycles(cyc || []);
    setLoading(false);
  }

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f && (f.name.endsWith(".xlsx") || f.name.endsWith(".xls"))) {
      setFile(f);
      setResult(null);
      setError(null);
      setNewSkus([]);
      setShowSkuConfirm(false);
    }
  }, []);

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) {
      setFile(f);
      setResult(null);
      setError(null);
      setNewSkus([]);
      setShowSkuConfirm(false);
    }
  }

  async function doUpload(addNewSkus: boolean) {
    if (!file || !selectedCycle) return;

    setUploading(true);
    setError(null);
    setResult(null);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      const formData = new FormData();
      formData.append("file", file);
      formData.append("cycle_id", selectedCycle);
      formData.append("auth_token", session.access_token);
      if (addNewSkus) formData.append("add_new_skus", "true");

      const res = await fetch("/api/admin/bulk-upload-forecast", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();

      if (data.needs_confirmation) {
        // API found new SKUs — show confirmation dialog
        setNewSkus(data.new_skus || []);
        setShowSkuConfirm(true);
        return;
      }

      if (!res.ok) {
        setError(data.error || "Upload failed");
        if (data.warnings) {
          setResult({
            success: false,
            rows_inserted: 0,
            skus_found: 0,
            skus_missing: 0,
            channels_matched: 0,
            months: [],
            warnings: data.warnings,
          });
        }
      } else {
        setResult(data);
        setShowSkuConfirm(false);
        setNewSkus([]);
      }
    } catch (err: any) {
      setError(err.message || "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function handleUpload() {
    if (!file || !selectedCycle) return;

    const cycle = cycles.find((c) => c.id === selectedCycle);
    if (!cycle) return;

    const confirmMsg = `This will REPLACE all existing forecast data for ${formatMonth(cycle.forecast_month)} V${cycle.version} (${cycle.status}).\n\nProceed?`;
    if (!confirm(confirmMsg)) return;

    await doUpload(false);
  }

  async function handleConfirmAddSkus() {
    // User confirmed adding new SKUs — re-upload with flag
    await doUpload(true);
  }

  function handleSkipNewSkus() {
    // User chose to skip new SKUs — upload without adding them
    setShowSkuConfirm(false);
    setNewSkus([]);
    doUpload(false);
  }

  function formatMonth(d: string) {
    const date = new Date(d);
    return date.toLocaleDateString("en-IN", {
      month: "short",
      year: "numeric",
    });
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!profile || profile.role !== "admin") {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="card p-8 text-center">
          <p className="text-[var(--text-secondary)]">
            Only admins can access Bulk Upload.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-[var(--text-primary)]">
          Bulk Upload Forecast
        </h1>
        <p className="text-sm text-[var(--text-secondary)] mt-1">
          Upload a forecast file in the download format (with Channels sheet) to
          populate forecast data for a cycle.
        </p>
      </div>

      {/* Cycle selector */}
      <div className="card p-5 space-y-4">
        <label className="block text-sm font-medium text-[var(--text-primary)]">
          Select Forecast Cycle
        </label>
        <select
          value={selectedCycle}
          onChange={(e) => {
            setSelectedCycle(e.target.value);
            setResult(null);
            setError(null);
            setNewSkus([]);
            setShowSkuConfirm(false);
          }}
          className="w-full px-3 py-2 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-primary)] text-[var(--text-primary)] text-sm"
        >
          <option value="">— Choose cycle —</option>
          {cycles.map((c) => (
            <option key={c.id} value={c.id}>
              {formatMonth(c.forecast_month)} — V{c.version} ({c.status})
            </option>
          ))}
        </select>
      </div>

      {/* File drop zone */}
      <div
        className={`card p-8 border-2 border-dashed transition-colors cursor-pointer ${
          dragOver
            ? "border-blue-500 bg-blue-500/5"
            : file
              ? "border-green-500/50 bg-green-500/5"
              : "border-[var(--border-primary)]"
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileRef.current?.click()}
      >
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls"
          className="hidden"
          onChange={handleFileSelect}
        />
        <div className="text-center">
          {file ? (
            <>
              <div className="text-3xl mb-2">📄</div>
              <p className="font-medium text-[var(--text-primary)]">
                {file.name}
              </p>
              <p className="text-xs text-[var(--text-secondary)] mt-1">
                {(file.size / 1024).toFixed(0)} KB — Click or drop to replace
              </p>
            </>
          ) : (
            <>
              <div className="text-3xl mb-2">📁</div>
              <p className="font-medium text-[var(--text-primary)]">
                Drop forecast Excel file here
              </p>
              <p className="text-xs text-[var(--text-secondary)] mt-1">
                or click to browse — .xlsx / .xls
              </p>
            </>
          )}
        </div>
      </div>

      {/* Upload button */}
      <button
        onClick={handleUpload}
        disabled={!file || !selectedCycle || uploading || showSkuConfirm}
        className="w-full py-3 rounded-lg font-semibold text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed bg-blue-600 hover:bg-blue-700"
      >
        {uploading ? (
          <span className="flex items-center justify-center gap-2">
            <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            {showSkuConfirm
              ? "Adding SKUs & Uploading..."
              : "Uploading & Processing..."}
          </span>
        ) : (
          "Upload & Populate Forecast"
        )}
      </button>

      {/* New SKU Confirmation */}
      {showSkuConfirm && newSkus.length > 0 && (
        <div className="card p-5 space-y-4 border border-blue-500/30 bg-blue-500/5">
          <div className="flex items-center gap-2 text-blue-400 font-semibold">
            <svg
              className="w-5 h-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
              />
            </svg>
            {newSkus.length} New SKU(s) Found
          </div>

          <p className="text-sm text-[var(--text-secondary)]">
            The following SKUs are not in the SKU Master. Would you like to add
            them?
          </p>

          {/* SKU table */}
          <div className="max-h-64 overflow-auto rounded-lg border border-[var(--border-primary)]">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                  <th className="px-3 py-2 text-left font-medium">
                    Master SKU
                  </th>
                  <th className="px-3 py-2 text-left font-medium">FG Code</th>
                  <th className="px-3 py-2 text-left font-medium">
                    Product Name
                  </th>
                  <th className="px-3 py-2 text-left font-medium">Category</th>
                </tr>
              </thead>
              <tbody>
                {newSkus.map((s, i) => (
                  <tr
                    key={i}
                    className="border-t border-[var(--border-primary)]"
                  >
                    <td className="px-3 py-1.5 font-mono text-[var(--text-primary)]">
                      {s.new_master_sku}
                    </td>
                    <td className="px-3 py-1.5 text-[var(--text-secondary)]">
                      {s.new_fg_code || "—"}
                    </td>
                    <td className="px-3 py-1.5 text-[var(--text-primary)]">
                      {s.product_name || "—"}
                    </td>
                    <td className="px-3 py-1.5 text-[var(--text-secondary)]">
                      {s.category || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex gap-3">
            <button
              onClick={handleConfirmAddSkus}
              disabled={uploading}
              className="flex-1 py-2.5 rounded-lg font-semibold text-white bg-green-600 hover:bg-green-700 transition-all disabled:opacity-50"
            >
              {uploading ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Adding & Uploading...
                </span>
              ) : (
                `Add ${newSkus.length} SKU(s) & Upload`
              )}
            </button>
            <button
              onClick={handleSkipNewSkus}
              disabled={uploading}
              className="px-4 py-2.5 rounded-lg font-medium text-[var(--text-secondary)] bg-[var(--bg-tertiary)] hover:bg-[var(--bg-secondary)] transition-all disabled:opacity-50"
            >
              Skip & Upload Without
            </button>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="card p-4 border border-red-500/30 bg-red-500/5">
          <p className="text-sm font-medium text-red-400">{error}</p>
        </div>
      )}

      {/* Results */}
      {result && result.success && (
        <div className="card p-5 space-y-4 border border-green-500/30 bg-green-500/5">
          <div className="flex items-center gap-2 text-green-400 font-semibold">
            <svg
              className="w-5 h-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
            Upload Successful
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <div className="text-center">
              <p className="text-2xl font-bold text-[var(--text-primary)]">
                {result.rows_inserted.toLocaleString()}
              </p>
              <p className="text-xs text-[var(--text-secondary)]">
                Rows Inserted
              </p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-[var(--text-primary)]">
                {result.skus_found}
              </p>
              <p className="text-xs text-[var(--text-secondary)]">
                SKUs Matched
              </p>
            </div>
            {(result.skus_added ?? 0) > 0 && (
              <div className="text-center">
                <p className="text-2xl font-bold text-green-400">
                  +{result.skus_added}
                </p>
                <p className="text-xs text-[var(--text-secondary)]">
                  SKUs Added
                </p>
              </div>
            )}
            <div className="text-center">
              <p className="text-2xl font-bold text-[var(--text-primary)]">
                {result.channels_matched}
              </p>
              <p className="text-xs text-[var(--text-secondary)]">Channels</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-[var(--text-primary)]">
                {result.months?.length || 0}
              </p>
              <p className="text-xs text-[var(--text-secondary)]">Months</p>
            </div>
          </div>

          {result.months && result.months.length > 0 && (
            <p className="text-xs text-[var(--text-secondary)]">
              Months covered: {result.months.join(", ")}
            </p>
          )}

          {result.skus_missing > 0 && (
            <div className="p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
              <p className="text-xs font-medium text-yellow-400">
                {result.skus_missing} SKU(s) still not matched (skipped)
              </p>
            </div>
          )}

          {result.warnings && result.warnings.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-[var(--text-secondary)]">
                Warnings:
              </p>
              {result.warnings.map((w, i) => (
                <p key={i} className="text-xs text-yellow-400 pl-2">
                  • {w}
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Info */}
      <div className="card p-4">
        <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
          <strong>How it works:</strong> Upload an Excel file with a "Channels"
          sheet in the standard download format. The system reads SKU rows and
          channel columns, matches them to the database, and inserts all
          quantities into the selected cycle. If new SKUs are found, you'll be
          asked to confirm adding them to the SKU Master before proceeding. This
          replaces any existing data for that cycle.
        </p>
      </div>
    </div>
  );
}
