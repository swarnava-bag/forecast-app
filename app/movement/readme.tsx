"use client";
// ============================================================================
// Readme tab — a codebase map of Forecast vs Movement.
//   Five stages, top-to-bottom, in true data-flow order: Sources → Mappers →
//   Engine → Snapshot → Views. Styled with the atlas tokens so it tracks the
//   viewer's theme; stage hues are driven by an inline --c custom property.
// ============================================================================
import { useTheme } from "./lib";

type Node = { name: string; arg?: string; ret?: string; d: string; wide?: boolean };
type Stage = { n: string; hue: keyof Hues; title: string; role: string; file: string; nodes: Node[] };
type Hues = { src: string; map: string; eng: string; snap: string; view: string };

const HUES_LIGHT: Hues = { src: "#B4712A", map: "#6E4CE0", eng: "#0B8497", snap: "#2C63C7", view: "#2A9161" };
const HUES_DARK: Hues = { src: "#D6963E", map: "#9C84F6", eng: "#20B4C7", snap: "#5B8CEC", view: "#43BE86" };

const STAGES: Stage[] = [
  { n: "01", hue: "src", title: "Sources", file: "templates.ts",
    role: "Four Excel workbooks read in the browser — nothing is uploaded until you publish. Forecast is monthly; the other three are daily.",
    nodes: [
      { name: "Forecast", arg: " · monthly", d: "Target per SKU × channel × platform. Uploaded once a month — later runs reuse it from the last publish." },
      { name: "SO", arg: " · daily", d: "Sales orders. Ex-node Dispatch Qty to a customer (Party Name); also feeds Qcom and the ship-sheet." },
      { name: "STN", arg: " · daily", d: "Stock transfers: From → To Warehouse, Qty, Status, Date." },
      { name: "Shipsheet", arg: " · yesterday", d: "Yesterday's shipped POs — the in-flight tail not yet closed in SO." },
    ] },
  { n: "02", hue: "map", title: "Mappers", file: "mappers.ts → type Mappers",
    role: "The join layer. Raw codes and customer names become master SKUs and channels. Reuses the platform's own Mapper Studio — no parallel master map.",
    nodes: [
      { name: "fgToSku", arg: "(rawFg)", d: "FG code → new_master_sku, via sku_master (N/G suffix) + fg-alias for code transitions." },
      { name: "explode", arg: "(sku)", d: "Combo → leaf {sku,qty}[] from combo_mapper_rows, nested-flattened." },
      { name: "customerToChannel", arg: "(party)", d: "Party Name → MT / GT / Qcom / B2B / B2C… movement_customer_map." },
      { name: "customerToPlatform", arg: "(party)", d: "Party Name → Blinkit / Zepto / Instamart… (Qcom split)." },
      { name: "warehouseToChannel", arg: "(to)", d: "STN destination → channel. movement_warehouse_map." },
      { name: "resolveLine", arg: "(fg, qty)", d: "The shared primitive: fgToSku → explode, weighting each leaf by the line qty." },
    ] },
  { n: "03", hue: "eng", title: "Engine", file: "engine.ts",
    role: "Pure functions — no React, no Supabase. Every row is scoped to the chosen month, combo-exploded, and filtered to the mother node.",
    nodes: [
      { name: "computeSO", arg: "(so, mp, mi)", ret: " → SoResult", d: "Ex-node dispatch to channel-mapped customers → bySku, bySkuChan." },
      { name: "computeSTN", arg: "(stn, mp, mi)", ret: " → StnResult", d: "Ex-node transfers ≠ Cancelled. Internal Central / Quarantine tallied apart." },
      { name: "computeQcom", arg: "(so, mp, mi)", ret: " → QcomAgg", d: "sku × platform → {orders, sales} from SO order vs dispatch qty." },
      { name: "computeShipsheet", arg: "(so, ship, mp)", ret: " → ShipResult", d: "Open qty on shipped POs — in-flight add-back, matched to SO by PO." },
      { name: "computeDaily", arg: "(so, stn, mp, mi)", ret: " → DailyResult", d: "Day-on-day: daily, dailyChannel, dailyInternal, dailySkuChannel." },
      { name: "parseForecast", arg: "(fc, mp)", ret: " → Forecast", d: "Long/wide forecast → bySku, byChannel, byPlatform." },
      { name: "computeSnapshot", arg: "(files, mp, monthKey, preset?)", ret: " → { snapshot, diagnostics }", wide: true,
        d: "The orchestrator. Runs every compute above, unions the SKUs, joins forecast to movement, and assembles the published Snapshot. Missing SO/STN → empty results; forecast can come from preset (last publish)." },
      { name: "helpers:", arg: " sheetGrid · findHeader · ymd · inMonth · monthInfoFromKey", wide: true,
        d: "sheetGrid real used-range + WeakMap cache · ymd TZ-safe serial decode · inMonth scopes every file to the target month." },
    ] },
  { n: "04", hue: "snap", title: "Snapshot", file: "lib.ts → type Snapshot · api/movement-snapshot",
    role: "One JSON object per month — the single published artifact. Persisted to Supabase movement_snapshots (keyed by month), read back through the API.",
    nodes: [
      { name: "meta", d: "Month, days elapsed / in-month, forecast totals, internalMoves, channel / platform / category lists." },
      { name: "overall[]", d: "Per SKU: forecast · stn · so · shipsheet · totalSupplied · toCentral · toQuarantine." },
      { name: "channelwise[]", d: "Per SKU × channel: forecast vs supplied." },
      { name: "qcom[]", d: "Per SKU × platform: forecast · mtdOrders · mtdSales." },
      { name: "daily · dailyChannel · dailyInternal · dailySkuChannel", d: "Timing series that drive the day-on-day view and the per-SKU drill-down." },
    ] },
  { n: "05", hue: "view", title: "Views", file: "page.tsx · ui.tsx · lib.ts",
    role: "The dashboard reads the snapshot only — never the raw files. Month selector top-left; each team gets its own lens.",
    nodes: [
      { name: "OverallView", d: "Ops. KPIs, path bar, service spread, exceptions → RCA, category / SKU tables, internal-transfer lines." },
      { name: "ChannelView", d: "Channel owners — forecast vs moved, per channel." },
      { name: "QcomView", d: "Orders vs sales, per q-commerce platform." },
      { name: "DailyView", d: "Day-on-day movement · SKU search · multi-select channels + internal." },
      { name: "RcaModal", d: "Per-SKU drill-down: where the gap sits, incl. To Central / Quarantine." },
      { name: "metrics:", arg: " achColor · actionFor", d: ">100% Alert · 90–100 On plan · 70–90 Pick up · <70 Urgent." },
    ] },
];

