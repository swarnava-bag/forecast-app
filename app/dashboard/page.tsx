"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";

type Profile = {
  id: string;
  email: string;
  full_name: string;
  role: string;
};

type Channel = {
  name: string;
  clusters: { name: string } | null;
};

export default function DashboardPage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [unassignedUsers, setUnassignedUsers] = useState<{id: string; email: string; full_name: string}[]>([]);
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    async function loadData() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        router.push("/login");
        return;
      }

      const { data: profileData } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", user.id)
        .single();

      setProfile(profileData);

      // Check for unassigned users (admin only)
      if (profileData?.role === "admin") {
        const { data: viewers } = await supabase
          .from("profiles")
          .select("id, email, full_name")
          .eq("role", "viewer");
        if (viewers) setUnassignedUsers(viewers);
      }

      const { data: userChannels } = await supabase
        .from("user_channels")
        .select("channel_id, channels(name, clusters(name))")
        .eq("user_id", user.id);

      if (userChannels) {
        const mapped = userChannels.map((uc: any) => uc.channels);
        setChannels(mapped);
      }

      setLoading(false);
    }

    loadData();
  }, []);

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-gray-950 flex items-center justify-center">
        <p className="text-gray-400">Loading...</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      {/* Top Navigation Bar */}
      <nav className="border-b border-gray-800 bg-gray-900">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <h1 className="text-lg font-bold text-white">
              Demand Planning Module - Yogabars
            </h1>
            <div className="hidden md:flex items-center gap-4">
              <a href="/dashboard" className="text-sm text-amber-400 font-medium">
                Dashboard
              </a>
              <a href="/upload" className="text-sm text-gray-400 hover:text-white transition">
                Upload
              </a>
              <a href="/channels" className="text-sm text-gray-400 hover:text-white transition">
                Forecast View
              </a>
              <a href="/combo-converter" className="text-sm text-gray-400 hover:text-white transition">
                Combo → Singles
              </a>
              {profile?.role === "admin" && (
                <a href="/admin" className="text-sm text-gray-400 hover:text-white transition">
                  Admin
                </a>
              )}
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <p className="text-sm text-white">{profile?.full_name}</p>
              <p className="text-xs text-gray-500">{profile?.role === "head_kam" ? "Head KAM" : profile?.role === "channel_kam" ? "Channel KAM" : profile?.role === "supply_chain" ? "Supply Chain" : profile?.role ? profile.role.charAt(0).toUpperCase() + profile.role.slice(1) : ""}</p>
            </div>
            <button
              onClick={handleSignOut}
              className="px-4 py-2 text-sm bg-gray-800 text-gray-300 rounded-lg hover:bg-gray-700 transition"
            >
              Sign Out
            </button>
          </div>
        </div>
      </nav>

      {/* Dashboard Content */}
      <div className="max-w-7xl mx-auto px-6 py-8">
        <h2 className="text-2xl font-bold mb-6">Dashboard</h2>

        {/* Unassigned Users Banner */}
        {profile?.role === "admin" && unassignedUsers.length > 0 && (
          <div className="mb-6 p-4 bg-red-900/30 border border-red-500/50 rounded-xl">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-sm font-semibold text-red-300 mb-1">
                  {unassignedUsers.length} new user{unassignedUsers.length > 1 ? "s" : ""} need role assignment
                </h3>
                <div className="flex flex-wrap gap-2 mt-2">
                  {unassignedUsers.map((u) => (
                    <span key={u.id} className="px-2 py-1 bg-red-900/50 rounded text-xs text-red-200">
                      {u.full_name || u.email}
                    </span>
                  ))}
                </div>
              </div>
              <a
                href="/admin/users"
                className="px-4 py-2 text-sm bg-red-500 text-white font-semibold rounded-lg hover:bg-red-400 transition whitespace-nowrap"
              >
                {"Assign Roles \u2192"}
              </a>
            </div>
          </div>
        )}

        {/* Profile Card */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
            <p className="text-sm text-gray-400 mb-1">Name</p>
            <p className="text-lg font-semibold">{profile?.full_name}</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
            <p className="text-sm text-gray-400 mb-1">Email</p>
            <p className="text-lg font-semibold">{profile?.email}</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
            <p className="text-sm text-gray-400 mb-1">Role</p>
            <span
              className={`inline-block px-3 py-1 rounded-full text-sm font-medium ${
                profile?.role === "admin"
                  ? "bg-amber-500/20 text-amber-400"
                  : profile?.role === "head_kam"
                  ? "bg-purple-500/20 text-purple-400"
                  : profile?.role === "channel_kam"
                  ? "bg-blue-500/20 text-blue-400"
                  : profile?.role === "supply_chain"
                  ? "bg-green-500/20 text-green-400"
                  : "bg-gray-700 text-gray-300"
              }`}
            >
              {profile?.role === "head_kam" ? "Head KAM" : profile?.role === "channel_kam" ? "Channel KAM" : profile?.role === "supply_chain" ? "Supply Chain" : profile?.role ? profile.role.charAt(0).toUpperCase() + profile.role.slice(1) : ""}
            </span>
          </div>
        </div>

        {/* Assigned Channels */}
        {channels.length > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-8">
            <h3 className="text-lg font-semibold mb-4">Your Assigned Channels</h3>
            <div className="flex flex-wrap gap-2">
              {channels.map((ch) => (
                <span
                  key={ch.name}
                  className="px-3 py-1.5 bg-gray-800 rounded-lg text-sm"
                >
                  {ch.name}
                  <span className="text-gray-500 ml-1 text-xs">
                    ({ch.clusters?.name})
                  </span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Quick Actions */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <a
            href="/upload"
            className="bg-gray-900 border border-gray-800 rounded-xl p-6 hover:border-amber-500/50 transition group"
          >
            <h3 className="text-lg font-semibold mb-2 group-hover:text-amber-400 transition">
              Upload Forecast
            </h3>
            <p className="text-sm text-gray-400">
              Upload your channel forecast Excel file for the current month.
            </p>
          </a>
          <a
            href="/channels"
            className="bg-gray-900 border border-gray-800 rounded-xl p-6 hover:border-amber-500/50 transition group"
          >
            <h3 className="text-lg font-semibold mb-2 group-hover:text-amber-400 transition">
              Forecast View
            </h3>
            <p className="text-sm text-gray-400">
              Analyse forecasts by channel, cluster, SKU, and pivot views.
            </p>
          </a>
        </div>

        {/* Admin Section */}
        {profile?.role === "admin" && (
          <div className="mt-8">
            <h3 className="text-lg font-semibold mb-4 text-amber-400">
              Admin Tools
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <a
                href="/admin/users"
                className="bg-gray-900 border border-gray-800 rounded-xl p-5 hover:border-amber-500/50 transition"
              >
                <p className="font-medium mb-1">Manage Users</p>
                <p className="text-xs text-gray-500">
                  Assign roles and channels to team members
                </p>
              </a>
              <a
                href="/admin/skus"
                className="bg-gray-900 border border-gray-800 rounded-xl p-5 hover:border-amber-500/50 transition"
              >
                <p className="font-medium mb-1">SKU Master</p>
                <p className="text-xs text-gray-500">
                  Add, edit, or deactivate products
                </p>
              </a>
              <a
                href="/admin/channels"
                className="bg-gray-900 border border-gray-800 rounded-xl p-5 hover:border-amber-500/50 transition"
              >
                <p className="font-medium mb-1">Channels & Clusters</p>
                <p className="text-xs text-gray-500">
                  Manage channel-cluster mapping
                </p>
              </a>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}