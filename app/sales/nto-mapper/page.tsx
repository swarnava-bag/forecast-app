"use client";
// NTO/Unit mapper — from the Singles lens, derive net-realisation per unit at
// Master SKU × Channel granularity, month by month (+ a weighted-average over a
// chosen range). Pick a basis (a single month, or the weighted average) and apply
// it to a Qty × Channel forecast upload to get forecast NTO / GTO. All client-side.
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import * as XLSX from "xlsx";
import AppShell from "@/app/components/AppShell";
import { createClient } from "@/lib/supabase/client";
import { monthLabel } from "../lib";

// Net-realisation is commercially sensitive → Sales & Admin only.
export const ALLOWED_ROLES = new Set(["admin", "head_kam", "channel_kam"]);

type Row = { month: string; channel: string; category: string; kind: string; masterSku: string; qty: number; nto: number; gto: number };
type Data = { rows: Row[]; months: string[]; channels: string[]; rowCount: number };
type PerUnit = "nto" | "gto";

const surface: React.CSSProperties = { background: "var(--atlas-surface)", border: "1px solid var(--atlas-line)" };
const CR = 1e7;                                   // ₹ Crore → ₹
const shortMonth = (m: string) => monthLabel(m + "-01");
const rupee = (v: number | null) => (v == null ? "—" : `₹${v.toFixed(2)}`);
const cr = (v: number) => `₹${v.toFixed(2)} Cr`;
const qtyFmt = (n: number) => Math.round(n).toLocaleString("en-IN");
const norm = (s: unknown) => String(s ?? "").trim();
const stripG = (s: string) => (s && s.endsWith("G") ? s.slice(0, -1) : s);

// per-unit ₹ = Σnto(Cr) × 1e7 / Σqty
const perUnit = (sumCr: number, qty: number) => (qty > 0 ? (sumCr * CR) / qty : null);

