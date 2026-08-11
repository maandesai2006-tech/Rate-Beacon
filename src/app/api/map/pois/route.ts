import { NextRequest, NextResponse } from "next/server";
import { poisInBounds, type PoiKind } from "@/lib/overpass";

export const runtime = "nodejs";
export const maxDuration = 60;

// Points of interest for whatever the map is currently showing.
//
// Bounds-driven rather than radius-driven so panning fills in, and entirely
// independent of the rate pipeline — the map works whether or not rates have
// been fetched. OpenStreetMap via Overpass: free, keyless, no attribution
// beyond the tile credit already on the map.

const VALID: PoiKind[] = ["lodging", "food", "attraction", "shop"];

// Overpass is a shared free service. Caching at the edge keeps a user panning
// around from hammering it, and POIs change on the order of weeks.
const CACHE_SECONDS = 60 * 60 * 6;

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const bboxRaw = q.get("bbox");
  if (!bboxRaw) {
    return NextResponse.json({ error: "bbox=south,west,north,east is required" }, { status: 400 });
  }

  const parts = bboxRaw.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return NextResponse.json({ error: "bbox must be four numbers" }, { status: 400 });
  }
  const [south, west, north, east] = parts;
  if (south >= north || west >= east) {
    return NextResponse.json({ error: "bbox is inverted" }, { status: 400 });
  }

  // A whole-continent query would time out on Overpass and return nothing
  // useful at that zoom anyway.
  const spanLat = north - south;
  const spanLon = east - west;
  if (spanLat > 1.2 || spanLon > 1.2) {
    return NextResponse.json({
      pois: [],
      skipped: "Zoom in to load places — the visible area is too large to query.",
    });
  }

  const kinds = (q.get("kinds") ?? "lodging,food,attraction,shop")
    .split(",")
    .map((k) => k.trim())
    .filter((k): k is PoiKind => (VALID as string[]).includes(k));

  if (kinds.length === 0) return NextResponse.json({ pois: [] });

  try {
    const pois = await poisInBounds({ south, west, north, east }, kinds);
    return NextResponse.json(
      { pois, counts: countByKind(pois) },
      {
        headers: {
          "Cache-Control": `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=86400`,
        },
      }
    );
  } catch (e) {
    return NextResponse.json(
      { pois: [], error: `OpenStreetMap did not answer: ${(e as Error).message}` },
      { status: 502 }
    );
  }
}

function countByKind(pois: { kind: PoiKind }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of pois) out[p.kind] = (out[p.kind] ?? 0) + 1;
  return out;
}
