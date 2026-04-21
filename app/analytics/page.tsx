"use client";
import { useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import AppShell from "@/app/components/AppShell";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  LineChart,
  Line,
  ReferenceLine,
  CartesianGrid,
} from "recharts";

// ── Types ─────────────────────────────────────────────────────────────────────
type SummaryRow = {
  name: string;
  m0_qty: number;
  m1_qty: number;
  m2_qty: number;
  delta_m1: number;
  delta_m1_pct: number | null;
  delta_m2: number;
  delta_m2_pct: number | null;
  fidelity_m1: number | null;
  fidelity_m2: number | null;
};

type SkuRow = {
  master_sku: string;
  product_name: string;
  category: string;
  m0_qty: number;
  m1_qty: number;
  m2_qty: number;
  delta_m1: number;
  delta_m1_pct: number | null;
  delta_m2: number;
  delta_m2_pct: number | null;
  fidelity_m1: number | null;
  fidelity_m2: number | null;
};

type ApiResponse = {
  target_month: string;
  available_months: string[];
  versions_by_month?: Record<string, number[]>;
  filters: { categories: string[]; product_categories: string[] };
  summary: {
    m0_total: number;
    m1_total: number;
    m2_total: number;
    m1_fidelity: number | null;
    m2_fidelity: number | null;
  };
  rows: SummaryRow[];
  has_m1: boolean;
  has_m2: boolean;
};

type VersionRow = {
  name: string;
  quantities: Record<number, number>;
  delta: number;
  delta_pct: number | null;
};

type VersionSkuRow = {
  master_sku: string;
  product_name: string;
  category: string;
  quantities: Record<number, number>;
  delta: number;
  delta_pct: number | null;
};

type VersionApiResponse = {
  source_month: string;
  versions: number[];
  available_months: string[];
  versions_by_month: Record<string, number[]>;
  filters: { categories: string[]; product_categories: string[] };
  summary: Record<number, number>;
  rows: VersionRow[];
};

type TrendPoint = {
  source_month: string;
  source_label: string;
  rolling_offset: number;
  offset_label: string;
  quantity: number;
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtQty(n: number) {
  if (n >= 10000000) return `${(n / 10000000).toFixed(2)}Cr`;
  if (n >= 100000) return `${(n / 100000).toFixed(1)}L`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toLocaleString();
}

function fmtMonth(ym: string) {
  const [y, m] = ym.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[parseInt(m) - 1]}'${y.slice(2)}`;
}

function deltaColor(pct: number | null) {
  if (pct === null) return "var(--atlas-ink-muted)";
  const abs = Math.abs(pct);
  if (abs <= 10) return "#16a34a";
  if (abs <= 25) return "#d97706";
  return "#dc2626";
}

function deltaBg(pct: number | null) {
  if (pct === null) return "transparent";
  const abs = Math.abs(pct);
  if (abs <= 10) return "rgba(22,163,74,0.08)";
  if (abs <= 25) return "rgba(217,119,6,0.08)";
  return "rgba(220,38,38,0.08)";
}

function fidelityColor(fidelity: number | null) {
  if (fidelity === null) return "var(--atlas-ink-muted)";
  if (fidelity >= 90) return "#16a34a";
  if (fidelity >= 75) return "#d97706";
  return "#dc2626";
}

const VERSION_COLORS = ["#3b82f6", "#8b5cf6", "#06b6d4", "#f59e0b", "#ef4444", "#10b981"];

