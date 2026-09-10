"use client";
import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";

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

export default function LoginCard() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rememberMe, setRememberMe] = useState(true);
  const [showContactAdmin, setShowContactAdmin] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const saved = localStorage.getItem("atlas_remember_email");
    if (saved) {
      setEmail(saved);
      setRememberMe(true);
    }
  }, []);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    if (rememberMe) {
      localStorage.setItem("atlas_remember_email", email);
    } else {
      localStorage.removeItem("atlas_remember_email");
    }

    const supabase = createClient();
    const { error: loginError } = await supabase.auth.signInWithPassword({ email, password });

    if (loginError) {
      setError(loginError.message);
      setLoading(false);
    } else {
      router.push("/dashboard");
      router.refresh();
    }
  }

  return (
    <div className="atlas-login-card-wrapper">
      <div className="atlas-card-behind" />
      <div className="atlas-login-card login-card-anim">
        <div>
            <h2 className="font-display" style={{ fontSize: "30px", fontWeight: 400, letterSpacing: "var(--tracking-display)", margin: "0 0 4px" }}>
              Welcome <em style={{ color: "var(--atlas-accent)" }}>back</em>.
            </h2>
            <p style={{ fontSize: "13.5px", color: "var(--atlas-ink-muted)", margin: "0 0 24px" }}>
              Sign in to continue. Current cycle:{" "}
              <span className="font-mono" style={{ color: "var(--atlas-accent)" }}>April 2026 &middot; v2</span>
            </p>

            <form onSubmit={handleLogin} autoComplete="on">
              <div className="mb-5">
                <label htmlFor="email" className="font-mono uppercase block mb-2" style={{ fontSize: "10.5px", letterSpacing: "0.1em", color: "var(--atlas-ink-muted)" }}>
                  Email address
                </label>
                <input id="email" name="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="you@yogabars.in" className="atlas-input" />
              </div>

              <div className="mb-4">
                <label htmlFor="password" className="font-mono uppercase block mb-2" style={{ fontSize: "10.5px", letterSpacing: "0.1em", color: "var(--atlas-ink-muted)" }}>
                  Password
                </label>
                <div className="relative">
                  <input id="password" name="password" type={showPassword ? "text" : "password"} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required placeholder="••••••••••" className="atlas-input" style={{ paddingRight: "40px" }} />
                  <button type="button" onClick={() => setShowPassword(!showPassword)}
                    style={{ position: "absolute", right: "4px", top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "var(--atlas-ink-muted)", cursor: "pointer", padding: "4px" }}>
                    {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between mb-6" style={{ fontSize: "var(--text-sm)" }}>
                <label className="flex items-center gap-2 cursor-pointer" style={{ color: "var(--atlas-ink-soft)" }}>
                  <input type="checkbox" checked={rememberMe} onChange={(e) => setRememberMe(e.target.checked)} style={{ accentColor: "var(--atlas-accent)" }} />
                  Remember this device
                </label>
                <button type="button" onClick={() => setShowContactAdmin(true)}
                  style={{ background: "none", border: "none", color: "var(--atlas-accent)", cursor: "pointer", fontFamily: "var(--font-sans)", fontSize: "var(--text-sm)", padding: 0 }}>
                  Forgot password?
                </button>
              </div>

              {error && (
                <div className="rounded-lg p-3 mb-4" style={{ background: "var(--atlas-red-bg)", border: "1px solid var(--atlas-red)" }}>
                  <p style={{ fontSize: "var(--text-sm)", color: "var(--atlas-red)" }}>{error}</p>
                </div>
              )}

              <button type="submit" disabled={loading} className="atlas-submit">
                <span>{loading ? "Signing in..." : "Sign in to Atlas"}</span>
                <span className="arrow">&rarr;</span>
              </button>
            </form>

            <p className="text-center mt-5" style={{ fontSize: "13px", color: "var(--atlas-ink-muted)" }}>
              Don&apos;t have an account?{" "}
              <a href="/signup" style={{ color: "var(--atlas-accent)", textDecoration: "none" }}>Sign up</a>
            </p>
        </div>
      </div>

      {/* Forgot-password popup — password resets are handled by an admin,
          since transactional email is not available on this project. */}
      {showContactAdmin && (
        <div
          onClick={() => setShowContactAdmin(false)}
          style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)", padding: "16px" }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            style={{ background: "var(--atlas-surface)", border: "1px solid var(--atlas-line)", borderRadius: "12px", padding: "24px", width: "100%", maxWidth: "380px", boxShadow: "0 20px 40px rgba(0,0,0,0.3)" }}
          >
            <h3 className="font-display" style={{ fontSize: "22px", fontWeight: 400, letterSpacing: "var(--tracking-display)", margin: "0 0 10px", color: "var(--atlas-ink)" }}>
              Contact <em style={{ color: "var(--atlas-accent)" }}>admin</em>.
            </h3>
            <p style={{ fontSize: "13.5px", color: "var(--atlas-ink-muted)", margin: "0 0 8px", lineHeight: 1.5 }}>
              Password resets are handled by an administrator. Reach out to your
              admin and they will issue you a temporary password.
            </p>
            <p style={{ fontSize: "13.5px", color: "var(--atlas-ink-muted)", margin: "0 0 20px", lineHeight: 1.5 }}>
              Once you sign in with it, use{" "}
              <span style={{ color: "var(--atlas-ink)" }}>Change Password</span> in the
              sidebar to set your own.
            </p>
            <button
              type="button"
              onClick={() => setShowContactAdmin(false)}
              className="atlas-submit"
            >
              <span>Got it</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
