"use client";

import type { Message } from "@/lib/api";
import type { CancellationProposalUiEvent } from "@/lib/chat-ui";
import {
  ProposalFooter,
  ProposalStatusBadge,
  useProposalResponse,
  type ProposalButtonLabels,
  type ProposalNotes,
} from "./ProposalActions";
import { formatPkr, formatSlot, MEAL_LABELS, partyText, Row, tablesText } from "./reservation-display";

type CancellationData = CancellationProposalUiEvent["data"];

type CancellationProposalCardProps = {
  conversationId: string;
  proposal: CancellationData;
  // Called with the proposal's new state, only after the backend answers
  onChange: (proposal: CancellationData) => void;
  // Called with the agent's reply the backend saved after confirming or keeping it
  onReply: (message: Message) => void;
};

const NOTES: ProposalNotes = {
  pending: "Your reservation is still confirmed.",
  expired: "Your reservation is still confirmed.",
  accepted: "Your reservation has been cancelled.",
  declined: "You kept your reservation. Nothing was changed.",
  failed: "This cancellation couldn't be completed, so nothing was changed by it.",
};

const LABELS: ProposalButtonLabels = {
  accept: "Confirm Cancellation",
  accepting: "Cancelling...",
  decline: "Keep Reservation",
  declining: "Keeping...",
};

const RESERVATION_STATUS_LABELS: Record<string, string> = {
  confirmed: "Confirmed",
  cancelled: "Cancelled",
};

// A cancellation Claude proposed, shown inside the reply that announced it.
// Every detail comes from the proposal the backend saved; the backend decides
// whether it can be confirmed, and the reservation stays confirmed until then.
export function CancellationProposalCard({ conversationId, proposal, onChange, onReply }: CancellationProposalCardProps) {
  const { status, expiresAt, reservationCode, reservation } = proposal;
  // The accept response's reservation shows the cancellation straight away;
  // after a refresh the backend sends the reservation's status itself
  const response = useProposalResponse({
    conversationId,
    proposal,
    onChange: (update) =>
      onChange({
        ...proposal,
        status: update.status,
        reservation: { ...reservation, status: update.reservation?.status ?? reservation.status },
      }),
    onReply,
  });
  const { isOpen, timeIsUp } = response;
  const reservationStatus = reservation.status;

  return (
    <section
      aria-label={`Cancel reservation ${reservationCode}`}
      className={`w-full max-w-md rounded-2xl border bg-surface shadow-sm sm:max-w-lg ${
        isOpen ? "border-danger/40" : "border-line"
      }`}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h3 className="font-display text-base font-semibold text-ink">
          {status === "accepted" ? "Reservation cancelled" : `Cancel ${reservationCode}?`}
        </h3>
        <ProposalStatusBadge status={status} timeIsUp={timeIsUp} isOpen={isOpen} acceptedLabel="Cancelled" />
      </header>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 px-4 py-3 text-sm">
        <Row label="Code">
          <span className="font-mono font-semibold tracking-wide">{reservationCode}</span>
        </Row>
        <Row label="When">{formatSlot(reservation.startTime, reservation.endTime)}</Row>
        <Row label="Meal">{MEAL_LABELS[reservation.mealType] ?? reservation.mealType}</Row>
        <Row label="Guests">{partyText(reservation.adults, reservation.children)}</Row>
        <Row label="Table">{tablesText(reservation.tables) || "—"}</Row>
        <Row label="Estimated total">{formatPkr(reservation.estimatedTotalPaisa)}</Row>
        {reservationStatus && (
          <Row label="Status">
            <span className={reservationStatus === "cancelled" ? "font-semibold text-danger" : "font-semibold text-brand"}>
              {RESERVATION_STATUS_LABELS[reservationStatus] ?? reservationStatus}
            </span>
          </Row>
        )}
      </dl>

      <ProposalFooter {...response} status={status} expiresAt={expiresAt} notes={NOTES} labels={LABELS} />
    </section>
  );
}
