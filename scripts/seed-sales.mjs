// Re-seed aop_sales from "AOP Singles Final.xlsx".
//   Combos sheet is the BASE WORKING (native singles + combos) → kind 'combo'.
//   Singles sheet is the exploded reconciled view          → kind 'single'.
// Mirrors app/api/sales/upload/route.ts (month-replace, key-aggregate, category enrich).
import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
// load .env.local
for (const line of fs.readFileSync(path.join(APP, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const svc = createClient(url, key);
const TABLE = "aop_sales";
const stripG = (s) => (s && s.endsWith("G") ? s.slice(0, -1) : s);
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function toMonth(v) {
  if (v == null) return null;
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth()+1).padStart(2,"0")}-01`;
  if (typeof v === "number") { const d = new Date(Date.UTC(1899,11,30)); d.setUTCDate(d.getUTCDate()+Math.round(v)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-01`; }
  const s = String(v).trim(); let m = s.match(/^(\d{4})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-01`;
  m = s.match(/^([A-Za-z]{3})[-\s](\d{2,4})$/);
  if (m) { const mi = MON.findIndex((x)=>x.toLowerCase()===m[1].toLowerCase()); if (mi>=0){ const y=m[2].length===2?2000+ +m[2]:+m[2]; return `${y}-${String(mi+1).padStart(2,"0")}-01`; } }
  return null;
}
const numOf = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

function extract(wb) {
  const out = [];
  const read = (name, kind) => {
    const ws = wb.Sheets[name]; if (!ws) return;
    const g = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
    let hr = -1; const H = {};
    for (let i=0;i<Math.min(g.length,10);i++){ const m={}; (g[i]||[]).forEach((h,j)=>{ if(h!=null&&String(h).trim()!=="") m[String(h).trim()]=j; }); if(("Master SKU" in m||"Master SKU (combo)" in m)&&"NTO" in m){ hr=i; Object.assign(H,m); break; } }
    if (hr<0) return;
    const cM=H["Month"], cCh=H["Channel 2"]??H["Channel"], cSku=H["Master SKU"]??H["Master SKU (combo)"], cQ=H["Qty"], cN=H["NTO"], cG=H["GTO"];
    for (let i=hr+1;i<g.length;i++){ const r=g[i]; if(!r) continue; const month=toMonth(r[cM]); const sku=r[cSku]!=null?String(r[cSku]).trim():""; if(!month||!sku) continue;
      out.push({ month, channel:String(r[cCh]??"").trim(), masterSku:sku, kind, qty:numOf(r[cQ]), nto:numOf(r[cN]), gto:cG!=null?numOf(r[cG]):0 }); }
  };
  read("Singles","single"); read("Combos","combo");
  return out;
}

async function summary(label) {
  const out = {};
  for (const kind of ["single","combo"]) {
    let from=0, cnt=0, nto=0;
    for(;;){ const {data}= await svc.from(TABLE).select("nto",{count:"exact"}).eq("kind",kind).range(from,from+999); if(!data||!data.length) break; cnt+=data.length; nto+=data.reduce((a,r)=>a+Number(r.nto),0); if(data.length<1000) break; from+=1000; }
    out[kind]={cnt,nto};
  }
  console.log(`${label}: single ${out.single.cnt} rows / ₹${out.single.nto.toFixed(2)}Cr | combo ${out.combo.cnt} rows / ₹${out.combo.nto.toFixed(2)}Cr`);
}

async function main() {
  const file = path.join(APP, "New", "AOP Singles Final.xlsx");
  console.log("Reading", file);
  // No cellDates — month cells arrive as raw serials (SheetJS's cellDates lands
  // ~10s short of midnight, rolling the 1st back a month). toMonth's number branch
  // converts the serial correctly.
  const wb = XLSX.read(fs.readFileSync(file));
  const rows = extract(wb);
  console.log(`Parsed ${rows.length} rows (single ${rows.filter(r=>r.kind==="single").length}, combo ${rows.filter(r=>r.kind==="combo").length})`);

  await summary("BEFORE");

  // category map
  const cat = new Map();
  for (let from=0;;from+=1000){ const {data,error}=await svc.from("sku_master").select("new_master_sku,category").range(from,from+999); if(error) break; for(const s of data??[]){ const k=stripG(s.new_master_sku); if(k&&s.category&&!cat.has(k)) cat.set(k,s.category); } if(!data||data.length<1000) break; }

  const months=[...new Set(rows.map(r=>r.month))].sort();
  // Full re-seed of the entire workbook → clear the whole table (also removes any
  // orphan months left by the earlier month-shifted seeds).
  const {error:delErr}=await svc.from(TABLE).delete().gte("forecast_month","1900-01-01");
  if(delErr) throw new Error("delete: "+delErr.message);

  const now=new Date().toISOString(); const byKey=new Map();
  for(const r of rows){ const k=`${r.month}|${r.channel}|${r.masterSku}|${r.kind}`; const a=byKey.get(k)??{forecast_month:r.month,channel:r.channel,master_sku:r.masterSku,kind:r.kind,qty:0,nto:0,gto:0}; a.qty+=r.qty;a.nto+=r.nto;a.gto+=r.gto; byKey.set(k,a); }
  const recs=[...byKey.values()].map(a=>({...a,category:cat.get(a.master_sku)??null,uploaded_at:now}));
  let inserted=0;
  for(let i=0;i<recs.length;i+=500){ const {error}=await svc.from(TABLE).insert(recs.slice(i,i+500)); if(error) throw new Error(`insert @${i}: ${error.message}`); inserted+=Math.min(500,recs.length-i); }
  console.log(`Inserted ${inserted} aggregated rows across ${months.length} months`);

  await summary("AFTER ");
}
main().catch(e=>{ console.error(e); process.exit(1); });
