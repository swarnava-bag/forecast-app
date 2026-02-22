"use client";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";


export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [unassignedCount, setUnassignedCount] = useState(0);
  const supabase = createClient();

  useEffect(() => {
    checkUnassigned();
  }, [pathname]); // Re-check when navigating between admin pages

  async function checkUnassigned() {
    const { data: viewers } = await supabase
      .from("profiles")
      .select("id")
      .eq("role", "viewer");
    setUnassignedCount(viewers?.length || 0);
  }

  const adminLinks = [
    { href: "/admin/skus", label: "SKU Master", badge: 0 },
    { href: "/admin/sku-channels", label: "SKU-Channel Map", badge: 0 },
    { href: "/admin/users", label: "Manage Users", badge: unassignedCount },
    { href: "/admin/channels", label: "Channels & Clusters", badge: 0 },
    { href: "/admin/cycles", label: "Forecast Cycles", badge: 0 },
    { href: "/admin/audit", label: "Audit Log", badge: 0 },
  ];

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* Top Navigation Bar */}
      <nav className="border-b border-gray-800 bg-gray-900">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/dashboard" className="text-lg font-bold text-white">
              Demand Planning Module - Yogabars
            </Link>
            <div className="hidden md:flex items-center gap-4">
              <Link href="/dashboard" className="text-sm text-gray-400 hover:text-white transition">Dashboard</Link>
              <Link href="/upload" className="text-sm text-gray-400 hover:text-white transition">Upload</Link>
              <Link href="/channels" className="text-sm text-gray-400 hover:text-white transition">Forecast View</Link>
              <Link href="/admin/skus" className="text-sm text-amber-400 font-medium">
                Admin
                {unassignedCount > 0 && (
                  <span className="ml-1.5 px-1.5 py-0.5 text-[10px] bg-red-500 text-white rounded-full font-bold">
                    {unassignedCount}
                  </span>
                )}
              </Link>
            </div>
          </div>
        </div>
      </nav>

      <div className="flex">
        {/* Admin Sidebar */}
        <aside className="w-56 min-h-[calc(100vh-65px)] border-r border-gray-800 bg-gray-900/50 p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wider font-semibold mb-4 px-3">Admin Panel</p>
          <div className="space-y-1">
            {adminLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={`flex items-center justify-between px-3 py-2 rounded-lg text-sm transition ${
                  pathname === link.href
                    ? "bg-amber-500/10 text-amber-400 font-medium"
                    : "text-gray-400 hover:text-white hover:bg-gray-800"
                }`}
              >
                <span>{link.label}</span>
                {link.badge > 0 && (
                  <span className="px-1.5 py-0.5 text-[10px] bg-red-500 text-white rounded-full font-bold">
                    {link.badge}
                  </span>
                )}
              </Link>
            ))}
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 p-8">{children}</main>
      </div>
    </div>
  );
}