export default function NtoMapperPage() {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [metric, setMetric] = useState<PerUnit>("nto");
  const [fromM, setFromM] = useState("");
  const [toM, setToM] = useState("");
  const [basis, setBasis] = useState<string>("WTD");       // "YYYY-MM" or "WTD"
  const [skuQuery, setSkuQuery] = useState("");
  const [fRows, setFRows] = useState<{ sku: string; channel: string; qty: number }[] | null>(null);
  const [fName, setFName] = useState("");
  const [applied, setApplied] = useState<AppliedResult | null>(null);
  const [role, setRole] = useState<string | null | undefined>(undefined); // undefined = loading
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    (async () => {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setRole(null); return; }
      const { data: p } = await supabase.from("profiles").select("role").eq("id", user.id).single();
      const r = p?.role ?? null; setRole(r);
      if (!r || !ALLOWED_ROLES.has(r)) return;                 // don't fetch sensitive data if not allowed
      const res = await fetch("/api/sales/data", { cache: "no-store" });
      const d = await res.json();
      if (d.error) setErr(d.error);
      else { setData(d); if (d.months?.length) { const ms: string[] = d.months; setFromM(ms[Math.max(0, ms.length - 3)]); setToM(ms[ms.length - 1]); setBasis("WTD"); } }
    })().catch((e) => setErr(String(e)));
  }, []);

  const singles = useMemo(() => (data?.rows ?? []).filter((r) => r.kind === "single"), [data]);
  const months = useMemo(() => data?.months ?? [], [data]);
  const channels = useMemo(() => {
    const t = new Map<string, number>();
    for (const r of singles) t.set(r.channel, (t.get(r.channel) ?? 0) + r.qty);
    return [...t.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  }, [singles]);
  const rangeMonths = useMemo(() => months.filter((mo) => (!fromM || mo >= fromM) && (!toM || mo <= toM)), [months, fromM, toM]);

  // Σ{nto,gto,qty} keyed by sku|channel|month  and  sku|month (all-channel fallback)
  const agg = useMemo(() => {
    const kc = new Map<string, { nto: number; gto: number; qty: number }>();
    const ks = new Map<string, { nto: number; gto: number; qty: number }>();
    const bump = (map: Map<string, { nto: number; gto: number; qty: number }>, key: string, r: Row) => { const a = map.get(key) ?? { nto: 0, gto: 0, qty: 0 }; a.nto += r.nto; a.gto += r.gto; a.qty += r.qty; map.set(key, a); };
    for (const r of singles) { bump(kc, `${r.masterSku}|${r.channel}|${r.month}`, r); bump(ks, `${r.masterSku}|${r.month}`, r); }
    return { kc, ks };
  }, [singles]);

  const basisMonths = useMemo(() => (basis === "WTD" ? rangeMonths : [basis]), [basis, rangeMonths]);
  const basisLabel = basis === "WTD" ? `Wtd avg ${shortMonth(rangeMonths[0] ?? "")}–${shortMonth(rangeMonths[rangeMonths.length - 1] ?? "")}` : `${shortMonth(basis)}`;

  // rate lookup under the chosen basis: channel-specific → sku all-channel fallback
  const rates = useMemo(() => {
    const key = new Map<string, { nto: number; gto: number; qty: number }>(), sk = new Map<string, { nto: number; gto: number; qty: number }>();
    const add = (map: Map<string, { nto: number; gto: number; qty: number }>, k: string, v: { nto: number; gto: number; qty: number }) => { const a = map.get(k) ?? { nto: 0, gto: 0, qty: 0 }; a.nto += v.nto; a.gto += v.gto; a.qty += v.qty; map.set(k, a); };
    for (const mo of basisMonths) {
      for (const [k, v] of agg.kc) if (k.endsWith(`|${mo}`)) add(key, k.slice(0, k.length - mo.length - 1), v);
      for (const [k, v] of agg.ks) if (k.endsWith(`|${mo}`)) add(sk, k.slice(0, k.length - mo.length - 1), v);
    }
    const rate = (sku: string, ch: string) => {
      const c = key.get(`${sku}|${ch}`); if (c && c.qty > 0) return { nto: perUnit(c.nto, c.qty)!, gto: perUnit(c.gto, c.qty)!, src: "channel" as const };
      const s = sk.get(sku); if (s && s.qty > 0) return { nto: perUnit(s.nto, s.qty)!, gto: perUnit(s.gto, s.qty)!, src: "sku-avg" as const };
      return null;
    };
    return { rate, key, sk };
  }, [agg, basisMonths]);

  // SKU list + MoM detail for the searched SKU
  const skuList = useMemo(() => {
    const t = new Map<string, number>();
    for (const r of singles) t.set(r.masterSku, (t.get(r.masterSku) ?? 0) + r.qty);
    return [...t.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
  }, [singles]);
  const sku = skuQuery && skuList.includes(skuQuery) ? skuQuery : (skuList[0] ?? "");
  const skuMoM = useMemo(() => {
    const chans = sku ? channels.filter((c) => months.some((mo) => (agg.kc.get(`${sku}|${c}|${mo}`)?.qty ?? 0) > 0)) : [];
    const cell = (c: string, mo: string) => { const a = agg.kc.get(`${sku}|${c}|${mo}`); return a ? perUnit(a[metric], a.qty) : null; };
    const wtd = (c: string) => { let n = 0, q = 0; for (const mo of rangeMonths) { const a = agg.kc.get(`${sku}|${c}|${mo}`); if (a) { n += a[metric]; q += a.qty; } } return perUnit(n, q); };
    return { chans, cell, wtd };
  }, [sku, channels, months, agg, metric, rangeMonths]);

  // ── apply to a forecast upload ──────────────────────────────────────────────
  const parseForecast = (wb: XLSX.WorkBook) => {
    const out: { sku: string; channel: string; qty: number }[] = [];
    for (const name of wb.SheetNames) {
      const g = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null }) as unknown[][];
      let hr = -1; const H: Record<string, number> = {};
      for (let i = 0; i < Math.min(g.length, 12); i++) { const mm: Record<string, number> = {}; (g[i] || []).forEach((h, j) => { const k = norm(h); if (k) mm[k.toLowerCase()] = j; }); if (("master sku" in mm || "sku" in mm) && ("qty" in mm || "quantity" in mm || "channel" in mm || "channel 2" in mm || channels.some((c) => c.toLowerCase() in mm))) { hr = i; Object.assign(H, mm); break; } }
      if (hr < 0) continue;
      const cSku = H["master sku"] ?? H["sku"], cCh = H["channel 2"] ?? H["channel"], cQ = H["qty"] ?? H["quantity"];
      const wideCols = channels.filter((c) => c.toLowerCase() in H).map((c) => ({ c, j: H[c.toLowerCase()] }));
      for (let i = hr + 1; i < g.length; i++) {
        const r = g[i]; if (!r) continue; const s = norm(r[cSku]); if (!s) continue;
        if (cCh != null && cQ != null) { const q = Number(r[cQ]); if (Number.isFinite(q) && q !== 0) out.push({ sku: s, channel: norm(r[cCh]), qty: q }); }
        else if (wideCols.length) for (const { c, j } of wideCols) { const q = Number(r[j]); if (Number.isFinite(q) && q !== 0) out.push({ sku: s, channel: c, qty: q }); }
      }
      if (out.length) break;
    }
    // reconcile SKU codes to the mapper's master-sku form (try raw, then ±G)
    const known = new Set(skuList);
    return out.map((o) => { let s = o.sku; if (!known.has(s)) { if (known.has(stripG(s))) s = stripG(s); else if (known.has(s + "G")) s = s + "G"; } return { ...o, sku: s }; });
  };

  const pickFile = async (f: File) => {
    setErr(null); setApplied(null); setFName(f.name);
    try { const wb = XLSX.read(await f.arrayBuffer()); const rows = parseForecast(wb); if (!rows.length) throw new Error("No forecast rows found. Expect a sheet with 'Master SKU', 'Channel' and 'Qty' columns (or Master SKU rows with channel-named quantity columns)."); setFRows(rows); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); setFRows(null); }
  };

  const apply = () => {
    if (!fRows) return;
    let nto = 0, gto = 0, qty = 0, mapped = 0, skuAvg = 0;
    const unmapped = new Map<string, number>(); const byCh = new Map<string, { nto: number; qty: number }>();
    const detail = fRows.map((r) => {
      const rt = rates.rate(r.sku, r.channel); qty += r.qty;
      const bc = byCh.get(r.channel) ?? { nto: 0, qty: 0 };
      if (!rt) { unmapped.set(`${r.sku} · ${r.channel}`, (unmapped.get(`${r.sku} · ${r.channel}`) ?? 0) + r.qty); byCh.set(r.channel, bc); return { ...r, ntoRate: null, gtoRate: null, fNto: 0, fGto: 0, src: "unmapped" }; }
      const fNto = (r.qty * rt.nto) / CR, fGto = (r.qty * rt.gto) / CR; nto += fNto; gto += fGto; mapped++; if (rt.src === "sku-avg") skuAvg++;
      bc.nto += fNto; bc.qty += r.qty; byCh.set(r.channel, bc);
      return { ...r, ntoRate: rt.nto, gtoRate: rt.gto, fNto, fGto, src: rt.src };
    });
    setApplied({ detail, nto, gto, qty, mapped, skuAvg, unmapped: [...unmapped.entries()].sort((a, b) => b[1] - a[1]), byCh: [...byCh.entries()].map(([channel, v]) => ({ channel, nto: v.nto, qty: v.qty })).sort((a, b) => b.nto - a.nto), rows: fRows.length });
  };

  const downloadApplied = () => {
    if (!applied) return;
    const header = ["Master SKU", "Channel", "Qty", "NTO/unit (₹)", "GTO/unit (₹)", "Forecast NTO (Cr)", "Forecast GTO (Cr)", "Rate source", "Basis"];
    const aoa = [header, ...applied.detail.map((d) => [d.sku, d.channel, d.qty, d.ntoRate == null ? "" : +d.ntoRate.toFixed(4), d.gtoRate == null ? "" : +d.gtoRate.toFixed(4), +d.fNto.toFixed(6), +d.fGto.toFixed(6), d.src, basisLabel])];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Forecast NTO");
    XLSX.writeFile(wb, `forecast_nto_${basis === "WTD" ? "wtdavg" : basis}.xlsx`);
  };

  const downloadMap = () => {
    const body: (string | number)[][] = [];
    for (const [k, v] of rates.key) if (v.qty > 0) { const [s, c] = k.split("|"); body.push([s, c, +perUnit(v.nto, v.qty)!.toFixed(4), +perUnit(v.gto, v.qty)!.toFixed(4), basisLabel]); }
    body.sort((a, b) => (a[0] === b[0] ? String(a[1]).localeCompare(String(b[1])) : String(a[0]).localeCompare(String(b[0]))));
    const aoa = [["Master SKU", "Channel", "NTO/unit (₹)", "GTO/unit (₹)", "Basis"], ...body];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "NTO per unit"); XLSX.writeFile(wb, `nto_unit_map_${basis === "WTD" ? "wtdavg" : basis}.xlsx`);
  };

  const downloadTemplate = () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Master SKU", "Channel", "Qty"], [skuList[0] ?? "BB_AF", channels[0] ?? "Qcom", 1000]]), "Forecast");
    XLSX.writeFile(wb, "forecast_template.xlsx");
  };

  if (role === undefined) return <AppShell><div className="py-16 text-center" style={{ color: "var(--atlas-ink-muted)" }}>Checking access…</div></AppShell>;
  if (!role || !ALLOWED_ROLES.has(role)) return <AppShell><div className="py-16 text-center"><p className="text-lg font-semibold" style={{ color: "var(--atlas-ink)" }}>Restricted</p><p className="mt-2 text-sm" style={{ color: "var(--atlas-ink-muted)" }}>Net realisation (NTO / unit) is available to Sales &amp; Admin roles only.</p><Link href="/sales" className="inline-block mt-4 px-4 py-2 rounded-lg text-white text-sm" style={{ background: "var(--atlas-accent)", textDecoration: "none" }}>← Sales dashboard</Link></div></AppShell>;
  if (err) return <AppShell><div className="py-16 text-center"><p style={{ color: "var(--atlas-red)" }}>{err}</p></div></AppShell>;
  if (!data) return <AppShell><div className="py-16 text-center" style={{ color: "var(--atlas-ink-muted)" }}>Loading…</div></AppShell>;

  return (
    <AppShell>
      <div className="max-w-7xl mx-auto space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">NTO / Unit mapper</h1>
            <p className="text-sm mt-1" style={{ color: "var(--atlas-ink-muted)" }}>Net realisation per unit by Master SKU × Channel (Singles lens) — month by month, or weighted-average over a range. Apply it to a Qty × Channel forecast.</p>
          </div>
          <Link href="/sales" className="px-3 py-1.5 rounded-lg" style={{ ...surface, fontSize: 12, textDecoration: "none", color: "var(--atlas-ink-soft)" }}>← Sales dashboard</Link>
        </div>

        {/* basis controls */}
        <div className="rounded-xl p-3 flex flex-wrap items-center gap-x-5 gap-y-2" style={surface}>
          <div className="flex items-center gap-2"><span className="text-xs font-semibold" style={{ color: "var(--atlas-ink-muted)" }}>Rate</span>
            {(["nto", "gto"] as PerUnit[]).map((k) => <button key={k} onClick={() => setMetric(k)} className="px-3 py-1.5 rounded-lg" style={{ fontSize: 12, fontWeight: 600, cursor: "pointer", border: "1px solid var(--atlas-line)", background: metric === k ? "var(--atlas-accent)" : "var(--atlas-surface)", color: metric === k ? "#fff" : "var(--atlas-ink-muted)" }}>{k.toUpperCase()}/unit</button>)}
          </div>
          <div className="flex items-center gap-2"><span className="text-xs font-semibold" style={{ color: "var(--atlas-ink-muted)" }}>Wtd-avg range</span>
            <select value={fromM} onChange={(e) => setFromM(e.target.value > toM ? toM : e.target.value)} className="px-2 py-1.5 rounded-lg text-sm" style={{ background: "var(--atlas-surface-soft)", border: "1px solid var(--atlas-line)", color: "var(--atlas-ink)" }}>{months.map((mo) => <option key={mo} value={mo}>{shortMonth(mo)}</option>)}</select>
            <span style={{ color: "var(--atlas-ink-faint)" }}>→</span>
            <select value={toM} onChange={(e) => setToM(e.target.value < fromM ? fromM : e.target.value)} className="px-2 py-1.5 rounded-lg text-sm" style={{ background: "var(--atlas-surface-soft)", border: "1px solid var(--atlas-line)", color: "var(--atlas-ink)" }}>{months.map((mo) => <option key={mo} value={mo}>{shortMonth(mo)}</option>)}</select>
          </div>
          <div className="flex items-center gap-2"><span className="text-xs font-semibold" style={{ color: "var(--atlas-ink-muted)" }}>Apply basis</span>
            <select value={basis} onChange={(e) => setBasis(e.target.value)} className="px-2 py-1.5 rounded-lg text-sm font-semibold" style={{ background: "var(--atlas-surface-soft)", border: "1px solid var(--atlas-accent)", color: "var(--atlas-ink)" }}>
              <option value="WTD">{basisLabel}</option>
              {months.map((mo) => <option key={mo} value={mo}>{shortMonth(mo)} NTO</option>)}
            </select>
          </div>
          <button onClick={downloadMap} className="px-3 py-1.5 rounded-lg text-xs" style={{ ...surface, cursor: "pointer", color: "var(--atlas-ink-soft)" }}>↓ Export map ({basisLabel})</button>
        </div>

        {/* MoM detail for one SKU */}
        <div className="p-4 rounded-xl" style={surface}>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="text-sm font-semibold" style={{ color: "var(--atlas-ink)" }}>Month-on-month {metric.toUpperCase()}/unit</div>
            <input list="mapSkus" value={skuQuery} onChange={(e) => setSkuQuery(e.target.value)} placeholder={`Type a Master SKU… (e.g. ${skuList[0] ?? ""})`} className="px-3 py-1.5 rounded-lg text-sm" style={{ background: "var(--atlas-surface-soft)", border: "1px solid var(--atlas-line)", color: "var(--atlas-ink)", minWidth: 240 }} />
            <datalist id="mapSkus">{skuList.map((s) => <option key={s} value={s} />)}</datalist>
            {sku && <span className="text-xs" style={{ color: "var(--atlas-ink-faint)" }}>{sku} · rank #{skuList.indexOf(sku) + 1} of {skuList.length} · ₹/unit</span>}
          </div>
          <div className="overflow-x-auto">
            <table className="text-sm" style={{ borderCollapse: "separate", borderSpacing: 0, minWidth: "100%" }}>
              <thead><tr style={{ color: "var(--atlas-ink-muted)" }}>
                <th className="text-left py-2 pr-3 sticky left-0" style={{ background: "var(--atlas-surface)", fontWeight: 600 }}>Channel</th>
                {months.map((mo) => <th key={mo} className="px-2 py-2 text-right font-medium whitespace-nowrap">{shortMonth(mo)}</th>)}
                <th className="px-2 py-2 text-right font-semibold whitespace-nowrap" style={{ color: "var(--atlas-accent)" }}>Wtd avg</th>
              </tr></thead>
              <tbody>
                {skuMoM.chans.map((c) => (
                  <tr key={c} style={{ borderTop: "1px solid var(--atlas-line)" }}>
                    <td className="py-1.5 pr-3 sticky left-0 whitespace-nowrap" style={{ background: "var(--atlas-surface)", color: "var(--atlas-ink)" }}>{c}</td>
                    {months.map((mo) => { const v = skuMoM.cell(c, mo); const inR = rangeMonths.includes(mo); return <td key={mo} className="px-2 py-1.5 text-right font-mono" style={{ color: v == null ? "var(--atlas-ink-faint)" : "var(--atlas-ink-soft)", background: inR ? "color-mix(in srgb, var(--atlas-accent) 6%, transparent)" : "transparent", fontVariantNumeric: "tabular-nums" }}>{v == null ? "" : v.toFixed(1)}</td>; })}
                    <td className="px-2 py-1.5 text-right font-mono font-semibold" style={{ color: "var(--atlas-ink)" }}>{rupee(skuMoM.wtd(c))}</td>
                  </tr>
                ))}
                {skuMoM.chans.length === 0 && <tr><td colSpan={months.length + 2} className="py-6 text-center" style={{ color: "var(--atlas-ink-faint)" }}>No data for this SKU.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] mt-2" style={{ color: "var(--atlas-ink-faint)" }}>Shaded columns are inside the weighted-avg range. Weighted avg = Σ{metric.toUpperCase()} ÷ Σ Qty over the range (qty-weighted).</p>
        </div>

        {/* apply to forecast */}
        <div className="p-4 rounded-xl" style={surface}>
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <div className="text-sm font-semibold" style={{ color: "var(--atlas-ink)" }}>Apply to forecast <span style={{ color: "var(--atlas-ink-muted)", fontWeight: 400 }}>— basis: {basisLabel}</span></div>
            <button onClick={downloadTemplate} className="px-3 py-1.5 rounded-lg text-xs" style={{ ...surface, cursor: "pointer", color: "var(--atlas-ink-soft)" }}>↓ Forecast template</button>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <input ref={inputRef} type="file" accept=".xlsx,.xls,.xlsb" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) pickFile(f); }} />
            <button onClick={() => inputRef.current?.click()} className="px-4 py-2 rounded-lg text-white text-sm" style={{ background: "var(--atlas-accent)", cursor: "pointer" }}>Choose forecast file…</button>
            {fName && <span className="text-sm" style={{ color: "var(--atlas-ink-soft)" }}>{fName} — {fRows?.length ?? 0} rows</span>}
            {fRows && <button onClick={apply} className="px-4 py-2 rounded-lg text-sm font-semibold" style={{ border: "1px solid var(--atlas-accent)", color: "var(--atlas-accent)", cursor: "pointer" }}>Compute forecast {metric.toUpperCase()} →</button>}
          </div>

          {applied && (
            <div className="mt-4 space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  { l: "Forecast NTO", v: cr(applied.nto) },
                  { l: "Forecast GTO", v: cr(applied.gto) },
                  { l: "Total Qty", v: qtyFmt(applied.qty) },
                  { l: "Mapped", v: `${applied.mapped}/${applied.rows}`, s: applied.skuAvg ? `${applied.skuAvg} via SKU avg` : "all channel-specific" },
                ].map((k) => <div key={k.l} className="p-3 rounded-xl" style={{ background: "var(--atlas-surface-soft)", border: "1px solid var(--atlas-line)" }}><div className="text-xl font-bold" style={{ color: "var(--atlas-ink)" }}>{k.v}</div><div className="text-[11px] mt-0.5" style={{ color: "var(--atlas-ink-muted)" }}>{k.l}</div>{k.s ? <div className="text-[11px]" style={{ color: "var(--atlas-ink-faint)" }}>{k.s}</div> : null}</div>)}
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div>
                  <div className="text-xs font-semibold mb-1" style={{ color: "var(--atlas-ink-muted)" }}>Forecast NTO by channel</div>
                  <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr style={{ color: "var(--atlas-ink-muted)" }}><th className="text-left py-1.5 font-medium">Channel</th><th className="text-right py-1.5 font-medium">Qty</th><th className="text-right py-1.5 font-medium">NTO</th><th className="text-right py-1.5 font-medium">Share</th></tr></thead><tbody>
                    {applied.byCh.map((r) => <tr key={r.channel} style={{ borderTop: "1px solid var(--atlas-line)" }}><td className="py-1.5" style={{ color: "var(--atlas-ink)" }}>{r.channel}</td><td className="py-1.5 text-right font-mono" style={{ color: "var(--atlas-ink-soft)" }}>{qtyFmt(r.qty)}</td><td className="py-1.5 text-right font-mono" style={{ color: "var(--atlas-ink)" }}>{cr(r.nto)}</td><td className="py-1.5 text-right font-mono" style={{ color: "var(--atlas-ink-soft)" }}>{applied.nto ? `${(r.nto / applied.nto * 100).toFixed(1)}%` : "—"}</td></tr>)}
                  </tbody></table></div>
                </div>
                <div>
                  <div className="text-xs font-semibold mb-1" style={{ color: applied.unmapped.length ? "var(--atlas-red)" : "var(--atlas-ink-muted)" }}>{applied.unmapped.length ? `Unmapped (${applied.unmapped.length}) — no rate under this basis` : "All rows mapped ✓"}</div>
                  {applied.unmapped.length > 0 && <div className="overflow-x-auto" style={{ maxHeight: 200 }}><table className="w-full text-sm"><tbody>
                    {applied.unmapped.slice(0, 30).map(([k, q]) => <tr key={k} style={{ borderTop: "1px solid var(--atlas-line)" }}><td className="py-1" style={{ color: "var(--atlas-ink-soft)" }}>{k}</td><td className="py-1 text-right font-mono" style={{ color: "var(--atlas-ink-faint)" }}>{qtyFmt(q)}</td></tr>)}
                  </tbody></table>{applied.unmapped.length > 30 && <div className="text-[11px] mt-1" style={{ color: "var(--atlas-ink-faint)" }}>+{applied.unmapped.length - 30} more</div>}</div>}
                </div>
              </div>
              <button onClick={downloadApplied} className="px-4 py-2 rounded-lg text-white text-sm" style={{ background: "var(--atlas-green)", cursor: "pointer" }}>↓ Download forecast + NTO (xlsx)</button>
            </div>
          )}
        </div>

        <p style={{ fontSize: 11, color: "var(--atlas-ink-faint)", lineHeight: 1.6 }}>
          <b style={{ color: "var(--atlas-ink-muted)" }}>How it works.</b> Rates come from the Singles lens: <b>{metric.toUpperCase()}/unit = Σ {metric.toUpperCase()} (Cr) × 10⁷ ÷ Σ Qty</b> at Master SKU × Channel, per month (or qty-weighted over the range). On apply, each forecast row uses its channel-specific rate; if that Master SKU × Channel has no history in the basis window, it falls back to the SKU&apos;s all-channel rate, else it&apos;s flagged unmapped. Forecast {`{NTO,GTO}`} = Qty × rate ÷ 10⁷ (Cr).
        </p>
      </div>
    </AppShell>
  );
}

type AppliedResult = {
  detail: { sku: string; channel: string; qty: number; ntoRate: number | null; gtoRate: number | null; fNto: number; fGto: number; src: string }[];
  nto: number; gto: number; qty: number; mapped: number; skuAvg: number; rows: number;
  unmapped: [string, number][]; byCh: { channel: string; nto: number; qty: number }[];
};
