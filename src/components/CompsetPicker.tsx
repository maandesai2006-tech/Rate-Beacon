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
        `Added ${j.added} hotel${j.added === 1 ? "" : "s"}${
          baselineName ? ` to ${baselineName}'s competitive set` : ""
        }. Rates start collecting on the next refresh.`
      );
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
