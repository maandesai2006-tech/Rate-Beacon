import { NextRequest, NextResponse } from "next/server";
import { tickHydration, registerSchedulerTarget } from "@/lib/hydration";

export const maxDuration = 60;

// One slice of today's rate collection.
//
// Called by Vercel Cron once a day to start the run, and by Postgres every few
// minutes to keep it moving — a day's collection is far more work than one
// serverless invocation can do, and a daily cron cannot call itself back. Each
// call does what it can inside its budget and records where it stopped, so the
// next one continues rather than restarting.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Written on every run so the in-database scheduler always knows where to
    // call, including after a rename or a first deploy.
    const target = await registerSchedulerTarget();

    // Leave headroom under the platform's 60s limit so the state write lands.
    const state = await tickHydration({ budgetMs: 45_000 });

    return NextResponse.json({
      ...state,
      schedulerTarget: target,
      note: state.finishedAt
        ? "Today's collection is complete."
        : `Collected ${state.cursor} of ${state.total} hotel-nights so far.`,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
