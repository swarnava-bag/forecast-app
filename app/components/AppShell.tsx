"use client";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

/* ── Types ─────────────────────────────────────────────────────────────── */
type Profile = {
  id: string;
  email: string;
  full_name: string;
  role: string;
};

/* ── Nav config ────────────────────────────────────────────────────────── */
type NavItem = { href: string; label: string; icon: () => React.JSX.Element; comingSoon?: boolean };

const MAIN_NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: DashboardIcon },
  { href: "/upload", label: "Upload", icon: UploadIcon },
  { href: "/channels", label: "Forecast View", icon: ChannelsIcon },
  { href: "/combo-converter", label: "Combo \u2192 Singles", icon: ComboIcon },
  { href: "/master-data", label: "Master Data", icon: MasterDataIcon },
  { href: "/analytics", label: "Analytics", icon: AnalyticsIcon },
  { href: "#", label: "Base Data", icon: BaseDataIcon, comingSoon: true },
  { href: "#", label: "Forecast Check", icon: ForecastCheckIcon, comingSoon: true },
];

const ADMIN_NAV = [
  { href: "/admin/skus", label: "SKU Master", icon: AdminSkuIcon },
  { href: "/admin/sku-channels", label: "SKU-Channel Map", icon: AdminMapIcon },
  { href: "/admin/users", label: "Manage Users", icon: AdminUsersIcon },
  { href: "/admin/channels", label: "Channels & Clusters", icon: AdminChannelsIcon },
  { href: "/admin/cycles", label: "Forecast Cycles", icon: AdminCyclesIcon },
  { href: "/admin/fg-codes", label: "Combo Mapper", icon: AdminComboIcon },
  { href: "/admin/bulk-upload", label: "Bulk Upload", icon: AdminBulkUploadIcon },
  { href: "/admin/audit", label: "Audit Log", icon: AdminAuditIcon },
  { href: "/admin/workflow", label: "Workflow Guide", icon: AdminWorkflowIcon },
];

/* ── Component ─────────────────────────────────────────────────────────── */
export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createClient();

  const [profile, setProfile] = useState<Profile | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [unassignedCount, setUnassignedCount] = useState(0);
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    loadProfile();
    const saved = localStorage.getItem("atlas_sidebar_collapsed");
    if (saved === "true") setCollapsed(true);

    // Restore theme preference
    const savedTheme = localStorage.getItem("atlas_theme");
    if (savedTheme === "dark" || savedTheme === "light") {
      setTheme(savedTheme);
      document.documentElement.setAttribute("data-theme", savedTheme);
    } else {
      // Default to light
      document.documentElement.setAttribute("data-theme", "light");
    }
  }, []);

  useEffect(() => {
    // Close mobile sidebar on nav
    setSidebarOpen(false);
  }, [pathname]);

  async function loadProfile() {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase
      .from("profiles")
      .select("id, email, full_name, role")
      .eq("id", user.id)
      .single();
    if (data) setProfile(data);

    // Unassigned user count for admin badge
    if (data?.role === "admin") {
      const { data: viewers } = await supabase
        .from("profiles")
        .select("id")
        .eq("role", "viewer");
      setUnassignedCount(viewers?.length || 0);
    }
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push("/");
    router.refresh();
  }

  const isAdmin = profile?.role === "admin";
  const isAdminPage = pathname.startsWith("/admin");

  function toggleCollapse() {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem("atlas_sidebar_collapsed", String(next));
  }

  function toggleTheme() {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    localStorage.setItem("atlas_theme", next);
    document.documentElement.setAttribute("data-theme", next);
  }

  function roleLabel(role: string) {
    return (
      ({
        admin: "Admin",
        head_kam: "Head KAM",
        channel_kam: "KAM",
        supply_chain: "Supply Chain",
        viewer: "Viewer",
      } as Record<string, string>)[role] || role
    );
  }

  return (
    <div className={`atlas-shell ${collapsed ? "atlas-shell--collapsed" : ""}`}>
      {/* ── Mobile overlay ──────────────────────────────────────────── */}
      {sidebarOpen && (
        <div
          className="atlas-sidebar-overlay"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* ── Sidebar ────────────────────────────────────────────────── */}
      <aside className={`atlas-sidebar ${sidebarOpen ? "open" : ""}`}>
        {/* Brand + collapse toggle */}
        <div className="atlas-sidebar-brand">
          <div className="flex items-center justify-between">
            <Link href="/dashboard" className="flex items-center gap-2.5 no-underline atlas-sidebar-brand-link">
              <span className="atlas-sidebar-brand-yb">Yogabars</span>
              <span className="atlas-sidebar-brand-sep" />
              <span className="atlas-sidebar-brand-atlas atlas-wordmark-mark">
                atlas
              </span>
            </Link>
            <button
              onClick={toggleCollapse}
              className="atlas-sidebar-collapse-btn"
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Main nav */}
        <nav className="atlas-sidebar-nav">
          <div className="atlas-sidebar-section-label">Navigation</div>
          {MAIN_NAV.map((item) => {
            if (item.comingSoon) {
              return (
                <div
                  key={item.label}
                  className="atlas-sidebar-link opacity-50 cursor-default"
                  title="Coming Soon"
                >
                  <item.icon />
                  <span>{item.label}</span>
                  <span className="ml-auto text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400">Soon</span>
                </div>
              );
            }
            const active =
              pathname === item.href ||
              (item.href !== "/dashboard" && pathname.startsWith(item.href));
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`atlas-sidebar-link ${active ? "active" : ""}`}
              >
                <item.icon />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Admin section */}
        {isAdmin && (
          <nav className="atlas-sidebar-nav">
            <div className="atlas-sidebar-section-label">
              Admin
              {unassignedCount > 0 && (
                <span className="atlas-sidebar-badge">{unassignedCount}</span>
              )}
            </div>
            {ADMIN_NAV.map((item) => {
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`atlas-sidebar-link ${active ? "active" : ""}`}
                >
                  <item.icon />
                  <span>{item.label}</span>
                  {item.label === "Manage Users" && unassignedCount > 0 && (
                    <span className="atlas-sidebar-badge">{unassignedCount}</span>
                  )}
                </Link>
              );
            })}
          </nav>
        )}

        {/* User footer */}
        {profile && (
          <div className="atlas-sidebar-footer">
            <div className="atlas-sidebar-user">
              <div className="atlas-sidebar-avatar">
                {(profile.full_name || profile.email)[0]?.toUpperCase()}
              </div>
              <div className="atlas-sidebar-user-info">
                <span className="atlas-sidebar-user-name">
                  {profile.full_name || profile.email}
                </span>
                <span className="atlas-sidebar-user-role">
                  {roleLabel(profile.role)}
                </span>
              </div>
            </div>
            <button onClick={handleSignOut} className="atlas-sidebar-signout">
              <SignOutIcon />
            </button>
          </div>
        )}
      </aside>

      {/* ── Main area ──────────────────────────────────────────────── */}
      <div className="atlas-main">
        {/* Topbar */}
        <header className="atlas-topbar">
          {/* Mobile hamburger */}
          <button
            className="atlas-topbar-hamburger"
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>

          {/* Breadcrumb */}
          <div className="atlas-topbar-breadcrumb">
            {getBreadcrumb(pathname)}
          </div>

          {/* Right side */}
          <div className="atlas-topbar-right">
            {/* Theme toggle */}
            <button
              onClick={toggleTheme}
              className="atlas-theme-toggle"
              title={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
            >
              {theme === "light" ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
                </svg>
              )}
            </button>

            {profile && (
              <div className="atlas-topbar-user">
                <span className="atlas-topbar-user-name">{profile.full_name}</span>
                <span className="atlas-topbar-user-role">{roleLabel(profile.role)}</span>
              </div>
            )}
          </div>
        </header>

        {/* Page content */}
        <main className="atlas-page">{children}</main>
      </div>
    </div>
  );
}

