import type { ReservationListUiEvent } from "@/lib/chat-ui";
import { ConfirmedReservation } from "./reservation-display";

type ReservationListCardsProps = {
  reservations: ReservationListUiEvent["data"]["reservations"];
};

// The confirmed reservations Claude looked up, one card each, shown inside the
// reply that answered the guest. Every detail comes from the backend.
export function ReservationListCards({ reservations }: ReservationListCardsProps) {
  return (
    <div className="flex flex-col gap-3">
      {reservations.map((reservation) => (
        <section
          key={reservation.reservationCode}
          aria-label={`Reservation ${reservation.reservationCode}`}
          className="w-full max-w-md rounded-2xl border border-brand/40 bg-surface shadow-sm sm:max-w-lg"
        >
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
            <h3 className="font-display text-base font-semibold text-ink">Your reservation</h3>
            <span className="rounded-full bg-brand/10 px-2.5 py-0.5 text-xs font-semibold text-brand">Confirmed</span>
          </header>
          <ConfirmedReservation reservation={reservation} />
        </section>
      ))}
    </div>
  );
}
