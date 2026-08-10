import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";

// Gate the app behind a session cookie. Validity is checked in the route
// handlers (the database isn't reachable from Edge middleware); this only
// routes unauthenticated visitors to the sign-in page.
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const open =
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/cron") ||
    pathname.startsWith("/api/map-set") ||
    pathname === "/login";
  if (open) return NextResponse.next();

  if (req.cookies.get(SESSION_COOKIE)?.value) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
