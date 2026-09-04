import type { DemoGrid as DemoGridData } from "@/lib/demo";

// The public rate grid, rendered on the server.
//
// Shared by the landing page and /demo so the two can never disagree about
// what the product looks like. Real published prices, read-only, no sign-in.

function dayLabel(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default function DemoGrid({
  demo,
  compact = false,
}: {
  demo: DemoGridData;
  compact?: boolean;
}) {
  if (demo.error || demo.rows.length === 0) {
    return (
      <div className="card p-8">
        <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
          {demo.error ??
            demo.note ??
            "The demo market has no rates collected yet. The first collection runs as soon as a hotel is added."}
        </p>
      </div>
    );
  }

  const dates = compact ? demo.dates.slice(0, 7) : demo.dates;
  const rows = compact ? demo.rows.slice(0, 8) : demo.rows;

  return (
    <div className="card overflow-hidden">
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <span className="kicker">{demo.market}</span>
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>
          {rows.length} hotels · next {dates.length} nights · live published rates
        </span>
        {demo.capturedAt && (
          <span className="ml-auto text-xs" style={{ color: "var(--text-muted)" }}>
            updated {new Date(demo.capturedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          </span>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className={`w-full text-sm ${compact ? "min-w-[560px]" : "min-w-[720px]"}`}>
          <thead>
            <tr>
              <th
                className="th-label sticky left-0 z-10 px-5 py-2.5 text-left"
                style={{ background: "var(--surface)" }}
              >
                Hotel
              </th>
              {dates.map((d) => (
                <th key={d} className="th-label px-4 py-2.5 text-right whitespace-nowrap">
                  {dayLabel(d)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.hotel} style={{ borderTop: "1px solid var(--gridline)" }}>
                <td
                  className="sticky left-0 z-10 max-w-[240px] truncate px-5 py-2.5"
                  style={{ background: "var(--surface)", color: "var(--text-secondary)" }}
                  title={r.hotel}
                >
                  {r.hotel}
                </td>
                {dates.map((_, i) => {
                  const p = r.prices[i];
                  const med = demo.medians[i];
                  const delta = p != null && med ? ((p - med) / med) * 100 : null;
                  const tone =
                    delta == null
                      ? "var(--text-muted)"
                      : delta <= -5
                        ? "var(--div-low)"
                        : delta >= 5
                          ? "var(--div-high)"
                          : "var(--text-secondary)";
                  return (
                    <td
                      key={i}
                      className="px-4 py-2.5 text-right tabular-nums"
                      style={{ color: tone }}
                      title={
                        delta == null
                          ? "no rate captured"
                          : `${delta >= 0 ? "+" : ""}${delta.toFixed(0)}% vs market median`
                      }
                    >
                      {p == null ? "—" : `$${Math.round(p)}`}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr style={{ borderTop: "2px solid var(--border)" }}>
              <td
                className="sticky left-0 z-10 px-5 py-2.5 text-xs font-semibold uppercase tracking-wide"
                style={{ background: "var(--surface)", color: "var(--text-muted)" }}
              >
                Market median
              </td>
              {dates.map((_, i) => (
                <td
                  key={i}
                  className="px-4 py-2.5 text-right tabular-nums font-semibold"
                  style={{ color: "var(--text-primary)" }}
                >
                  {demo.medians[i] == null ? "—" : `$${Math.round(demo.medians[i] as number)}`}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
