// Display helpers shared by the chat's reservation and proposal cards.
// They only format what the backend sent; nothing here decides anything.

import type { ReactNode } from "react";
import type { ReservationDetails } from "@/lib/reservation-api";

export const MEAL_LABELS: Record<string, string> = {
  buffet_lunch: "Buffet lunch",
  buffet_dinner: "Buffet dinner",
  a_la_carte: "À la carte",
};

// "Fri, 13 Nov 2026, 19:00–23:00" in Karachi time
export function formatSlot(start: string, end: string) {
  const options = { timeZone: "Asia/Karachi", hour: "2-digit", minute: "2-digit", hour12: false } as const;
  const day = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Karachi",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(start));
  const from = new Intl.DateTimeFormat("en-GB", options).format(new Date(start));
  const to = new Intl.DateTimeFormat("en-GB", options).format(new Date(end));
  return `${day}, ${from}–${to}`;
}

// The time a proposal expires, in the guest's own clock
export function formatExpiry(expiresAt: string) {
  return new Date(expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// Display only: the API always sends integer paisa
export function formatPkr(paisa: number) {
  const rupees = (paisa / 100).toLocaleString("en-US", {
    minimumFractionDigits: paisa % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `PKR ${rupees}`;
}

export const partyText = (adults: number, children: number) =>
  [
    `${adults} ${adults === 1 ? "adult" : "adults"}`,
    children > 0 ? `${children} ${children === 1 ? "child" : "children"}` : null,
  ]
    .filter(Boolean)
    .join(", ");

export const tablesText = (tables: { tableNumber: string; section: string }[]) =>
  tables.map((table) => `${table.tableNumber} (${table.section.toLowerCase()})`).join(", ");

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="wrap-anywhere text-ink">{children}</dd>
    </>
  );
}

// A reservation the backend confirmed, from an accept response or a lookup
export function ConfirmedReservation({ reservation }: { reservation: ReservationDetails }) {
  return (
    <div className="flex flex-col gap-3 px-4 py-3 text-sm">
      <div className="rounded-xl bg-brand/5 px-3 py-2">
        <span className="block text-xs text-muted">Reservation code</span>
        <span className="font-mono text-lg font-semibold tracking-wide text-ink">{reservation.reservationCode}</span>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
        <Row label="Name">{reservation.guestName}</Row>
        <Row label="When">{formatSlot(reservation.startTime, reservation.endTime)}</Row>
        <Row label="Meal">{MEAL_LABELS[reservation.mealType] ?? reservation.mealType}</Row>
        <Row label="Guests">{partyText(reservation.adults, reservation.children)}</Row>
        <Row label="Table">{tablesText(reservation.tables)}</Row>
        {reservation.specialRequest && <Row label="Request">{reservation.specialRequest}</Row>}
      </dl>
      {reservation.extras.length > 0 && (
        <ul className="flex flex-col gap-1 border-t border-line pt-2">
          {reservation.extras.map((extra) => (
            <li key={extra.extraKey} className="flex items-baseline justify-between gap-3">
              <span className="text-muted">
                {extra.name} × {extra.quantity}
                {extra.approvalStatus === "pending" ? " · awaiting staff approval" : ""}
              </span>
              <span className="whitespace-nowrap text-ink">{formatPkr(extra.lineTotalPaisa)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-baseline justify-between gap-3 border-t border-line pt-2 font-semibold text-ink">
        <span>Estimated total</span>
        <span className="whitespace-nowrap">{formatPkr(reservation.estimatedTotalPaisa)}</span>
      </div>
    </div>
  );
}
