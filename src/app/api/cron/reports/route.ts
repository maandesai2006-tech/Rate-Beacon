import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { syncMailbox } from "@/lib/mail-sync";
import { reportError } from "@/lib/errors";

export const maxDuration = 60;

// Daily mailbox check for every connected profile.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const supa = db();
  const { data: sources } = await supa.from("email_sources").select("*");
  const list = sources ?? [];
  // Share the 60-second ceiling across every connected mailbox rather than
  // letting the first one spend it all. A daily run only has a night or two of
  // mail to collect; a backfill resumes on the next run.
  const budgetEach = list.length ? Math.floor(45_000 / list.length) : 45_000;
  const outcomes = [];
  for (const s of list) {
    try {
      const outcome = await syncMailbox(supa, s, budgetEach);
      outcomes.push(outcome);
      if (outcome && typeof outcome === "object" && "error" in outcome && outcome.error) {
        await reportError("mailbox", String(outcome.error), { detail: `email_sources ${s.id}` }, supa);
      }
    } catch (e) {
      await reportError("mailbox", e, { detail: `email_sources ${s.id}` }, supa);
      outcomes.push({ id: s.id, error: (e as Error).message });
    }
  }
  return NextResponse.json({ checked: outcomes.length, outcomes });
}
