import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { syncMailbox } from "@/lib/mail-sync";

export const maxDuration = 60;

// Daily mailbox check for every connected profile.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const supa = db();
  const { data: sources } = await supa.from("email_sources").select("*");
  const outcomes = [];
  for (const s of sources ?? []) {
    outcomes.push(await syncMailbox(supa, s));
  }
  return NextResponse.json({ checked: outcomes.length, outcomes });
}
