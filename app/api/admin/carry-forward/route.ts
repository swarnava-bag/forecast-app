import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";

// POST /api/admin/carry-forward
// Body: { target_cycle_id: string, preview?: boolean }
// If preview=true: returns counts without writing anything
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: profile } = await supabase
    .from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { target_cycle_id, preview } = await request.json();
  if (!target_cycle_id) return NextResponse.json({ error: "target_cycle_id required" }, { status: 400 });

  const adminClient = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // 1. Get target cycle
  const { data: targetCycle, error: targetErr } = await adminClient
    .from("forecast_cycles").select("*").eq("id", target_cycle_id).single();
  if (targetErr || !targetCycle)
    return NextResponse.json({ error: "Target cycle not found" }, { status: 404 });

  if (targetCycle.status === "published")
    return NextResponse.json({ error: "Cannot carry forward into a published cycle" }, { status: 400 });

  // 2. Find source: same month, previous version, published
  let sourceCycle: any = null;

  if (targetCycle.version > 1) {
    const { data } = await adminClient
      .from("forecast_cycles").select("*")
      .eq("forecast_month", targetCycle.forecast_month)
      .eq("version", targetCycle.version - 1)
      .eq("status", "published")
      .single();
    sourceCycle = data;
  }

  // 3. Fallback: latest published cycle from any other month
  if (!sourceCycle) {
    const { data } = await adminClient
      .from("forecast_cycles").select("*")
      .eq("status", "published")
      .neq("id", target_cycle_id)
      .order("published_at", { ascending: false })
      .limit(1)
      .single();
    sourceCycle = data;
  }

  if (!sourceCycle)
    return NextResponse.json({ error: "No published cycle found to carry forward from" }, { status: 404 });

  // 4. Get source published forecast data (paginated)
  const PAGE = 1000;
  let sourceData: any[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await adminClient
      .from("forecast_data")
      .select("sku_id, channel_id, quantity, forecast_month")
      .eq("cycle_id", sourceCycle.id)
      .eq("status", "published")
      .range(from, from + PAGE - 1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) break;
    sourceData = sourceData.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  if (sourceData.length === 0)
    return NextResponse.json({ error: "Source cycle has no published data" }, { status: 404 });

  // 5. Get existing data in target cycle (all statuses, paginated)
  let existingData: any[] = [];
  from = 0;
  while (true) {
    const { data } = await adminClient
      .from("forecast_data")
      .select("sku_id, channel_id, forecast_month")
      .eq("cycle_id", target_cycle_id)
      .range(from, from + PAGE - 1);
    if (!data || data.length === 0) break;
    existingData = existingData.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  const existingKeys = new Set(
    (existingData || []).map((r: any) => `${r.sku_id}::${r.channel_id}::${r.forecast_month}`)
  );

  // 6. Filter: skip rows already in target
  const toInsert = sourceData.filter((r) => {
    const key = `${r.sku_id}::${r.channel_id}::${r.forecast_month}`;
    return !existingKeys.has(key);
  });

  const skipped = sourceData.length - toInsert.length;

  // If preview mode, return counts without writing
  if (preview) {
    return NextResponse.json({
      source_cycle: {
        id: sourceCycle.id,
        forecast_month: sourceCycle.forecast_month,
        version: sourceCycle.version,
        published_at: sourceCycle.published_at,
      },
      total_in_source: sourceData.length,
      will_copy: toInsert.length,
      will_skip: skipped,
    });
  }

  if (toInsert.length === 0) {
    return NextResponse.json({
      copied: 0, skipped,
      source_cycle: sourceCycle,
      message: "All records already exist in the target cycle. Nothing new to carry forward.",
    });
  }

  // 7. Insert in batches of 500
  const now = new Date().toISOString();
  const inserts = toInsert.map((r) => ({
    sku_id: r.sku_id,
    channel_id: r.channel_id,
    quantity: r.quantity,
    forecast_month: r.forecast_month,
    cycle_id: target_cycle_id,
    version: targetCycle.version,
    status: "draft",
    uploaded_by: user.id,
    uploaded_at: now,
    updated_at: now,
  }));

  let copied = 0;
  for (let i = 0; i < inserts.length; i += 500) {
    const batch = inserts.slice(i, i + 500);
    const { error } = await adminClient.from("forecast_data").insert(batch);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    copied += batch.length;
  }

  // 8. Audit log
  await adminClient.from("audit_log").insert({
    user_id: user.id,
    user_email: user.email,
    action: "carry_forward",
    table_name: "forecast_data",
    record_id: target_cycle_id,
    old_values: { source_cycle_id: sourceCycle.id, source_version: sourceCycle.version },
    new_values: { records_copied: copied, records_skipped: skipped },
  });

  return NextResponse.json({ copied, skipped, source_cycle: sourceCycle });
}
