"use client";

import { getPendingExtraApprovals, getStaffSummary, type StaffSummary } from "@/lib/staff-api";
import { ExtraApprovals } from "./ExtraApprovals";
import { ReservationBrowser } from "./ReservationBrowser";
import { formatLongDay } from "./staff-dates";
import { ErrorState, Panel } from "./staff-ui";
import { useApiData } from "./useApiData";

type StaffDashboardProps = {
  // Today in Karachi, as YYYY-MM-DD
  today: string;
  // The day the reservation list opens on
  initialDate: string;
};

const CARDS: { key: Exclude<keyof StaffSummary, "today">; label: string; hint: string }[] = [
  { key: "todayReservations", label: "Today's reservations", hint: "Confirmed, starting today" },
  { key: "upcomingReservations", label: "Upcoming", hint: "Confirmed, not started yet" },
  { key: "confirmedReservations", label: "Confirmed", hint: "All dates" },
  { key: "cancelledReservations", label: "Cancelled", hint: "All dates" },
  { key: "pendingExtraApprovals", label: "Extras to approve", hint: "From today on" },
];

// The staff dashboard: counts, the reservations for any day, and the extras
// waiting for approval. Everything is read from the backend; nothing here
// changes a reservation.
export function StaffDashboard({ today, initialDate }: StaffDashboardProps) {
  const summary = useApiData(getStaffSummary, "summary");
  const approvals = useApiData(getPendingExtraApprovals, "approvals");

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-6 sm:px-6 lg:py-8">
      <header>
        <h1 className="font-display text-3xl font-semibold text-ink">Dashboard</h1>
        <p className="mt-1 text-sm text-muted">{formatLongDay(today)} · Karachi time</p>
      </header>

      <section aria-label="Overview">
        {summary.error ? (
          <Panel>
            <ErrorState message={summary.error} onRetry={summary.retry} />
          </Panel>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
            {CARDS.map((card) => (
              <li key={card.key}>
                <Panel className={`h-full p-4 ${card.key === "pendingExtraApprovals" && summary.data?.[card.key] ? "border-amber-300" : ""}`}>
                  <p className="text-sm font-medium text-muted">{card.label}</p>
                  <p className="mt-2 font-display text-3xl font-semibold text-ink tabular-nums">
                    {summary.data ? summary.data[card.key] : <span className="inline-block h-8 w-10 animate-pulse rounded bg-line" />}
                  </p>
                  <p className="mt-1 text-xs text-muted">{card.hint}</p>
                </Panel>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ReservationBrowser today={today} initialDate={initialDate} />

      <ExtraApprovals approvals={approvals} />
    </main>
  );
}
