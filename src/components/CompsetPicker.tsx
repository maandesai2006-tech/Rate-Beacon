"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Choosing who you compete with.
//
// Two ways in, because operators arrive with different amounts of certainty:
// a suggested set for "just give me the obvious ones", and a search box for
// "I know exactly which four matter". Both are bounded by a radius from the
// operator's own hotel, so the list is the handful a guest would actually
// choose between rather than every hotel sharing a brand name.

interface Candidate {
  hotelKey: string;
  name: string;
  distanceMiles: number | null;
  rating: number | null;
  reviewCount: number | null;
  alreadyTracked: boolean;
  priceable?: boolean;
  /** For a hotel we cannot price: a search that lands on its TripAdvisor page. */
  lookupUrl?: string;
  /** Median published rate over the next fortnight, when known. */
  typicalRate?: number | null;
  /** Within about a third of the baseline's typical rate. */
  bandMatch?: boolean | null;
}

const RADII = [5, 10, 25, 50];

export default function CompsetPicker({
  profileId,
  baselineHotelId,
  baselineName,
  onChanged,
}: {
  profileId: number | null;
  baselineHotelId: string | null;
  baselineName: string | null;
  onChanged: () => void;
}) {
  const [radius, setRadius] = useState(25);
  const [suggestions, setSuggestions] = useState<Candidate[] | null>(null);
  // Real hotels near you that the rate feed has no record of. They are shown
  // separately because they ask for something: a link, once.
  const [needsLink, setNeedsLink] = useState<Candidate[]>([]);
  const [linking, setLinking] = useState<string | null>(null);
  const [linkValue, setLinkValue] = useState("");
  const [baselineRate, setBaselineRate] = useState<number | null>(null);
  // The listing endpoint's answers, verbatim, so they can be read and passed on.
  const [diag, setDiag] = useState<{ summary: string; sources: { name: string; ok: boolean; detail: string }[]; outcomes: { shape: string; message: string }[] } | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Candidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchNote, setSearchNote] = useState<string | null>(null);

  const loadSuggestions = useCallback(async () => {
    if (!profileId) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(
        `/api/compset/suggest?profileId=${profileId}&radius=${radius}&count=15`
      );
      const j = await res.json();
      setSuggestions(j.suggestions ?? []);
      setNeedsLink(j.needsLink ?? []);
      setBaselineRate(j.baselineTypicalRate ?? null);
      setChosen(new Set((j.suggestions ?? []).map((c: Candidate) => c.hotelKey)));
      setNote(j.error ?? j.note ?? null);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [profileId, radius]);

  // Search as they type, but not on every keystroke — the directory refresh
  // behind this can reach out to a third party.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!profileId) return;
    if (timer.current) clearTimeout(timer.current);
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setSearchNote(null);
      return;
    }
    timer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(
          `/api/compset/search?profileId=${profileId}&radius=${radius}&q=${encodeURIComponent(q)}`
        );
        const j = await res.json();
        setResults(j.results ?? []);
        setSearchNote(
          j.error ? `${j.error} ${j.hint ?? ""}`.trim() : (j.note ?? null)
        );
      } catch (e) {
        setSearchNote((e as Error).message);
      } finally {
        setSearching(false);
      }
    }, 400);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query, profileId, radius]);

  async function add(hotels: { hotelKey: string; name: string }[]) {
    if (!profileId || hotels.length === 0) return;
    setSaving(true);
    try {
      const res = await fetch("/api/compset/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId, baselineHotelId, hotels }),
      });
      const j = await res.json();
      if (j.error) {
        setNote(j.error);
        return;
      }
      setNote(
        j.note
          ? j.note
          : `Added ${j.added} hotel${j.added === 1 ? "" : "s"}${
              baselineName ? ` to ${baselineName}'s competitive set` : ""
            }. Rates start collecting on the next run.`
      );
      setNeedsLink((n) => n.filter((c) => !hotels.some((h) => h.hotelKey === c.hotelKey)));
      setSuggestions((s) => (s ?? []).filter((c) => !hotels.some((h) => h.hotelKey === c.hotelKey)));
      setResults((r) => r.map((c) => (hotels.some((h) => h.hotelKey === c.hotelKey) ? { ...c, alreadyTracked: true } : c)));
      setQuery("");
      onChanged();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const selected = useMemo(
    () => (suggestions ?? []).filter((c) => chosen.has(c.hotelKey)),
    [suggestions, chosen]
  );

  return (
    <div className="card mt-4 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="kicker mr-1">Competitive set</span>
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>
          within
        </span>
        {RADII.map((r) => (
          <button
            key={r}
            onClick={() => setRadius(r)}
            className="btn-ghost px-2.5 py-1 text-[12px]"
            style={
              radius === r
                ? { borderColor: "var(--accent)", background: "var(--accent-soft)", color: "var(--accent)" }
                : undefined
            }
          >
            {r} mi
          </button>
        ))}
        <button
          onClick={loadSuggestions}
          disabled={busy || !profileId}
          className="btn-accent ml-auto px-4 py-1.5 text-[13px]"
        >
          {busy ? "Looking…" : "Suggest competitors"}
        </button>
        <button
          onClick={async () => {
            if (!profileId) return;
            setDiagBusy(true);
            try {
              const res = await fetch(`/api/compset/diagnose?profileId=${profileId}`, { method: "POST" });
              setDiag(await res.json());
            } finally {
              setDiagBusy(false);
            }
          }}
          disabled={diagBusy}
          className="btn-ghost px-3 py-1.5 text-[12px]"
          title="Test every source competitors can come from and show what each answered"
        >
          {diagBusy ? "Testing…" : "Test sources"}
        </button>
      </div>

      {/* Search */}
      <div className="mt-4">
        <label className="block text-xs" style={{ color: "var(--text-secondary)" }}>
          Add a specific hotel
          <input
            className="input mt-1"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search hotels within ${radius} miles, or paste a TripAdvisor link`}
          />
        </label>

        {searching && (
          <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
            Searching…
          </p>
        )}
        {searchNote && (
          <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
            {searchNote}
          </p>
        )}

        {results.length > 0 && (
          <ul
            className="mt-2 max-h-64 overflow-y-auto rounded-lg"
            style={{ border: "1px solid var(--border)" }}
          >
            {results.map((c) => (
              <li
                key={c.hotelKey}
                className="flex items-center gap-3 px-3 py-2"
                style={{ borderBottom: "1px solid var(--gridline)" }}
              >
                <span className="min-w-0 flex-1">
                  <span
                    className="block truncate text-[13px]"
                    style={{ color: "var(--text-primary)" }}
                  >
                    {c.name}
                  </span>
                  <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                    {c.distanceMiles != null
                      ? `${c.distanceMiles.toFixed(1)} mi away`
                      : "distance unknown"}
                    {c.rating != null ? ` · ${c.rating.toFixed(1)}★` : ""}
                    {c.typicalRate != null ? ` · ~$${Math.round(c.typicalRate)}/night` : ""}
                    {c.bandMatch === true ? " · same range" : c.bandMatch === false ? " · different range" : ""}
                  </span>
                </span>
                {c.alreadyTracked ? (
                  <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                    tracked
                  </span>
                ) : (
                  <button
                    onClick={() => add([{ hotelKey: c.hotelKey, name: c.name }])}
                    disabled={saving}
                    className="btn-ghost px-3 py-1 text-[12px]"
                  >
                    Add
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {diag && (
        <div className="mt-4 rounded-lg p-4 text-[12px]" style={{ background: "var(--surface-2)" }}>
          <div style={{ color: "var(--text-primary)" }}>{diag.summary}</div>
          <ul className="mt-2 grid gap-1">
            {diag.sources.map((src) => (
              <li key={src.name}>
                <span style={{ color: src.ok ? "var(--status-good)" : "var(--status-critical)" }}>{src.ok ? "✓" : "✗"}</span>{" "}
                <b>{src.name}</b> — {src.detail}
              </li>
            ))}
          </ul>
          {diag.outcomes.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer" style={{ color: "var(--text-secondary)" }}>
                What the listing endpoint said to each request shape
              </summary>
              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-[11px]" style={{ color: "var(--text-secondary)" }}>
                {diag.outcomes.map((o) => `${o.shape}: ${o.message}`).join("\n")}
              </pre>
            </details>
          )}
        </div>
      )}

      {/* Real neighbours the rate feed has no record of. Offered rather than
          hidden: the operator recognises these names, and one link each is a
          far smaller job than thinking up a compset from nothing. */}
      {needsLink.length > 0 && (
        <div className="mt-5 rounded-lg p-4" style={{ background: "var(--surface-2)" }}>
          <div className="text-[13px]" style={{ color: "var(--text-primary)" }}>
            {needsLink.length} more hotels near you, not yet in the rate feed
          </div>
          <p className="mt-1 text-[12px]" style={{ color: "var(--text-secondary)" }}>
            These are real properties within {radius} miles. Paste a TripAdvisor
            link for any you compete with and they are checked and added.
          </p>
          <ul className="mt-3 grid gap-1.5">
            {needsLink.map((c) => (
              <li key={c.hotelKey} className="text-[13px]">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span style={{ color: "var(--text-primary)" }}>{c.name}</span>
                  <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                    {c.distanceMiles != null ? `${c.distanceMiles.toFixed(1)} mi` : ""}
                  </span>
                  {c.lookupUrl && (
                    <a
                      href={c.lookupUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[12px] underline"
                      style={{ color: "var(--accent)" }}
                    >
                      Find on TripAdvisor
                    </a>
                  )}
                  <button
                    onClick={() => {
                      setLinking(linking === c.hotelKey ? null : c.hotelKey);
                      setLinkValue("");
                    }}
                    className="text-[12px] underline"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {linking === c.hotelKey ? "Cancel" : "Paste link"}
                  </button>
                </div>
                {linking === c.hotelKey && (
                  <div className="mt-1.5 flex gap-2">
                    <input
                      value={linkValue}
                      onChange={(e) => setLinkValue(e.target.value)}
                      placeholder={`TripAdvisor link for ${c.name}`}
                      className="input flex-1 px-2 py-1 text-[12px]"
                      autoFocus
                    />
                    <button
                      onClick={() => {
                        const key = linkValue.match(/(g\d+-d\d+)/i)?.[1];
                        if (!key) {
                          setNote(
                            "That link has no TripAdvisor hotel id in it. Open the hotel's page and copy the URL from the address bar."
                          );
                          return;
                        }
                        setLinking(null);
                        add([{ hotelKey: key.toLowerCase(), name: c.name }]);
                      }}
                      disabled={saving}
                      className="btn-accent px-3 py-1 text-[12px]"
                    >
                      Add
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Suggestions */}
      {suggestions != null && (
        <div className="mt-5">
          {suggestions.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
              {note ?? `No untracked hotels found within ${radius} miles. Try a wider radius.`}
            </p>
          ) : (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                  {suggestions.length} nearby, {selected.length} selected
                  {baselineRate != null ? ` · yours is ~$${Math.round(baselineRate)}/night` : ""}
                </span>
                <button
                  onClick={() =>
                    setChosen(
                      chosen.size === suggestions.length
                        ? new Set()
                        : new Set(suggestions.map((c) => c.hotelKey))
                    )
                  }
                  className="text-xs underline"
                  style={{ color: "var(--text-secondary)" }}
                >
                  {chosen.size === suggestions.length ? "Clear all" : "Select all"}
                </button>
                <button
                  onClick={() => add(selected.map((c) => ({ hotelKey: c.hotelKey, name: c.name })))}
                  disabled={saving || selected.length === 0}
                  className="btn-accent ml-auto px-4 py-1.5 text-[13px]"
                >
                  {saving ? "Adding…" : `Add ${selected.length}`}
                </button>
              </div>

              <ul className="rounded-lg" style={{ border: "1px solid var(--border)" }}>
                {suggestions.map((c) => (
                  <li
                    key={c.hotelKey}
                    className="flex items-center gap-3 px-3 py-2"
                    style={{ borderBottom: "1px solid var(--gridline)" }}
                  >
                    <input
                      type="checkbox"
                      checked={chosen.has(c.hotelKey)}
                      onChange={() =>
                        setChosen((prev) => {
                          const next = new Set(prev);
                          if (next.has(c.hotelKey)) next.delete(c.hotelKey);
                          else next.add(c.hotelKey);
                          return next;
                        })
                      }
                      aria-label={`Include ${c.name}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className="block truncate text-[13px]"
                        style={{ color: "var(--text-primary)" }}
                      >
                        {c.name}
                      </span>
                      <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                        {c.distanceMiles != null ? `${c.distanceMiles.toFixed(1)} mi` : "distance unknown"}
                        {c.rating != null ? ` · ${c.rating.toFixed(1)}★` : ""}
                        {c.reviewCount != null ? ` (${c.reviewCount.toLocaleString()})` : ""}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {note && suggestions != null && suggestions.length > 0 && (
        <p className="mt-3 text-xs" style={{ color: "var(--text-secondary)" }}>
          {note}
        </p>
      )}
    </div>
  );
}
