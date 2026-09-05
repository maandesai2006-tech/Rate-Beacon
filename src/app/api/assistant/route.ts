import { NextRequest, NextResponse } from "next/server";
import { requireAccount, SESSION_COOKIE } from "@/lib/auth";
import { askAssistant, type AssistantTurn } from "@/lib/assistant";
import { reportError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// One question to the assistant.
//
// The account-scoped connection is handed to the tools, so the assistant reads
// through the same wall as every screen: a question about "all hotels" returns
// this account's hotels because that is all the connection can see.
//
// A daily cap per account keeps one curious afternoon from spending the shared
// free tier that every other customer's assistant also draws on.
const DAILY_TURNS = Number(process.env.ASSISTANT_DAILY_TURNS) || 40;

export async function POST(req: NextRequest) {
  const auth = await requireAccount(req.cookies.get(SESSION_COOKIE)?.value);
  if (!auth.ok) return auth.response;
  const { accountId, supa, shared } = auth;

  const body = (await req.json().catch(() => null)) as {
    profileId?: number;
    baselineHotelId?: string | null;
    question?: string;
    history?: AssistantTurn[];
  } | null;

  const question = body?.question?.trim();
  if (!question) return NextResponse.json({ error: "Ask a question" }, { status: 400 });
  if (question.length > 1000) {
    return NextResponse.json({ error: "That question is too long — try a shorter one." }, { status: 400 });
  }

  const { data: profile } = await supa
    .from("profiles")
    .select("id")
    .eq("account_id", accountId)
    .eq("id", body?.profileId ?? -1)
    .maybeSingle<{ id: number }>();
  if (!profile) return NextResponse.json({ error: "Unknown profile" }, { status: 400 });

  const today = new Date().toISOString().slice(0, 10);
  const { data: usage } = await shared
    .from("assistant_usage")
    .select("turns")
    .eq("account_id", accountId)
    .eq("day", today)
    .maybeSingle<{ turns: number }>();

  if ((usage?.turns ?? 0) >= DAILY_TURNS) {
    return NextResponse.json(
      {
        error: `You have used today's ${DAILY_TURNS} assistant questions. Everything else on the dashboard is unaffected, and it resets tomorrow.`,
      },
      { status: 429 }
    );
  }

  try {
    const reply = await askAssistant(
      { supa, shared, profileId: profile.id, baselineHotelId: body?.baselineHotelId ?? null },
      body?.history ?? [],
      question
    );

    await shared
      .from("assistant_usage")
      .upsert(
        { account_id: accountId, day: today, turns: (usage?.turns ?? 0) + 1 },
        { onConflict: "account_id,day" }
      );

    return NextResponse.json({
      ...reply,
      remaining: Math.max(0, DAILY_TURNS - (usage?.turns ?? 0) - 1),
    });
  } catch (e) {
    await reportError("assistant", e, { accountId });
    return NextResponse.json(
      { error: "The assistant could not answer that just now. The dashboard is unaffected." },
      { status: 502 }
    );
  }
}
