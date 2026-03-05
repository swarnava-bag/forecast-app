"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Profile = { id: string; email: string; full_name: string; role: string };
type Channel = { id: string; name: string; cluster_id: string };
type Cluster = { id: string; name: string };

const ROLES = [
  { value: "admin", label: "Admin", desc: "Full access to everything including admin tools.", color: "amber" },
  { value: "head_kam", label: "Head KAM", desc: "Can edit forecasts for all channels in assigned clusters.", color: "purple" },
  { value: "channel_kam", label: "Channel KAM", desc: "Can upload/edit forecasts for assigned channels only.", color: "blue" },
  { value: "supply_chain", label: "Supply Chain", desc: "Read-only access. Can download consolidated forecasts.", color: "green" },
  { value: "viewer", label: "Viewer", desc: "Read-only access to dashboards and reports.", color: "gray" },
];

const roleColors: Record<string, string> = {
  admin: "bg-amber-500/20 text-amber-400",
  head_kam: "bg-purple-500/20 text-purple-400",
  channel_kam: "bg-blue-500/20 text-blue-400",
  supply_chain: "bg-green-500/20 text-green-400",
  viewer: "bg-gray-700 text-gray-300",
};

const roleLabels: Record<string, string> = {
  admin: "Admin",
  head_kam: "Head KAM",
  channel_kam: "Channel KAM",
  supply_chain: "Supply Chain",
  viewer: "Viewer",
};

