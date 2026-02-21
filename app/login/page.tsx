"use client";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import Link from "next/link";

function EyeIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <line x1="2" x2="22" y1="2" y2="22" />
    </svg>
  );
}

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetSent, setResetSent] = useState(false);
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [resetLoading, setResetLoading] = useState(false);
  const router = useRouter();

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

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
      {
        redirectTo: `${siteUrl}/auth?next=/reset-password`,
      }
    );

    if (resetError) {
      setError(resetError.message);
    } else {
      setResetSent(true);
    }
    setResetLoading(false);
  }

  // Forgot Password View
  if (showForgotPassword) {
    return (
      <main className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-white mb-2">
              Demand Planning Module - Yogabars
            </h1>
            <p className="text-gray-400">Reset your password</p>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-xl p-8">
            {resetSent ? (
              <div className="text-center">
                <div className="p-3 bg-green-900/50 border border-green-500 rounded-lg mb-4">
                  <p className="text-green-300 text-sm">
                    Password reset link sent! Check your email (and spam folder).
                  </p>
                </div>
                <button
                  onClick={() => {
                    setShowForgotPassword(false);
                    setResetSent(false);
                  }}
                  className="text-amber-400 hover:text-amber-300 text-sm"
                >
                  Back to login
                </button>
              </div>
            ) : (
              <form onSubmit={handleForgotPassword} className="space-y-5">
                <p className="text-sm text-gray-400">
                  Enter your email address and we&apos;ll send you a link to reset
                  your password.
                </p>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1.5">
                    Email
                  </label>
                  <input
                    type="email"
                    value={resetEmail}
                    onChange={(e) => setResetEmail(e.target.value)}
                    required
                    placeholder="you@company.com"
                    className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition"
                  />
                </div>

                {error && (
                  <div className="p-3 bg-red-900/50 border border-red-500 rounded-lg">
                    <p className="text-red-300 text-sm">{error}</p>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={resetLoading}
                  className="w-full py-2.5 bg-amber-500 text-black font-semibold rounded-lg hover:bg-amber-400 disabled:opacity-50 disabled:cursor-not-allowed transition"
                >
                  {resetLoading ? "Sending..." : "Send Reset Link"}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setShowForgotPassword(false);
                    setError(null);
                  }}
                  className="w-full text-center text-sm text-gray-400 hover:text-white transition"
                >
                  Back to login
                </button>
              </form>
            )}
          </div>
        </div>
      </main>
    );
  }

  // Login View
  return (
    <main className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">
            Demand Planning Module - Yogabars
          </h1>
          <p className="text-gray-400">Sign in to your account</p>
        </div>

        {/* Form Card */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-8">
          <form onSubmit={handleLogin} className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1.5">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="you@company.com"
                className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-sm font-medium text-gray-300">
                  Password
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setShowForgotPassword(true);
                    setError(null);
                    setResetEmail(email);
                  }}
                  className="text-xs text-amber-400 hover:text-amber-300 transition"
                >
                  Forgot password?
                </button>
              </div>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  placeholder="Enter your password"
                  className="w-full px-4 py-2.5 pr-12 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white transition"
                >
                  {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
            </div>

            {error && (
              <div className="p-3 bg-red-900/50 border border-red-500 rounded-lg">
                <p className="text-red-300 text-sm">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 bg-amber-500 text-black font-semibold rounded-lg hover:bg-amber-400 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              {loading ? "Signing in..." : "Sign In"}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-gray-400">
            Don&apos;t have an account?{" "}
            <Link
              href="/signup"
              className="text-amber-400 hover:text-amber-300"
            >
              Sign up
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}