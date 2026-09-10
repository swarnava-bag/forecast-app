import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";

// Unambiguous alphabet — no O/0, I/l/1 — so the password can be read out over
// chat or spoken aloud without confusion.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

function generateTempPassword(length = 14) {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return `Yb-${out}`;
}

export async function POST(request: Request) {
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

  // The password is always generated here — never accepted from the client —
  // so an admin cannot set a chosen password on someone else's account.
  const tempPassword = generateTempPassword();

  const adminClient = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: updated, error: updateError } = await adminClient.auth.admin.updateUserById(
    userId,
    { password: tempPassword }
  );

  if (updateError) {
    return NextResponse.json(
      { error: `Failed to reset password: ${updateError.message}` },
      { status: 500 }
    );
  }

  // Audit log (best-effort). The temp password itself is never recorded.
  await supabase.from("audit_log").insert({
    user_id: user.id,
    user_email: user.email,
    action: "reset_user_password",
    table_name: "auth.users",
    record_id: userId,
    old_values: null,
    new_values: { reset_by: user.email, target_email: updated?.user?.email },
  });

  return NextResponse.json({
    success: true,
    email: updated?.user?.email,
    tempPassword,
  });
}
