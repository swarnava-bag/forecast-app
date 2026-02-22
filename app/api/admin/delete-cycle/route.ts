import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";

// DELETE /api/admin/delete-cycle
// Body: { cycle_id: string, drafts_only?: boolean }
// drafts_only=true  → only wipe draft forecast_data, keep cycle intact
// drafts_only=false → delete all forecast_data + the cycle itself
export async function DELETE(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: profile } = await supabase
    .from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { cycle_id, drafts_only } = await request.json();
  if (!cycle_id) return NextResponse.json({ error: "cycle_id required" }, { status: 400 });

  const adminClient = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Get cycle info for audit
  const { data: cycle, error: cycleErr } = await adminClient
    .from("forecast_cycles").select("*").eq("id", cycle_id).single();
  if (cycleErr || !cycle)
    return NextResponse.json({ error: "Cycle not found" }, { status: 404 });

  if (drafts_only) {
    // Clear only draft forecast_data, keep cycle and published rows
    const { error } = await adminClient
      .from("forecast_data").delete()
      .eq("cycle_id", cycle_id)
      .eq("status", "draft");

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    await adminClient.from("audit_log").insert({
      user_id: user.id,
      user_email: user.email,
      action: "clear_drafts",
      table_name: "forecast_data",
      record_id: cycle_id,
      old_values: { forecast_month: cycle.forecast_month, version: cycle.version },
      new_values: { action: "cleared all draft forecast data" },
    });

    return NextResponse.json({ success: true, action: "drafts_cleared" });
  }

  // Full delete: all forecast_data first, then the cycle
  const { error: dataErr } = await adminClient
    .from("forecast_data").delete().eq("cycle_id", cycle_id);
  if (dataErr) return NextResponse.json({ error: dataErr.message }, { status: 500 });

  const { error: delCycleErr } = await adminClient
    .from("forecast_cycles").delete().eq("id", cycle_id);
  if (delCycleErr) return NextResponse.json({ error: delCycleErr.message }, { status: 500 });

  await adminClient.from("audit_log").insert({
    user_id: user.id,
    user_email: user.email,
    action: "delete_cycle",
    table_name: "forecast_cycles",
    record_id: cycle_id,
    old_values: { forecast_month: cycle.forecast_month, version: cycle.version, status: cycle.status },
    new_values: { deleted: true },
  });

  return NextResponse.json({ success: true, action: "cycle_deleted" });
}
