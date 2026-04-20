import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const month = formData.get("month") as string | null;
    const authToken = formData.get("auth_token") as string | null;

    if (!file || !month) {
      return NextResponse.json(
        { error: "file and month are required" },
        { status: 400 }
      );
    }

    // Auth — admin only
    if (!authToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const {
      data: { user },
    } = await supabase.auth.getUser(authToken);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();
    if (!profile || profile.role !== "admin") {
      return NextResponse.json({ error: "Admin only" }, { status: 403 });
    }

    // Parse Excel
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws || !ws["!ref"]) {
      return NextResponse.json({ error: "Empty file" }, { status: 400 });
    }

    const range = XLSX.utils.decode_range(ws["!ref"]);

    // Find Master SKU and Quantity columns
    let skuCol = -1,
      qtyCol = -1;
    for (let r = 0; r <= Math.min(5, range.e.r); r++) {
      for (let c = 0; c <= range.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (!cell) continue;
        const v = String(cell.v).toLowerCase().trim();
        if (
          v.includes("master sku") ||
          v.includes("new master") ||
          v === "sku"
        )
          skuCol = c;
        if (
          v === "qty" ||
          v === "quantity" ||
          v.includes("supply plan") ||
          v.includes("supply")
        )
          qtyCol = c;
      }
      if (skuCol >= 0 && qtyCol >= 0) break;
    }

    if (skuCol < 0 || qtyCol < 0) {
      return NextResponse.json(
        {
          error:
            "Could not find Master SKU and Quantity columns. Expected headers like 'Master SKU' and 'Quantity' or 'Supply Plan'.",
        },
        { status: 400 }
      );
    }

    // Find data start row (row after headers)
    let dataStart = 0;
    for (let r = 0; r <= Math.min(5, range.e.r); r++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c: skuCol })];
      if (cell) {
        const v = String(cell.v).toLowerCase().trim();
        if (
          v.includes("master") ||
          v.includes("sku") ||
          v === "sku"
        ) {
          dataStart = r + 1;
          break;
        }
      }
    }

    const rows: { master_sku: string; quantity: number }[] = [];
    const warnings: string[] = [];

    for (let r = dataStart; r <= range.e.r; r++) {
      const skuCell = ws[XLSX.utils.encode_cell({ r, c: skuCol })];
      const qtyCell = ws[XLSX.utils.encode_cell({ r, c: qtyCol })];
      if (!skuCell || !skuCell.v) continue;

      const masterSku = String(skuCell.v).trim();
      const qty = qtyCell ? Math.round(Number(qtyCell.v) || 0) : 0;
      if (!masterSku) continue;

      rows.push({ master_sku: masterSku, quantity: qty });
    }

    if (rows.length === 0) {
      return NextResponse.json(
        { error: "No valid rows found" },
        { status: 400 }
      );
    }

    // Delete existing supply plan for this month
    await supabase.from("supply_plan").delete().eq("month", month);

    // Insert in batches
    const BATCH = 500;
    let inserted = 0;
    const now = new Date().toISOString();

    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH).map((r) => ({
        month,
        master_sku: r.master_sku,
        quantity: r.quantity,
        uploaded_by: user.id,
        uploaded_at: now,
      }));

      const { error: insErr } = await supabase
        .from("supply_plan")
        .insert(batch);

      if (insErr) {
        return NextResponse.json(
          { error: `Insert failed: ${insErr.message}` },
          { status: 500 }
        );
      }
      inserted += batch.length;
    }

    return NextResponse.json({
      success: true,
      month,
      rows_inserted: inserted,
      warnings,
    });
  } catch (err: any) {
    console.error("Supply plan upload error:", err);
    return NextResponse.json(
      { error: err.message || "Internal error" },
      { status: 500 }
    );
  }
}