export default function ManageUsersPage() {
  const [users, setUsers] = useState<Profile[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedUser, setSelectedUser] = useState<Profile | null>(null);
  const [selectedRole, setSelectedRole] = useState("");
  const [userChannels, setUserChannels] = useState<string[]>([]);
  const [userClusters, setUserClusters] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const supabase = createClient();

  useEffect(() => {
    loadData();
    supabase.auth.getUser().then(({ data }) => setCurrentUserId(data.user?.id ?? null));
  }, []);

  async function loadData() {
    setLoading(true);
    const { data: allUsers } = await supabase.from("profiles").select("*").order("created_at");
    const { data: allChannels } = await supabase.from("channels").select("id, name, cluster_id").order("display_order");
    const { data: allClusters } = await supabase.from("clusters").select("id, name").order("display_order");

    if (allUsers) setUsers(allUsers);
    if (allChannels) setChannels(allChannels);
    if (allClusters) setClusters(allClusters);
    setLoading(false);
  }

  async function selectUser(user: Profile) {
    setSelectedUser(user);
    setSelectedRole(user.role);
    setError(null);

    const { data: uc } = await supabase.from("user_channels").select("channel_id").eq("user_id", user.id);
    setUserChannels(uc ? uc.map((x: any) => x.channel_id) : []);

    const { data: ucl } = await supabase.from("user_clusters").select("cluster_id").eq("user_id", user.id);
    setUserClusters(ucl ? ucl.map((x: any) => x.cluster_id) : []);
  }

  function toggleChannel(id: string) {
    setUserChannels((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }

  function toggleCluster(id: string) {
    setUserClusters((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }

  async function handleSave() {
    if (!selectedUser) return;
    setSaving(true);
    setError(null);

    // Update role
    const { error: roleError } = await supabase
      .from("profiles")
      .update({ role: selectedRole, updated_at: new Date().toISOString() })
      .eq("id", selectedUser.id);

    if (roleError) { setError(roleError.message); setSaving(false); return; }

    // Update channel assignments (for channel_kam)
    await supabase.from("user_channels").delete().eq("user_id", selectedUser.id);
    if (selectedRole === "channel_kam" && userChannels.length > 0) {
      const inserts = userChannels.map((cid) => ({ user_id: selectedUser.id, channel_id: cid }));
      const { error: chErr } = await supabase.from("user_channels").insert(inserts);
      if (chErr) { setError(chErr.message); setSaving(false); return; }
    }

    // Update cluster assignments (for head_kam)
    await supabase.from("user_clusters").delete().eq("user_id", selectedUser.id);
    if (selectedRole === "head_kam" && userClusters.length > 0) {
      const inserts = userClusters.map((cid) => ({ user_id: selectedUser.id, cluster_id: cid }));
      const { error: clErr } = await supabase.from("user_clusters").insert(inserts);
      if (clErr) { setError(clErr.message); setSaving(false); return; }
    }

    // Audit log
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from("audit_log").insert({
      user_id: user?.id,
      user_email: user?.email,
      action: "update_user_role",
      table_name: "profiles",
      record_id: selectedUser.id,
      old_values: { role: selectedUser.role },
      new_values: { role: selectedRole, channels: userChannels, clusters: userClusters },
    });

    setSuccessMsg(`${selectedUser.full_name || selectedUser.email}'s settings saved!`);
    setSaving(false);
    loadData();
    setTimeout(() => setSuccessMsg(null), 3000);
  }

  async function handleDelete() {
    if (!selectedUser) return;
    if (selectedUser.id === currentUserId) return;
    setDeleting(true);
    setError(null);
    setShowDeleteConfirm(false);

    const res = await fetch("/api/admin/delete-user", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: selectedUser.id }),
    });

    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "Failed to delete user");
      setDeleting(false);
      return;
    }

    setSuccessMsg(`${selectedUser.full_name || selectedUser.email} has been deleted.`);
    setSelectedUser(null);
    setDeleting(false);
    loadData();
    setTimeout(() => setSuccessMsg(null), 3000);
  }

  if (loading) {
    return <div className="flex items-center justify-center h-64"><p className="text-gray-400">Loading users...</p></div>;
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-bold">Manage Users</h2>
        <p className="text-sm text-gray-400 mt-1">{users.length} registered users</p>
      </div>

      {successMsg && (
        <div className="mb-4 p-3 bg-green-900/50 border border-green-500 rounded-lg">
          <p className="text-green-300 text-sm">{successMsg}</p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* User List */}
        <div className="lg:col-span-1">
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-gray-800">
              <p className="text-sm font-medium text-gray-300">All Users</p>
            </div>
            <div className="divide-y divide-gray-800/50 max-h-[600px] overflow-y-auto">
              {users.map((user) => (
                <button key={user.id} onClick={() => selectUser(user)}
                  className={`w-full text-left px-4 py-3 transition ${selectedUser?.id === user.id ? "bg-amber-500/10 border-l-2 border-amber-500" : "hover:bg-gray-800/50 border-l-2 border-transparent"}`}>
                  <p className="text-sm font-medium text-white">{user.full_name || "No name"}</p>
                  <p className="text-xs text-gray-500">{user.email}</p>
                  <span className={`inline-block mt-1 px-2 py-0.5 rounded text-xs font-medium ${roleColors[user.role] || roleColors.viewer}`}>
                    {roleLabels[user.role] || user.role}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* User Settings */}
        <div className="lg:col-span-2">
          {selectedUser ? (
            <div className="bg-gray-900 border border-gray-800 rounded-xl">
              <div className="p-6 border-b border-gray-800 flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-lg font-semibold">{selectedUser.full_name || "No name"}</h3>
                  <p className="text-sm text-gray-400">{selectedUser.email}</p>
                </div>
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  disabled={deleting || selectedUser.id === currentUserId}
                  title={selectedUser.id === currentUserId ? "You cannot delete your own account" : undefined}
                  className="flex-shrink-0 px-3 py-1.5 text-sm font-medium text-red-400 border border-red-500/50 rounded-lg hover:bg-red-500/10 disabled:opacity-50 disabled:cursor-not-allowed transition"
                >
                  {deleting ? "Deleting..." : "Delete User"}
                </button>
              </div>
              <div className="p-6 space-y-6">
                {/* Role Selection */}
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-3">Role</label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {ROLES.map((role) => (
                      <button key={role.value} onClick={() => setSelectedRole(role.value)}
                        className={`text-left px-4 py-3 rounded-lg text-sm transition border ${selectedRole === role.value
                          ? `${roleColors[role.value]} ring-1 ring-current border-current/30`
                          : "bg-gray-800 text-gray-400 hover:bg-gray-700 border-transparent"}`}>
                        <p className="font-medium">{role.label}</p>
                        <p className="text-xs mt-0.5 opacity-70">{role.desc}</p>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Cluster Assignments (Head KAM) */}
                {selectedRole === "head_kam" && (
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-3">Assigned Clusters</label>
                    <p className="text-xs text-gray-500 mb-3">Head KAM can edit forecasts for all channels within these clusters.</p>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {clusters.map((cl) => (
                        <button key={cl.id} onClick={() => toggleCluster(cl.id)}
                          className={`px-3 py-2 rounded-lg text-sm text-left transition ${userClusters.includes(cl.id) ? "bg-purple-500/20 text-purple-300 ring-1 ring-purple-500" : "bg-gray-800 text-gray-400 hover:bg-gray-700"}`}>
                          {userClusters.includes(cl.id) ? "✓ " : ""}{cl.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Channel Assignments (Channel KAM) */}
                {selectedRole === "channel_kam" && (
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-3">Assigned Channels</label>
                    <p className="text-xs text-gray-500 mb-3">Channel KAM can upload/edit forecasts for these channels only.</p>
                    {clusters.map((cl) => {
                      const clChannels = channels.filter((ch) => ch.cluster_id === cl.id);
                      if (clChannels.length === 0) return null;
                      return (
                        <div key={cl.id} className="mb-4">
                          <p className="text-xs text-gray-500 mb-2 uppercase tracking-wider">{cl.name}</p>
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                            {clChannels.map((ch) => (
                              <button key={ch.id} onClick={() => toggleChannel(ch.id)}
                                className={`px-3 py-2 rounded-lg text-sm text-left transition ${userChannels.includes(ch.id) ? "bg-blue-500/20 text-blue-300 ring-1 ring-blue-500" : "bg-gray-800 text-gray-400 hover:bg-gray-700"}`}>
                                {userChannels.includes(ch.id) ? "✓ " : ""}{ch.name}
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {error && (
                  <div className="p-3 bg-red-900/50 border border-red-500 rounded-lg">
                    <p className="text-red-300 text-sm">{error}</p>
                  </div>
                )}

                <button onClick={handleSave} disabled={saving}
                  className="px-6 py-2.5 bg-amber-500 text-black font-semibold rounded-lg hover:bg-amber-400 disabled:opacity-50 transition">
                  {saving ? "Saving..." : "Save Changes"}
                </button>
              </div>
            </div>
          ) : (
            <div className="bg-gray-900 border border-gray-800 rounded-xl flex items-center justify-center h-64">
              <p className="text-gray-500">Select a user from the list to manage their settings.</p>
            </div>
          )}
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && selectedUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-sm mx-4 shadow-xl">
            <h3 className="text-lg font-semibold text-white mb-2">Delete User?</h3>
            <p className="text-sm text-gray-400 mb-1">
              You are about to permanently delete:
            </p>
            <p className="text-sm font-medium text-white mb-1">{selectedUser.full_name || "No name"}</p>
            <p className="text-xs text-gray-500 mb-5">{selectedUser.email}</p>
            <p className="text-xs text-red-400 mb-6">
              This will remove the user from all channels, clusters, and authentication. This action cannot be undone.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="flex-1 px-4 py-2 text-sm font-medium text-gray-300 bg-gray-800 rounded-lg hover:bg-gray-700 transition"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                className="flex-1 px-4 py-2 text-sm font-semibold text-white bg-red-600 rounded-lg hover:bg-red-500 transition"
              >
                Yes, Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}