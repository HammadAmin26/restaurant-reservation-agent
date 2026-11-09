import Link from "next/link";
import type { StaffReservation } from "@/lib/staff-api";
import { formatPkr, MEAL_LABELS, partyText } from "../chat/reservation-display";
import { formatLongDay, formatTimeRange, karachiDayOf } from "./staff-dates";
import { ReservationStatusBadge } from "./staff-ui";

type StaffReservationCardProps = {
  reservation: StaffReservation;
  // Show the day too, when the list covers more than one
  showDate?: boolean;
};

// One reservation in the staff list; the whole card opens its details
export function StaffReservationCard({ reservation, showDate = false }: StaffReservationCardProps) {
  const cancelled = reservation.status === "cancelled";

  return (
    <Link
      href={`/staff/reservations/${encodeURIComponent(reservation.reservationCode)}`}
      className={`group flex h-full flex-col gap-3 rounded-xl border bg-surface p-4 transition-colors hover:border-brand/50 hover:bg-cream/40 ${
        cancelled ? "border-line opacity-80" : "border-line"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-sm font-semibold tracking-wide text-brand">{reservation.reservationCode}</p>
          <p className={`mt-0.5 truncate font-semibold text-ink ${cancelled ? "line-through decoration-muted/60" : ""}`}>
            {reservation.guestName}
          </p>
        </div>
        <ReservationStatusBadge status={reservation.status} />
      </div>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted">When</dt>
        <dd className="text-ink tabular-nums">
          {showDate && `${formatLongDay(karachiDayOf(reservation.startTime))}, `}
          {formatTimeRange(reservation.startTime, reservation.endTime)}
        </dd>
        <dt className="text-muted">Meal</dt>
        <dd className="text-ink">{MEAL_LABELS[reservation.mealType] ?? reservation.mealType}</dd>
        <dt className="text-muted">Guests</dt>
        <dd className="text-ink">{partyText(reservation.adults, reservation.children)}</dd>
        <dt className="text-muted">Table</dt>
        <dd className="text-ink">{reservation.tables.map((table) => table.tableNumber).join(", ") || "—"}</dd>
      </dl>

      <div className="mt-auto flex items-baseline justify-between gap-3 border-t border-line pt-2 text-sm">
        <span className="text-muted">Estimated total</span>
        <span className="font-semibold text-ink tabular-nums">{formatPkr(reservation.estimatedTotalPaisa)}</span>
      </div>
      <span className="sr-only">Open the reservation&apos;s details</span>
    </Link>
  );
}
