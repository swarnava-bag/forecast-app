/**
 * Generic file consolidator — pure core (no DOM, no network).
 *
 * Merges any set of CSV texts that share the same columns into one CSV.
 * (Excel inputs are converted to CSV text by the caller before reaching here.)
 *  - header written once (first file's spelling and order)
 *  - records split quote-aware (fields may contain commas / newlines)
 *  - column names matched loosely: case, surrounding / repeated spaces ignored
 *  - when a file's header matches exactly, its records pass through byte-for-byte
 *  - otherwise rows are re-aligned to the output header; columns only some files
 *    have are appended at the end and left blank for the others
 */

export type CsvFileInput = { name: string; text: string };

export type FileReport = {
  name: string;
  rows: number;
  /** exact = same header as output; realigned = columns re-mapped */
  header: "exact" | "realigned";
  missing: string[]; // output columns this file did not have (left blank)
  extra: string[]; // columns this file had that the first file did not
  /** share of the first file's columns this file has (0..1) */
  overlap: number;
};

export type ConsolidateResult = {
  csv: string;
  header: string[];
  totalRows: number;
  reports: FileReport[];
};

export type ConsolidateOptions = {
  /** append a "Source File" column holding each row's file name (no extension) */
  addSourceColumn?: boolean;
};

export const SOURCE_COLUMN = "Source File";
/** below this column overlap with the first file, a file is likely the wrong one */
export const LOW_OVERLAP = 0.5;

/** Split CSV text into raw record strings (without line terminators). Quote-aware. */
export function splitRecords(text: string): string[] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const out: string[] = [];
  let start = 0;
  let inQuotes = false;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 34 /* " */) {
      inQuotes = !inQuotes; // "" escapes toggle twice → net unchanged
    } else if (!inQuotes && (c === 10 /* \n */ || c === 13 /* \r */)) {
      out.push(text.slice(start, i));
      if (c === 13 && text.charCodeAt(i + 1) === 10) i++;
      start = i + 1;
    }
  }
  if (start < n) out.push(text.slice(start));
  // drop blank lines (trailing newline, empty rows, rows of only commas)
  return out.filter((r) => r.replace(/[,\s"]/g, "") !== "");
}

/** Parse one raw record into field values. */
export function parseRecord(rec: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < rec.length; i++) {
    const ch = rec[i];
    if (inQuotes) {
      if (ch === '"') {
        if (rec[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { fields.push(cur); cur = ""; }
    else cur += ch;
  }
  fields.push(cur);
  return fields;
}

export function escapeField(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** loose column key: trimmed, inner whitespace collapsed, case-insensitive */
export const colKey = (h: string) => h.trim().replace(/\s+/g, " ").toLowerCase();
const stripExt = (name: string) => name.replace(/\.[^.]+$/, "");

export function consolidate(files: CsvFileInput[], opts: ConsolidateOptions = {}): ConsolidateResult {
  if (files.length === 0) throw new Error("No files to consolidate.");

  const parsed = files.map((f) => {
    const records = splitRecords(f.text);
    if (records.length === 0) throw new Error(`"${f.name}" is empty.`);
    const header = parseRecord(records[0]).map((h) => h.trim());
    // trailing unnamed columns (e.g. a trailing comma) are dropped from matching
    while (header.length > 1 && header[header.length - 1] === "") header.pop();
    return { name: f.name, header, keys: header.map(colKey), rawHeader: records[0], body: records.slice(1) };
  });

  // Output columns = first file's columns + any new ones met later, in order.
  const header = [...parsed[0].header];
  const outKeys = [...parsed[0].keys];
  const seen = new Set(outKeys);
  for (const p of parsed) p.keys.forEach((k, i) => { if (!seen.has(k)) { seen.add(k); outKeys.push(k); header.push(p.header[i]); } });

  const firstKeys = new Set(parsed[0].keys);
  const isExact = (p: (typeof parsed)[number]) =>
    p.header.length === header.length && p.header.every((h, i) => h === header[i]) &&
    parseRecord(p.rawHeader).length === header.length;

  const lines: string[] = [];
  const headerLine = isExact(parsed[0]) ? parsed[0].rawHeader : header.map(escapeField).join(",");
  lines.push(opts.addSourceColumn ? `${headerLine},${escapeField(SOURCE_COLUMN)}` : headerLine);

  const reports: FileReport[] = [];
  let totalRows = 0;

  for (const p of parsed) {
    const suffix = opts.addSourceColumn ? `,${escapeField(stripExt(p.name))}` : "";
    const exact = isExact(p);
    if (exact) {
      for (const rec of p.body) lines.push(rec + suffix);
    } else {
      const idx = new Map<string, number>();
      p.keys.forEach((k, i) => { if (!idx.has(k)) idx.set(k, i); });
      const pick = outKeys.map((k) => idx.get(k));
      for (const rec of p.body) {
        const f = parseRecord(rec);
        lines.push(pick.map((i) => (i === undefined ? "" : escapeField(f[i] ?? ""))).join(",") + suffix);
      }
    }
    const own = new Set(p.keys);
    reports.push({
      name: p.name,
      rows: p.body.length,
      header: exact ? "exact" : "realigned",
      missing: header.filter((_, i) => !own.has(outKeys[i])),
      extra: p.header.filter((_, i) => !firstKeys.has(p.keys[i])),
      overlap: [...firstKeys].filter((k) => own.has(k)).length / firstKeys.size,
    });
    totalRows += p.body.length;
  }

  return { csv: lines.join("\r\n") + "\r\n", header, totalRows, reports };
}
