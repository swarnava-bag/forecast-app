/**
 * ETL Script: Import Historical Forecast Excel Files into Supabase
 *
 * Reads all forecast files from "Forecast Repo/", parses the Channels sheet,
 * and inserts denormalized rows into historical_forecast_data.
 *
 * Usage: node scripts/import-historical-forecasts.js
 *
 * Requires: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local
 */

const XLSX = require("xlsx");
const path = require("path");
const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");

// ── Load env from .env.local ──────────────────────────────────────────────
const envPath = path.join(__dirname, "..", ".env.local");
const envContent = fs.readFileSync(envPath, "utf-8");
const env = {};
envContent.split("\n").forEach((line) => {
  const [key, ...rest] = line.split("=");
  if (key && rest.length) env[key.trim()] = rest.join("=").trim();
});

const supabase = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY
);

// ── File mapping ──────────────────────────────────────────────────────────
const REPO_DIR = path.join(__dirname, "..", "Forecast Repo");

const FILE_MAP = [
  { filename: "1. Stock Forecast Apr'25 V6.xlsx", sourceMonth: "2025-04-01" },
  { filename: "2. Stock Forecast May'25 V5.xlsx", sourceMonth: "2025-05-01" },
  { filename: "3. Jun'25 Forecast V5.xlsx", sourceMonth: "2025-06-01" },
  { filename: "4. Jul'25 Forecast V7.xlsx", sourceMonth: "2025-07-01" },
  { filename: "5. Aug Forecast V4.xlsx", sourceMonth: "2025-08-01" },
  { filename: "6. Sep 25 Forecast V7.xlsx", sourceMonth: "2025-09-01" },
  { filename: "7. Oct 25 Forecast V6.xlsx", sourceMonth: "2025-10-01" },
  { filename: "8. Nov 25 Forecast V7.xlsx", sourceMonth: "2025-11-01" },
  { filename: "9. Dec 25 Forecast V7.xlsx", sourceMonth: "2025-12-01" },
  {
    filename: "10. Jan 26 Forecast V6 - Updated Sales Plan.xlsx",
    sourceMonth: "2026-01-01",
  },
  { filename: "Feb 26 Forecast V7.xlsx", sourceMonth: "2026-02-01" },
  { filename: "11. Mar 26 Forecast V4.xlsx", sourceMonth: "2026-03-01" },
  { filename: "12. Apr 26 Forecast V5.xlsx", sourceMonth: "2026-04-01" },
];

// ── Helpers ───────────────────────────────────────────────────────────────

/** Convert Excel date serial to YYYY-MM-DD */
function excelDateToISO(serial) {
  const d = new Date((serial - 25569) * 86400000);
  return d.toISOString().split("T")[0];
}

