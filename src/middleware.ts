import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/session";

// The dashboard is gated; the shop window is not.
//
// Everything under /app needs a session. The marketing page, the demo, and the
// two auth pages are public, because a visitor who cannot see what the product
// does before signing up will not sign up.
//
// Session *validity* is still checked in the route handlers — the database is
// not reachable from Edge middleware, so this only routes on the presence of a
// cookie.
const PUBLIC_PAGES = new Set(["/", "/login", "/signup", "/demo"]);

const PUBLIC_API_PREFIXES = [
  "/api/auth",
  "/api/cron",
  "/api/demo",
  // /api/map-set used to be here. It loops over profile baselines, so leaving
  // it open let any visitor trigger work across every tenant.
];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PAGES.has(pathname)) return NextResponse.next();
  if (PUBLIC_API_PREFIXES.some((p) => pathname.startsWith(p))) return NextResponse.next();

  if (req.cookies.get(SESSION_COOKIE)?.value) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }

  // Send them to sign in, and remember where they were headed.
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  if (pathname !== "/app") url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