/* ── Breadcrumb helper ─────────────────────────────────────────────────── */
function getBreadcrumb(pathname: string) {
  const LABELS: Record<string, string> = {
    "/dashboard": "Dashboard",
    "/upload": "Upload Forecasts",
    "/channels": "Forecast View",
    "/combo-converter": "Combo \u2192 Singles",
    "/master-data": "Master Data",
    "/admin/skus": "Admin / SKU Master",
    "/admin/sku-channels": "Admin / SKU-Channel Map",
    "/admin/users": "Admin / Manage Users",
    "/admin/channels": "Admin / Channels & Clusters",
    "/admin/cycles": "Admin / Forecast Cycles",
    "/admin/fg-codes": "Admin / Combo Mapper",
    "/admin/audit": "Admin / Audit Log",
    "/admin/workflow": "Admin / Workflow Guide",
    "/analytics": "Forecast Analytics",
  };

  return (
    <span className="font-mono" style={{ fontSize: "var(--text-xs)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
      {LABELS[pathname] || pathname.replace(/\//g, " / ").trim()}
    </span>
  );
}

/* ── Icons (inline SVG, Lucide-style) ──────────────────────────────────── */
function DashboardIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}
function UploadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}
function ChannelsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  );
}
function ComboIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 3 21 3 21 8" /><line x1="4" y1="20" x2="21" y2="3" />
      <polyline points="21 16 21 21 16 21" /><line x1="15" y1="15" x2="21" y2="21" />
      <line x1="4" y1="4" x2="9" y2="9" />
    </svg>
  );
}
function MasterDataIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  );
}
function BaseDataIcon() {
  return (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>);
}
function ForecastCheckIcon() {
  return (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>);
}
function AnalyticsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v18h18" /><path d="M18 17V9" /><path d="M13 17V5" /><path d="M8 17v-3" />
    </svg>
  );
}
function SignOutIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

/* ── Admin icons ───────────────────────────────────────────────────────── */
function AdminSkuIcon() {
  return (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/></svg>);
}
function AdminMapIcon() {
  return (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4z"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>);
}
function AdminUsersIcon() {
  return (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>);
}
function AdminChannelsIcon() {
  return (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>);
}
function AdminCyclesIcon() {
  return (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>);
}
function AdminComboIcon() {
  return (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>);
}
function AdminBulkUploadIcon() {
  return (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>);
}
function AdminAuditIcon() {
  return (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>);
}
function AdminWorkflowIcon() {
  return (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>);
}
