import { NextRequest, NextResponse } from "next/server";
import { runSnapshot } from "@/lib/snapshot";

export const maxDuration = 60;

// Vercel Cron calls this daily (see vercel.json) with
// "Authorization: Bearer <CRON_SECRET>" when CRON_SECRET is set. The work is
// chunked so no single invocation exceeds the platform time limit.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const started = Date.now();
    let offset = 0;
    let rowsWritten = 0;
    const errors: string[] = [];
    let total = 0;
    // Keep going while there is both work left and time left.
    for (let i = 0; i < 20; i++) {
      const r = await runSnapshot(undefined, { offset, limit: 200 });
      rowsWritten += r.rowsWritten;
      errors.push(...r.errors);
      total = r.total;
      if (r.nextOffset == null) break;
      offset = r.nextOffset;
      if (Date.now() - started > 45_000) break;
    }
    return NextResponse.json({ rowsWritten, total, resumeFrom: offset, errors: errors.slice(0, 10) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
