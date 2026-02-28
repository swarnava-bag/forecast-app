export default function WorkflowGuidePage() {
  return (
    <div className="max-w-5xl space-y-10">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold text-white">Platform Workflow Guide</h2>
        <p className="text-sm text-gray-400 mt-1">
          End-to-end walkthrough of the Demand Planning Module — roles, cycles, uploads, and downloads.
        </p>
      </div>

      {/* ── 1. USER ROLES ─────────────────────────────────────────────────── */}
      <Section title="1. User Roles & Permissions">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="text-left py-2 pr-6 text-gray-400 font-medium">Role</th>
                <th className="text-left py-2 pr-6 text-gray-400 font-medium">Scope</th>
                <th className="text-left py-2 text-gray-400 font-medium">Key Capabilities</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              <RoleRow
                badge="Admin"
                color="amber"
                scope="Full system"
                caps="Create & manage cycles · Manage SKUs, channels, clusters · Assign user roles · View all submissions · Download forecasts · Carry-forward data · View audit log"
              />
              <RoleRow
                badge="Head KAM"
                color="purple"
                scope="Assigned clusters"
                caps="Upload & edit forecasts for all channels in assigned clusters · View KAM tracker · Download forecasts"
              />
              <RoleRow
                badge="Channel KAM"
                color="blue"
                scope="Assigned channels"
                caps="Upload & edit forecasts for assigned channels only · View own channel data · Download forecasts"
              />
              <RoleRow
                badge="Supply Chain"
                color="green"
                scope="Read-only"
                caps="View dashboard · Download consolidated forecasts · No upload or edit access"
              />
              <RoleRow
                badge="Viewer"
                color="gray"
                scope="Read-only"
                caps="View dashboard and reports only · No upload, edit, or download access"
              />
            </tbody>
          </table>
        </div>
        <InfoBox>
          New sign-ups default to <strong className="text-white">Viewer</strong>. Assign the correct role under <strong className="text-white">Admin → Manage Users</strong> before the user can contribute to a cycle.
        </InfoBox>
      </Section>

      {/* ── 2. ADMIN SETUP CHECKLIST ──────────────────────────────────────── */}
      <Section title="2. Admin Setup Checklist">
        <p className="text-sm text-gray-400 mb-4">
          Complete these steps once — or whenever the catalogue changes — before opening a new forecast cycle.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[
            { step: "A", label: "Load SKU Master", desc: "Add or bulk-upload all active product SKUs under Admin → SKU Master.", href: "/admin/skus" },
            { step: "B", label: "Configure Channels & Clusters", desc: "Create cluster groups and assign channels to them.", href: "/admin/channels" },
            { step: "C", label: "Map SKUs to Channels", desc: "Mark which SKUs are valid for each channel in the SKU-Channel mapping matrix.", href: "/admin/sku-channels" },
            { step: "D", label: "Assign User Roles", desc: "Set each user's role and bind Channel KAMs to channels, Head KAMs to clusters.", href: "/admin/users" },
            { step: "E", label: "Upload Combo Mapper (if needed)", desc: "Upload a combo → singles conversion template in the Combo Converter page.", href: "/combo-converter" },
          ].map(({ step, label, desc, href }) => (
            <a
              key={step}
              href={href}
              className="flex gap-4 p-4 rounded-xl bg-gray-900 border border-gray-800 hover:border-amber-500/30 hover:bg-amber-500/5 transition group"
            >
              <span className="flex-shrink-0 w-7 h-7 rounded-full bg-amber-500/20 text-amber-400 text-xs font-bold flex items-center justify-center">
                {step}
              </span>
              <div>
                <p className="text-sm font-medium text-white group-hover:text-amber-400 transition">{label}</p>
                <p className="text-xs text-gray-500 mt-0.5">{desc}</p>
              </div>
            </a>
          ))}
        </div>
      </Section>

      {/* ── 3. FORECAST CYCLE LIFECYCLE ───────────────────────────────────── */}
      <Section title="3. Forecast Cycle Lifecycle">
        <p className="text-sm text-gray-400 mb-6">
          Every forecast round is tracked through a <strong className="text-white">Cycle</strong> with a month, version number, and status.
          The lifecycle below applies to each version.
        </p>

        <div className="space-y-3">
          {[
            {
              status: "Create", color: "gray",
              who: "Admin",
              what: "Create a new cycle for a forecast month (e.g. March 2026 V1). Set a submission deadline.",
              where: "Admin → Forecast Cycles",
            },
            {
              status: "Open", color: "green",
              who: "Admin",
              what: "Opens the cycle for uploads. KAMs can now submit their channel forecasts.",
              where: "Admin → Forecast Cycles → Open",
            },
            {
              status: "Upload", color: "blue",
              who: "KAMs (Channel & Head)",
              what: "KAMs upload forecast data for their assigned channels. Data is saved as Draft. Uploads can be re-done — later upload overwrites earlier draft.",
              where: "/upload",
            },
            {
              status: "Review", color: "purple",
              who: "Admin / Head KAM",
              what: "Monitor submission progress on the Dashboard. Use Forecast View (/channels) to inspect or inline-edit values.",
              where: "/dashboard, /channels",
            },
            {
              status: "Lock", color: "amber",
              who: "Admin",
              what: "Closes the cycle to new uploads. Carry-forward or manual edits still possible. No KAM uploads accepted.",
              where: "Admin → Forecast Cycles → Lock",
            },
            {
              status: "Publish", color: "amber",
              who: "Admin",
              what: "Marks all draft rows as Published. The cycle becomes the canonical forecast. Used as the base for the next version's carry-forward.",
              where: "Admin → Forecast Cycles → Publish",
            },
            {
              status: "New Version", color: "gray",
              who: "Admin",
              what: "Create V2 (or V3, etc.) for the same month. Use Carry-Forward to seed it with published V1 data. Open for revisions.",
              where: "Admin → Forecast Cycles",
            },
          ].map(({ status, color, who, what, where }, i) => (
            <div key={status} className="flex gap-4">
              <div className="flex flex-col items-center">
                <StatusDot color={color} />
                {i < 6 && <div className="w-px flex-1 bg-gray-800 my-1" />}
              </div>
              <div className="pb-4 flex-1">
                <div className="flex items-center gap-3 mb-1">
                  <span className={`px-2 py-0.5 rounded text-xs font-semibold ${statusColors[color]}`}>{status}</span>
                  <span className="text-xs text-gray-500">{who}</span>
                </div>
                <p className="text-sm text-gray-300">{what}</p>
                <p className="text-xs text-gray-600 mt-1">{where}</p>
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* ── 4. UPLOAD WORKFLOW ────────────────────────────────────────────── */}
      <Section title="4. Upload Workflow">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Standard Upload */}
          <div className="space-y-3">
            <p className="text-sm font-semibold text-white">Standard (Single Products)</p>
            <Steps steps={[
              "Go to Upload page and select an open cycle.",
              "Choose Single Products upload.",
              "Upload an Excel file with columns: SKU, Channel, M1 Qty, M2 Qty, M3 Qty.",
              "System validates: SKU exists and is active · Channel is active · SKU mapped to channel · Quantities are numeric.",
              "Review the preview table — valid rows are green, invalid are red with the reason shown.",
              "Click Save. Draft rows are written to the database.",
              "Re-uploading for the same channel/cycle replaces previous draft.",
            ]} />
          </div>

          {/* Combo Upload */}
          <div className="space-y-3">
            <p className="text-sm font-semibold text-white">Combo Products Upload</p>
            <Steps steps={[
              "Go to Upload page and select an open cycle.",
              "Choose Combo Products upload.",
              "Upload an Excel file with combo SKUs and quantities.",
              "System uses the active Combo Mapper template to explode each combo into its constituent single SKUs.",
              "Unmatched combos are flagged — review them in the Combo Converter page to update the mapper.",
              "Review the singles preview table, then Save.",
              "Combo originals are also stored separately (downloadable from Dashboard).",
            ]} />
          </div>
        </div>

        <InfoBox>
          <strong className="text-white">Validation rules:</strong> A row is only saved if the SKU is in the SKU Master, the channel is active, and the SKU-Channel mapping exists. Fix failures in Admin → SKU-Channel Map before re-uploading.
        </InfoBox>
      </Section>

      {/* ── 5. COMBO CONVERTER ────────────────────────────────────────────── */}
      <Section title="5. Combo Converter & Mapper">
        <p className="text-sm text-gray-400 mb-4">
          Channels that sell combo packs require a conversion step before their data can be stored as single-SKU forecasts.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {[
            { n: "1", t: "Upload Mapper Template", d: "An admin uploads a mapper Excel that defines which combo SKUs map to which single SKUs (and in what ratio). Done once per combo range change." },
            { n: "2", t: "Run Conversion", d: "On the Combo Converter page, upload a combo forecast file. The system matches each combo to the mapper and outputs a singles table." },
            { n: "3", t: "Review & Upload", d: "Check the Singles tab output. Unmatched rows are clearly flagged. Download the template or go to Upload page to push the converted data to the cycle." },
          ].map(({ n, t, d }) => (
            <div key={n} className="p-4 rounded-xl bg-gray-900 border border-gray-800">
              <span className="w-6 h-6 rounded-full bg-amber-500/20 text-amber-400 text-xs font-bold flex items-center justify-center mb-3">{n}</span>
              <p className="text-sm font-medium text-white mb-1">{t}</p>
              <p className="text-xs text-gray-500">{d}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* ── 6. DASHBOARD FEATURES ─────────────────────────────────────────── */}
      <Section title="6. Dashboard Features">
        <div className="space-y-4">
          {[
            {
              title: "Channel Submission Status",
              who: "All roles",
              desc: "Grid showing every channel (grouped by cluster) with colour-coded submission status for the selected cycle. Green = data received, Red = pending. Shows last upload time and total quantity.",
            },
            {
              title: "KAM Tracker",
              who: "Admin, Head KAM, Supply Chain",
              desc: "Per-KAM progress bar showing how many of their assigned channels have been submitted. Sorted: pending KAMs first. Includes last upload timestamp and Done / Partial / Pending badge.",
            },
            {
              title: "Version Comparison",
              who: "Admin, Head KAM",
              desc: "Select two versions of the same forecast month. Dashboard computes per-channel net change, % change, and overall Forecast Fidelity — how stable the forecast is across revisions.",
            },
            {
              title: "Deadline Countdown",
              who: "All roles",
              desc: "Live countdown to the cycle deadline. Turns amber when ≤5 days away, red when ≤2 days or overdue.",
            },
            {
              title: "Download Buttons",
              who: "Admin, Head KAM, Channel KAM, Supply Chain",
              desc: "Download Forecast (full SKU × Channel × Month Excel) and Download Combos (original combo-level data) are accessible from the Dashboard for the selected cycle.",
            },
          ].map(({ title, who, desc }) => (
            <div key={title} className="flex gap-4 p-4 rounded-xl bg-gray-900 border border-gray-800">
              <div className="flex-1">
                <div className="flex items-center gap-3 mb-1">
                  <p className="text-sm font-semibold text-white">{title}</p>
                  <span className="text-xs text-gray-500 italic">{who}</span>
                </div>
                <p className="text-sm text-gray-400">{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* ── 7. FORECAST VIEW ──────────────────────────────────────────────── */}
      <Section title="7. Forecast View (/channels)">
        <p className="text-sm text-gray-400 mb-4">
          Six analysis views — all filterable by category, search term, and cluster.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {[
            { view: "Original", desc: "Channel → SKU rows with M1, M2, M3 columns. Raw uploaded data." },
            { view: "Channel View", desc: "Quantities aggregated per channel across all SKUs." },
            { view: "Cluster View", desc: "Quantities aggregated per cluster (sum of channels in cluster)." },
            { view: "SKU View", desc: "Quantities aggregated per SKU across all channels." },
            { view: "SKU × Channel", desc: "Pivot: SKU rows × Channel columns. Inline-editable by admins." },
            { view: "SKU × Cluster", desc: "Pivot: SKU rows × Cluster columns. SUMIFS aggregation." },
          ].map(({ view, desc }) => (
            <div key={view} className="p-3 rounded-lg bg-gray-900 border border-gray-800">
              <p className="text-xs font-semibold text-amber-400 mb-1">{view}</p>
              <p className="text-xs text-gray-400">{desc}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* ── 8. DOWNLOAD OUTPUT ────────────────────────────────────────────── */}
      <Section title="8. Download Forecast — Excel Output">
        <p className="text-sm text-gray-400 mb-4">
          The downloaded <code className="text-amber-400 bg-gray-900 px-1 rounded text-xs">.xlsx</code> file contains two sheets:
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="p-4 rounded-xl bg-gray-900 border border-gray-800">
            <p className="text-sm font-semibold text-white mb-2">Channels Sheet</p>
            <ul className="text-xs text-gray-400 space-y-1.5">
              <li><span className="text-gray-500 mr-1">—</span>Rows: One per active SKU</li>
              <li><span className="text-gray-500 mr-1">—</span>Columns: SKU metadata (New Master SKU, FG Code, Product Name…) then one column per Channel per Month (M1, M2, M3)</li>
              <li><span className="text-gray-500 mr-1">—</span>Grand Total column per month (SUM formula)</li>
              <li><span className="text-gray-500 mr-1">—</span>Subtotal row (SUBTOTAL formula — filter-aware)</li>
              <li><span className="text-gray-500 mr-1">—</span>Missing forecasts shown as 0</li>
            </ul>
          </div>
          <div className="p-4 rounded-xl bg-gray-900 border border-gray-800">
            <p className="text-sm font-semibold text-white mb-2">Consolidated Sheet</p>
            <ul className="text-xs text-gray-400 space-y-1.5">
              <li><span className="text-gray-500 mr-1">—</span>Rows: One per active SKU</li>
              <li><span className="text-gray-500 mr-1">—</span>Columns: SKU metadata then one column per Cluster per Month</li>
              <li><span className="text-gray-500 mr-1">—</span>Values pulled via SUMIFS cross-sheet formulas from the Channels sheet</li>
              <li><span className="text-gray-500 mr-1">—</span>Subtotal row (SUBTOTAL formula)</li>
              <li><span className="text-gray-500 mr-1">—</span>File named: Forecast_MonthYear_V{"{version}"}.xlsx</li>
            </ul>
          </div>
        </div>
      </Section>

      {/* ── 9. CARRY-FORWARD ──────────────────────────────────────────────── */}
      <Section title="9. Carry-Forward">
        <p className="text-sm text-gray-400 mb-4">
          When creating a new version of the same forecast month, use <strong className="text-white">Carry-Forward</strong> to seed it with the previous published version's data — so KAMs only need to revise what changed.
        </p>
        <Steps steps={[
          "Create V2 cycle for the same month (Admin → Forecast Cycles).",
          "Click Carry-Forward on V2. Choose source: previous published version or another cycle.",
          "Preview mode shows how many rows will be copied before you confirm.",
          "Confirm — published rows from the source are copied into V2 as drafts.",
          "Open V2. KAMs can now overwrite channels they need to revise.",
          "Unchanged channels carry forward automatically — no re-upload needed.",
        ]} />
      </Section>

      {/* ── 10. AUDIT LOG ─────────────────────────────────────────────────── */}
      <Section title="10. Audit Log">
        <p className="text-sm text-gray-400">
          Every create, update, and delete action across the platform is recorded in the Audit Log (Admin → Audit Log).
          Each entry captures the acting user, timestamp, table affected, and old → new values.
          Actions include: <span className="text-gray-300">update_user_role · carry_forward · delete_cycle · bulk_upload · discontinue_sku · reactivate_sku</span> and more.
        </p>
        <InfoBox>
          The Audit Log shows the last 100 entries. It is read-only and cannot be modified.
        </InfoBox>
      </Section>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-base font-semibold text-white mb-4 pb-2 border-b border-gray-800">{title}</h3>
      {children}
    </div>
  );
}

function InfoBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 p-3 rounded-lg bg-amber-500/5 border border-amber-500/20 text-xs text-amber-200/70">
      {children}
    </div>
  );
}

function Steps({ steps }: { steps: string[] }) {
  return (
    <ol className="space-y-2">
      {steps.map((s, i) => (
        <li key={i} className="flex gap-3 text-sm text-gray-400">
          <span className="flex-shrink-0 w-5 h-5 rounded-full bg-gray-800 text-gray-500 text-xs font-medium flex items-center justify-center mt-0.5">
            {i + 1}
          </span>
          {s}
        </li>
      ))}
    </ol>
  );
}

function RoleRow({ badge, color, scope, caps }: { badge: string; color: string; scope: string; caps: string }) {
  const colors: Record<string, string> = {
    amber: "bg-amber-500/20 text-amber-400",
    purple: "bg-purple-500/20 text-purple-400",
    blue: "bg-blue-500/20 text-blue-400",
    green: "bg-green-500/20 text-green-400",
    gray: "bg-gray-700 text-gray-300",
  };
  return (
    <tr>
      <td className="py-2.5 pr-6">
        <span className={`px-2 py-0.5 rounded text-xs font-semibold ${colors[color]}`}>{badge}</span>
      </td>
      <td className="py-2.5 pr-6 text-sm text-gray-400 whitespace-nowrap">{scope}</td>
      <td className="py-2.5 text-sm text-gray-400">{caps}</td>
    </tr>
  );
}

function StatusDot({ color }: { color: string }) {
  const colors: Record<string, string> = {
    green: "bg-green-500",
    blue: "bg-blue-500",
    purple: "bg-purple-500",
    amber: "bg-amber-500",
    gray: "bg-gray-600",
  };
  return <div className={`w-3 h-3 rounded-full flex-shrink-0 mt-1 ${colors[color] || "bg-gray-600"}`} />;
}

const statusColors: Record<string, string> = {
  green: "bg-green-500/15 text-green-400",
  blue: "bg-blue-500/15 text-blue-400",
  purple: "bg-purple-500/15 text-purple-400",
  amber: "bg-amber-500/15 text-amber-400",
  gray: "bg-gray-700 text-gray-400",
};
