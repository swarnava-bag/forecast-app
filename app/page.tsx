"use client";
import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";

/* ── Inline SVG icons (Lucide style) ──────────────────────────────────── */

function EyeIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <line x1="2" x2="22" y1="2" y2="22" />
    </svg>
  );
}

/* ── Live toolkit / Roadmap ───────────────────────────────────────────── */

const TOOLKIT = [
  { num: "01", name: "Forecast collation", desc: "three-month rolling, per channel", status: "live" as const },
  { num: "02", name: "Combo → Singles", desc: "resolve combo SKUs to components", status: "live" as const },
  { num: "03", name: "SKU & FG management", desc: "master data admin, bulk import", status: "live" as const },
  { num: "04", name: "MRP change tracker", desc: "track FG code changes over time", status: "soon" as const },
  { num: "05", name: "Demand analytics", desc: "forecast accuracy & trend insights", status: "soon" as const },
];

/* ── SVG network illustration ────────────────────────────────────────── */

function NetworkGraph() {
  return (
    <svg
      viewBox="0 0 400 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="w-full"
      style={{ opacity: 0.5, maxWidth: 420 }}
    >
      {/* Edges */}
      <line x1="40" y1="60" x2="120" y2="30" stroke="var(--atlas-accent)" strokeWidth="1" strokeOpacity="0.3" />
      <line x1="40" y1="60" x2="120" y2="90" stroke="var(--atlas-accent)" strokeWidth="1" strokeOpacity="0.3" />
      <line x1="120" y1="30" x2="200" y2="50" stroke="var(--atlas-accent)" strokeWidth="1" strokeOpacity="0.3" />
      <line x1="120" y1="90" x2="200" y2="50" stroke="var(--atlas-accent)" strokeWidth="1" strokeOpacity="0.3" />
      <line x1="120" y1="90" x2="200" y2="100" stroke="var(--atlas-accent)" strokeWidth="1" strokeOpacity="0.3" />
      <line x1="200" y1="50" x2="280" y2="25" stroke="var(--atlas-accent)" strokeWidth="1" strokeOpacity="0.3" />
      <line x1="200" y1="50" x2="280" y2="70" stroke="var(--atlas-accent)" strokeWidth="1" strokeOpacity="0.3" />
      <line x1="200" y1="100" x2="280" y2="70" stroke="var(--atlas-accent)" strokeWidth="1" strokeOpacity="0.3" />
      <line x1="280" y1="25" x2="360" y2="55" stroke="var(--atlas-accent)" strokeWidth="1" strokeOpacity="0.3" />
      <line x1="280" y1="70" x2="360" y2="55" stroke="var(--atlas-accent)" strokeWidth="1" strokeOpacity="0.3" />

      {/* Animated pulse paths */}
      <circle r="3" fill="var(--atlas-accent)" opacity="0.7">
        <animateMotion dur="3s" repeatCount="indefinite" path="M40,60 L120,30 L200,50 L280,25 L360,55" />
      </circle>
      <circle r="2.5" fill="var(--atlas-accent)" opacity="0.5">
        <animateMotion dur="4s" repeatCount="indefinite" path="M40,60 L120,90 L200,100 L280,70 L360,55" begin="1s" />
      </circle>
      <circle r="2" fill="var(--atlas-accent)" opacity="0.4">
        <animateMotion dur="3.5s" repeatCount="indefinite" path="M40,60 L120,90 L200,50 L280,70 L360,55" begin="0.5s" />
      </circle>

      {/* Nodes */}
      {[
        [40, 60], [120, 30], [120, 90], [200, 50], [200, 100],
        [280, 25], [280, 70], [360, 55],
      ].map(([cx, cy], i) => (
        <g key={i}>
          <circle cx={cx} cy={cy} r="5" fill="var(--atlas-surface)" stroke="var(--atlas-accent)" strokeWidth="1.5" />
          <circle cx={cx} cy={cy} r="2" fill="var(--atlas-accent)" opacity="0.6">
            <animate attributeName="r" values="1.5;2.5;1.5" dur={`${2 + i * 0.3}s`} repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.4;0.8;0.4" dur={`${2 + i * 0.3}s`} repeatCount="indefinite" />
          </circle>
        </g>
      ))}

      {/* Labels */}
      <text x="40" y="80" textAnchor="middle" fill="var(--atlas-ink-muted)" fontSize="8" fontFamily="var(--font-mono)">Upload</text>
      <text x="200" y="22" textAnchor="middle" fill="var(--atlas-ink-muted)" fontSize="8" fontFamily="var(--font-mono)">Process</text>
      <text x="360" y="78" textAnchor="middle" fill="var(--atlas-ink-muted)" fontSize="8" fontFamily="var(--font-mono)">Output</text>
    </svg>
  );
}

