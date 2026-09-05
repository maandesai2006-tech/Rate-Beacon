"use client";

import { useRef, useState } from "react";

// The assistant, in the dashboard.
//
// It answers from the same data the screens show and can act on the compset,
// so what it says can be checked against the grid beside it. Which tools it
// used is shown under each answer — an assistant that says where its numbers
// came from is one a revenue manager can trust enough to use.

interface Turn {
  role: "user" | "model";
  text: string;
  used?: string[];
}

const TOOL_LABEL: Record<string, string> = {
  market_summary: "read your rates",
  report_summary: "read your reports",
  conditions: "checked conditions",
  find_hotels: "searched nearby hotels",
  add_competitors: "updated your compset",
};

const STARTERS = [
  "How am I priced for this weekend?",
  "What did the reports flag this week?",
  "Find hotels near me I'm not tracking",
];

export default function Assistant({
  profileId,
  baselineHotelId,
  onChanged,
}: {
  profileId: number | null;
  baselineHotelId: string | null;
  onChanged: () => void;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  async function ask(question: string) {
    if (!profileId || !question.trim() || busy) return;
    const asked: Turn = { role: "user", text: question.trim() };
    setTurns((t) => [...t, asked]);
    setInput("");
    setBusy(true);
    setNote(null);

    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profileId,
          baselineHotelId,
          question: asked.text,
          history: turns.map(({ role, text }) => ({ role, text })),
        }),
      });
      const j = await res.json();
      if (!res.ok) {
        setNote(j.error ?? "That did not work.");
        return;
      }
      setTurns((t) => [...t, { role: "model", text: j.text, used: j.used ?? [] }]);
      if (j.changed) onChanged();
      if (typeof j.remaining === "number" && j.remaining <= 5) {
        setNote(`${j.remaining} question${j.remaining === 1 ? "" : "s"} left today.`);
      }
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
      requestAnimationFrame(() => endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
    }
  }

  return (
    <div>
      {turns.length === 0 ? (
        <div className="flex flex-wrap gap-2">
          {STARTERS.map((s) => (
            <button key={s} onClick={() => ask(s)} disabled={busy} className="btn-ghost px-3 py-1.5 text-[12px]">
              {s}
            </button>
          ))}
        </div>
      ) : (
        <div className="max-h-[420px] space-y-3 overflow-y-auto">
          {turns.map((t, i) => (
            <div key={i} className={t.role === "user" ? "flex justify-end" : ""}>
              <div
                className="max-w-[85%] rounded-lg px-3 py-2 text-[13px] leading-relaxed"
                style={
                  t.role === "user"
                    ? { background: "var(--accent-soft)", color: "var(--text-primary)" }
                    : { background: "var(--surface-2)", color: "var(--text-secondary)" }
                }
              >
                <span style={{ whiteSpace: "pre-wrap" }}>{t.text}</span>
                {t.used && t.used.length > 0 && (
                  <div className="mt-1.5 text-[11px]" style={{ color: "var(--text-muted)" }}>
                    {[...new Set(t.used)].map((u) => TOOL_LABEL[u] ?? u).join(" · ")}
                  </div>
                )}
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
        className="mt-3 flex gap-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about your rates, your reports, or hotels nearby"
          className="input flex-1 px-3 py-2 text-[13px]"
          disabled={busy}
        />
        <button type="submit" disabled={busy || !input.trim()} className="btn-accent px-4 py-2 text-[13px]">
          {busy ? "Thinking…" : "Ask"}
        </button>
      </form>

      {note && (
        <p className="mt-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
          {note}
        </p>
      )}
    </div>
  );
}
