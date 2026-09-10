import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// The only routes a "viewer" may reach. Dashboard is the single section they
// see; /account/password is allowed so someone signed in with an
// admin-issued temporary password can still set their own.
// Everything else — every other page and every API route — is refused.
const VIEWER_ALLOWED_PATHS = ["/dashboard", "/account/password"];

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request,
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, {
              ...options,
              // Ensure cookies persist across browser restarts (7 days)
              maxAge: options?.maxAge ?? 60 * 60 * 24 * 7,
              sameSite: options?.sameSite ?? "lax",
              path: options?.path ?? "/",
            })
          );
        },
      },
    }
  );

  // Refresh the auth token
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Define protected routes (everything except login, signup, and home)
  const isProtectedRoute =
    !request.nextUrl.pathname.startsWith("/login") &&
    !request.nextUrl.pathname.startsWith("/signup") &&
    !request.nextUrl.pathname.startsWith("/auth") &&
    !request.nextUrl.pathname.startsWith("/reset-password") &&
    request.nextUrl.pathname !== "/";

  // Redirect to login if not authenticated and trying to access protected route
  if (!user && isProtectedRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // Redirect to dashboard if already logged in and trying to access login/signup/home
  if (
    user &&
    (request.nextUrl.pathname === "/" ||
      request.nextUrl.pathname === "/login" ||
      request.nextUrl.pathname === "/signup")
  ) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }

  // Viewers keep the app shell but see Dashboard only. AppShell hides the
  // other nav tabs; this refuses the routes server-side so they cannot be
  // reached by typing a URL or calling the API directly.
  if (user && isProtectedRoute) {
    const path = request.nextUrl.pathname;
    const isAllowed = VIEWER_ALLOWED_PATHS.some(
      (allowed) => path === allowed || path.startsWith(`${allowed}/`)
    );

    if (!isAllowed) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .single();

      if (profile?.role === "viewer") {
        if (path.startsWith("/api/")) {
          return NextResponse.json(
            { error: "Your account does not have access to this section. Contact an administrator." },
            { status: 403 }
          );
        }
        const url = request.nextUrl.clone();
        url.pathname = "/dashboard";
        url.search = "";
        return NextResponse.redirect(url);
      }
    }
  }

  return supabaseResponse;
}