const RULES: { tag: string; h: string; p: string; c: string }[] = [
  { tag: "Node filter", h: "Only the mother node counts", c: "eng", p: "Movement means leaving YB FG Warehouse. Rows sourced anywhere else are ignored." },
  { tag: "Month scoping", h: "The selected month is the source of truth", c: "snap", p: "Every file is filtered to the target month by date (inMonth). A two-month export, or a late SO for an older month, only counts the rows that belong there." },
  { tag: "STN status", h: "Everything but Cancelled", c: "amber", p: "GT books to a dummy account as Raised, not Closed — a Closed-only filter would silently drop it." },
  { tag: "Mapped only", h: "Unmapped ≠ supply", c: "map", p: "Only dispatch / transfer to a channel-mapped customer or warehouse is real outbound. Samples, gifting and unmapped types fall out." },
  { tag: "Internal moves", h: "Central & Quarantine aren't movement", c: "red", p: "To Central (repacking) and To Quarantine are tracked as separate lines — never added to what the channels received." },
  { tag: "Alert logic", h: "Over-supply is the red flag", c: "red", p: ">100% moved reads red, not green — pushing past forecast burns downstream working capital." },
  { tag: "Explosion", h: "One master mapper, always", c: "map", p: "Every FG line explodes to leaf SKUs through the shared Mapper Studio (sku_master + combo_mapper_rows). No parallel master SKU map." },
  { tag: "Cadence", h: "Forecast is monthly", c: "src", p: "Reused from the last publish, so a daily run needs only SO + STN + Shipsheet. SO/STN are optional when starting a new month." },
];

const MODULES: { group: string; rows: { f: string; r: string }[] }[] = [
  { group: "Transform & data", rows: [
    { f: "engine.ts", r: "Pure transform. Files + mappers → snapshot. No React, no network — the one file to unit-test." },
    { f: "mappers.ts", r: "Loads Supabase (sku_master, combo_mapper_rows, movement maps) into the Mappers interface." },
    { f: "lib.ts", r: "Snapshot types + metrics (achColor, actionFor), palette, formatting, CSV export." },
    { f: "templates.ts", r: "Downloadable blank templates for each of the four source files." },
  ] },
  { group: "Screens", rows: [
    { f: "page.tsx", r: "The dashboard. Overall · Daily · Channel · Qcom views + RCA modal, driven by the snapshot." },
    { f: "compute/page.tsx", r: "Upload flow: pick month → drop files → engine → diagnostics → publish." },
    { f: "mappers/page.tsx", r: "Edit the movement mappers (customer / warehouse / fg-alias) · Excel export." },
    { f: "ui.tsx", r: "Shared atoms — Kpi, Panel, Badge, PctBar, sortable table cells." },
  ] },
  { group: "Persistence", rows: [
    { f: "api/movement-snapshot", r: "GET one / list · POST publish. Supabase-first, filesystem fallback." },
    { f: "supabase/sql/*", r: "movement_mappers.sql (+ seed) · movement_snapshots.sql — tables & RLS." },
  ] },
];