// ── Component ─────────────────────────────────────────────────────────────────
export default function AnalyticsPage() {
  const router = useRouter();
  const supabase = createClient();

  const [loading, setLoading] = useState(true);
  const [availableMonths, setAvailableMonths] = useState<string[]>([]);
  const [versionsByMonth, setVersionsByMonth] = useState<Record<string, number[]>>({});
  const [targetMonth, setTargetMonth] = useState("");
  const [viewMode, setViewMode] = useState<"cluster" | "channel">("cluster");
  const [comparisonMode, setComparisonMode] = useState<"cross_month" | "version">("cross_month");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [activeTab, setActiveTab] = useState<"comparison" | "trend" | "usage">("comparison");

  // Cross-month state
  const [data, setData] = useState<ApiResponse | null>(null);
  const [drilldown, setDrilldown] = useState<string | null>(null);
  const [skuRows, setSkuRows] = useState<SkuRow[]>([]);
  const [skuLoading, setSkuLoading] = useState(false);

  // Version state
  const [versionData, setVersionData] = useState<VersionApiResponse | null>(null);
  const [versionDrilldown, setVersionDrilldown] = useState<string | null>(null);
  const [versionSkuRows, setVersionSkuRows] = useState<VersionSkuRow[]>([]);

  // Trend state
  const [trendData, setTrendData] = useState<TrendPoint[]>([]);
  const [trendLoading, setTrendLoading] = useState(false);
  const [trendSku, setTrendSku] = useState("");
  const [trendEntity, setTrendEntity] = useState("");

  // Usage stats (admin only)
  const [isAdmin, setIsAdmin] = useState(false);
  const [usageData, setUsageData] = useState<{ user_email: string; user_name: string; conversion_type: string; sku_count: number; created_at: string }[]>([]);
  const [usageLoading, setUsageLoading] = useState(false);

  // Auth check
  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) router.push("/");
      else {
        supabase.from("profiles").select("role").eq("id", user.id).single().then(({ data }) => {
          if (data?.role === "admin") setIsAdmin(true);
        });
      }
    });
  }, []);

  // Load available months on mount
  useEffect(() => {
    fetch("/api/historical-forecast")
      .then((r) => r.json())
      .then((d) => {
        setAvailableMonths(d.available_months || []);
        setVersionsByMonth(d.versions_by_month || {});
        if (d.available_months?.length) {
          setTargetMonth(d.available_months[d.available_months.length - 1]);
        }
        setLoading(false);
      });
  }, []);

  // Load usage data when Usage tab is selected
  useEffect(() => {
    if (activeTab !== "usage" || !isAdmin) return;
    setUsageLoading(true);
    supabase.from("combo_usage_log").select("*").order("created_at", { ascending: false }).limit(500)
      .then(({ data }) => { setUsageData(data || []); setUsageLoading(false); });
  }, [activeTab, isAdmin]);

  // Load data when month/view/filters/mode change
  useEffect(() => {
    if (!targetMonth) return;
    setLoading(true);
    setDrilldown(null);
    setVersionDrilldown(null);
    setSkuRows([]);
    setVersionSkuRows([]);

    const params = new URLSearchParams({
      target_month: targetMonth,
      view: viewMode,
      mode: comparisonMode,
    });
    if (categoryFilter) params.set("category", categoryFilter);
    if (searchTerm) params.set("search", searchTerm);

    fetch(`/api/historical-forecast?${params}`)
      .then((r) => r.json())
      .then((d) => {
        if (comparisonMode === "version") {
          setVersionData(d);
          setData(null);
        } else {
          setData(d);
          setVersionData(null);
        }
        if (d.versions_by_month) setVersionsByMonth(d.versions_by_month);
        if (d.available_months) setAvailableMonths(d.available_months);
        setLoading(false);
      });
  }, [targetMonth, viewMode, comparisonMode, categoryFilter, searchTerm]);

  // Load drilldown SKU data (cross-month)
  useEffect(() => {
    if (!drilldown || !targetMonth || comparisonMode !== "cross_month") return;
    setSkuLoading(true);
    const params = new URLSearchParams({ target_month: targetMonth, view: viewMode, drilldown });
    if (categoryFilter) params.set("category", categoryFilter);
    if (searchTerm) params.set("search", searchTerm);

    fetch(`/api/historical-forecast?${params}`)
      .then((r) => r.json())
      .then((d) => { setSkuRows(d.sku_rows || []); setSkuLoading(false); });
  }, [drilldown, targetMonth, viewMode, categoryFilter, searchTerm, comparisonMode]);

  // Load drilldown SKU data (version)
  useEffect(() => {
    if (!versionDrilldown || !targetMonth || comparisonMode !== "version") return;
    setSkuLoading(true);
    const params = new URLSearchParams({ target_month: targetMonth, view: viewMode, mode: "version", drilldown: versionDrilldown });
    if (categoryFilter) params.set("category", categoryFilter);
    if (searchTerm) params.set("search", searchTerm);

    fetch(`/api/historical-forecast?${params}`)
      .then((r) => r.json())
      .then((d) => { setVersionSkuRows(d.sku_rows || []); setSkuLoading(false); });
  }, [versionDrilldown, targetMonth, viewMode, categoryFilter, searchTerm, comparisonMode]);

  // Load trend data
  function loadTrend(sku?: string, entity?: string) {
    if (!targetMonth) return;
    setTrendLoading(true);
    const params = new URLSearchParams({ target_month: targetMonth });
    if (sku) params.set("master_sku", sku);
    if (entity) {
      if (viewMode === "channel") params.set("channel", entity);
      else params.set("cluster", entity);
    }
    fetch(`/api/historical-forecast/trend?${params}`)
      .then((r) => r.json())
      .then((d) => {
        setTrendData(d.trend || []);
        setTrendSku(sku || "");
        setTrendEntity(entity || "");
        setTrendLoading(false);
        setActiveTab("trend");
      });
  }

  // Cross-month chart data
  const chartData = useMemo(() => {
    if (!data) return [];
    return data.rows.slice(0, 15).map((r) => ({
      name: r.name.length > 18 ? r.name.substring(0, 16) + "…" : r.name,
      fullName: r.name,
      "M-2 Forecast": r.m2_qty,
      "M-1 Forecast": r.m1_qty,
      "Actual (M0)": r.m0_qty,
    }));
  }, [data]);

  // Version chart data
  const versionChartData = useMemo(() => {
    if (!versionData) return [];
    return versionData.rows.slice(0, 15).map((r) => {
      const entry: any = { name: r.name.length > 18 ? r.name.substring(0, 16) + "…" : r.name };
      for (const v of versionData.versions) {
        entry[`V${v}`] = r.quantities[v] || 0;
      }
      return entry;
    });
  }, [versionData]);

  const currentVersions = versionsByMonth[targetMonth] || [1];
  const hasMultipleVersions = currentVersions.length > 1;
  const filters = comparisonMode === "version" ? versionData?.filters : data?.filters;

  if (loading && !data && !versionData) {
    return (
      <AppShell>
        <div className="flex items-center justify-center min-h-[60vh]">
          <p className="text-atlas-ink-muted font-mono text-sm">Loading analytics…</p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="space-y-6">
        {/* ── Filter Bar ─────────────────────────────────────────────── */}
        <div
          className="flex flex-wrap items-center gap-3 p-4 rounded-xl"
          style={{ background: "var(--atlas-surface)", border: "1px solid var(--atlas-line)" }}
        >
          {/* Month selector */}
          <div className="flex items-center gap-2">
            <label className="font-mono uppercase text-atlas-ink-muted" style={{ fontSize: "10px", letterSpacing: "0.1em" }}>Month</label>
            <select
              value={targetMonth}
              onChange={(e) => setTargetMonth(e.target.value)}
              className="px-3 py-1.5 rounded-lg text-sm"
              style={{ background: "var(--atlas-surface-soft)", border: "1px solid var(--atlas-line)", color: "var(--atlas-ink)" }}
            >
              {availableMonths.map((m) => (
                <option key={m} value={m}>
                  {fmtMonth(m)} {(versionsByMonth[m]?.length || 0) > 1 ? `(${versionsByMonth[m].length}V)` : ""}
                </option>
              ))}
            </select>
          </div>

          {/* Comparison mode toggle */}
          <div
            className="flex font-mono uppercase"
            style={{ fontSize: "10px", letterSpacing: "0.06em", border: "1px solid var(--atlas-line)", borderRadius: "var(--radius-full, 999px)", overflow: "hidden" }}
          >
            {([
              { key: "cross_month" as const, label: "Cross-Month" },
              { key: "version" as const, label: "Versions" },
            ]).map((m) => (
              <button
                key={m.key}
                onClick={() => { setComparisonMode(m.key); setActiveTab("comparison"); }}
                style={{
                  padding: "6px 14px", cursor: "pointer", border: "none",
                  background: comparisonMode === m.key ? "var(--atlas-accent)" : "var(--atlas-surface)",
                  color: comparisonMode === m.key ? "#fff" : "var(--atlas-ink-muted)",
                  transition: "all 0.15s",
                }}
              >
                {m.label}
              </button>
            ))}
          </div>

          {/* View toggle */}
          <div
            className="flex font-mono uppercase"
            style={{ fontSize: "10px", letterSpacing: "0.06em", border: "1px solid var(--atlas-line)", borderRadius: "var(--radius-full, 999px)", overflow: "hidden" }}
          >
            {(["cluster", "channel"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setViewMode(v)}
                style={{
                  padding: "6px 14px", cursor: "pointer", border: "none",
                  background: viewMode === v ? "var(--atlas-accent)" : "var(--atlas-surface)",
                  color: viewMode === v ? "#fff" : "var(--atlas-ink-muted)",
                  transition: "all 0.15s",
                }}
              >
                {v}
              </button>
            ))}
          </div>

          {/* Category filter */}
          {filters?.categories && filters.categories.length > 0 && (
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="px-3 py-1.5 rounded-lg text-sm"
              style={{ background: "var(--atlas-surface-soft)", border: "1px solid var(--atlas-line)", color: "var(--atlas-ink)" }}
            >
              <option value="">All Categories</option>
              {filters.categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}

          {/* Search */}
          <input
            type="text" placeholder="Search SKU…" value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="px-3 py-1.5 rounded-lg text-sm flex-1 min-w-[140px]"
            style={{ background: "var(--atlas-surface-soft)", border: "1px solid var(--atlas-line)", color: "var(--atlas-ink)", maxWidth: 220 }}
          />
        </div>

        {/* Tabs */}
        <div className="flex gap-1" style={{ borderBottom: "1px solid var(--atlas-line)" }}>
          {(["comparison", "trend", ...(isAdmin ? ["usage"] : [])] as const).map((tab) => (
            <button key={tab} onClick={() => setActiveTab(tab as typeof activeTab)} className="font-mono uppercase px-4 py-2"
              style={{ fontSize: "10.5px", letterSpacing: "0.08em", border: "none", borderBottom: activeTab === tab ? "2px solid var(--atlas-accent)" : "2px solid transparent", background: "transparent", color: activeTab === tab ? "var(--atlas-accent)" : "var(--atlas-ink-muted)", cursor: "pointer" }}>
              {tab}
            </button>
          ))}
        </div>

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* CROSS-MONTH FIDELITY MODE                                    */}
        {/* ══════════════════════════════════════════════════════════════ */}
        {comparisonMode === "cross_month" && data && activeTab !== "usage" && (
          <>
            {/* Summary Cards */}
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
              {[
                { label: "M-2 Forecast", value: data.summary.m2_total, sub: data.has_m2 ? fmtMonth(targetMonth) + " predicted 2mo ago" : "No data", valueType: "qty" as const },
                { label: "M-1 Forecast", value: data.summary.m1_total, sub: data.has_m1 ? fmtMonth(targetMonth) + " predicted 1mo ago" : "No data", valueType: "qty" as const },
                { label: "Actual (M0)", value: data.summary.m0_total, sub: fmtMonth(targetMonth) + " final forecast", valueType: "qty" as const },
                { label: "M-1 Fidelity", value: data.summary.m1_fidelity, sub: data.summary.m1_fidelity !== null ? "How close M-1 was to M0" : "No M-1 data", valueType: "fidelity" as const, accent: true },
                { label: "M-2 Fidelity", value: data.summary.m2_fidelity, sub: data.summary.m2_fidelity !== null ? "How close M-2 was to M0" : "No M-2 data", valueType: "fidelity" as const, accent: true },
              ].map((card, i) => (
                <div key={i} className="p-4 rounded-xl" style={{ background: "var(--atlas-surface)", border: "1px solid var(--atlas-line)" }}>
                  <div className="font-mono uppercase mb-1" style={{ fontSize: "9.5px", letterSpacing: "0.1em", color: card.accent ? fidelityColor(card.value as number | null) : "var(--atlas-ink-muted)" }}>{card.label}</div>
                  <div className="font-display" style={{ fontSize: "24px", fontWeight: 400, color: card.valueType === "fidelity" ? fidelityColor(card.value as number | null) : "var(--atlas-ink)" }}>
                    {card.valueType === "qty" ? fmtQty(card.value as number) : card.value !== null ? `${card.value}%` : "—"}
                  </div>
                  <div style={{ fontSize: "11px", color: "var(--atlas-ink-muted)", marginTop: 2 }}>{card.sub}</div>
                </div>
              ))}
            </div>

            {/* Comparison Tab */}
            {activeTab === "comparison" && (
              <div className="space-y-6">
                {chartData.length > 0 && (
                  <div className="p-4 rounded-xl" style={{ background: "var(--atlas-surface)", border: "1px solid var(--atlas-line)" }}>
                    <div className="font-mono uppercase mb-3" style={{ fontSize: "10px", letterSpacing: "0.1em", color: "var(--atlas-ink-muted)" }}>
                      Rolling Forecast Comparison — {fmtMonth(targetMonth)}{drilldown && ` — ${drilldown}`}
                    </div>
                    <ResponsiveContainer width="100%" height={Math.max(300, chartData.length * 40)}>
                      <BarChart data={chartData} layout="vertical" margin={{ left: 10, right: 30, top: 5, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--atlas-line-soft)" />
                        <XAxis type="number" tick={{ fontSize: 11, fill: "var(--atlas-ink-muted)" }} tickFormatter={(v) => fmtQty(v)} />
                        <YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 11, fill: "var(--atlas-ink)" }} />
                        <Tooltip formatter={(value) => Number(value).toLocaleString()} contentStyle={{ background: "var(--atlas-surface)", border: "1px solid var(--atlas-line)", borderRadius: 8, fontSize: 12, color: "var(--atlas-ink)" }} />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                        <Bar dataKey="M-2 Forecast" fill="#6366f1" radius={[0, 2, 2, 0]} />
                        <Bar dataKey="M-1 Forecast" fill="#8b5cf6" radius={[0, 2, 2, 0]} />
                        <Bar dataKey="Actual (M0)" fill="#22c55e" radius={[0, 2, 2, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}

                {/* Fidelity Table */}
                <div className="rounded-xl overflow-hidden" style={{ background: "var(--atlas-surface)", border: "1px solid var(--atlas-line)" }}>
                  <div className="font-mono uppercase px-4 py-3" style={{ fontSize: "10px", letterSpacing: "0.1em", color: "var(--atlas-ink-muted)", borderBottom: "1px solid var(--atlas-line)" }}>
                    {drilldown ? `SKU Breakdown — ${drilldown}` : `Forecast Fidelity — ${viewMode === "cluster" ? "Clusters" : "Channels"}`}
                    {drilldown && (
                      <button onClick={() => setDrilldown(null)} style={{ marginLeft: 12, background: "none", border: "none", color: "var(--atlas-accent)", cursor: "pointer", fontSize: "10px", fontFamily: "var(--font-mono)" }}>← Back</button>
                    )}
                  </div>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                      <thead>
                        <tr style={{ borderBottom: "1px solid var(--atlas-line)" }}>
                          <th style={{ ...thStyle, textAlign: "left" }}>{drilldown ? "SKU" : viewMode === "cluster" ? "Cluster" : "Channel"}</th>
                          <th style={thStyle}>M-2</th>
                          <th style={thStyle}>M-1</th>
                          <th style={thStyle}>Actual (M0)</th>
                          <th style={thStyle}>M-1 Fidelity</th>
                          <th style={thStyle}>M-2 Fidelity</th>
                          <th style={thStyle}>Trend</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(drilldown ? skuRows : data.rows).map((row: any, i: number) => {
                          const name = drilldown ? row.master_sku : row.name;
                          const subtitle = drilldown ? row.product_name : null;
                          return (
                            <tr key={name + i} style={{ borderBottom: "1px solid var(--atlas-line-soft)", cursor: drilldown ? undefined : "pointer", background: deltaBg(row.delta_m2_pct) }}
                              onClick={() => { if (!drilldown) setDrilldown(name); }}>
                              <td style={{ padding: "10px 16px", color: "var(--atlas-ink)" }}>
                                <div>{name}</div>
                                {subtitle && <div style={{ fontSize: "11px", color: "var(--atlas-ink-muted)", marginTop: 1 }}>{subtitle.length > 40 ? subtitle.substring(0, 38) + "…" : subtitle}</div>}
                              </td>
                              <td style={tdStyle}>{fmtQty(row.m2_qty)}</td>
                              <td style={tdStyle}>{fmtQty(row.m1_qty)}</td>
                              <td style={{ ...tdStyle, fontWeight: 500 }}>{fmtQty(row.m0_qty)}</td>
                              <td style={{ ...tdStyle, color: fidelityColor(row.fidelity_m1), fontWeight: 600 }}>{row.fidelity_m1 !== null ? `${row.fidelity_m1}%` : "—"}</td>
                              <td style={{ ...tdStyle, color: fidelityColor(row.fidelity_m2), fontWeight: 600 }}>{row.fidelity_m2 !== null ? `${row.fidelity_m2}%` : "—"}</td>
                              <td style={tdStyle}>
                                <button onClick={(e) => { e.stopPropagation(); drilldown ? loadTrend(row.master_sku, drilldown) : loadTrend(undefined, name); }}
                                  style={{ background: "none", border: "1px solid var(--atlas-line)", borderRadius: 6, padding: "3px 8px", cursor: "pointer", fontSize: "10px", fontFamily: "var(--font-mono)", color: "var(--atlas-accent)" }}>View</button>
                              </td>
                            </tr>
                          );
                        })}
                        {(drilldown ? skuRows : data.rows).length === 0 && (
                          <tr><td colSpan={7} style={{ padding: 24, textAlign: "center", color: "var(--atlas-ink-muted)" }}>No data available</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {/* Trend Tab */}
            {activeTab === "trend" && <TrendSection trendData={trendData} trendLoading={trendLoading} trendSku={trendSku} trendEntity={trendEntity} targetMonth={targetMonth} />}
          </>
        )}

        {/* ══════════════════════════════════════════════════════════════ */}
        {/* VERSION COMPARISON MODE                                       */}
        {/* ══════════════════════════════════════════════════════════════ */}
        {comparisonMode === "version" && activeTab !== "usage" && (
          <>
            {!hasMultipleVersions && !loading && (
              <div className="p-6 rounded-xl text-center" style={{ background: "var(--atlas-surface)", border: "1px solid var(--atlas-line)" }}>
                <p className="text-atlas-ink-muted font-mono text-sm">Only 1 version available for {fmtMonth(targetMonth)}.</p>
                <p className="text-atlas-ink-faint text-xs mt-1">Push multiple published forecast cycles for this month to compare versions.</p>
              </div>
            )}

            {versionData && versionData.versions.length > 1 && (
              <>
                {/* Summary Cards — one per version + delta */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  {versionData.versions.map((v, i) => (
                    <div key={v} className="p-4 rounded-xl" style={{ background: "var(--atlas-surface)", border: "1px solid var(--atlas-line)" }}>
                      <div className="font-mono uppercase mb-1" style={{ fontSize: "9.5px", letterSpacing: "0.1em", color: VERSION_COLORS[i % VERSION_COLORS.length] }}>Version {v}</div>
                      <div className="font-display" style={{ fontSize: "24px", fontWeight: 400, color: "var(--atlas-ink)" }}>{fmtQty(versionData.summary[v] || 0)}</div>
                      <div style={{ fontSize: "11px", color: "var(--atlas-ink-muted)", marginTop: 2 }}>{fmtMonth(targetMonth)} — V{v} total</div>
                    </div>
                  ))}
                  {versionData.versions.length >= 2 && (() => {
                    const vers = versionData.versions;
                    const latest = versionData.summary[vers[vers.length - 1]] || 0;
                    const prev = versionData.summary[vers[vers.length - 2]] || 0;
                    const delta = latest - prev;
                    const pct = prev > 0 ? Math.round(((latest - prev) / prev) * 1000) / 10 : null;
                    return (
                      <div className="p-4 rounded-xl" style={{ background: "var(--atlas-surface)", border: "1px solid var(--atlas-line)" }}>
                        <div className="font-mono uppercase mb-1" style={{ fontSize: "9.5px", letterSpacing: "0.1em", color: deltaColor(pct) }}>V{vers[vers.length - 1]} vs V{vers[vers.length - 2]}</div>
                        <div className="font-display" style={{ fontSize: "24px", fontWeight: 400, color: deltaColor(pct) }}>
                          {pct !== null ? `${pct > 0 ? "+" : ""}${pct}%` : "—"}
                        </div>
                        <div style={{ fontSize: "11px", color: "var(--atlas-ink-muted)", marginTop: 2 }}>
                          {delta > 0 ? "+" : ""}{fmtQty(delta)} units
                        </div>
                      </div>
                    );
                  })()}
                </div>

                {/* Version Bar Chart */}
                {versionChartData.length > 0 && (
                  <div className="p-4 rounded-xl" style={{ background: "var(--atlas-surface)", border: "1px solid var(--atlas-line)" }}>
                    <div className="font-mono uppercase mb-3" style={{ fontSize: "10px", letterSpacing: "0.1em", color: "var(--atlas-ink-muted)" }}>
                      Version Comparison — {fmtMonth(targetMonth)}{versionDrilldown && ` — ${versionDrilldown}`}
                    </div>
                    <ResponsiveContainer width="100%" height={Math.max(300, versionChartData.length * 40)}>
                      <BarChart data={versionChartData} layout="vertical" margin={{ left: 10, right: 30, top: 5, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--atlas-line-soft)" />
                        <XAxis type="number" tick={{ fontSize: 11, fill: "var(--atlas-ink-muted)" }} tickFormatter={(v) => fmtQty(v)} />
                        <YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 11, fill: "var(--atlas-ink)" }} />
                        <Tooltip formatter={(value) => Number(value).toLocaleString()} contentStyle={{ background: "var(--atlas-surface)", border: "1px solid var(--atlas-line)", borderRadius: 8, fontSize: 12, color: "var(--atlas-ink)" }} />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                        {versionData.versions.map((v, i) => (
                          <Bar key={v} dataKey={`V${v}`} fill={VERSION_COLORS[i % VERSION_COLORS.length]} radius={[0, 2, 2, 0]} />
                        ))}
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}

                {/* Version Table */}
                <div className="rounded-xl overflow-hidden" style={{ background: "var(--atlas-surface)", border: "1px solid var(--atlas-line)" }}>
                  <div className="font-mono uppercase px-4 py-3" style={{ fontSize: "10px", letterSpacing: "0.1em", color: "var(--atlas-ink-muted)", borderBottom: "1px solid var(--atlas-line)" }}>
                    {versionDrilldown ? `SKU Breakdown — ${versionDrilldown}` : `Version Comparison — ${viewMode === "cluster" ? "Clusters" : "Channels"}`}
                    {versionDrilldown && (
                      <button onClick={() => setVersionDrilldown(null)} style={{ marginLeft: 12, background: "none", border: "none", color: "var(--atlas-accent)", cursor: "pointer", fontSize: "10px", fontFamily: "var(--font-mono)" }}>← Back</button>
                    )}
                  </div>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                      <thead>
                        <tr style={{ borderBottom: "1px solid var(--atlas-line)" }}>
                          <th style={{ ...thStyle, textAlign: "left" }}>{versionDrilldown ? "SKU" : viewMode === "cluster" ? "Cluster" : "Channel"}</th>
                          {versionData.versions.map((v) => <th key={v} style={thStyle}>V{v}</th>)}
                          <th style={thStyle}>Delta</th>
                          <th style={thStyle}>Change %</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(versionDrilldown ? versionSkuRows : versionData.rows).map((row: any, i: number) => {
                          const name = versionDrilldown ? row.master_sku : row.name;
                          const subtitle = versionDrilldown ? row.product_name : null;
                          return (
                            <tr key={name + i} style={{ borderBottom: "1px solid var(--atlas-line-soft)", cursor: versionDrilldown ? undefined : "pointer", background: deltaBg(row.delta_pct) }}
                              onClick={() => { if (!versionDrilldown) setVersionDrilldown(name); }}>
                              <td style={{ padding: "10px 16px", color: "var(--atlas-ink)" }}>
                                <div>{name}</div>
                                {subtitle && <div style={{ fontSize: "11px", color: "var(--atlas-ink-muted)", marginTop: 1 }}>{subtitle.length > 40 ? subtitle.substring(0, 38) + "…" : subtitle}</div>}
                              </td>
                              {versionData.versions.map((v, vi) => (
                                <td key={v} style={{ ...tdStyle, fontWeight: vi === versionData.versions.length - 1 ? 500 : 400 }}>{fmtQty(row.quantities[v] || 0)}</td>
                              ))}
                              <td style={{ ...tdStyle, color: deltaColor(row.delta_pct), fontWeight: 500 }}>
                                {row.delta > 0 ? "+" : ""}{fmtQty(row.delta)}
                              </td>
                              <td style={{ ...tdStyle, color: deltaColor(row.delta_pct), fontWeight: 600 }}>
                                {row.delta_pct !== null ? `${row.delta_pct > 0 ? "+" : ""}${row.delta_pct}%` : "—"}
                              </td>
                            </tr>
                          );
                        })}
                        {(versionDrilldown ? versionSkuRows : versionData.rows).length === 0 && (
                          <tr><td colSpan={versionData.versions.length + 3} style={{ padding: 24, textAlign: "center", color: "var(--atlas-ink-muted)" }}>No data available</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </>
        )}

        {/* Usage Tab — Admin Only */}
        {activeTab === "usage" && isAdmin && (
          <UsageStatsPanel data={usageData} loading={usageLoading} />
        )}
      </div>
    </AppShell>
  );
}

// ── Trend Section (extracted for reuse) ───────────────────────────────────────
function TrendSection({ trendData, trendLoading, trendSku, trendEntity, targetMonth }: {
  trendData: TrendPoint[]; trendLoading: boolean; trendSku: string; trendEntity: string; targetMonth: string;
}) {
  return (
    <div className="space-y-4">
      <div className="p-4 rounded-xl" style={{ background: "var(--atlas-surface)", border: "1px solid var(--atlas-line)" }}>
        <div className="font-mono uppercase mb-1" style={{ fontSize: "10px", letterSpacing: "0.1em", color: "var(--atlas-ink-muted)" }}>
          Forecast Evolution for {fmtMonth(targetMonth)}{trendSku && ` — ${trendSku}`}{trendEntity && ` — ${trendEntity}`}
        </div>
        <div style={{ fontSize: "12px", color: "var(--atlas-ink-soft)", marginBottom: 16 }}>
          How the prediction for {fmtMonth(targetMonth)} changed across source files
        </div>

        {trendLoading ? (
          <p className="text-atlas-ink-muted font-mono text-sm py-8 text-center">Loading…</p>
        ) : trendData.length > 0 ? (
          <>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={trendData} margin={{ left: 10, right: 30, top: 5, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--atlas-line-soft)" />
                <XAxis dataKey="source_label" tick={{ fontSize: 11, fill: "var(--atlas-ink-muted)" }} />
                <YAxis tick={{ fontSize: 11, fill: "var(--atlas-ink-muted)" }} tickFormatter={(v) => fmtQty(v)} />
                <Tooltip formatter={(value) => Number(value).toLocaleString()} labelFormatter={(label) => `Source: ${label}`}
                  contentStyle={{ background: "var(--atlas-surface)", border: "1px solid var(--atlas-line)", borderRadius: 8, fontSize: 12, color: "var(--atlas-ink)" }} />
                {trendData.some((t) => t.rolling_offset === 0) && (
                  <ReferenceLine y={trendData.find((t) => t.rolling_offset === 0)?.quantity} stroke="#22c55e" strokeDasharray="5 5" label={{ value: "Actual", fill: "#22c55e", fontSize: 11 }} />
                )}
                <Line type="monotone" dataKey="quantity" stroke="var(--atlas-accent)" strokeWidth={2} dot={{ fill: "var(--atlas-accent)", r: 4 }} activeDot={{ r: 6 }} />
              </LineChart>
            </ResponsiveContainer>

            <div style={{ overflowX: "auto", marginTop: 16 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--atlas-line)" }}>
                    <th style={thStyle}>Source File</th>
                    <th style={thStyle}>Offset</th>
                    <th style={thStyle}>Quantity</th>
                  </tr>
                </thead>
                <tbody>
                  {trendData.map((t, i) => (
                    <tr key={i} style={{ borderBottom: "1px solid var(--atlas-line-soft)" }}>
                      <td style={tdStyle}>{t.source_label}</td>
                      <td style={tdStyle}>
                        <span style={{ padding: "2px 6px", borderRadius: 4, fontSize: "10px", fontFamily: "var(--font-mono)",
                          background: t.rolling_offset === 0 ? "rgba(22,163,74,0.1)" : "rgba(99,102,241,0.1)",
                          color: t.rolling_offset === 0 ? "#16a34a" : "#6366f1" }}>
                          {t.offset_label}
                        </span>
                      </td>
                      <td style={{ ...tdStyle, fontWeight: t.rolling_offset === 0 ? 600 : 400 }}>{t.quantity.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p className="text-atlas-ink-muted font-mono text-sm py-8 text-center">
            Click &quot;View&quot; on any row in the Comparison tab to see its forecast trend
          </p>
        )}
      </div>
    </div>
  );
}

// ── Shared table styles ───────────────────────────────────────────────────────
const thStyle: React.CSSProperties = {
  textAlign: "right",
  padding: "10px 16px",
  color: "var(--atlas-ink-muted)",
  fontWeight: 500,
  fontSize: "11px",
  fontFamily: "var(--font-mono)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
};

const tdStyle: React.CSSProperties = {
  textAlign: "right",
  padding: "10px 16px",
  color: "var(--atlas-ink)",
  fontFamily: "var(--font-mono)",
  fontSize: "12px",
};

// ── Usage Stats Panel (Admin Only) ────────────────────────────────────────────
function UsageStatsPanel({ data, loading }: { data: { user_email: string; user_name: string; conversion_type: string; sku_count: number; created_at: string }[]; loading: boolean }) {
  const dailyStats = useMemo(() => {
    const map = new Map<string, number>();
    data.forEach((r) => {
      const day = r.created_at.slice(0, 10);
      map.set(day, (map.get(day) || 0) + 1);
    });
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 30);
  }, [data]);

  const userStats = useMemo(() => {
    const map = new Map<string, { name: string; count: number; lastUsed: string }>();
    data.forEach((r) => {
      const key = r.user_email;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, { name: r.user_name || r.user_email, count: 1, lastUsed: r.created_at });
      } else {
        existing.count++;
        if (r.created_at > existing.lastUsed) existing.lastUsed = r.created_at;
      }
    });
    return [...map.values()].sort((a, b) => b.count - a.count);
  }, [data]);

  const userDayStats = useMemo(() => {
    const map = new Map<string, number>();
    data.forEach((r) => {
      const key = `${r.user_name || r.user_email}||${r.created_at.slice(0, 10)}`;
      map.set(key, (map.get(key) || 0) + 1);
    });
    return [...map.entries()]
      .map(([k, count]) => { const [name, day] = k.split("||"); return { name, day, count }; })
      .sort((a, b) => b.day.localeCompare(a.day) || b.count - a.count)
      .slice(0, 50);
  }, [data]);

  if (loading) return <div className="py-12 text-center font-mono text-sm" style={{ color: "var(--atlas-ink-muted)" }}>Loading usage data...</div>;
  if (data.length === 0) return <div className="py-12 text-center font-mono text-sm" style={{ color: "var(--atlas-ink-muted)" }}>No usage data yet. Logs appear after users run conversions.</div>;

  return (
    <div className="space-y-6">
      {/* Daily summary */}
      <div className="p-4 rounded-xl" style={{ background: "var(--atlas-surface)", border: "1px solid var(--atlas-line)" }}>
        <div className="font-mono uppercase mb-3" style={{ fontSize: "10px", letterSpacing: "0.1em", color: "var(--atlas-ink-muted)" }}>
          Daily Conversions (Last 30 Days)
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
          {dailyStats.map(([day, count]) => (
            <div key={day} className="flex items-center justify-between px-3 py-2 rounded-lg" style={{ background: "var(--atlas-surface-soft)" }}>
              <span className="font-mono" style={{ fontSize: "11px", color: "var(--atlas-ink-soft)" }}>{day.slice(5)}</span>
              <span className="font-mono font-semibold" style={{ fontSize: "13px", color: "var(--atlas-accent)" }}>{count}</span>
            </div>
          ))}
        </div>
      </div>

      {/* User summary */}
      <div className="p-4 rounded-xl" style={{ background: "var(--atlas-surface)", border: "1px solid var(--atlas-line)" }}>
        <div className="font-mono uppercase mb-3" style={{ fontSize: "10px", letterSpacing: "0.1em", color: "var(--atlas-ink-muted)" }}>
          By User (All Time)
        </div>
        <div className="overflow-x-auto">
          <table className="w-full" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--atlas-line)" }}>
                <th style={{ ...thStyle, textAlign: "left" }}>User</th>
                <th style={thStyle}>Conversions</th>
                <th style={thStyle}>Last Used</th>
              </tr>
            </thead>
            <tbody>
              {userStats.map((u) => (
                <tr key={u.name} style={{ borderBottom: "1px solid var(--atlas-line-soft, var(--atlas-line))" }}>
                  <td style={{ ...tdStyle, textAlign: "left" }}>{u.name}</td>
                  <td style={{ ...tdStyle, color: "var(--atlas-accent)", fontWeight: 600 }}>{u.count}</td>
                  <td style={tdStyle}>{new Date(u.lastUsed).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* User x Day */}
      <div className="p-4 rounded-xl" style={{ background: "var(--atlas-surface)", border: "1px solid var(--atlas-line)" }}>
        <div className="font-mono uppercase mb-3" style={{ fontSize: "10px", letterSpacing: "0.1em", color: "var(--atlas-ink-muted)" }}>
          User x Day (Recent 50)
        </div>
        <div className="overflow-x-auto">
          <table className="w-full" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--atlas-line)" }}>
                <th style={{ ...thStyle, textAlign: "left" }}>Date</th>
                <th style={{ ...thStyle, textAlign: "left" }}>User</th>
                <th style={thStyle}>Conversions</th>
              </tr>
            </thead>
            <tbody>
              {userDayStats.map((r, i) => (
                <tr key={i} style={{ borderBottom: "1px solid var(--atlas-line-soft, var(--atlas-line))" }}>
                  <td style={{ ...tdStyle, textAlign: "left" }}>{r.day}</td>
                  <td style={{ ...tdStyle, textAlign: "left" }}>{r.name}</td>
                  <td style={{ ...tdStyle, color: "var(--atlas-accent)", fontWeight: 600 }}>{r.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
