"use client";
import { useEffect, useState, useRef, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import * as XLSX from "xlsx";
import Link from "next/link";

type Profile = { id: string; email: string; full_name: string; role: string };
type Channel = { id: string; name: string; cluster_id: string };
type Cluster = { id: string; name: string };
type Cycle = { id: string; forecast_month: string; version: number; status: string; deadline: string | null };
type SKU = { id: string; new_master_sku: string; fg_code: string; product_name: string; category: string; product_category: string; is_active: boolean; discontinued_at: string | null };

type UploadRow = {
  sku_id: string;
  new_master_sku: string;
  product_name: string;
  channel_id: string;
  channel_name: string;
  qty_m1: number;
  qty_m2: number;
  qty_m3: number;
  isValid: boolean;
  errors: string[];
  originalRow: number;
};

function addMonths(dateStr: string, n: number): string {
  const d = new Date(dateStr);
  d.setMonth(d.getMonth() + n);
  return d.toISOString().slice(0, 10);
}

function formatMonthShort(dateStr: string): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short" });
}

export default function UploadPage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [skus, setSkus] = useState<SKU[]>([]);
  const [channelSkuMapping, setChannelSkuMapping] = useState<Map<string, Set<string>>>(new Map());
  const [allowedChannelIds, setAllowedChannelIds] = useState<string[]>([]);
  const [selectedChannel, setSelectedChannel] = useState("");
  const [selectedCycle, setSelectedCycle] = useState("");
  const [uploadMode, setUploadMode] = useState<"single" | "multi">("single");
  const [loading, setLoading] = useState(true);
  const [uploadData, setUploadData] = useState<UploadRow[]>([]);
  const [showPreview, setShowPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const supabase = createClient();

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data: profileData } = await supabase.from("profiles").select("*").eq("id", user.id).single();
    setProfile(profileData);

    const { data: channelData } = await supabase.from("channels").select("*").eq("is_active", true).order("display_order");
    if (channelData) setChannels(channelData);

    const { data: clusterData } = await supabase.from("clusters").select("*").order("display_order");
    if (clusterData) setClusters(clusterData);

    const { data: cycleData } = await supabase.from("forecast_cycles").select("*").eq("status", "open").order("forecast_month", { ascending: false });
    if (cycleData) setCycles(cycleData);

    const { data: skuData } = await supabase.from("sku_master").select("*").eq("is_active", true).is("discontinued_at", null).order("product_name");
    if (skuData) setSkus(skuData);

    // Load channel-SKU mappings
    const { data: mappingData } = await supabase.from("channel_sku_mapping").select("channel_id, sku_id").eq("is_enabled", true);
    if (mappingData) {
      const map = new Map<string, Set<string>>();
      mappingData.forEach((m: any) => {
        if (!map.has(m.channel_id)) map.set(m.channel_id, new Set());
        map.get(m.channel_id)!.add(m.sku_id);
      });
      setChannelSkuMapping(map);
    }

    // Determine allowed channels based on role
    if (profileData) {
      if (profileData.role === "admin") {
        if (channelData) setAllowedChannelIds(channelData.map((c: Channel) => c.id));
      } else if (profileData.role === "head_kam") {
        const { data: userClusters } = await supabase.from("user_clusters").select("cluster_id").eq("user_id", user.id);
        if (userClusters && channelData) {
          const clusterIds = userClusters.map((uc: any) => uc.cluster_id);
          setAllowedChannelIds(channelData.filter((ch: Channel) => clusterIds.includes(ch.cluster_id)).map((ch: Channel) => ch.id));
        }
      } else if (profileData.role === "channel_kam") {
        const { data: userChannels } = await supabase.from("user_channels").select("channel_id").eq("user_id", user.id);
        if (userChannels) setAllowedChannelIds(userChannels.map((uc: any) => uc.channel_id));
      }
    }
    setLoading(false);
  }

  const allowedChannels = channels.filter((ch) => allowedChannelIds.includes(ch.id));
  const selectedCycleData = cycles.find((c) => c.id === selectedCycle);
  const isDeadlinePassed = selectedCycleData?.deadline && new Date(selectedCycleData.deadline) < new Date();

  // Multi mode: Admin and Head KAM only (they manage multiple channels)
  const canUseMultiMode = profile?.role === "admin" || profile?.role === "head_kam";
  const canUpload = profile?.role === "admin" || profile?.role === "head_kam" || profile?.role === "channel_kam";

  // 3-month labels
  const month1 = selectedCycleData?.forecast_month || "";
  const month2 = month1 ? addMonths(month1, 1) : "";
  const month3 = month1 ? addMonths(month1, 2) : "";
  const m1Label = formatMonthShort(month1);
  const m2Label = formatMonthShort(month2);
  const m3Label = formatMonthShort(month3);

  function getChannelsByCluster() {
    const grouped: { cluster: Cluster; channels: Channel[] }[] = [];
    clusters.forEach((cl) => {
      const clChannels = allowedChannels.filter((ch) => ch.cluster_id === cl.id);
      if (clChannels.length > 0) grouped.push({ cluster: cl, channels: clChannels });
    });
    return grouped;
  }

  function getSkusForChannel(channelId: string): SKU[] {
    const chMapping = channelSkuMapping.get(channelId);
    if (chMapping && chMapping.size > 0) return skus.filter((s) => chMapping.has(s.id));
    return skus;
  }

  // ====== TEMPLATE DOWNLOAD ======
  function downloadTemplate() {
    if (!selectedCycle) { setError("Please select a forecast cycle first."); return; }

    if (uploadMode === "single") {
      if (!selectedChannel) { setError("Please select a channel."); return; }
      const channelName = channels.find((c) => c.id === selectedChannel)?.name || "Channel";
      const chSkus = getSkusForChannel(selectedChannel);

      // Single mode: New Master SKU | M1 | M2 | M3  (no Channel column needed)
      const templateData = chSkus.map((sku) => ({
        "New Master SKU": sku.new_master_sku,
        [m1Label]: "",
        [m2Label]: "",
        [m3Label]: "",
      }));

      const ws = XLSX.utils.json_to_sheet(templateData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Forecast");
      ws["!cols"] = [{ wch: 18 }, { wch: 14 }, { wch: 14 }, { wch: 14 }];
      const cycleName = `${m1Label.replace(" ", "_")}_V${selectedCycleData?.version || 1}`;
      XLSX.writeFile(wb, `${channelName}_${cycleName}_Template.xlsx`);
    } else {
      // Multi mode: New Master SKU | Channel | M1 | M2 | M3
      const templateData: any[] = [];
      allowedChannels.forEach((ch) => {
        const chSkus = getSkusForChannel(ch.id);
        chSkus.forEach((sku) => {
          templateData.push({
            "New Master SKU": sku.new_master_sku,
            "Channel": ch.name,
            [m1Label]: "",
            [m2Label]: "",
            [m3Label]: "",
          });
        });
      });

      const ws = XLSX.utils.json_to_sheet(templateData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Forecast");
      ws["!cols"] = [{ wch: 18 }, { wch: 20 }, { wch: 14 }, { wch: 14 }, { wch: 14 }];
      const cycleName = `${m1Label.replace(" ", "_")}_V${selectedCycleData?.version || 1}`;
      XLSX.writeFile(wb, `Multi_Channel_${cycleName}_Template.xlsx`);
    }
  }

  // ====== FILE PARSING ======
  function parseFile(file: File) {
    setError(null);
    if (!file.name.endsWith(".xlsx") && !file.name.endsWith(".xls") && !file.name.endsWith(".csv")) {
      setError("Please upload an Excel file (.xlsx, .xls) or CSV file.");
      return;
    }

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = evt.target?.result;
        const workbook = XLSX.read(data, { type: "binary" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json<any>(sheet);

        if (json.length === 0) { setError("The uploaded file is empty."); return; }

        const headers = Object.keys(json[0]);

        // Auto-detect if file has a Channel/Platform column
        const hasChannelCol = headers.some((h) =>
          ["Channel", "channel", "Platform", "platform"].includes(h)
        );

        // If no channel column and no channel selected, error
        if (!hasChannelCol && !selectedChannel) {
          setError("File has no Channel column. Please select a channel in single-channel mode, or add a Channel column.");
          return;
        }

        // Detect month columns
        const m1Col = headers.find((h) => h === m1Label || h.includes(m1Label)) || headers.find((h) => /quantity|qty/i.test(h)) || m1Label;
        const m2Col = headers.find((h) => h === m2Label || h.includes(m2Label)) || m2Label;
        const m3Col = headers.find((h) => h === m3Label || h.includes(m3Label)) || m3Label;

        const rows: UploadRow[] = json.map((row: any, index: number) => {
          const errors: string[] = [];

          // SKU validation
          const skuCode = String(row["New Master SKU"] || row["new_master_sku"] || "").trim();
          const matchedSku = skus.find((s) => s.new_master_sku.toLowerCase() === skuCode.toLowerCase());
          if (!skuCode) errors.push("Missing SKU");
          else if (!matchedSku) errors.push(`SKU "${skuCode}" not found`);

          // Channel resolution
          let channelId = "";
          let channelName = "";

          if (hasChannelCol) {
            // Multi-channel file: read channel from row
            const platform = String(row["Channel"] || row["channel"] || row["Platform"] || row["platform"] || "").trim();
            if (!platform) {
              errors.push("Missing Channel");
            } else {
              const matchedCh = channels.find((ch) => ch.name.toLowerCase() === platform.toLowerCase());
              if (!matchedCh) {
                errors.push(`Channel "${platform}" not found`);
              } else if (!allowedChannelIds.includes(matchedCh.id)) {
                // ACCESS ENFORCEMENT: reject channels user doesn't have access to
                errors.push(`No access to "${platform}"`);
              } else {
                channelId = matchedCh.id;
                channelName = matchedCh.name;
              }
            }
          } else {
            // Single-channel file: use selected channel
            channelId = selectedChannel;
            channelName = channels.find((c) => c.id === selectedChannel)?.name || "";
          }

          // Validate SKU-channel mapping
          if (matchedSku && channelId) {
            const chMapping = channelSkuMapping.get(channelId);
            if (chMapping && chMapping.size > 0 && !chMapping.has(matchedSku.id)) {
              errors.push("SKU not enabled for this channel");
            }
          }

          // Parse 3 month quantities
          function parseQty(val: any, label: string): number {
            if (val === "" || val === null || val === undefined) return 0;
            const num = Number(val);
            if (isNaN(num)) { errors.push(`Invalid number in ${label}`); return 0; }
            if (num < 0) { errors.push(`Negative in ${label}`); return 0; }
            return num;
          }

          const q1 = parseQty(row[m1Col], m1Label);
          const q2 = parseQty(row[m2Col], m2Label);
          const q3 = parseQty(row[m3Col], m3Label);

          if (matchedSku && channelId && q1 === 0 && q2 === 0 && q3 === 0) {
            errors.push("All quantities are zero");
          }

          return {
            sku_id: matchedSku?.id || "",
            new_master_sku: skuCode || "-",
            product_name: matchedSku?.product_name || "Unknown",
            channel_id: channelId,
            channel_name: channelName || "-",
            qty_m1: q1, qty_m2: q2, qty_m3: q3,
            isValid: errors.length === 0,
            errors,
            originalRow: index + 2,
          };
        });

        setUploadData(rows);
        setShowPreview(true);
      } catch (err) {
        setError("Failed to parse the file. Please check the format.");
      }
    };
    reader.readAsBinaryString(file);
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) parseFile(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") setDragActive(true);
    else if (e.type === "dragleave") setDragActive(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) parseFile(file);
  }, [skus, channels, allowedChannelIds, selectedChannel, m1Label]);

  // ====== SAVE ======
  async function handleSave() {
    const validRows = uploadData.filter((r) => r.isValid);
    if (validRows.length === 0) { setError("No valid rows to save."); return; }

    setSaving(true);
    setError(null);

    const { data: { user } } = await supabase.auth.getUser();

    // Build inserts: up to 3 per row (one per month), skip zero qty
    const inserts: any[] = [];
    for (const row of validRows) {
      const base = {
        sku_id: row.sku_id,
        channel_id: row.channel_id,
        version: selectedCycleData?.version || 1,
        status: "draft",
        cycle_id: selectedCycle,
        uploaded_by: user?.id,
        uploaded_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      if (row.qty_m1 > 0) inserts.push({ ...base, forecast_month: month1, quantity: row.qty_m1 });
      if (row.qty_m2 > 0) inserts.push({ ...base, forecast_month: month2, quantity: row.qty_m2 });
      if (row.qty_m3 > 0) inserts.push({ ...base, forecast_month: month3, quantity: row.qty_m3 });
    }

    // Delete existing drafts for affected channels
    const channelIds = [...new Set(validRows.map((r) => r.channel_id))];
    for (const chId of channelIds) {
      await supabase.from("forecast_data").delete()
        .eq("channel_id", chId)
        .eq("cycle_id", selectedCycle)
        .eq("status", "draft")
        .eq("uploaded_by", user?.id);
    }

    const { error: insertError } = await supabase.from("forecast_data").insert(inserts);
    if (insertError) { setError(insertError.message); setSaving(false); return; }

    // Logs
    const channelNames = channelIds.map((id) => channels.find((c) => c.id === id)?.name).join(", ");
    for (const chId of channelIds) {
      const chRows = validRows.filter((r) => r.channel_id === chId);
      await supabase.from("upload_log").insert({
        user_id: user?.id, channel_id: chId,
        forecast_month: selectedCycleData?.forecast_month,
        file_name: `${channels.find((c) => c.id === chId)?.name}_upload`,
        rows_uploaded: chRows.length, status: "success",
      });
    }

    await supabase.from("audit_log").insert({
      user_id: user?.id, user_email: user?.email, action: "forecast_upload",
      table_name: "forecast_data", record_id: selectedCycle,
      new_values: {
        channels: channelNames, mode: uploadMode,
        cycle: `${m1Label} V${selectedCycleData?.version}`,
        sku_rows: validRows.length, db_rows: inserts.length,
        months: [m1Label, m2Label, m3Label],
      },
    });

    setSuccessMsg(
      `${validRows.length} SKU rows saved across ${channelIds.length} channel(s): ${channelNames}. (${inserts.length} forecast records created)`
    );
    setShowPreview(false);
    setUploadData([]);
    setSaving(false);
    setTimeout(() => setSuccessMsg(null), 6000);
  }

  function formatDeadline(dateStr: string | null) {
    if (!dateStr) return "No deadline";
    return new Date(dateStr).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  const validCount = uploadData.filter((r) => r.isValid).length;
  const errorCount = uploadData.filter((r) => !r.isValid).length;
  const totalM1 = uploadData.filter((r) => r.isValid).reduce((s, r) => s + r.qty_m1, 0);
  const totalM2 = uploadData.filter((r) => r.isValid).reduce((s, r) => s + r.qty_m2, 0);
  const totalM3 = uploadData.filter((r) => r.isValid).reduce((s, r) => s + r.qty_m3, 0);
  const uniqueChannels = [...new Set(uploadData.filter((r) => r.isValid).map((r) => r.channel_name))];

  // Ready to show upload zone?
  const readyToUpload = selectedCycle && (uploadMode === "multi" || (uploadMode === "single" && selectedChannel));

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 text-white">
        <nav className="border-b border-gray-800 bg-gray-900">
          <div className="max-w-7xl mx-auto px-6 py-4">
            <Link href="/dashboard" className="text-lg font-bold text-white">Demand Planning Module - Yogabars</Link>
          </div>
        </nav>
        <div className="flex items-center justify-center h-64"><p className="text-gray-400">Loading...</p></div>
      </div>
    );
  }

  if (!canUpload) {
    return (
      <div className="min-h-screen bg-gray-950 text-white">
        <nav className="border-b border-gray-800 bg-gray-900">
          <div className="max-w-7xl mx-auto px-6 py-4 flex items-center gap-6">
            <Link href="/dashboard" className="text-lg font-bold text-white">Demand Planning Module - Yogabars</Link>
            <Link href="/dashboard" className="text-sm text-gray-400 hover:text-white transition">Dashboard</Link>
          </div>
        </nav>
        <div className="max-w-7xl mx-auto px-6 py-16 text-center">
          <h2 className="text-2xl font-bold mb-4">Access Restricted</h2>
          <p className="text-gray-400">Your role does not have upload access.</p>
          <Link href="/dashboard" className="inline-block mt-6 px-6 py-2 bg-gray-800 rounded-lg text-sm hover:bg-gray-700 transition">Back to Dashboard</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <nav className="border-b border-gray-800 bg-gray-900">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/dashboard" className="text-lg font-bold text-white">Demand Planning Module - Yogabars</Link>
            <div className="hidden md:flex items-center gap-4">
              <Link href="/dashboard" className="text-sm text-gray-400 hover:text-white transition">Dashboard</Link>
              <span className="text-sm text-amber-400 font-medium">Upload</span>
              <Link href="/channels" className="text-sm text-gray-400 hover:text-white transition">Channels</Link>
              <Link href="/combo-converter" className="text-sm text-gray-400 hover:text-white transition">Combo → Singles</Link>
              {profile?.role === "admin" && <Link href="/admin" className="text-sm text-gray-400 hover:text-white transition">Admin</Link>}
            </div>
          </div>
        </div>
      </nav>

      <div className="max-w-6xl mx-auto px-6 py-8">
        <h2 className="text-2xl font-bold mb-2">Upload Forecast</h2>
        <p className="text-sm text-gray-400 mb-8">
          Upload forecast data with 3-month rolling quantities. Data is saved as draft until admin publishes.
        </p>

        {successMsg && (
          <div className="mb-6 p-4 bg-green-900/50 border border-green-500 rounded-xl">
            <p className="text-green-300 font-medium">{successMsg}</p>
            <p className="text-green-400/70 text-sm mt-1">Saved as draft. Admin will review and publish.</p>
          </div>
        )}

        {!showPreview && (
          <div className="space-y-6">

            {/* Upload Mode Toggle (Admin & Head KAM only) */}
            {canUseMultiMode && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
                <label className="block text-sm font-medium text-gray-300 mb-3">Upload Mode</label>
                <div className="flex gap-3">
                  <button
                    onClick={() => { setUploadMode("single"); setError(null); }}
                    className={`flex-1 px-4 py-3 rounded-lg text-sm text-left transition border ${
                      uploadMode === "single"
                        ? "bg-amber-500/10 text-amber-400 border-amber-500/30 ring-1 ring-amber-500"
                        : "bg-gray-800 text-gray-400 border-transparent hover:bg-gray-700"
                    }`}
                  >
                    <p className="font-medium">Single Channel</p>
                    <p className="text-xs mt-0.5 opacity-70">Upload for one channel at a time</p>
                  </button>
                  <button
                    onClick={() => { setUploadMode("multi"); setSelectedChannel(""); setError(null); }}
                    className={`flex-1 px-4 py-3 rounded-lg text-sm text-left transition border ${
                      uploadMode === "multi"
                        ? "bg-amber-500/10 text-amber-400 border-amber-500/30 ring-1 ring-amber-500"
                        : "bg-gray-800 text-gray-400 border-transparent hover:bg-gray-700"
                    }`}
                  >
                    <p className="font-medium">Multi-Channel</p>
                    <p className="text-xs mt-0.5 opacity-70">Upload for all your channels in one file</p>
                  </button>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

              {/* Channel Selection (Single mode only) */}
              {uploadMode === "single" && (
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
                  <label className="block text-sm font-medium text-gray-300 mb-3">
                    {canUseMultiMode ? "2" : "1"}. Select Channel
                  </label>
                  {allowedChannels.length === 0 ? (
                    <p className="text-sm text-red-400">No channels assigned to you. Contact admin.</p>
                  ) : (
                    <select value={selectedChannel} onChange={(e) => setSelectedChannel(e.target.value)}
                      className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-500">
                      <option value="">Choose a channel...</option>
                      {getChannelsByCluster().map((group) => (
                        <optgroup key={group.cluster.id} label={group.cluster.name}>
                          {group.channels.map((ch) => (
                            <option key={ch.id} value={ch.id}>{ch.name}</option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  )}
                </div>
              )}

              {/* Multi-channel info */}
              {uploadMode === "multi" && (
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
                  <label className="block text-sm font-medium text-gray-300 mb-3">2. Your Channels ({allowedChannels.length})</label>
                  <p className="text-xs text-gray-500 mb-3">
                    Template includes only channels you have access to. Upload will reject any channel outside your access.
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {allowedChannels.map((ch) => (
                      <span key={ch.id} className="px-2 py-1 bg-gray-800 rounded text-xs text-gray-300">{ch.name}</span>
                    ))}
                  </div>
                </div>
              )}

              {/* Cycle Selection */}
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
                <label className="block text-sm font-medium text-gray-300 mb-3">
                  {canUseMultiMode ? "3" : "2"}. Select Forecast Cycle
                </label>
                {cycles.length === 0 ? (
                  <p className="text-sm text-red-400">
                    No open forecast cycles. {profile?.role === "admin" ? "Create one in Admin > Forecast Cycles." : "Contact admin."}
                  </p>
                ) : (
                  <select value={selectedCycle} onChange={(e) => setSelectedCycle(e.target.value)}
                    className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-500">
                    <option value="">Choose a cycle...</option>
                    {cycles.map((cycle) => (
                      <option key={cycle.id} value={cycle.id}>
                        {formatMonthShort(cycle.forecast_month)} - V{cycle.version}
                        {cycle.deadline ? ` (Due: ${formatDeadline(cycle.deadline)})` : ""}
                      </option>
                    ))}
                  </select>
                )}
                {isDeadlinePassed && (
                  <div className="mt-3 p-3 bg-red-900/50 border border-red-500 rounded-lg">
                    <p className="text-red-300 text-xs">Deadline passed. You may not be able to submit.</p>
                  </div>
                )}
              </div>
            </div>

            {/* Template Info + Download */}
            {readyToUpload && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-medium text-gray-300 mb-1">
                      {canUseMultiMode ? "4" : "3"}. Download Template & Upload
                    </h3>
                    <p className="text-xs text-gray-500">
                      {uploadMode === "single" ? (
                        <>Columns: <span className="text-white">New Master SKU</span>, <span className="text-amber-400">{m1Label}</span>, <span className="text-blue-400">{m2Label}</span>, <span className="text-purple-400">{m3Label}</span></>
                      ) : (
                        <>Columns: <span className="text-white">New Master SKU</span>, <span className="text-white">Channel</span>, <span className="text-amber-400">{m1Label}</span>, <span className="text-blue-400">{m2Label}</span>, <span className="text-purple-400">{m3Label}</span></>
                      )}
                    </p>
                  </div>
                  <button onClick={downloadTemplate} className="px-4 py-2 text-sm bg-gray-800 text-gray-300 rounded-lg hover:bg-gray-700 transition whitespace-nowrap">
                    Download Template
                  </button>
                </div>
              </div>
            )}

            {/* Upload Zone */}
            {readyToUpload && !isDeadlinePassed && (
              <div onDragEnter={handleDrag} onDragLeave={handleDrag} onDragOver={handleDrag} onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition ${dragActive ? "border-amber-500 bg-amber-500/5" : "border-gray-700 hover:border-gray-600 hover:bg-gray-900/50"}`}>
                <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFileInput} />
                <div className="text-4xl mb-3">{"\uD83D\uDCC4"}</div>
                <p className="text-gray-300 font-medium mb-1">Drag & drop your Excel file here</p>
                <p className="text-gray-500 text-sm">or click to browse</p>
              </div>
            )}

            {error && (
              <div className="p-4 bg-red-900/50 border border-red-500 rounded-xl">
                <p className="text-red-300 text-sm">{error}</p>
              </div>
            )}
          </div>
        )}

        {/* ====== PREVIEW ====== */}
        {showPreview && (
          <div>
            {/* Summary */}
            <div className="grid grid-cols-3 md:grid-cols-7 gap-3 mb-6">
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 text-center">
                <p className="text-xl font-bold">{uploadData.length}</p>
                <p className="text-xs text-gray-400">Rows</p>
              </div>
              <div className="bg-gray-900 border border-green-800 rounded-xl p-3 text-center">
                <p className="text-xl font-bold text-green-400">{validCount}</p>
                <p className="text-xs text-gray-400">Valid</p>
              </div>
              <div className="bg-gray-900 border border-red-800 rounded-xl p-3 text-center">
                <p className="text-xl font-bold text-red-400">{errorCount}</p>
                <p className="text-xs text-gray-400">Errors</p>
              </div>
              <div className="bg-gray-900 border border-amber-800/50 rounded-xl p-3 text-center">
                <p className="text-xl font-bold text-amber-400">{totalM1.toLocaleString()}</p>
                <p className="text-xs text-gray-400">{m1Label}</p>
              </div>
              <div className="bg-gray-900 border border-blue-800/50 rounded-xl p-3 text-center">
                <p className="text-xl font-bold text-blue-400">{totalM2.toLocaleString()}</p>
                <p className="text-xs text-gray-400">{m2Label}</p>
              </div>
              <div className="bg-gray-900 border border-purple-800/50 rounded-xl p-3 text-center">
                <p className="text-xl font-bold text-purple-400">{totalM3.toLocaleString()}</p>
                <p className="text-xs text-gray-400">{m3Label}</p>
              </div>
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 text-center">
                <p className="text-xl font-bold text-cyan-400">{uniqueChannels.length}</p>
                <p className="text-xs text-gray-400">Channels</p>
              </div>
            </div>

            {/* Info bar */}
            <div className="flex items-center gap-4 mb-4 text-sm text-gray-400 flex-wrap">
              <span>Cycle: <span className="text-white font-medium">{m1Label} V{selectedCycleData?.version}</span></span>
              <span>&#8226;</span>
              <span>Rolling: <span className="text-amber-400">{m1Label}</span> + <span className="text-blue-400">{m2Label}</span> + <span className="text-purple-400">{m3Label}</span></span>
              {uniqueChannels.length <= 6 && (
                <>
                  <span>&#8226;</span>
                  <span>Channels: <span className="text-white font-medium">{uniqueChannels.join(", ")}</span></span>
                </>
              )}
            </div>

            {/* Table */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden mb-6">
              <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-gray-900 z-10">
                    <tr className="border-b border-gray-800">
                      <th className="text-left py-3 px-3 text-gray-400 font-medium w-10">Row</th>
                      <th className="text-left py-3 px-3 text-gray-400 font-medium">SKU</th>
                      <th className="text-left py-3 px-3 text-gray-400 font-medium">Channel</th>
                      <th className="text-right py-3 px-3 text-amber-400 font-medium">{m1Label}</th>
                      <th className="text-right py-3 px-3 text-blue-400 font-medium">{m2Label}</th>
                      <th className="text-right py-3 px-3 text-purple-400 font-medium">{m3Label}</th>
                      <th className="text-left py-3 px-3 text-gray-400 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {uploadData.map((row, i) => (
                      <tr key={i} className={`border-b border-gray-800/50 ${!row.isValid ? "bg-red-900/10" : ""}`}>
                        <td className="py-2 px-3 text-gray-500 text-xs">{row.originalRow}</td>
                        <td className="py-2 px-3 font-mono text-xs">{row.new_master_sku}</td>
                        <td className="py-2 px-3 text-xs text-gray-300">{row.channel_name}</td>
                        <td className="py-2 px-3 text-right font-mono text-xs">{row.isValid ? (row.qty_m1 > 0 ? row.qty_m1.toLocaleString() : "-") : "-"}</td>
                        <td className="py-2 px-3 text-right font-mono text-xs">{row.isValid ? (row.qty_m2 > 0 ? row.qty_m2.toLocaleString() : "-") : "-"}</td>
                        <td className="py-2 px-3 text-right font-mono text-xs">{row.isValid ? (row.qty_m3 > 0 ? row.qty_m3.toLocaleString() : "-") : "-"}</td>
                        <td className="py-2 px-3">
                          {row.isValid ? (
                            <span className="text-green-400 text-xs">{"\u2713"}</span>
                          ) : (
                            <div>{row.errors.map((err, j) => (<span key={j} className="block text-red-400 text-xs">{"\u2717"} {err}</span>))}</div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {error && (
              <div className="mb-6 p-4 bg-red-900/50 border border-red-500 rounded-xl">
                <p className="text-red-300 text-sm">{error}</p>
              </div>
            )}

            {/* Actions */}
            <div className="flex justify-between items-center">
              <button onClick={() => { setShowPreview(false); setUploadData([]); setError(null); }}
                className="px-6 py-2.5 bg-gray-800 text-gray-300 rounded-lg hover:bg-gray-700 transition">
                {"\u2190"} Back
              </button>
              <div className="flex items-center gap-4">
                {errorCount > 0 && <p className="text-xs text-gray-500">{errorCount} error rows skipped.</p>}
                <button onClick={handleSave} disabled={saving || validCount === 0}
                  className="px-6 py-2.5 bg-amber-500 text-black font-semibold rounded-lg hover:bg-amber-400 disabled:opacity-50 disabled:cursor-not-allowed transition">
                  {saving ? "Saving..." : `Save ${validCount} Rows as Draft`}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}