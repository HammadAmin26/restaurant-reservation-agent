"use client";

import { useEffect, useState } from "react";
import { getStaffReservations, type MealFilter, type StaffReservationQuery, type StatusFilter } from "@/lib/staff-api";
import { StaffReservationCard } from "./StaffReservationCard";
import { formatLongDay, isDay, shiftDay } from "./staff-dates";
import { EmptyState, ErrorState, LoadingState, Panel } from "./staff-ui";
import { useApiData } from "./useApiData";

type ReservationBrowserProps = {
  today: string;
  initialDate: string;
};

// Typing pauses this long before the search is sent
const SEARCH_DELAY_MS = 300;

const controlClass =
  "h-10 rounded-xl border border-line bg-surface px-3 text-sm text-ink transition-colors hover:border-muted/40 focus-visible:border-brand";
const buttonClass =
  "inline-flex h-10 items-center justify-center rounded-xl border border-line bg-surface px-3 text-sm font-semibold text-ink transition-colors hover:bg-cream disabled:cursor-not-allowed disabled:opacity-50";

// Reservations for any day, past or future, or matching a search across every
// day. The backend filters by Karachi day, status, meal and search.
export function ReservationBrowser({ today, initialDate }: ReservationBrowserProps) {
  const [date, setDate] = useState(initialDate);
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [mealType, setMealType] = useState<MealFilter>("all");

  // Send the search once typing pauses
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchText.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [searchText]);

  // Keep the day in the address, so going back from a reservation returns to it
  useEffect(() => {
    window.history.replaceState(null, "", `/staff?date=${date}${window.location.hash}`);
  }, [date]);

  // A search covers every day; otherwise the chosen day is listed
  const query: StaffReservationQuery = search ? { search, status, mealType } : { date, status, mealType };
  const result = useApiData(() => getStaffReservations(query), JSON.stringify(query));

  const isSearching = search !== "";
  const hasFilters = status !== "all" || mealType !== "all";

  return (
    <section id="reservations" aria-labelledby="reservations-heading" className="scroll-mt-24 lg:scroll-mt-8">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="reservations-heading" className="font-display text-2xl font-semibold text-ink">
            Reservations
          </h2>
          <p className="mt-0.5 text-sm text-muted" aria-live="polite">
            {isSearching ? (
              <>
                Matches for <span className="font-semibold text-ink">“{search}”</span> on every day, latest first
              </>
            ) : (
              <>
                <span className="font-semibold text-ink">{formatLongDay(date)}</span>
                {date === today && " · Today"}
              </>
            )}
          </p>
        </div>
      </div>

      <Panel>
        <div className="flex flex-col gap-3 border-b border-line p-3 sm:p-4">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setDate((day) => shiftDay(day, -1))}
              disabled={isSearching}
              className={buttonClass}
              aria-label="Previous day"
            >
              ‹
            </button>
            <label className="sr-only" htmlFor="reservation-date">
              Date
            </label>
            <input
              id="reservation-date"
              type="date"
              value={date}
              onChange={(event) => {
                if (isDay(event.target.value)) setDate(event.target.value);
              }}
              disabled={isSearching}
              className={`${controlClass} min-w-0 flex-1 sm:flex-none`}
            />
            <button
              type="button"
              onClick={() => setDate((day) => shiftDay(day, 1))}
              disabled={isSearching}
              className={buttonClass}
              aria-label="Next day"
            >
              ›
            </button>
            <button
              type="button"
              onClick={() => setDate(today)}
              disabled={isSearching || date === today}
              className={`${buttonClass} px-4`}
            >
              Today
            </button>
          </div>

          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
            <div className="relative">
              <label className="sr-only" htmlFor="reservation-search">
                Search by reservation code or guest name
              </label>
              <input
                id="reservation-search"
                type="search"
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                placeholder="Search code or guest name (all dates)"
                maxLength={100}
                className={`${controlClass} w-full`}
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-muted">
              <span className="shrink-0">Status</span>
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value as StatusFilter)}
                className={`${controlClass} flex-1`}
              >
                <option value="all">All</option>
                <option value="confirmed">Confirmed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm text-muted">
              <span className="shrink-0">Meal</span>
              <select
                value={mealType}
                onChange={(event) => setMealType(event.target.value as MealFilter)}
                className={`${controlClass} flex-1`}
              >
                <option value="all">All</option>
                <option value="buffet">Buffet</option>
                <option value="a_la_carte">À la carte</option>
              </select>
            </label>
          </div>
        </div>

        {result.isLoading ? (
          <LoadingState label="Loading reservations..." />
        ) : result.error ? (
          <ErrorState message={result.error} onRetry={result.retry} />
        ) : result.data && result.data.reservations.length > 0 ? (
          <div className="p-3 sm:p-4">
            <ul className="grid gap-3 md:grid-cols-2">
              {result.data.reservations.map((reservation) => (
                <li key={reservation.reservationCode}>
                  <StaffReservationCard reservation={reservation} showDate={isSearching} />
                </li>
              ))}
            </ul>
            {result.data.truncated && (
              <p className="mt-3 text-center text-xs text-muted">
                Showing the latest {result.data.reservations.length} matches. Type more of the code or name to narrow it down.
              </p>
            )}
          </div>
        ) : (
          <EmptyState title={isSearching ? "No matching reservations" : "No reservations on this day"}>
            {isSearching
              ? "Nothing matches that code or name on any day."
              : hasFilters
                ? "Nothing matches these filters on this day. Try All, or another day."
                : "Pick another day with the arrows or the calendar."}
          </EmptyState>
        )}
      </Panel>
    </section>
  );
}
