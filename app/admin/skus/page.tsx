"use client";
import { useEffect, useState, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
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

type Channel = { id: string; name: string; cluster_id: string };
type Cluster = { id: string; name: string };
type FormData = Omit<SKU, "id" | "is_active" | "discontinued_at">;

const emptyForm: FormData = {
  new_master_sku: "",
  new_fg_code: "",
  master_sku: "",
  fg_code: "",
  product_name: "",
  category: "",
  product_category: "",
};

export default function SKUMasterPage() {
  const [skus, setSkus] = useState<SKU[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("active");
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState<FormData>(emptyForm);
  const [formChannelIds, setFormChannelIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [uploadPreview, setUploadPreview] = useState<FormData[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const supabase = createClient();

  useEffect(() => {
    loadAll();
  }, []);

  async function loadAll() {
    setLoading(true);
    const { data: skuData } = await supabase
      .from("sku_master")
      .select("*")
      .order("category")
      .order("product_name");
    if (skuData) setSkus(skuData);

    const { data: chData } = await supabase
      .from("channels")
      .select("*")
      .eq("is_active", true)
      .order("display_order");
    if (chData) setChannels(chData);

    const { data: clData } = await supabase
      .from("clusters")
      .select("*")
      .order("display_order");
    if (clData) setClusters(clData);

    setLoading(false);
  }

  async function logAudit(action: string, recordId: string, oldVals: any, newVals: any) {
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from("audit_log").insert({
      user_id: user?.id,
      user_email: user?.email,
      action,
      table_name: "sku_master",
      record_id: recordId,
      old_values: oldVals,
      new_values: newVals,
    });
  }

  const categories = [...new Set(skus.map((s) => s.category).filter(Boolean))];

  const filteredSKUs = skus.filter((sku) => {
    const matchesSearch =
      !searchTerm ||
      sku.product_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      sku.new_master_sku.toLowerCase().includes(searchTerm.toLowerCase()) ||
      sku.fg_code?.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = !categoryFilter || sku.category === categoryFilter;
    const matchesStatus =
      statusFilter === "all" ||
      (statusFilter === "active" && sku.is_active && !sku.discontinued_at) ||
      (statusFilter === "discontinued" && sku.discontinued_at);
    return matchesSearch && matchesCategory && matchesStatus;
  });

  // Load existing channel mappings for a SKU being edited
  async function loadSkuMappings(skuId: string) {
    const { data } = await supabase
      .from("channel_sku_mapping")
      .select("channel_id")
      .eq("sku_id", skuId)
      .eq("is_active", true);
    if (data) {
      setFormChannelIds(data.map((m: any) => m.channel_id));
    }
  }

  function handleEdit(sku: SKU) {
    setEditingId(sku.id);
    setFormData({
      new_master_sku: sku.new_master_sku,
      new_fg_code: sku.new_fg_code || "",
      master_sku: sku.master_sku || "",
      fg_code: sku.fg_code || "",
      product_name: sku.product_name,
      category: sku.category || "",
      product_category: sku.product_category || "",
    });
    loadSkuMappings(sku.id);
    setShowForm(true);
    setError(null);
  }

  function handleAddNew() {
    setEditingId(null);
    setFormData(emptyForm);
    // Default: all channels selected
    setFormChannelIds(channels.map((ch) => ch.id));
    setShowForm(true);
    setError(null);
  }

  // Toggle channel in form
  function toggleFormChannel(channelId: string) {
    setFormChannelIds((prev) =>
      prev.includes(channelId) ? prev.filter((id) => id !== channelId) : [...prev, channelId]
    );
  }

  // Toggle all channels in a cluster
  function toggleFormCluster(clusterId: string) {
    const clChannels = channels.filter((ch) => ch.cluster_id === clusterId).map((ch) => ch.id);
    const allSelected = clChannels.every((id) => formChannelIds.includes(id));
    if (allSelected) {
      setFormChannelIds((prev) => prev.filter((id) => !clChannels.includes(id)));
    } else {
      setFormChannelIds((prev) => [...new Set([...prev, ...clChannels])]);
    }
  }

  // Toggle all channels
  function toggleAllFormChannels() {
    if (formChannelIds.length === channels.length) {
      setFormChannelIds([]);
    } else {
      setFormChannelIds(channels.map((ch) => ch.id));
    }
  }

  // Save SKU + channel mappings
  async function handleSave() {
    setSaving(true);
    setError(null);

    if (!formData.new_master_sku || !formData.product_name) {
      setError("New Master SKU and Product Name are required.");
      setSaving(false);
      return;
    }

    const { data: { user } } = await supabase.auth.getUser();

    if (editingId) {
      // Update existing SKU
      const oldSku = skus.find((s) => s.id === editingId);
      const { error: updateError } = await supabase
        .from("sku_master")
        .update({ ...formData, updated_at: new Date().toISOString() })
        .eq("id", editingId);

      if (updateError) {
        setError(updateError.message);
        setSaving(false);
        return;
      }

      // Update channel mappings
      await updateChannelMappings(editingId, user?.id);
      await logAudit("update", editingId, oldSku, { ...formData, channels: formChannelIds.length });
      setSuccessMsg("SKU updated successfully!");
    } else {
      // Insert new SKU
      const { data: newSku, error: insertError } = await supabase
        .from("sku_master")
        .insert([formData])
        .select()
        .single();

      if (insertError) {
        setError(
          insertError.message.includes("duplicate")
            ? "A SKU with this Master SKU code already exists."
            : insertError.message
        );
        setSaving(false);
        return;
      }

      // Create channel mappings for the new SKU
      await updateChannelMappings(newSku.id, user?.id);
      await logAudit("create", newSku.id, null, { ...formData, channels: formChannelIds.length });
      setSuccessMsg("SKU added successfully!");
    }

    setShowForm(false);
    loadAll();
    setSaving(false);
    setTimeout(() => setSuccessMsg(null), 3000);
  }

  // Helper: Update channel mappings for a SKU
  async function updateChannelMappings(skuId: string, userId: string | undefined) {
    // Get current mappings
    const { data: currentMappings } = await supabase
      .from("channel_sku_mapping")
      .select("channel_id, is_active")
      .eq("sku_id", skuId);

    const currentActiveIds = (currentMappings || [])
      .filter((m: any) => m.is_active)
      .map((m: any) => m.channel_id);

    const currentAllIds = (currentMappings || []).map((m: any) => m.channel_id);

    // Channels to add (in formChannelIds but not currently active)
    const toAdd = formChannelIds.filter((id) => !currentActiveIds.includes(id));

    // Channels to deactivate (currently active but not in formChannelIds)
    const toDeactivate = currentActiveIds.filter((id: string) => !formChannelIds.includes(id));

    // Insert or reactivate
    for (const channelId of toAdd) {
      if (currentAllIds.includes(channelId)) {
        // Reactivate existing mapping
        await supabase
          .from("channel_sku_mapping")
          .update({ is_active: true })
          .eq("sku_id", skuId)
          .eq("channel_id", channelId);
      } else {
        // Insert new mapping
        await supabase
          .from("channel_sku_mapping")
          .insert({ sku_id: skuId, channel_id: channelId, is_active: true, created_by: userId });
      }
    }

    // Deactivate removed
    for (const channelId of toDeactivate) {
      await supabase
        .from("channel_sku_mapping")
        .update({ is_active: false })
        .eq("sku_id", skuId)
        .eq("channel_id", channelId);
    }
  }

  async function handleDiscontinue(sku: SKU) {
    const isDiscontinuing = !sku.discontinued_at;
    const confirmed = window.confirm(
      isDiscontinuing
        ? `Discontinue "${sku.product_name}"? It will remain in the system but won't appear in new forecasts.`
        : `Reactivate "${sku.product_name}"?`
    );
    if (!confirmed) return;

    const { data: { user } } = await supabase.auth.getUser();

    const updates = isDiscontinuing
      ? { is_active: false, discontinued_at: new Date().toISOString(), discontinued_by: user?.id, updated_at: new Date().toISOString() }
      : { is_active: true, discontinued_at: null, discontinued_by: null, updated_at: new Date().toISOString() };

    const { error } = await supabase.from("sku_master").update(updates).eq("id", sku.id);
    if (!error) {
      await logAudit(isDiscontinuing ? "discontinue" : "reactivate", sku.id,
        { is_active: sku.is_active, discontinued_at: sku.discontinued_at }, updates);
      setSuccessMsg(isDiscontinuing ? `"${sku.product_name}" discontinued.` : `"${sku.product_name}" reactivated.`);
      loadAll();
      setTimeout(() => setSuccessMsg(null), 3000);
    }
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const data = evt.target?.result;
      const workbook = XLSX.read(data, { type: "binary" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const json = XLSX.utils.sheet_to_json<any>(sheet);
      const mapped: FormData[] = json.map((row: any) => ({
        new_master_sku: String(row["New Master SKU"] || row["new_master_sku"] || "").trim(),
        new_fg_code: String(row["New FG Code"] || row["new_fg_code"] || "").trim(),
        master_sku: String(row["Master SKU"] || row["master_sku"] || "").trim(),
        fg_code: String(row["FG Code"] || row["fg_code"] || "").trim(),
        product_name: String(row["Product Name"] || row["product_name"] || "").trim(),
        category: String(row["Category"] || row["category"] || "").trim(),
        product_category: String(row["Product Category"] || row["product_category"] || "").trim(),
      }));
      const valid = mapped.filter((m) => m.new_master_sku && m.product_name);
      setUploadPreview(valid);
      setShowUpload(true);
    };
    reader.readAsBinaryString(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleBulkUpload() {
    setUploading(true);
    setError(null);

    // Upsert SKUs
    const { data: upserted, error: uploadError } = await supabase
      .from("sku_master")
      .upsert(uploadPreview, { onConflict: "new_master_sku" })
      .select();

    if (uploadError) {
      setError(uploadError.message);
      setUploading(false);
      return;
    }

    // For bulk uploaded SKUs, enable all channels by default
    if (upserted && upserted.length > 0) {
      const { data: { user } } = await supabase.auth.getUser();
      const mappings: any[] = [];
      for (const sku of upserted) {
        for (const ch of channels) {
          mappings.push({
            sku_id: sku.id,
            channel_id: ch.id,
            is_active: true,
            created_by: user?.id,
          });
        }
      }

      // Batch insert in chunks
      for (let i = 0; i < mappings.length; i += 500) {
        const chunk = mappings.slice(i, i + 500);
        await supabase.from("channel_sku_mapping").upsert(chunk, { onConflict: "channel_id,sku_id" });
      }
    }

    await logAudit("bulk_upload", "multiple", null, { count: uploadPreview.length, all_channels_enabled: true });
    setSuccessMsg(`${uploadPreview.length} SKUs uploaded! All channels enabled by default.`);
    setShowUpload(false);
    setUploadPreview([]);
    loadAll();
    setUploading(false);
    setTimeout(() => setSuccessMsg(null), 3000);
  }

  function downloadTemplate() {
    const templateData = [{
      "New Master SKU": "EXAMPLE_SKU1", "New FG Code": "12345G", "Master SKU": "EX_SKU1",
      "FG Code": "12345", "Product Name": "Example Product Name 50g", "Category": "Bars", "Product Category": "Breakfast Bar",
    }];
    const ws = XLSX.utils.json_to_sheet(templateData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "SKU Template");
    ws["!cols"] = [{ wch: 18 }, { wch: 14 }, { wch: 14 }, { wch: 10 }, { wch: 40 }, { wch: 12 }, { wch: 18 }];
    XLSX.writeFile(wb, "SKU_Upload_Template.xlsx");
  }

  if (loading) {
    return <div className="flex items-center justify-center h-64"><p className="text-gray-400">Loading SKUs...</p></div>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">SKU Master</h2>
          <p className="text-sm text-gray-400 mt-1">
            {skus.length} total · {skus.filter((s) => s.is_active && !s.discontinued_at).length} active · {skus.filter((s) => s.discontinued_at).length} discontinued
          </p>
        </div>
        <div className="flex gap-3">
          <button onClick={downloadTemplate} className="px-4 py-2 text-sm bg-gray-800 text-gray-300 rounded-lg hover:bg-gray-700 transition">Download Template</button>
          <label className="px-4 py-2 text-sm bg-gray-800 text-gray-300 rounded-lg hover:bg-gray-700 transition cursor-pointer">
            Bulk Upload
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFileUpload} />
          </label>
          <button onClick={handleAddNew} className="px-4 py-2 text-sm bg-amber-500 text-black font-semibold rounded-lg hover:bg-amber-400 transition">+ Add SKU</button>
        </div>
      </div>

      {successMsg && (
        <div className="mb-4 p-3 bg-green-900/50 border border-green-500 rounded-lg"><p className="text-green-300 text-sm">{successMsg}</p></div>
      )}
      {error && !showForm && (
        <div className="mb-4 p-3 bg-red-900/50 border border-red-500 rounded-lg"><p className="text-red-300 text-sm">{error}</p></div>
      )}

      {/* Bulk Upload Preview Modal */}
      {showUpload && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-4xl max-h-[80vh] overflow-hidden flex flex-col">
            <div className="p-6 border-b border-gray-800">
              <h3 className="text-lg font-semibold">Bulk Upload Preview — {uploadPreview.length} SKUs</h3>
              <p className="text-sm text-gray-400 mt-1">Existing SKUs will be updated. <span className="text-amber-400">All channels will be enabled by default</span> for new SKUs.</p>
            </div>
            <div className="overflow-auto flex-1 p-6">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800">
                    <th className="text-left py-2 px-3 text-gray-400 font-medium">New Master SKU</th>
                    <th className="text-left py-2 px-3 text-gray-400 font-medium">Product Name</th>
                    <th className="text-left py-2 px-3 text-gray-400 font-medium">Category</th>
                    <th className="text-left py-2 px-3 text-gray-400 font-medium">FG Code</th>
                  </tr>
                </thead>
                <tbody>
                  {uploadPreview.map((row, i) => (
                    <tr key={i} className="border-b border-gray-800/50">
                      <td className="py-2 px-3 font-mono text-xs">{row.new_master_sku}</td>
                      <td className="py-2 px-3">{row.product_name}</td>
                      <td className="py-2 px-3 text-gray-400">{row.category}</td>
                      <td className="py-2 px-3 font-mono text-xs text-gray-400">{row.fg_code}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="p-6 border-t border-gray-800 flex justify-end gap-3">
              <button onClick={() => { setShowUpload(false); setUploadPreview([]); }} className="px-4 py-2 text-sm bg-gray-800 text-gray-300 rounded-lg hover:bg-gray-700 transition">Cancel</button>
              <button onClick={handleBulkUpload} disabled={uploading} className="px-6 py-2 text-sm bg-amber-500 text-black font-semibold rounded-lg hover:bg-amber-400 disabled:opacity-50 transition">
                {uploading ? "Uploading..." : `Upload ${uploadPreview.length} SKUs`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add/Edit Form Modal — Now with Channel Selection */}
      {showForm && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-gray-800">
              <h3 className="text-lg font-semibold">{editingId ? "Edit SKU" : "Add New SKU"}</h3>
            </div>
            <div className="p-6 space-y-4">
              {/* SKU Details */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-gray-400 mb-1">New Master SKU *</label>
                  <input value={formData.new_master_sku} onChange={(e) => setFormData({ ...formData, new_master_sku: e.target.value })} placeholder="e.g. BB_AFG" className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">New FG Code</label>
                  <input value={formData.new_fg_code} onChange={(e) => setFormData({ ...formData, new_fg_code: e.target.value })} placeholder="e.g. 14244G" className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Master SKU</label>
                  <input value={formData.master_sku} onChange={(e) => setFormData({ ...formData, master_sku: e.target.value })} placeholder="e.g. BB_AF" className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">FG Code</label>
                  <input value={formData.fg_code} onChange={(e) => setFormData({ ...formData, fg_code: e.target.value })} placeholder="e.g. 14244" className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />
                </div>
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Product Name *</label>
                <input value={formData.product_name} onChange={(e) => setFormData({ ...formData, product_name: e.target.value })} placeholder="e.g. YB - 14244 - Breakfast Bar - Apricot Fig 45g (MRP 60)" className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Category</label>
                  <input value={formData.category} onChange={(e) => setFormData({ ...formData, category: e.target.value })} placeholder="e.g. Bars" className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Product Category</label>
                  <input value={formData.product_category} onChange={(e) => setFormData({ ...formData, product_category: e.target.value })} placeholder="e.g. Breakfast Bar" className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />
                </div>
              </div>

              {/* Channel Selection */}
              <div className="border-t border-gray-800 pt-4">
                <div className="flex items-center justify-between mb-3">
                  <label className="block text-sm font-medium text-gray-300">Active Channels</label>
                  <button
                    onClick={toggleAllFormChannels}
                    className="text-xs text-amber-400 hover:text-amber-300 transition"
                  >
                    {formChannelIds.length === channels.length ? "Deselect All" : "Select All"}
                  </button>
                </div>
                <p className="text-xs text-gray-500 mb-3">
                  Select which channels this SKU is available on. ({formChannelIds.length}/{channels.length} selected)
                </p>
                <div className="space-y-3 max-h-[250px] overflow-y-auto pr-2">
                  {clusters.map((cl) => {
                    const clChannels = channels.filter((ch) => ch.cluster_id === cl.id);
                    if (clChannels.length === 0) return null;
                    const allInCluster = clChannels.every((ch) => formChannelIds.includes(ch.id));
                    const someInCluster = clChannels.some((ch) => formChannelIds.includes(ch.id));
                    return (
                      <div key={cl.id}>
                        <button
                          type="button"
                          onClick={() => toggleFormCluster(cl.id)}
                          className="flex items-center gap-2 mb-1.5 group"
                        >
                          <div className={`w-3.5 h-3.5 rounded border flex items-center justify-center text-[9px] transition ${
                            allInCluster ? "bg-amber-500 border-amber-500 text-black" :
                            someInCluster ? "border-amber-500 bg-amber-500/30" :
                            "border-gray-600 group-hover:border-gray-400"
                          }`}>
                            {allInCluster && "✓"}
                            {someInCluster && !allInCluster && "—"}
                          </div>
                          <span className="text-xs text-gray-400 uppercase tracking-wider font-semibold">{cl.name}</span>
                        </button>
                        <div className="flex flex-wrap gap-1.5 ml-5">
                          {clChannels.map((ch) => (
                            <button
                              key={ch.id}
                              type="button"
                              onClick={() => toggleFormChannel(ch.id)}
                              className={`px-2.5 py-1 rounded text-xs transition ${
                                formChannelIds.includes(ch.id)
                                  ? "bg-amber-500/20 text-amber-300 ring-1 ring-amber-500/50"
                                  : "bg-gray-800 text-gray-500 hover:bg-gray-700"
                              }`}
                            >
                              {formChannelIds.includes(ch.id) ? "✓ " : ""}{ch.name}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {error && (
                <div className="p-3 bg-red-900/50 border border-red-500 rounded-lg">
                  <p className="text-red-300 text-sm">{error}</p>
                </div>
              )}
            </div>
            <div className="p-6 border-t border-gray-800 flex justify-end gap-3">
              <button onClick={() => { setShowForm(false); setError(null); }} className="px-4 py-2 text-sm bg-gray-800 text-gray-300 rounded-lg hover:bg-gray-700 transition">Cancel</button>
              <button onClick={handleSave} disabled={saving} className="px-6 py-2 text-sm bg-amber-500 text-black font-semibold rounded-lg hover:bg-amber-400 disabled:opacity-50 transition">
                {saving ? "Saving..." : editingId ? "Update SKU" : "Add SKU"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-4 mb-4">
        <input type="text" placeholder="Search by name, SKU code, or FG code..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="flex-1 px-4 py-2 bg-gray-900 border border-gray-800 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-amber-500" />
        <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} className="px-4 py-2 bg-gray-900 border border-gray-800 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-500">
          <option value="">All Categories</option>
          {categories.map((cat) => (<option key={cat} value={cat}>{cat}</option>))}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="px-4 py-2 bg-gray-900 border border-gray-800 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-500">
          <option value="active">Active Only</option>
          <option value="discontinued">Discontinued</option>
          <option value="all">All</option>
        </select>
      </div>

      {/* SKU Table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 bg-gray-900/80">
                <th className="text-left py-3 px-4 text-gray-400 font-medium">New Master SKU</th>
                <th className="text-left py-3 px-4 text-gray-400 font-medium">Product Name</th>
                <th className="text-left py-3 px-4 text-gray-400 font-medium">Category</th>
                <th className="text-left py-3 px-4 text-gray-400 font-medium">Product Category</th>
                <th className="text-left py-3 px-4 text-gray-400 font-medium">FG Code</th>
                <th className="text-left py-3 px-4 text-gray-400 font-medium">Status</th>
                <th className="text-left py-3 px-4 text-gray-400 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredSKUs.length === 0 ? (
                <tr><td colSpan={7} className="py-8 text-center text-gray-500">{searchTerm || categoryFilter ? "No SKUs match your filters." : "No SKUs added yet. Click '+ Add SKU' to get started."}</td></tr>
              ) : (
                filteredSKUs.map((sku) => (
                  <tr key={sku.id} className={`border-b border-gray-800/50 hover:bg-gray-800/30 transition ${sku.discontinued_at ? "opacity-60" : ""}`}>
                    <td className="py-3 px-4 font-mono text-xs">{sku.new_master_sku}</td>
                    <td className="py-3 px-4">{sku.product_name}</td>
                    <td className="py-3 px-4 text-gray-400">{sku.category}</td>
                    <td className="py-3 px-4 text-gray-400">{sku.product_category}</td>
                    <td className="py-3 px-4 font-mono text-xs text-gray-400">{sku.fg_code}</td>
                    <td className="py-3 px-4">
                      {sku.discontinued_at ? (
                        <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-orange-500/20 text-orange-400">Discontinued</span>
                      ) : (
                        <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-green-500/20 text-green-400">Active</span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex gap-3">
                        <button onClick={() => handleEdit(sku)} className="text-amber-400 hover:text-amber-300 text-xs font-medium transition">Edit</button>
                        <button onClick={() => handleDiscontinue(sku)} className={`text-xs font-medium transition ${sku.discontinued_at ? "text-green-400 hover:text-green-300" : "text-red-400 hover:text-red-300"}`}>
                          {sku.discontinued_at ? "Reactivate" : "Discontinue"}
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
    </div>
  );
}