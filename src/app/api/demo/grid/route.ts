import { NextResponse } from "next/server";
import { buildDemoGrid } from "@/lib/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The demo grid as JSON, for anything that wants it over HTTP. The demo and
// landing pages do not: they call buildDemoGrid() directly.
export async function GET() {
  const grid = await buildDemoGrid();
  return NextResponse.json(grid, {
    headers: { "Cache-Control": "public, s-maxage=900, stale-while-revalidate=3600" },
  });
}
