import { NextRequest, NextResponse } from "next/server";
import { runSnapshot } from "@/lib/snapshot";

// Vercel's Hobby plan stops a function at 60s, so a full refresh is done in
// chunks: each call fetches a bounded slice and reports where to resume.
export const maxDuration = 60;

const CHUNK = 220;

export async function POST(req: NextRequest) {
  const offset = Number(req.nextUrl.searchParams.get("offset")) || 0;
  const limit = Number(req.nextUrl.searchParams.get("limit")) || CHUNK;
  const maxDates = Number(req.nextUrl.searchParams.get("maxDates")) || undefined;
  try {
    const result = await runSnapshot(maxDates, { offset, limit });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
