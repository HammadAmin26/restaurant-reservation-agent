"use client";

import type { Message } from "@/lib/api";
import type { ReservationProposalUiEvent } from "@/lib/chat-ui";
import { ProposalFooter, ProposalStatusBadge, useProposalResponse, type ProposalNotes } from "./ProposalActions";
import { ConfirmedReservation, MEAL_LABELS, partyText, Row } from "./reservation-display";

type ProposalData = ReservationProposalUiEvent["data"];

type ReservationProposalCardProps = {
  conversationId: string;
  proposal: ProposalData;
  // Called with the proposal's new state, only after the backend answers
  onChange: (proposal: ProposalData) => void;
  // Called with the agent's reply the backend saved after accepting or declining
  onReply: (message: Message) => void;
};

const EXTRA_LABELS: Record<string, string> = {
  birthday_cake: "Birthday cake",
  candles: "Candles",
  high_chair: "High chair",
  balloons: "Balloons",
  birthday_decorations: "Birthday decorations",
};

const NOTES: ProposalNotes = {
  pending: "Not confirmed yet.",
  expired: "Ask for a new one if you'd still like to book.",
  accepted: "Your reservation is confirmed.",
  declined: "You declined this proposal. Nothing was booked.",
  failed: "Nothing was booked from this proposal. Ask for a new one if you'd still like to book.",
};

// "Friday 13 November 2026", for a YYYY-MM-DD date in Karachi
function formatDate(date: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Karachi",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(`${date}T12:00:00+05:00`));
}

// A reservation proposal Claude created, shown inside the reply that announced it.
// Every detail comes from the proposal the backend saved; the backend decides
// whether it can be accepted.
export function ReservationProposalCard({ conversationId, proposal, onChange, onReply }: ReservationProposalCardProps) {
  const { payload, status, expiresAt, reservation } = proposal;
  const response = useProposalResponse({
    conversationId,
    proposal,
    onChange: (update) => onChange({ ...proposal, ...update }),
    onReply,
  });
  const { isOpen, timeIsUp } = response;

  const extras = payload.extras ?? [];

  return (
    <section
      aria-label="Reservation proposal"
      className={`w-full max-w-md rounded-2xl border bg-surface shadow-sm sm:max-w-lg ${
        isOpen || status === "accepted" ? "border-brand/40" : "border-line"
      }`}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h3 className="font-display text-base font-semibold text-ink">
          {status === "accepted" ? "Reservation confirmed" : "Reservation proposal"}
        </h3>
        <ProposalStatusBadge status={status} timeIsUp={timeIsUp} isOpen={isOpen} acceptedLabel="Confirmed" />
      </header>

      {status === "accepted" && reservation ? (
        <ConfirmedReservation reservation={reservation} />
      ) : (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 px-4 py-3 text-sm">
          <Row label="Name">{payload.guestName}</Row>
          <Row label="Date">
            {formatDate(payload.date)}
            {payload.time ? `, ${payload.time}` : ""}
          </Row>
          <Row label="Meal">{MEAL_LABELS[payload.mealType] ?? payload.mealType}</Row>
          <Row label="Guests">
            {partyText(payload.adults, payload.children)}
            {payload.childrenUnder3 ? ` (${payload.childrenUnder3} under 3)` : ""}
          </Row>
          {extras.length > 0 && (
            <Row label="Extras">
              {extras.map((extra) => `${EXTRA_LABELS[extra.extraKey] ?? extra.extraKey} × ${extra.quantity}`).join(", ")}
            </Row>
          )}
          {payload.outsideCake && <Row label="Own cake">Yes, you&apos;ll bring it (needs staff approval)</Row>}
          {payload.specialRequest && <Row label="Request">{payload.specialRequest}</Row>}
        </dl>
      )}

      <ProposalFooter {...response} status={status} expiresAt={expiresAt} notes={NOTES} />
    </section>
  );
}
