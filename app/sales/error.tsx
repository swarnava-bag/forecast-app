"use client";
// Route-segment error boundary for /sales and /sales/* — keeps a thrown client
// error from blanking the app, and surfaces the message so it can be fixed.
import { useEffect } from "react";
import Link from "next/link";

export default function SalesError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error("[/sales] boundary:", error); }, [error]);
  return (
    <div style={{ maxWidth: 720, margin: "64px auto", padding: 24 }}>
      <div className="rounded-xl p-5" style={{ background: "var(--atlas-surface)", border: "1px solid var(--atlas-line)" }}>
        <div className="text-lg font-bold" style={{ color: "var(--atlas-ink)" }}>Something went wrong on Sales</div>
        <p className="text-sm mt-1" style={{ color: "var(--atlas-ink-muted)" }}>The page hit an error. Try again — if it persists, share the message below.</p>
        <pre className="mt-3 p-3 rounded-lg text-xs overflow-auto" style={{ background: "var(--atlas-surface-soft)", border: "1px solid var(--atlas-line)", color: "var(--atlas-red)", whiteSpace: "pre-wrap" }}>{error?.message || String(error)}{error?.digest ? `\n\ndigest: ${error.digest}` : ""}</pre>
        <div className="flex gap-2 mt-4">
          <button onClick={reset} className="px-4 py-2 rounded-lg text-white text-sm" style={{ background: "var(--atlas-accent)", cursor: "pointer" }}>Try again</button>
          <Link href="/sales" className="px-4 py-2 rounded-lg text-sm" style={{ border: "1px solid var(--atlas-line)", color: "var(--atlas-ink-soft)", textDecoration: "none" }}>Reload Sales dashboard</Link>
        </div>
      </div>
    </div>
  );
}
