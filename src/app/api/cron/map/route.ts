import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

// Daily rebuild of every profile's map set, so the map stays current on its
// own rather than depending on a rate refresh or a manual click.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const origin = req.nextUrl.origin;
  try {
    const res = await fetch(`${origin}/api/map-set?limit=30`, { method: "POST" });
    const body = await res.json().catch(() => ({}));
    return NextResponse.json({ ok: res.ok, body });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
