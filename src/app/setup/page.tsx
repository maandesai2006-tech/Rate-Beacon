"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface FoundHotel {
  hotelKey: string;
  name: string;
}
interface Picked extends FoundHotel {
  isMine: boolean;
}

const CURRENCIES = ["USD", "EUR", "GBP", "INR", "CAD", "AUD", "AED", "JPY"];

export default function SetupPage() {
  const router = useRouter();
  const [profileId, setProfileId] = useState<number | null>(null);
  const [profileName, setProfileName] = useState("");
  const [ref, setRef] = useState("");
  const [locationKey, setLocationKey] = useState<string | null>(null);
  const [found, setFound] = useState<FoundHotel[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [addUrl, setAddUrl] = useState("");
  const [hotelName, setHotelName] = useState("");
  const [marketName, setMarketName] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [horizonDays, setHorizonDays] = useState(45);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // ?profileId=N → edit that profile; ?new=1 → blank form for a new one.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("new")) return;
    const id = Number(params.get("profileId")) || null;
    fetch(`/api/setup${id ? `?profileId=${id}` : ""}`)
      .then((r) => r.json())
      .then((j) => {
        if (!j.profile) return;
        setProfileId(j.profile.id);
        setProfileName(j.profile.name ?? "");
        setHotelName(j.profile.hotel_name ?? "");
        setMarketName(j.profile.city_name ?? "");
        setCurrency(j.profile.currency ?? "USD");
        setHorizonDays(j.profile.horizon_days ?? 45);
        setNotes(j.profile.notes ?? "");
        if (j.profile.city_code) setLocationKey(j.profile.city_code);
        if (j.hotels?.length) {
          setPicked(
            j.hotels.map(
              (h: { hotel_id: string; name: string; is_mine: boolean }) => ({
                hotelKey: h.hotel_id,
                name: h.name,
                isMine: h.is_mine,
              })
            )
          );
        }
      })
      .catch(() => {});
  }, []);

  async function lookup(input: string, nextOffset = 0, append = false) {
    setLoading(true);
    setError(null);
    try {
      const params = append
        ? `locationKey=${locationKey}&offset=${nextOffset}`
        : `ref=${encodeURIComponent(input)}`;
      const res = await fetch(`/api/hotels?${params}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Lookup failed");
      setLocationKey(j.locationKey);
      setFound(append ? [...found, ...j.hotels] : j.hotels);
      setOffset(nextOffset + (j.hotels?.length ?? 0));
      setHasMore((j.hotels?.length ?? 0) >= 30);
      if (!append && j.pastedHotel) {
        const p = j.pastedHotel as { hotelKey: string; name: string | null };
        setPicked((prev) => {
          if (prev.some((x) => x.hotelKey === p.hotelKey)) return prev;
          const mineExists = prev.some((x) => x.isMine);
          return [
            ...prev,
            { hotelKey: p.hotelKey, name: p.name ?? p.hotelKey, isMine: !mineExists },
          ];
        });
        if (p.name && !hotelName) setHotelName(p.name);
        if (p.name && !profileName) setProfileName(p.name);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function addByUrl() {
    if (!addUrl.trim()) return;
    fetch(`/api/hotels?ref=${encodeURIComponent(addUrl)}`)
      .then(async (res) => {
        const j = await res.json();
        if (!res.ok) throw new Error(j.error ?? "Couldn't parse that link");
        const p = j.pastedHotel as { hotelKey: string; name: string | null } | null;
        if (!p) throw new Error("That link is a location, not a specific hotel page.");
        setPicked((prev) =>
          prev.some((x) => x.hotelKey === p.hotelKey)
            ? prev
            : [...prev, { hotelKey: p.hotelKey, name: p.name ?? p.hotelKey, isMine: false }]
        );
        setAddUrl("");
        setError(null);
      })
      .catch((e) => setError((e as Error).message));
  }

  function togglePick(h: FoundHotel) {
    setPicked((p) =>
      p.some((x) => x.hotelKey === h.hotelKey)
        ? p.filter((x) => x.hotelKey !== h.hotelKey)
        : [...p, { ...h, isMine: false }]
    );
  }

  // Several hotels in one profile can be "mine"; each gets its own
  // competitor set on the dashboard.
  function setMine(hotelKey: string) {
    setPicked((p) =>
      p.map((x) => (x.hotelKey === hotelKey ? { ...x, isMine: !x.isMine } : x))
    );
  }

  async function save() {
    if (!locationKey) return setError("Paste a TripAdvisor link first.");
    if (picked.length === 0) return setError("Add at least one hotel to track.");
    setSaving(true);
    setError(null);
    const res = await fetch("/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profileId,
        name: profileName,
        hotelName,
        cityCode: locationKey,
        cityName: marketName,
        currency,
        horizonDays,
        adults: 2,
        notes,
        hotels: picked.map((h) => ({
          hotelId: h.hotelKey,
          name: h.name,
          isMine: h.isMine,
        })),
      }),
    });
    const j = await res.json();
    setSaving(false);
    if (!res.ok) return setError(j.error ?? "Save failed");
    router.push("/app");
  }

  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-2xl">{profileId ? "Edit profile" : "New hotel profile"}</h1>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
        A profile is one baseline hotel plus the competitor set it&apos;s shopped
        against. Rates come from TripAdvisor&apos;s public compare list (via the
        free Xotelo API), preferring each hotel&apos;s brand-site price.
      </p>

      {/* Step 1: paste link */}
      <section className="card mt-8 p-5">
        <div className="kicker">1 · Baseline hotel</div>
        <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
          Find the hotel on tripadvisor.com and paste the page link — e.g.
          …/Hotel_Review-g187147-d197685-Reviews-… (a city page link works too).
        </p>
        <div className="mt-2 flex gap-2">
          <input
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && lookup(ref)}
            placeholder="Paste a TripAdvisor hotel or city link"
            className="input"
          />
          <button
            onClick={() => lookup(ref)}
            disabled={loading || !ref.trim()}
            className="btn-accent px-4 py-2 text-[13px] disabled:opacity-45"
          >
            {loading ? "Looking…" : "Look up"}
          </button>
        </div>
        {locationKey && (
          <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
            Market location: <code>{locationKey}</code>
          </p>
        )}
      </section>

      {/* Step 2: tracked hotels */}
      <section className="card mt-5 p-5">
        <div className="kicker">2 · Hotels to track</div>

        {picked.length > 0 && (
          <div className="mt-2">
            <h3 className="text-sm font-medium">
              Tracking {picked.length} hotel{picked.length > 1 ? "s" : ""}
            </h3>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              Tick &ldquo;mine&rdquo; on every hotel you own — the dashboard lets
              you switch between them, each against its own competitor set. Leave
              it unticked if a hotel isn&apos;t on TripAdvisor; rates can be typed
              into the grid instead.
            </p>
            <ul className="mt-2 space-y-1">
              {picked.map((h) => (
                <li
                  key={h.hotelKey}
                  className="flex items-center justify-between px-3 py-2 text-[13px]"
                  style={{
                    border: `1px solid ${h.isMine ? "var(--accent)" : "var(--border)"}`,
                    background: "var(--surface)",
                  }}
                >
                  <span>
                    {h.name}
                    {h.isMine && (
                      <span
                        className="ml-2 inline-flex px-2 py-0.5 text-[11px] font-medium"
                        style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
                      >
                        mine
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-3">
                    <label className="flex items-center gap-1 text-xs">
                      <input
                        type="checkbox"
                        checked={h.isMine}
                        onChange={() => setMine(h.hotelKey)}
                      />
                      mine
                    </label>
                    <button
                      onClick={() => togglePick(h)}
                      className="text-xs underline"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      remove
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-3 flex gap-2">
          <input
            value={addUrl}
            onChange={(e) => setAddUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addByUrl()}
            placeholder="Add a competitor by pasting its TripAdvisor link"
            className="input text-[13px]"
          />
          <button onClick={addByUrl} className="btn-ghost px-4 py-2 text-[13px]">
            Add
          </button>
        </div>

        {found.length > 0 && (
          <>
            <p className="mt-4 text-xs" style={{ color: "var(--text-muted)" }}>
              Or pick from hotels in this location:
            </p>
            <ul
              className="mt-1 max-h-80 space-y-1 overflow-y-auto p-2"
              style={{ border: "1px solid var(--border)" }}
            >
              {found
                .filter((h) => !picked.some((p) => p.hotelKey === h.hotelKey))
                .map((h) => (
                  <li key={h.hotelKey}>
                    <button
                      onClick={() => togglePick(h)}
                      className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:opacity-70"
                    >
                      <span>{h.name}</span>
                      <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                        add +
                      </span>
                    </button>
                  </li>
                ))}
              {hasMore && (
                <li>
                  <button
                    onClick={() => lookup("", offset, true)}
                    disabled={loading}
                    className="w-full rounded px-2 py-1.5 text-center text-xs underline"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {loading ? "Loading…" : "Load more"}
                  </button>
                </li>
              )}
            </ul>
          </>
        )}
      </section>

      {/* Step 3: options */}
      <section className="card mt-5 p-5">
        <div className="kicker">3 · Options</div>
        <div className="mt-2 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-sm">
            <span style={{ color: "var(--text-secondary)" }}>Profile name</span>
            <input
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
              placeholder="e.g. Candlewood — Pensacola"
              className="input mt-1"
            />
          </label>
          <label className="text-sm">
            <span style={{ color: "var(--text-secondary)" }}>Market label</span>
            <input
              value={marketName}
              onChange={(e) => setMarketName(e.target.value)}
              placeholder="e.g. Pensacola, FL"
              className="input mt-1"
            />
          </label>
          <label className="text-sm">
            <span style={{ color: "var(--text-secondary)" }}>Currency</span>
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className="input mt-1"
            >
              {CURRENCIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span style={{ color: "var(--text-secondary)" }}>Days ahead (7–120)</span>
            <input
              type="number"
              min={7}
              max={120}
              value={horizonDays}
              onChange={(e) => setHorizonDays(Number(e.target.value))}
              className="input mt-1"
            />
          </label>
        </div>
        <label className="mt-4 block text-sm">
          <span style={{ color: "var(--text-secondary)" }}>
            Notes (tier, area, why these competitors)
          </span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            className="input mt-1"
          />
        </label>
      </section>

      {error && (
        <p className="mt-4 text-sm" style={{ color: "var(--status-critical)" }}>
          {error}
        </p>
      )}

      <div className="mt-8 flex gap-3">
        <button onClick={save} disabled={saving} className="btn-accent px-5 py-2.5 disabled:opacity-45">
          {saving ? "Saving…" : "Save & open dashboard"}
        </button>
        <button onClick={() => router.push("/app")} className="btn-ghost px-5 py-2.5">
          Cancel
        </button>
      </div>
    </main>
  );
}
