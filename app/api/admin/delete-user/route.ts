import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";

export async function DELETE(request: Request) {
  const supabase = await createClient();

  // Verify the caller is authenticated and is an admin
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: callerProfile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (!callerProfile || callerProfile.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { userId } = await request.json();
  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }

  // Prevent self-deletion
  if (userId === user.id) {
    return NextResponse.json({ error: "You cannot delete your own account" }, { status: 400 });
  }

  // Use admin client (service role) for ALL deletions — bypasses RLS
  const adminClient = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Clean up related table data first (order matters for FK constraints)
  const { error: ucErr } = await adminClient.from("user_channels").delete().eq("user_id", userId);
  if (ucErr) console.error("user_channels delete error:", ucErr.message);

  const { error: uclErr } = await adminClient.from("user_clusters").delete().eq("user_id", userId);
  if (uclErr) console.error("user_clusters delete error:", uclErr.message);

  const { error: profileErr } = await adminClient.from("profiles").delete().eq("id", userId);
  if (profileErr) {
    return NextResponse.json({ error: `Failed to delete profile: ${profileErr.message}` }, { status: 500 });
  }

  // Delete from auth.users (service role required)
  const { error: deleteError } = await adminClient.auth.admin.deleteUser(userId);

  // Ignore "not found" — means auth user was already deleted manually from Supabase dashboard
  if (deleteError && !deleteError.message.toLowerCase().includes("not found")) {
    return NextResponse.json({ error: `Failed to delete auth user: ${deleteError.message}` }, { status: 500 });
  }

  // Audit log (best-effort, don't fail on this)
  await supabase.from("audit_log").insert({
    user_id: user.id,
    user_email: user.email,
    action: "delete_user",
    table_name: "profiles",
    record_id: userId,
    old_values: { deleted_by: user.email },
    new_values: null,
  });

  return NextResponse.json({ success: true });
}
