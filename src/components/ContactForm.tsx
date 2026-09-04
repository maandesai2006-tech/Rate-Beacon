"use client";

import { useState } from "react";

// "Contact us", wired to /api/contact.
//
// Says exactly what happens: the message is saved and a person replies. No
// promise of an email that no mail provider on the deployment could send.

const TYPES: { value: string; label: string }[] = [
  { value: "franchised", label: "Franchised hotel" },
  { value: "independent", label: "Independent hotel" },
  { value: "bnb", label: "Bed & breakfast" },
  { value: "other", label: "Something else" },
];

export default function ContactForm({ initialType = "" }: { initialType?: string }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [propertyName, setPropertyName] = useState("");
  const [propertyType, setPropertyType] = useState(initialType);
  const [message, setMessage] = useState("");
  const [website, setWebsite] = useState(""); // honeypot
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [note, setNote] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState("sending");
    setNote(null);
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, propertyName, propertyType, message, website, source: "landing" }),
      });
      const j = await res.json();
      if (!res.ok) {
        setState("error");
        setNote(j.error ?? "Something went wrong. Try again in a moment.");
        return;
      }
      setState("sent");
      setNote(j.note ?? "Got it. A person will reply to that address, usually within a working day.");
    } catch (err) {
      setState("error");
      setNote((err as Error).message);
    }
  }

  if (state === "sent") {
    return (
      <div className="card p-6">
        <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          Message received
        </p>
        <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
          {note}
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="card grid gap-4 p-6 sm:grid-cols-2">
      <label className="grid gap-1 text-sm">
        <span style={{ color: "var(--text-secondary)" }}>Your name</span>
        <input className="input px-3 py-2" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
      </label>
      <label className="grid gap-1 text-sm">
        <span style={{ color: "var(--text-secondary)" }}>Email</span>
        <input
          className="input px-3 py-2"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
        />
      </label>
      <label className="grid gap-1 text-sm">
        <span style={{ color: "var(--text-secondary)" }}>Property</span>
        <input
          className="input px-3 py-2"
          value={propertyName}
          onChange={(e) => setPropertyName(e.target.value)}
          placeholder="Hotel name, city"
        />
      </label>
      <label className="grid gap-1 text-sm">
        <span style={{ color: "var(--text-secondary)" }}>Type of property</span>
        <select className="input px-3 py-2" value={propertyType} onChange={(e) => setPropertyType(e.target.value)}>
          <option value="">Choose…</option>
          {TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm sm:col-span-2">
        <span style={{ color: "var(--text-secondary)" }}>What would you like to know?</span>
        <textarea
          className="input min-h-[110px] px-3 py-2"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
      </label>

      {/* Off-screen, never shown to people. A value here means a bot. */}
      <input
        tabIndex={-1}
        autoComplete="off"
        value={website}
        onChange={(e) => setWebsite(e.target.value)}
        aria-hidden="true"
        style={{ position: "absolute", left: "-10000px", width: 1, height: 1, opacity: 0 }}
      />

      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <button type="submit" disabled={state === "sending" || !email} className="btn-accent px-5 py-2.5 text-[14px]">
          {state === "sending" ? "Sending…" : "Send"}
        </button>
        {note && (
          <span className="text-sm" style={{ color: state === "error" ? "var(--status-critical)" : "var(--text-secondary)" }}>
            {note}
          </span>
        )}
      </div>
    </form>
  );
}