export function ReadmeView() {
  const theme = useTheme();
  const H = theme === "dark" ? HUES_DARK : HUES_LIGHT;
  const sem: Record<string, string> = { ...H, red: "var(--atlas-red)", green: "var(--atlas-green)", amber: "var(--atlas-amber-warn, #D97706)" };
  const legend: { k: keyof Hues; label: string; note: string }[] = [
    { k: "src", label: "Sources", note: "raw files" }, { k: "map", label: "Mappers", note: "the join layer" },
    { k: "eng", label: "Engine", note: "pure compute" }, { k: "snap", label: "Snapshot", note: "published data" },
    { k: "view", label: "Views", note: "dashboard" },
  ];
  return (
    <div className="rm">
      <style>{CSS}</style>

      <p className="rm-intro">
        The whole feature is one <b>pure transform</b>: four spreadsheets, joined through editable mappers,
        collapsed into a single published snapshot the dashboard reads. Read the five stages top-to-bottom —
        the arrows are the data.
      </p>
      <div className="rm-legend">
        {legend.map((l) => (
          <span key={l.k} className="rm-lg"><i style={{ background: H[l.k] }} /><b>{l.label}</b> {l.note}</span>
        ))}
      </div>

      <div className="rm-flow">
        {STAGES.map((s, i) => (
          <div key={s.n}>
            {i > 0 && <div className="rm-arrow" aria-hidden="true">↓</div>}
            <section className="rm-band" style={{ ["--c" as string]: H[s.hue] }}>
              <div className="rm-head">
                <div className="rm-stg">STAGE {s.n}</div>
                <h3>{s.title}</h3>
                <p className="rm-role">{s.role}</p>
                <span className="rm-file">{s.file}</span>
              </div>
              <div className="rm-nodes">
                {s.nodes.map((n) => (
                  <div key={n.name} className={`rm-node${n.wide ? " wide" : ""}`}>
                    <div className="rm-sym">{n.name}{n.arg && <span className="arg">{n.arg}</span>}{n.ret && <span className="ret">{n.ret}</span>}</div>
                    <div className="rm-d">{n.d}</div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        ))}
      </div>

      <section className="rm-sec">
        <div className="rm-eyebrow">Correctness</div>
        <h2>Rules that make the numbers right</h2>
        <p className="rm-sub">The transform is simple; the judgement lives in these rules. Each was reverse-engineered against the reference workbooks and validated to the unit — change one and the totals move.</p>
        <div className="rm-rules">
          {RULES.map((r) => (
            <div key={r.tag} className="rm-rule" style={{ ["--rc" as string]: sem[r.c] }}>
              <span className="rm-tag">{r.tag}</span>
              <h4>{r.h}</h4>
              <p>{r.p}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="rm-sec">
        <div className="rm-eyebrow">Navigation</div>
        <h2>Module map</h2>
        <p className="rm-sub">Where each responsibility lives — the seam to respect when extending: the engine stays pure, the loader owns Supabase, the views only ever read a snapshot.</p>
        <div className="rm-mods">
          {MODULES.map((g) => (
            <div key={g.group}>
              <div className="rm-mgroup">{g.group}</div>
              {g.rows.map((row) => (
                <div key={row.f} className="rm-mrow"><span className="f">{row.f}</span><span className="r">{row.r}</span></div>
              ))}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

const CSS = `
.rm{ --rm-mono: ui-monospace,"Cascadia Code","JetBrains Mono",SFMono-Regular,Menlo,Consolas,monospace; }
.rm .rm-intro{ max-width:66ch;font-size:14px;color:var(--atlas-ink-soft);line-height:1.6;margin:0; }
.rm .rm-intro b{ color:var(--atlas-ink);font-weight:640; }
.rm .rm-legend{ display:flex;flex-wrap:wrap;gap:8px 18px;margin:18px 0 0; }
.rm .rm-lg{ display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--atlas-ink-muted); }
.rm .rm-lg b{ color:var(--atlas-ink);font-weight:600; }
.rm .rm-lg i{ width:11px;height:11px;border-radius:3px;flex:none;display:inline-block; }
.rm .rm-flow{ margin-top:26px; }
.rm .rm-arrow{ text-align:center;color:var(--atlas-ink-faint);font-size:17px;line-height:1;margin:9px 0; }
.rm .rm-band{ background:var(--atlas-surface);border:1px solid var(--atlas-line);border-left:4px solid var(--c);
  border-radius:16px;padding:20px 22px;display:grid;grid-template-columns:212px 1fr;gap:26px; }
.rm .rm-stg{ font-family:var(--rm-mono);font-size:11px;letter-spacing:.14em;color:var(--c);font-weight:600; }
.rm .rm-band h3{ margin:5px 0 0;font-size:18px;font-weight:650;color:var(--atlas-ink);letter-spacing:-.01em; }
.rm .rm-role{ margin:9px 0 0;font-size:12.5px;color:var(--atlas-ink-soft);line-height:1.5; }
.rm .rm-file{ margin-top:12px;display:inline-block;font-family:var(--rm-mono);font-size:11px;color:var(--atlas-ink-muted);
  background:var(--atlas-surface-soft);border:1px solid var(--atlas-line);border-radius:6px;padding:3px 7px;word-break:break-word; }
.rm .rm-nodes{ display:grid;grid-template-columns:repeat(auto-fill,minmax(214px,1fr));gap:12px;align-content:start; }
.rm .rm-node{ background:var(--atlas-surface-soft);border:1px solid var(--atlas-line);border-left:3px solid var(--c);
  border-radius:10px;padding:11px 13px;transition:transform .14s ease,border-color .14s ease; }
.rm .rm-node:hover{ transform:translateY(-2px);border-color:var(--c); }
.rm .rm-node.wide{ grid-column:1 / -1; }
.rm .rm-sym{ font-family:var(--rm-mono);font-size:12.5px;font-weight:600;color:var(--atlas-ink);word-break:break-word; }
.rm .rm-sym .arg{ color:var(--atlas-ink-muted);font-weight:400; }
.rm .rm-sym .ret{ color:var(--c); }
.rm .rm-d{ margin-top:6px;font-size:12px;color:var(--atlas-ink-soft);line-height:1.48; }
.rm .rm-sec{ margin-top:44px; }
.rm .rm-eyebrow{ font-family:var(--rm-mono);font-size:10.5px;letter-spacing:.18em;text-transform:uppercase;color:var(--atlas-ink-muted); }
.rm .rm-sec h2{ margin:5px 0 0;font-size:21px;font-weight:650;color:var(--atlas-ink);letter-spacing:-.015em; }
.rm .rm-sub{ margin:9px 0 20px;font-size:13px;color:var(--atlas-ink-soft);max-width:64ch;line-height:1.55; }
.rm .rm-rules{ display:grid;grid-template-columns:repeat(auto-fill,minmax(256px,1fr));gap:12px; }
.rm .rm-rule{ background:var(--atlas-surface);border:1px solid var(--atlas-line);border-radius:12px;padding:15px 16px; }
.rm .rm-tag{ display:inline-flex;align-items:center;gap:6px;font-family:var(--rm-mono);font-size:10.5px;letter-spacing:.06em;
  text-transform:uppercase;color:var(--rc);font-weight:600; }
.rm .rm-tag::before{ content:"";width:7px;height:7px;border-radius:50%;background:var(--rc); }
.rm .rm-rule h4{ margin:8px 0 0;font-size:13.5px;font-weight:640;color:var(--atlas-ink);letter-spacing:-.01em; }
.rm .rm-rule p{ margin:6px 0 0;font-size:12.5px;color:var(--atlas-ink-soft);line-height:1.5; }
.rm .rm-mods{ border:1px solid var(--atlas-line);border-radius:12px;overflow:hidden; }
.rm .rm-mgroup{ font-family:var(--rm-mono);font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--atlas-ink-muted);
  padding:11px 18px 4px;background:var(--atlas-surface-soft); }
.rm .rm-mrow{ display:grid;grid-template-columns:minmax(180px,230px) 1fr;gap:22px;padding:12px 18px;
  background:var(--atlas-surface);border-top:1px solid var(--atlas-line); }
.rm .rm-mrow .f{ font-family:var(--rm-mono);font-size:12.5px;color:var(--atlas-ink);font-weight:600;word-break:break-word;align-self:start; }
.rm .rm-mrow .r{ font-size:12.5px;color:var(--atlas-ink-soft);line-height:1.5;align-self:center; }
@media (max-width:720px){ .rm .rm-band{ grid-template-columns:1fr;gap:14px; } .rm .rm-mrow{ grid-template-columns:1fr;gap:4px; } }
@media (prefers-reduced-motion:reduce){ .rm *{ transition:none !important; } }
`;