/** Extract month as YYYY-MM-01 from Excel date serial */
function excelDateToMonth(serial) {
  const d = new Date((serial - 25569) * 86400000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}

/**
 * Normalize Master SKU: ensure it ends with "G" for consistency
 * with sku_master.new_master_sku
 */
function normalizeSku(sku) {
  if (!sku) return "";
  const s = String(sku).trim();
  return s.endsWith("G") ? s : s + "G";
}

/** Normalize FG code: append G if it's a plain number */
function normalizeFgCode(fg) {
  if (!fg) return null;
  const s = String(fg).trim();
  if (/^\d+$/.test(s)) return s + "G";
  return s;
}

// ── Create tables ─────────────────────────────────────────────────────────

async function createTables() {
  console.log("Creating tables if not exist...");

  const { error: e1 } = await supabase.rpc("exec_sql", {
    sql: `
      CREATE TABLE IF NOT EXISTS historical_forecast_files (
        id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        file_name       TEXT NOT NULL,
        source_month    DATE NOT NULL UNIQUE,
        months_covered  SMALLINT NOT NULL DEFAULT 3,
        row_count       INT,
        schema_version  TEXT,
        imported_at     TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS historical_forecast_data (
        id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        source_file     TEXT NOT NULL,
        source_month    DATE NOT NULL,
        forecast_month  DATE NOT NULL,
        rolling_offset  SMALLINT NOT NULL,
        master_sku      TEXT NOT NULL,
        fg_code         TEXT,
        product_name    TEXT,
        category        TEXT,
        product_category TEXT,
        channel_name    TEXT NOT NULL,
        cluster_name    TEXT NOT NULL,
        quantity        NUMERIC NOT NULL DEFAULT 0,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(source_month, forecast_month, master_sku, channel_name)
      );

      CREATE INDEX IF NOT EXISTS idx_hfd_forecast_month ON historical_forecast_data(forecast_month);
      CREATE INDEX IF NOT EXISTS idx_hfd_source_month ON historical_forecast_data(source_month);
      CREATE INDEX IF NOT EXISTS idx_hfd_rolling ON historical_forecast_data(rolling_offset);
      CREATE INDEX IF NOT EXISTS idx_hfd_target_lookup ON historical_forecast_data(forecast_month, rolling_offset, channel_name);
      CREATE INDEX IF NOT EXISTS idx_hfd_category ON historical_forecast_data(category);
    `,
  });

  if (e1) {
    console.log(
      "Could not create tables via RPC (function may not exist). Please create tables manually in Supabase SQL editor."
    );
    console.log("Error:", e1.message);
    // Try a simple test query to check if tables already exist
    const { error: testErr } = await supabase
      .from("historical_forecast_data")
      .select("id")
      .limit(1);
    if (testErr && testErr.message.includes("does not exist")) {
      console.error(
        "\n❌ Tables do not exist. Please run the CREATE TABLE SQL in Supabase SQL Editor first."
      );
      console.log("\nSQL to run:\n");
      printCreateSQL();
      process.exit(1);
    } else {
      console.log("✓ Tables already exist, proceeding with import.");
    }
  } else {
    console.log("✓ Tables created/verified.");
  }
}

function printCreateSQL() {
  console.log(`
CREATE TABLE IF NOT EXISTS historical_forecast_files (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  file_name       TEXT NOT NULL,
  source_month    DATE NOT NULL UNIQUE,
  months_covered  SMALLINT NOT NULL DEFAULT 3,
  row_count       INT,
  schema_version  TEXT,
  imported_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS historical_forecast_data (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source_file     TEXT NOT NULL,
  source_month    DATE NOT NULL,
  forecast_month  DATE NOT NULL,
  rolling_offset  SMALLINT NOT NULL,
  master_sku      TEXT NOT NULL,
  fg_code         TEXT,
  product_name    TEXT,
  category        TEXT,
  product_category TEXT,
  channel_name    TEXT NOT NULL,
  cluster_name    TEXT NOT NULL,
  quantity        NUMERIC NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(source_month, forecast_month, master_sku, channel_name)
);

CREATE INDEX IF NOT EXISTS idx_hfd_forecast_month ON historical_forecast_data(forecast_month);
CREATE INDEX IF NOT EXISTS idx_hfd_source_month ON historical_forecast_data(source_month);
CREATE INDEX IF NOT EXISTS idx_hfd_rolling ON historical_forecast_data(rolling_offset);
CREATE INDEX IF NOT EXISTS idx_hfd_target_lookup ON historical_forecast_data(forecast_month, rolling_offset, channel_name);
CREATE INDEX IF NOT EXISTS idx_hfd_category ON historical_forecast_data(category);
  `);
}

// ── Parse a single file ───────────────────────────────────────────────────

function parseFile(filePath, sourceMonth) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets["Channels"];
  if (!ws) {
    console.warn(`  ⚠ No "Channels" sheet found in ${path.basename(filePath)}`);
    return [];
  }

  const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });

  // 1. Find header row — contains "Grand Total" and channel names
  const headerIdx = data.findIndex(
    (r) =>
      r.some(
        (v) =>
          typeof v === "string" &&
          (v === "Product Name" || v === "Grand Total")
      ) &&
      r.some(
        (v) =>
          typeof v === "string" &&
          (v === "Amazon" || v === "Flipkart" || v === "MT" || v === "GT")
      )
  );

  if (headerIdx < 0) {
    console.warn(
      `  ⚠ Could not find header row in Channels sheet of ${path.basename(filePath)}`
    );
    return [];
  }

  const headers = data[headerIdx];

  // 2. Detect SKU info column indices
  const skuCols = {};
  headers.forEach((v, i) => {
    const s = String(v).trim();
    if (s === "New Master SKU") skuCols.newMasterSku = i;
    else if (s === "Master SKU" && !skuCols.masterSku) skuCols.masterSku = i;
    else if (s === "Row Labels") skuCols.rowLabels = i;
    else if (s === "New FG Code") skuCols.newFgCode = i;
    else if (s === "FG Code" && !skuCols.fgCode) skuCols.fgCode = i;
    else if (s === "Product Name") skuCols.productName = i;
    else if (s === "Category") skuCols.category = i;
    else if (s === "Product Category") skuCols.productCategory = i;
  });

  // The master SKU column (pick best available)
  const masterSkuCol =
    skuCols.newMasterSku ?? skuCols.masterSku ?? skuCols.rowLabels;
  const fgCodeCol = skuCols.newFgCode ?? skuCols.fgCode;

  if (masterSkuCol === undefined) {
    console.warn(
      `  ⚠ No Master SKU column found in ${path.basename(filePath)}`
    );
    return [];
  }

  // 3. Find month blocks — each starts with a "Grand Total" column
  const grandTotalCols = [];
  headers.forEach((v, i) => {
    if (String(v).trim() === "Grand Total") grandTotalCols.push(i);
  });

  if (grandTotalCols.length === 0) {
    console.warn(
      `  ⚠ No Grand Total columns found in ${path.basename(filePath)}`
    );
    return [];
  }

  // 4. Find the dates for each month block
  // Dates are in rows above headers (typically row 0, 1, or 2)
  const monthDates = []; // one per Grand Total column
  for (const gtCol of grandTotalCols) {
    let found = false;
    // Search nearby columns and rows above for date serials
    for (let r = 0; r < headerIdx; r++) {
      // Check the Grand Total column and a few around it
      for (let c = gtCol - 1; c <= gtCol + 1; c++) {
        const v = data[r]?.[c];
        if (typeof v === "number" && v > 45000 && v < 47000) {
          monthDates.push(excelDateToMonth(v));
          found = true;
          break;
        }
      }
      if (found) break;
    }
    if (!found) {
      // Fallback: derive from sourceMonth + offset
      const baseDate = new Date(sourceMonth);
      const offset = monthDates.length;
      const d = new Date(
        baseDate.getFullYear(),
        baseDate.getMonth() + offset,
        1
      );
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      monthDates.push(`${y}-${m}-01`);
    }
  }

  // 5. Find cluster grouping row (typically 1-2 rows above header)
  // This row has cluster names (Marketplace B2C, Qcom, MT, etc.) above channel columns
  let clusterRow = null;
  for (let r = headerIdx - 1; r >= Math.max(0, headerIdx - 3); r--) {
    const row = data[r];
    const hasClusterName = row.some(
      (v) =>
        typeof v === "string" &&
        (v.includes("Marketplace") ||
          v === "Qcom" ||
          v === "MT" ||
          v === "GT" ||
          v === "Growth" ||
          v === "CSD" ||
          v === "Website")
    );
    if (hasClusterName) {
      clusterRow = r;
      break;
    }
  }

  // 6. Build channel info for each month block
  const monthBlocks = []; // { forecastMonth, channels: [{col, name, cluster}] }

  for (let mi = 0; mi < grandTotalCols.length; mi++) {
    const gtCol = grandTotalCols[mi];
    const nextGtCol =
      mi + 1 < grandTotalCols.length ? grandTotalCols[mi + 1] : headers.length;

    const channels = [];
    for (let c = gtCol + 1; c < nextGtCol; c++) {
      const channelName = String(headers[c] || "").trim();
      if (!channelName) continue;

      // Get cluster name from cluster row
      let clusterName = "Other";
      if (clusterRow !== null) {
        const clVal = String(data[clusterRow][c] || "").trim();
        if (clVal) clusterName = clVal;
      }

      // Some channels ARE their own cluster (MT, GT, Growth, CSD, Website)
      const selfClusterChannels = ["MT", "GT", "Growth", "CSD", "Website"];
      if (
        selfClusterChannels.includes(channelName) &&
        clusterName === "Other"
      ) {
        clusterName = channelName;
      }

      channels.push({ col: c, name: channelName, cluster: clusterName });
    }

    monthBlocks.push({
      forecastMonth: monthDates[mi],
      rollingOffset: mi,
      channels,
    });
  }

  // 7. Parse data rows
  const rows = [];
  const shortName = path
    .basename(filePath, ".xlsx")
    .replace(/^\d+\.\s*/, "")
    .trim();

  for (let r = headerIdx + 1; r < data.length; r++) {
    const row = data[r];
    const rawSku = row[masterSkuCol];
    if (!rawSku || String(rawSku).trim() === "") continue;

    const masterSku = normalizeSku(rawSku);
    const fgCode = fgCodeCol !== undefined ? normalizeFgCode(row[fgCodeCol]) : null;
    const productName = skuCols.productName !== undefined
      ? String(row[skuCols.productName] || "").trim()
      : "";
    const category = skuCols.category !== undefined
      ? String(row[skuCols.category] || "").trim()
      : "";
    const productCategory = skuCols.productCategory !== undefined
      ? String(row[skuCols.productCategory] || "").trim()
      : "";

    // Skip if this looks like a total/summary row
    if (
      masterSku === "Grand TotalG" ||
      productName.toLowerCase().includes("grand total")
    )
      continue;

    for (const block of monthBlocks) {
      for (const ch of block.channels) {
        const qty = Number(row[ch.col]) || 0;
        if (qty === 0) continue; // Skip zero-quantity entries to save space

        rows.push({
          source_file: shortName,
          source_month: sourceMonth,
          forecast_month: block.forecastMonth,
          rolling_offset: block.rollingOffset,
          version: 1,
          master_sku: masterSku,
          fg_code: fgCode,
          product_name: productName,
          category: category,
          product_category: productCategory,
          channel_name: ch.name,
          cluster_name: ch.cluster,
          quantity: Math.round(qty * 100) / 100, // round to 2 decimals
        });
      }
    }
  }

  return rows;
}