/* ── Page ──────────────────────────────────────────────────────────────── */

export default function AtlasLanding() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetSent, setResetSent] = useState(false);
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [resetLoading, setResetLoading] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [checkingAuth, setCheckingAuth] = useState(true);
  const router = useRouter();

  // Check if already logged in → redirect to dashboard
  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        router.replace("/dashboard");
      } else {
        setCheckingAuth(false);
      }
    });
  }, [router]);

  // Load remembered email + theme preference on mount
  useEffect(() => {
    const saved = localStorage.getItem("atlas_remember_email");
    if (saved) {
      setEmail(saved);
      setRememberMe(true);
    }
    const savedTheme = localStorage.getItem("atlas_login_theme");
    if (savedTheme === "dark" || savedTheme === "light") {
      setTheme(savedTheme);
    }
  }, []);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    // Persist or clear remembered email
    if (rememberMe) {
      localStorage.setItem("atlas_remember_email", email);
    } else {
      localStorage.removeItem("atlas_remember_email");
    }

    const supabase = createClient();
    const { error: loginError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (loginError) {
      setError(loginError.message);
      setLoading(false);
    } else {
      router.push("/dashboard");
      router.refresh();
    }
  }

  async function handleForgotPassword(e: React.FormEvent) {
    e.preventDefault();
    setResetLoading(true);
    setError(null);

    const supabase = createClient();
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || window.location.origin;
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(
      resetEmail,
      { redirectTo: `${siteUrl}/auth?next=/reset-password` }
    );

    if (resetError) {
      setError(resetError.message);
    } else {
      setResetSent(true);
    }
    setResetLoading(false);
  }

  if (checkingAuth) {
    return (
      <main className="min-h-screen grid place-items-center" style={{ background: "var(--atlas-bg)" }}>
        <div className="font-mono text-sm" style={{ color: "var(--atlas-ink-muted)" }}>Loading...</div>
      </main>
    );
  }

  return (
    <main
      data-theme={theme}
      className="relative min-h-screen overflow-hidden"
      style={{ background: "var(--atlas-bg)", color: "var(--atlas-ink)" }}
    >
      {/* Background mesh */}
      <div className="atlas-mesh" />

      {/* ── Topbar ─────────────────────────────────────────────────────── */}
      <header
        className="relative z-10 flex items-center justify-between"
        style={{ padding: "22px 44px" }}
      >
        <div className="flex items-center gap-2.5">
          <span
            className="font-mono uppercase"
            style={{
              fontSize: "14px",
              letterSpacing: "0.04em",
              color: "var(--atlas-ink-muted)",
            }}
          >
            Yogabars
          </span>
          <span
            style={{
              width: "1px",
              height: "20px",
              background: "var(--atlas-line)",
            }}
          />
          <span
            className="font-display atlas-wordmark-mark"
            style={{ fontSize: "28px", color: "var(--atlas-ink)" }}
          >
            atlas
          </span>
        </div>

        {/* Theme toggle — segmented pill: Light | Dark */}
        <div
          className="flex font-mono uppercase"
          style={{
            fontSize: "10.5px",
            letterSpacing: "0.08em",
            border: "1px solid var(--atlas-line)",
            borderRadius: "var(--radius-full)",
            overflow: "hidden",
          }}
        >
          <button
            type="button"
            onClick={() => { setTheme("light"); localStorage.setItem("atlas_login_theme", "light"); }}
            className="flex items-center gap-1.5"
            style={{
              padding: "6px 14px",
              cursor: "pointer",
              border: "none",
              transition: "all var(--duration-fast) var(--ease-standard)",
              background: theme === "light" ? "var(--atlas-accent)" : "var(--atlas-surface)",
              color: theme === "light" ? "#fff" : "var(--atlas-ink-muted)",
            }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="5"/>
              <line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
              <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
            </svg>
          </button>
          <button
            type="button"
            onClick={() => { setTheme("dark"); localStorage.setItem("atlas_login_theme", "dark"); }}
            className="flex items-center gap-1.5"
            style={{
              padding: "6px 14px",
              cursor: "pointer",
              border: "none",
              borderLeft: "1px solid var(--atlas-line)",
              transition: "all var(--duration-fast) var(--ease-standard)",
              background: theme === "dark" ? "var(--atlas-accent)" : "var(--atlas-surface)",
              color: theme === "dark" ? "#fff" : "var(--atlas-ink-muted)",
            }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
            </svg>
          </button>
        </div>
      </header>

      {/* ── Two-column composition ─────────────────────────────────────── */}
      <div
        className="relative z-10 w-full grid place-items-center"
        style={{ minHeight: "calc(100vh - 120px)", padding: "0 44px" }}
      >
        <div
          className="atlas-composition w-full grid items-center gap-12 lg:gap-[72px]"
          style={{ maxWidth: "1120px" }}
        >
          {/* ── Left pane: Editorial ──────────────────────────────────── */}
          <div className="py-3">
            {/* Eyebrow */}
            <div className="atlas-eyebrow mb-6">
              Demand planning
            </div>

            {/* Headline */}
            <h1
              className="font-display"
              style={{
                fontSize: "clamp(40px, 5vw, 68px)",
                lineHeight: "0.98",
                letterSpacing: "var(--tracking-display)",
                color: "var(--atlas-ink)",
                margin: "0 0 20px",
                fontWeight: 400,
              }}
            >
              Every channel, every SKU,{" "}
              <em style={{ color: "var(--atlas-accent)" }}>in one place</em>.
            </h1>

            {/* Lede */}
            <p
              style={{
                fontSize: "15.5px",
                lineHeight: "1.6",
                color: "var(--atlas-ink-soft)",
                maxWidth: "460px",
                margin: "0 0 32px",
              }}
            >
              Upload forecasts for all your channels in one file. Combo SKUs
              are auto-converted to singles. Lower revision, higher fidelity.
            </p>

            {/* ── Network graph SVG ──────────────────────────────── */}
            <div className="hidden lg:block" style={{ marginBottom: "24px" }}>
              <NetworkGraph />
            </div>

            {/* ── Roadmap / toolkit ──────────────────────────────── */}
            <div
              className="hidden lg:block"
              style={{
                borderTop: "1px solid var(--atlas-line-soft)",
                paddingTop: "20px",
              }}
            >
              <ol className="list-none p-0 m-0">
                {TOOLKIT.map((item) => (
                  <li
                    key={item.num}
                    className="grid items-center"
                    style={{
                      gridTemplateColumns: "22px 1fr auto",
                      gap: "14px",
                      padding: "10px 0",
                      borderBottom: "1px dashed var(--atlas-line-soft)",
                    }}
                  >
                    <span
                      className="font-mono"
                      style={{
                        fontSize: "11px",
                        color: "var(--atlas-ink-muted)",
                      }}
                    >
                      {item.num}
                    </span>
                    <span>
                      <span
                        className="font-display"
                        style={{
                          fontSize: "var(--text-base)",
                          color: item.status === "soon" ? "var(--atlas-ink-soft)" : "var(--atlas-ink)",
                        }}
                      >
                        {item.name}
                      </span>
                      <span
                        className="hidden xl:inline"
                        style={{
                          fontSize: "12px",
                          color: "var(--atlas-ink-muted)",
                          marginLeft: "6px",
                        }}
                      >
                        &mdash; {item.desc}
                      </span>
                    </span>
                    <span className={`atlas-status-${item.status}`}>
                      {item.status === "live" ? "Live" : "Soon"}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          </div>

          {/* ── Right pane: Login card ────────────────────────────────── */}
          <div className="w-full flex justify-center lg:justify-end">
            <div className="relative w-full" style={{ maxWidth: "440px" }}>
              {/* Amber card behind */}
              <div className="atlas-card-behind" />

              {/* Login form card */}
              <div className="atlas-login-card relative">
                {showForgotPassword ? (
                  /* ── Forgot password view ──────────────────────────── */
                  <div>
                    <h2
                      className="font-display"
                      style={{
                        fontSize: "30px",
                        fontWeight: 400,
                        letterSpacing: "var(--tracking-display)",
                        margin: "0 0 8px",
                      }}
                    >
                      Reset <em style={{ color: "var(--atlas-accent)" }}>password</em>.
                    </h2>
                    <p
                      className="font-mono"
                      style={{
                        fontSize: "13px",
                        color: "var(--atlas-ink-muted)",
                        margin: "0 0 24px",
                      }}
                    >
                      We&apos;ll send you a reset link.
                    </p>

                    {resetSent ? (
                      <div>
                        <div
                          className="rounded-lg p-3 mb-4"
                          style={{
                            background: "var(--atlas-green-bg)",
                            border: "1px solid var(--atlas-green)",
                          }}
                        >
                          <p style={{ fontSize: "var(--text-sm)", color: "var(--atlas-green)" }}>
                            Reset link sent! Check your email (and spam folder).
                          </p>
                        </div>
                        <button
                          onClick={() => {
                            setShowForgotPassword(false);
                            setResetSent(false);
                          }}
                          style={{
                            background: "none",
                            border: "none",
                            color: "var(--atlas-accent)",
                            cursor: "pointer",
                            fontFamily: "var(--font-sans)",
                            fontSize: "var(--text-sm)",
                          }}
                        >
                          &larr; Back to login
                        </button>
                      </div>
                    ) : (
                      <form onSubmit={handleForgotPassword}>
                        <div className="mb-5">
                          <label
                            className="font-mono uppercase block mb-2"
                            style={{
                              fontSize: "10.5px",
                              letterSpacing: "0.1em",
                              color: "var(--atlas-ink-muted)",
                            }}
                          >
                            Email address
                          </label>
                          <input
                            type="email"
                            value={resetEmail}
                            onChange={(e) => setResetEmail(e.target.value)}
                            required
                            placeholder="you@yogabars.in"
                            className="atlas-input"
                          />
                        </div>

                        {error && (
                          <div
                            className="rounded-lg p-3 mb-4"
                            style={{
                              background: "var(--atlas-red-bg)",
                              border: "1px solid var(--atlas-red)",
                            }}
                          >
                            <p style={{ fontSize: "var(--text-sm)", color: "var(--atlas-red)" }}>
                              {error}
                            </p>
                          </div>
                        )}

                        <button
                          type="submit"
                          disabled={resetLoading}
                          className="atlas-submit mb-3"
                        >
                          <span>{resetLoading ? "Sending..." : "Send Reset Link"}</span>
                          <span className="arrow">&rarr;</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setShowForgotPassword(false);
                            setError(null);
                          }}
                          style={{
                            background: "none",
                            border: "none",
                            color: "var(--atlas-ink-muted)",
                            cursor: "pointer",
                            fontFamily: "var(--font-sans)",
                            fontSize: "var(--text-sm)",
                            width: "100%",
                            textAlign: "center",
                            padding: "8px 0",
                          }}
                        >
                          &larr; Back to login
                        </button>
                      </form>
                    )}
                  </div>
                ) : (
                  /* ── Login view ─────────────────────────────────────── */
                  <div>
                    <h2
                      className="font-display"
                      style={{
                        fontSize: "30px",
                        fontWeight: 400,
                        letterSpacing: "var(--tracking-display)",
                        margin: "0 0 4px",
                      }}
                    >
                      Welcome <em style={{ color: "var(--atlas-accent)" }}>back</em>.
                    </h2>
                    <p
                      style={{
                        fontSize: "13.5px",
                        color: "var(--atlas-ink-muted)",
                        margin: "0 0 24px",
                      }}
                    >
                      Sign in to continue. Current cycle:{" "}
                      <span className="font-mono" style={{ color: "var(--atlas-accent)" }}>
                        April 2026 &middot; v2
                      </span>
                    </p>

                    <form onSubmit={handleLogin} autoComplete="on">
                      {/* Email */}
                      <div className="mb-5">
                        <label
                          htmlFor="email"
                          className="font-mono uppercase block mb-2"
                          style={{
                            fontSize: "10.5px",
                            letterSpacing: "0.1em",
                            color: "var(--atlas-ink-muted)",
                          }}
                        >
                          Email address
                        </label>
                        <input
                          id="email"
                          name="email"
                          type="email"
                          autoComplete="email"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          required
                          placeholder="you@yogabars.in"
                          className="atlas-input"
                        />
                      </div>

                      {/* Password */}
                      <div className="mb-4">
                        <label
                          htmlFor="password"
                          className="font-mono uppercase block mb-2"
                          style={{
                            fontSize: "10.5px",
                            letterSpacing: "0.1em",
                            color: "var(--atlas-ink-muted)",
                          }}
                        >
                          Password
                        </label>
                        <div className="relative">
                          <input
                            id="password"
                            name="password"
                            type={showPassword ? "text" : "password"}
                            autoComplete="current-password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                            placeholder="••••••••••"
                            className="atlas-input"
                            style={{ paddingRight: "40px" }}
                          />
                          <button
                            type="button"
                            onClick={() => setShowPassword(!showPassword)}
                            style={{
                              position: "absolute",
                              right: "4px",
                              top: "50%",
                              transform: "translateY(-50%)",
                              background: "none",
                              border: "none",
                              color: "var(--atlas-ink-muted)",
                              cursor: "pointer",
                              padding: "4px",
                            }}
                          >
                            {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                          </button>
                        </div>
                      </div>

                      {/* Remember + Forgot */}
                      <div
                        className="flex items-center justify-between mb-6"
                        style={{ fontSize: "var(--text-sm)" }}
                      >
                        <label
                          className="flex items-center gap-2 cursor-pointer"
                          style={{ color: "var(--atlas-ink-soft)" }}
                        >
                          <input
                            type="checkbox"
                            checked={rememberMe}
                            onChange={(e) => setRememberMe(e.target.checked)}
                            style={{ accentColor: "var(--atlas-accent)" }}
                          />
                          Remember this device
                        </label>
                        <button
                          type="button"
                          onClick={() => {
                            setShowForgotPassword(true);
                            setError(null);
                            setResetEmail(email);
                          }}
                          style={{
                            background: "none",
                            border: "none",
                            color: "var(--atlas-accent)",
                            cursor: "pointer",
                            fontFamily: "var(--font-sans)",
                            fontSize: "var(--text-sm)",
                          }}
                        >
                          Forgot?
                        </button>
                      </div>

                      {/* Error */}
                      {error && (
                        <div
                          className="rounded-lg p-3 mb-4"
                          style={{
                            background: "var(--atlas-red-bg)",
                            border: "1px solid var(--atlas-red)",
                          }}
                        >
                          <p style={{ fontSize: "var(--text-sm)", color: "var(--atlas-red)" }}>
                            {error}
                          </p>
                        </div>
                      )}

                      {/* Submit */}
                      <button
                        type="submit"
                        disabled={loading}
                        className="atlas-submit"
                      >
                        <span>{loading ? "Signing in..." : "Sign in to Atlas"}</span>
                        <span className="arrow">&rarr;</span>
                      </button>
                    </form>

                    {/* Below link */}
                    <p
                      className="text-center mt-5"
                      style={{
                        fontSize: "13px",
                        color: "var(--atlas-ink-muted)",
                      }}
                    >
                      Don&apos;t have an account?{" "}
                      <a
                        href="/signup"
                        style={{
                          color: "var(--atlas-accent)",
                          textDecoration: "none",
                        }}
                      >
                        Sign up
                      </a>
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Footer meta ────────────────────────────────────────────────── */}
      <div
        className="atlas-corner-meta relative z-10"
        style={{
          position: "absolute",
          bottom: "18px",
          left: "44px",
          right: "44px",
        }}
      >
        <span>Yogabars &middot; Mumbai</span>
        <span className="rule" />
        <span>SOC2 &middot; Encrypted at rest &middot; v1.8.2</span>
      </div>
    </main>
  );
}
