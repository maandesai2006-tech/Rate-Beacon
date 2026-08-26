import { NextRequest, NextResponse } from "next/server";
import { requireAccount, SESSION_COOKIE } from "@/lib/auth";
import { hydrationState, queueHydration, registerSchedulerTarget } from "@/lib/hydration";

export const dynamic = "force-dynamic";

// Refreshing rates is a request, not a wait.
//
// This used to run the scrape in the request and hand the browser a loop to
// drive: thousands of upstream calls, sixty seconds at a time, with the
// dashboard showing "Fetching rates…" until something timed out. Now it moves
// the day's cursor back to the start and returns; the background run picks it
// up on its next tick, and the dashboard shows progress instead of blocking.
export async function POST(req: NextRequest) {
  const auth = await requireAccount(req.cookies.get(SESSION_COOKIE)?.value);
  if (!auth.ok) return auth.response;

  try {
    // Also the moment to tell the in-database scheduler where to call: it
    // cannot know the deployment's URL, and waiting for the nightly cron to
    // write it would leave the first day of a new deployment uncollected.
    await registerSchedulerTarget();
    const state = await queueHydration();
    return NextResponse.json({
      ...state,
      queued: true,
      note: "Rates are being collected in the background. This page updates as they land — you do not have to wait here.",
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

// Progress, for the dashboard to poll.
export async function GET(req: NextRequest) {
  const auth = await requireAccount(req.cookies.get(SESSION_COOKIE)?.value);
  if (!auth.ok) return auth.response;
  return NextResponse.json(await hydrationState());
}
