import { NextRequest, NextResponse } from "next/server";

// Diagnostic passthrough. The upstream API can only be reached from the
// deployed app, so this returns its RAW response for a given endpoint —
// enough to see exactly which fields exist (coordinates, ratings, seller
// names) before code is written against them.
//
//   /api/debug/xotelo?endpoint=list&location_key=g34550
//   /api/debug/xotelo?endpoint=rates&hotel_key=g34550-d10637341
//   /api/debug/xotelo?endpoint=heatmap&hotel_key=g34550-d10637341
//   /api/debug/xotelo?endpoint=search&query=Candlewood%20Pensacola
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const endpoint = (sp.get("endpoint") ?? "list").replace(/[^a-z]/gi, "");

  const params = new URLSearchParams();
  for (const [k, v] of sp.entries()) {
    if (k !== "endpoint") params.set(k, v);
  }
  if (endpoint === "list" && !params.has("limit")) params.set("limit", "5");
  if (endpoint === "rates" && !params.has("chk_in")) {
    const inD = new Date(Date.now() + 14 * 86400e3).toISOString().slice(0, 10);
    const outD = new Date(Date.now() + 15 * 86400e3).toISOString().slice(0, 10);
    params.set("chk_in", inD);
    params.set("chk_out", outD);
  }

  const url = `https://data.xotelo.com/api/${endpoint}?${params}`;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep the raw body below */
    }
    return NextResponse.json({
      requested: url,
      status: res.status,
      ms: Date.now() - started,
      body: parsed ?? text.slice(0, 4000),
    });
  } catch (e) {
    return NextResponse.json(
      { requested: url, ms: Date.now() - started, error: (e as Error).message },
      { status: 502 }
    );
  }
}
