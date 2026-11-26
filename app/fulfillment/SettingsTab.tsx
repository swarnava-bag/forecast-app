"use client";
import { useState } from "react";
import type { ChannelMapRow, ClosedDay, CredSla, FulfillmentConfig, ReasonRow } from "@/lib/fulfillment/engine";
import type { SectionMeta } from "@/lib/fulfillment/store";
import { surface, muted, faint, inputStyle, Btn, Notice } from "./ui";

type Col<R> = { key: keyof R; label: string; type?: "text" | "date" | "number"; width?: number; list?: string; placeholder?: string };

/** Editable grid with add / delete / save / reset. Render with key={JSON.stringify(rows)}
 *  so a saved change (new rows from the server) resets the draft. */
function Grid<R extends Record<string, unknown>>(props: Parameters<typeof GridInner<R>>[0]) {
  return <GridInner<R> key={JSON.stringify(props.rows)} {...props} />;
}
function GridInner<R extends Record<string, unknown>>({ title, note, rows, cols, blank, validate, onSave, disabled, extra, saved }: {
  title: string; note: string; rows: R[]; cols: Col<R>[]; blank: () => R; validate: (rs: R[]) => string | null;
  onSave: (rs: R[]) => Promise<void>; disabled: boolean; extra?: (add: (r: R) => void) => React.ReactNode; saved?: { at: string; by: string };
}) {
  const [draft, setDraft] = useState<R[]>(rows);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(rows);

  const set = (i: number, k: keyof R, v: string) => setDraft((d) => d.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const save = async () => {
    const v = validate(draft);
    if (v) { setMsg({ tone: "error", text: v }); return; }
    setBusy(true); setMsg(null);
    try { await onSave(draft); setMsg({ tone: "ok", text: "Saved — dashboard recalculated." }); }
    catch (e) { setMsg({ tone: "error", text: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(false); }
  };

  return (
    <section className="rounded-xl" style={surface}>
      <div className="px-4 py-3 flex flex-wrap items-start justify-between gap-2" style={{ borderBottom: "1px solid var(--atlas-line)" }}>
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 700 }}>{title} <span style={{ fontWeight: 400, ...faint }}>· {rows.length}</span></h3>
          <div style={{ fontSize: 11.5, ...muted }}>{note}</div>
          <div style={{ fontSize: 11, ...faint }} className="mt-0.5">
            {saved ? `Last saved by ${saved.by} · ${new Date(saved.at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}` : "Workbook defaults — not edited yet"}
            {dirty && <b style={{ color: "var(--atlas-ink-soft)" }}> · unsaved changes</b>}
          </div>
        </div>
        {!disabled && (
          <div className="flex gap-2">
            <Btn small onClick={() => setDraft((d) => [blank(), ...d])}>+ Add row</Btn>
            <Btn small disabled={!dirty || busy} onClick={() => { setDraft(rows); setMsg(null); }}>Reset</Btn>
            <Btn small primary disabled={!dirty || busy} onClick={save}>{busy ? "Saving…" : "Save"}</Btn>
          </div>
        )}
      </div>
      {extra && !disabled && <div className="px-4 pt-3">{extra((r) => setDraft((d) => [...d, r]))}</div>}
      {msg && <div className="px-4 pt-3"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
      <div style={{ maxHeight: 420, overflow: "auto" }} className="px-2 py-2">
        <table className="w-full" style={{ fontSize: 12.5 }}>
          <thead><tr style={{ ...muted, textAlign: "left" }}>{cols.map((c) => <th key={String(c.key)} className="px-2 py-1 font-medium" style={{ width: c.width }}>{c.label}</th>)}<th style={{ width: 32 }} /></tr></thead>
          <tbody>
            {draft.map((r, i) => (
              <tr key={i}>
                {cols.map((c) => (
                  <td key={String(c.key)} className="px-2 py-1">
                    <input type={c.type ?? "text"} value={String(r[c.key] ?? "")} disabled={disabled} list={c.list} placeholder={c.placeholder}
                      onChange={(e) => set(i, c.key, e.target.value)} style={inputStyle} />
                  </td>
                ))}
                <td className="px-1">{!disabled && <button onClick={() => setDraft((d) => d.filter((_, j) => j !== i))} title="Delete row" style={{ background: "none", border: "none", cursor: "pointer", ...faint }}>✕</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

type Props = {
  config: FulfillmentConfig;
  meta: SectionMeta;
  facilities: string[];
  unmapped: { channelName: string; orders: number }[];
  save: {
    channelMap: (r: ChannelMapRow[]) => Promise<void>;
    closedDays: (r: ClosedDay[]) => Promise<void>;
    credSla: (r: CredSla[]) => Promise<void>;
    reasons: (r: ReasonRow[]) => Promise<void>;
    settings: (s: { cutoff: string; credDefaultHours: number | null }) => Promise<void>;
  };
};

type ClosedDraft = { date: string; warehouse: string; remarks: string };
type CredDraft = { date: string; hours: string };

function ScalarSettings({ config, off, onSave }: { config: FulfillmentConfig; off: boolean; onSave: Props["save"]["settings"] }) {
  const savedDef = config.credDefaultHours === null ? "" : String(config.credDefaultHours);
  const [cutoff, setCutoff] = useState(config.cutoff);
  const [credDef, setCredDef] = useState(savedDef);
  const [sMsg, setSMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  return (
    <section className="rounded-xl p-4 flex flex-wrap items-end gap-4" style={surface}>
      <label style={{ fontSize: 12.5, ...muted }}>Marketplace cutoff time
        <input type="time" value={cutoff} disabled={off} onChange={(e) => setCutoff(e.target.value)} style={{ ...inputStyle, width: 130, display: "block", marginTop: 4 }} />
      </label>
      <label style={{ fontSize: 12.5, ...muted }}>CRED SLA for non-listed dates (hrs, blank = not tracked)
        <input type="number" min={0} value={credDef} disabled={off} onChange={(e) => setCredDef(e.target.value)} style={{ ...inputStyle, width: 130, display: "block", marginTop: 4 }} />
      </label>
      {!off && (
        <Btn small primary disabled={cutoff === config.cutoff && credDef === savedDef}
          onClick={async () => {
            setSMsg(null);
            try { await onSave({ cutoff: cutoff || "15:00", credDefaultHours: credDef.trim() === "" ? null : Number(credDef) }); setSMsg({ tone: "ok", text: "Saved." }); }
            catch (e) { setSMsg({ tone: "error", text: e instanceof Error ? e.message : String(e) }); }
          }}>Save</Btn>
      )}
      {sMsg && <span style={{ fontSize: 12.5, color: sMsg.tone === "ok" ? "var(--atlas-green)" : "var(--atlas-red)" }}>{sMsg.text}</span>}
    </section>
  );
}

export default function SettingsTab({ config, meta, facilities, unmapped, save }: Props) {
  const off = false; // the page itself is Supply Chain / admin only, and they can all edit
  const l1s = [...new Set(config.channelMap.map((r) => r.l1))].sort();

  const dupCheck = <R,>(rs: R[], key: (r: R) => string, what: string) => {
    const seen = new Set<string>();
    for (const r of rs) { const k = key(r); if (seen.has(k)) return `Duplicate ${what}: ${k.replace("\u0001", " / ")}`; seen.add(k); }
    return null;
  };

  return (
    <div className="space-y-4">
      <datalist id="ff-l1">{l1s.map((v) => <option key={v} value={v} />)}</datalist>
      <datalist id="ff-wh">{facilities.map((v) => <option key={v} value={v} />)}</datalist>

      <ScalarSettings key={`${config.cutoff}|${config.credDefaultHours}`} config={config} off={off} onSave={save.settings} />

      <Grid<ChannelMapRow>
        title="Channel Mapper" note="Unicommerce Channel Name → Channel (L1) used on the dashboard, and L2 (warehouse-level channel)."
        rows={config.channelMap} disabled={off} saved={meta.channelMap} blank={() => ({ channelName: "", l1: "", l2: "" })}
        cols={[{ key: "channelName", label: "Channel Name (Unicommerce)", width: 280 }, { key: "l1", label: "Channel (L1)", list: "ff-l1", width: 180 }, { key: "l2", label: "L2" }]}
        validate={(rs) => rs.some((r) => !r.channelName.trim() || !r.l1.trim()) ? "Every row needs a Channel Name and an L1." : dupCheck(rs, (r) => r.channelName.trim(), "Channel Name")}
        onSave={save.channelMap}
        extra={(add) => unmapped.length > 0 && (
          <Notice tone="warn">
            Channel names in the data that are not mapped (click to add):{" "}
            <span className="inline-flex flex-wrap gap-1.5 align-middle">
              {unmapped.map((u) => (
                <button key={u.channelName} onClick={() => add({ channelName: u.channelName, l1: "", l2: "" })} className="px-2 py-0.5 rounded"
                  style={{ fontSize: 12, cursor: "pointer", border: "1px solid var(--atlas-line)", background: "var(--atlas-surface)" }}>+ {u.channelName} ({u.orders})</button>
              ))}
            </span>
          </Notice>
        )}
      />

      <Grid<ClosedDraft>
        title="Warehouse Closed Dates" note="Orders on a closed date count from the next open day; due dates falling on closed days move to the next open day. Leave Warehouse blank for all warehouses."
        rows={config.closedDays.map((c) => ({ date: c.date, warehouse: c.warehouse ?? "", remarks: c.remarks }))} disabled={off} saved={meta.closedDays}
        blank={() => ({ date: "", warehouse: "", remarks: "" })}
        cols={[{ key: "date", label: "Closed date", type: "date", width: 170 }, { key: "warehouse", label: "Warehouse (blank = all)", list: "ff-wh", width: 260, placeholder: "All warehouses" }, { key: "remarks", label: "Remarks" }]}
        validate={(rs) => rs.some((r) => !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) ? "Every row needs a valid date." : dupCheck(rs, (r) => `${r.date}\u0001${r.warehouse.trim() || "All"}`, "closure")}
        onSave={(rs) => save.closedDays(rs.map((r) => ({ date: r.date, warehouse: r.warehouse.trim() || null, remarks: r.remarks })))}
      />

      <Grid<CredDraft>
        title="CRED SLA Dates" note="SLA hours for CRED orders placed on a given date. Dates not listed use the default above (blank = not tracked → NA)."
        rows={config.credSla.map((c) => ({ date: c.date, hours: String(c.hours) }))} disabled={off} saved={meta.credSla}
        blank={() => ({ date: "", hours: "72" })}
        cols={[{ key: "date", label: "Order date", type: "date", width: 170 }, { key: "hours", label: "SLA (hrs)", type: "number", width: 120 }]}
        validate={(rs) => rs.some((r) => !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !(Number(r.hours) > 0)) ? "Every row needs a date and SLA hours > 0." : dupCheck(rs, (r) => r.date, "date")}
        onSave={(rs) => save.credSla(rs.map((r) => ({ date: r.date, hours: Number(r.hours) })))}
      />

      <Grid<ReasonRow>
        title="Pending Reason Mapping" note="Status key (On Hold → ON_HOLD, else package status, else item status) → reason shown on Pending Orders."
        rows={config.reasons} disabled={off} saved={meta.reasons} blank={() => ({ statusKey: "", reason: "" })}
        cols={[{ key: "statusKey", label: "Status key", width: 240 }, { key: "reason", label: "Reason" }]}
        validate={(rs) => rs.some((r) => !r.statusKey.trim() || !r.reason.trim()) ? "Every row needs a status key and a reason." : dupCheck(rs, (r) => r.statusKey.trim(), "status key")}
        onSave={save.reasons}
      />
    </div>
  );
}
