import { NextRequest, NextResponse } from "next/server";
import { requireAccount, SESSION_COOKIE } from "@/lib/auth";
import { probeListShapes } from "@/lib/xotelo-list";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// What the hotel listing endpoint actually accepts.
//
// Its parameter shape is undocumented and has changed at least once, and it
// cannot be probed from a development machine that has no route to the host.
// This runs the full matrix against a real market and reports every response
// verbatim, so a failure names its cause instead of "check your params". The
// winning shape is stored and used from then on.

export async function POST(req: NextRequest) {
  const auth = await requireAccount(req.cookies.get(SESSION_COOKIE)?.value);
  if (!auth.ok) return auth.response;
  const { accountId, supa } = auth;

  const locationKey = (req.nextUrl.searchParams.get("locationKey") ?? "g34550").trim();
  if (!/^g\d+$/.test(locationKey)) {
    return NextResponse.json({ error: "locationKey should look like g34550" }, { status: 400 });
  }

  const { winner, outcomes } = await probeListShapes(supa, locationKey);

  return NextResponse.json({
    locationKey,
    winner,
    outcomes,
    summary: winner
      ? `"${winner}" works and is now the shape discovery uses.`
      : "No parameter shape was accepted. The per-shape messages below are the evidence for what to try next.",
  });
}