// ── Parse Consolidated sheet (for months missing from Channels) ───────────

function parseConsolidatedSheet(filePath, sourceMonth, existingMonths) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets["Consolidated"];
  if (!ws) return [];

  const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });

  // Find header row
  const headerIdx = data.findIndex(
    (r) =>
      r.some(
        (v) =>
          typeof v === "string" &&
          (v === "Product Name" || v === "Grand Total")
      ) &&
      r.some(
        (v) =>
          typeof v === "string" &&
          (v.includes("Marketplace") || v === "MT" || v === "Qcom")
      )
  );
  if (headerIdx < 0) return [];

  const headers = data[headerIdx];

  // SKU columns
  const skuCols = {};
  headers.forEach((v, i) => {
    const s = String(v).trim();
    if (s === "New Master SKU") skuCols.newMasterSku = i;
    else if (s === "Master SKU" && !skuCols.masterSku) skuCols.masterSku = i;
    else if (s === "Row Labels") skuCols.rowLabels = i;
    else if (s === "New FG Code") skuCols.newFgCode = i;
    else if (s === "FG Code" && !skuCols.fgCode) skuCols.fgCode = i;
    else if (s === "Product Name") skuCols.productName = i;
    else if (s === "Category") skuCols.category = i;
    else if (s === "Product Category") skuCols.productCategory = i;
  });

  const masterSkuCol =
    skuCols.newMasterSku ?? skuCols.masterSku ?? skuCols.rowLabels;
  const fgCodeCol = skuCols.newFgCode ?? skuCols.fgCode;
  if (masterSkuCol === undefined) return [];

  // Grand Total columns
  const grandTotalCols = [];
  headers.forEach((v, i) => {
    if (String(v).trim() === "Grand Total") grandTotalCols.push(i);
  });

  // Dates for each month block
  const monthDates = [];
  for (const gtCol of grandTotalCols) {
    let found = false;
    for (let r = 0; r < headerIdx; r++) {
      for (let c = gtCol - 1; c <= gtCol + 1; c++) {
        const v = data[r]?.[c];
        if (typeof v === "number" && v > 45000 && v < 47000) {
          monthDates.push(excelDateToMonth(v));
          found = true;
          break;
        }
      }
      if (found) break;
    }
    if (!found) {
      const baseDate = new Date(sourceMonth);
      const offset = monthDates.length;
      const d = new Date(baseDate.getFullYear(), baseDate.getMonth() + offset, 1);
      monthDates.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`);
    }
  }

  // Only process months NOT already in Channels data
  const monthBlocks = [];
  for (let mi = 0; mi < grandTotalCols.length; mi++) {
    if (existingMonths.has(monthDates[mi])) continue; // already have this from Channels

    const gtCol = grandTotalCols[mi];
    const nextGtCol = mi + 1 < grandTotalCols.length ? grandTotalCols[mi + 1] : headers.length;

    const clusters = [];
    for (let c = gtCol + 1; c < nextGtCol; c++) {
      const clusterName = String(headers[c] || "").trim();
      if (!clusterName) continue;
      clusters.push({ col: c, name: clusterName });
    }

    monthBlocks.push({ forecastMonth: monthDates[mi], rollingOffset: mi, clusters });
  }

  if (monthBlocks.length === 0) return [];

  // Parse data rows
  const rows = [];
  const shortName = path.basename(filePath, ".xlsx").replace(/^\d+\.\s*/, "").trim();

  for (let r = headerIdx + 1; r < data.length; r++) {
    const row = data[r];
    const rawSku = row[masterSkuCol];
    if (!rawSku || String(rawSku).trim() === "") continue;

    const masterSku = normalizeSku(rawSku);
    const fgCode = fgCodeCol !== undefined ? normalizeFgCode(row[fgCodeCol]) : null;
    const productName = skuCols.productName !== undefined ? String(row[skuCols.productName] || "").trim() : "";
    const category = skuCols.category !== undefined ? String(row[skuCols.category] || "").trim() : "";
    const productCategory = skuCols.productCategory !== undefined ? String(row[skuCols.productCategory] || "").trim() : "";

    if (masterSku === "Grand TotalG" || productName.toLowerCase().includes("grand total")) continue;

    for (const block of monthBlocks) {
      for (const cl of block.clusters) {
        const qty = Number(row[cl.col]) || 0;
        if (qty === 0) continue;

        rows.push({
          source_file: shortName,
          source_month: sourceMonth,
          forecast_month: block.forecastMonth,
          rolling_offset: block.rollingOffset,
          version: 1,
          master_sku: masterSku,
          fg_code: fgCode,
          product_name: productName,
          category: category,
          product_category: productCategory,
          channel_name: cl.name, // cluster as channel for consolidated-only data
          cluster_name: cl.name,
          quantity: Math.round(qty * 100) / 100,
        });
      }
    }
  }

  return rows;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("Historical Forecast Import");
  console.log("==========================\n");

  await createTables();
  console.log("");

  let totalRows = 0;

  for (const entry of FILE_MAP) {
    const filePath = path.join(REPO_DIR, entry.filename);

    if (!fs.existsSync(filePath)) {
      console.log(`⚠ File not found: ${entry.filename}`);
      continue;
    }

    console.log(
      `Processing: ${entry.filename} (source: ${entry.sourceMonth})`
    );

    let rows = parseFile(filePath, entry.sourceMonth);
    console.log(`  Channels: ${rows.length} rows`);

    // Check if Consolidated has months that Channels didn't cover
    const channelMonths = new Set(rows.map((r) => r.forecast_month));
    const consolRows = parseConsolidatedSheet(filePath, entry.sourceMonth, channelMonths);
    if (consolRows.length > 0) {
      console.log(`  Consolidated (extra months): ${consolRows.length} rows`);
      rows = rows.concat(consolRows);
    }
    console.log(`  Total: ${rows.length} rows`);

    if (rows.length === 0) continue;

    // Delete existing data for this source_month (idempotent)
    const { error: delErr } = await supabase
      .from("historical_forecast_data")
      .delete()
      .eq("source_month", entry.sourceMonth);

    if (delErr) {
      console.log(`  ⚠ Delete error: ${delErr.message}`);
    }

    // Insert in chunks of 500
    const CHUNK = 500;
    let inserted = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const { error: insErr } = await supabase
        .from("historical_forecast_data")
        .upsert(chunk, { onConflict: "source_month,forecast_month,master_sku,channel_name,version" });

      if (insErr) {
        console.log(
          `  ⚠ Insert error at chunk ${Math.floor(i / CHUNK)}: ${insErr.message}`
        );
      } else {
        inserted += chunk.length;
      }
    }

    console.log(`  ✓ Inserted ${inserted} rows`);

    // Record in files table
    const months = [...new Set(rows.map((r) => r.forecast_month))];
    await supabase.from("historical_forecast_files").upsert(
      {
        file_name: entry.filename,
        source_month: entry.sourceMonth,
        version: 1,
        months_covered: months.length,
        row_count: inserted,
        schema_version:
          new Date(entry.sourceMonth) >= new Date("2025-12-01")
            ? "v3_new_sku"
            : new Date(entry.sourceMonth) >= new Date("2025-09-01")
              ? "v2_active_status"
              : "v1_legacy",
      },
      { onConflict: "source_month,version" }
    );

    totalRows += inserted;
  }

  console.log(`\n==========================`);
  console.log(`Total rows imported: ${totalRows}`);

  // Quick verification
  const { count } = await supabase
    .from("historical_forecast_data")
    .select("*", { count: "exact", head: true });
  console.log(`Rows in Supabase: ${count}`);

  // Summary by source month
  const { data: files } = await supabase
    .from("historical_forecast_files")
    .select("source_month, row_count, months_covered")
    .order("source_month");
  if (files) {
    console.log("\nFile summary:");
    for (const f of files) {
      console.log(
        `  ${f.source_month} — ${f.row_count} rows, ${f.months_covered} months`
      );
    }
  }
}

main().catch(console.error);
