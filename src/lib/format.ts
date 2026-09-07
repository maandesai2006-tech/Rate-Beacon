/**
 * Shared display formatting for the forecast UI. Money, percent and date
 * formatters were previously redefined in every forecast component; this is
 * the one place that changes if a display convention needs to change.
 */

export function moneyFormatter(currency: string, maximumFractionDigits = 2) {
  const format = new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits });
  return (value: number | null | undefined) => (value == null ? "—" : format.format(value));
}

export function percentFormatter(maximumFractionDigits = 1) {
  const format = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits });
  return (value: number | null | undefined) => (value == null ? "—" : format.format(value));
}

export function dateLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}
