"use client";

import type { Message } from "@/lib/api";
import type { ModificationProposalUiEvent } from "@/lib/chat-ui";
import { ProposalFooter, ProposalStatusBadge, useProposalResponse, type ProposalNotes } from "./ProposalActions";
import { ConfirmedReservation, formatPkr, formatSlot, MEAL_LABELS, partyText, tablesText } from "./reservation-display";

type ModificationData = ModificationProposalUiEvent["data"];
type Details = ModificationData["current"];

type ModificationProposalCardProps = {
  conversationId: string;
  proposal: ModificationData;
  // Called with the proposal's new state, only after the backend answers
  onChange: (proposal: ModificationData) => void;
  // Called with the agent's reply the backend saved after accepting or declining
  onReply: (message: Message) => void;
};

const NOTES: ProposalNotes = {
  pending: "Nothing has changed yet.",
  expired: "Your reservation wasn't changed.",
  accepted: "Your reservation has been updated.",
  declined: "You declined this change. Your reservation wasn't changed.",
  failed: "This change couldn't be made, so your reservation wasn't changed.",
};

// Each compared detail, as text for the current and proposed reservation
const ROWS: { label: string; text: (details: Details) => string }[] = [
  { label: "When", text: (d) => formatSlot(d.startTime, d.endTime) },
  { label: "Meal", text: (d) => MEAL_LABELS[d.mealType] ?? d.mealType },
  { label: "Guests", text: (d) => partyText(d.adults, d.children) },
  { label: "Table", text: (d) => tablesText(d.tables) || "—" },
  { label: "Estimated total", text: (d) => formatPkr(d.estimatedTotalPaisa) },
];

// A change to an existing reservation Claude proposed, shown inside the reply
// that announced it: the reservation as it is and as it would be. Every detail
// comes from the proposal the backend saved; the backend decides whether it
// can be accepted, and the reservation stays as it is until then.
export function ModificationProposalCard({ conversationId, proposal, onChange, onReply }: ModificationProposalCardProps) {
  const { status, expiresAt, reservationCode, current, proposed, specialRequest, extras, reservation } = proposal;
  const response = useProposalResponse({
    conversationId,
    proposal,
    onChange: (update) => onChange({ ...proposal, ...update }),
    onReply,
  });
  const { isOpen, timeIsUp } = response;

  return (
    <section
      aria-label={`Change to reservation ${reservationCode}`}
      className={`w-full max-w-md rounded-2xl border bg-surface shadow-sm sm:max-w-lg ${
        isOpen || status === "accepted" ? "border-brand/40" : "border-line"
      }`}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h3 className="font-display text-base font-semibold text-ink">
          {status === "accepted" ? "Reservation updated" : `Change to ${reservationCode}`}
        </h3>
        <ProposalStatusBadge status={status} timeIsUp={timeIsUp} isOpen={isOpen} acceptedLabel="Changed" />
      </header>

      {status === "accepted" && reservation ? (
        <ConfirmedReservation reservation={reservation} />
      ) : (
        <div className="flex flex-col gap-3 px-4 py-3 text-sm">
          <table className="w-full table-fixed border-collapse text-left">
            <thead>
              <tr className="text-xs text-muted">
                <th scope="col" className="w-[28%] pb-1 font-normal">
                  <span className="sr-only">Detail</span>
                </th>
                <th scope="col" className="pb-1 font-normal">Now</th>
                <th scope="col" className="pb-1 font-normal">New</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map(({ label, text }) => {
                const before = text(current);
                const after = text(proposed);
                const changed = before !== after;
                return (
                  <tr key={label} className="border-t border-line align-top">
                    <th scope="row" className="py-1.5 pr-2 font-normal text-muted">
                      {label}
                    </th>
                    <td className="py-1.5 pr-2 wrap-anywhere text-muted">{before}</td>
                    <td className={`py-1.5 wrap-anywhere ${changed ? "font-semibold text-brand" : "text-ink"}`}>
                      {after}
                      {changed && <span className="sr-only"> (changed)</span>}
                    </td>
                  </tr>
                );
              })}
              {specialRequest && (
                <tr className="border-t border-line align-top">
                  <th scope="row" className="py-1.5 pr-2 font-normal text-muted">
                    Request
                  </th>
                  <td className="py-1.5 pr-2 wrap-anywhere text-muted">{specialRequest.current || "—"}</td>
                  <td className="py-1.5 wrap-anywhere font-semibold text-brand">
                    {specialRequest.proposed || "None"}
                    <span className="sr-only"> (changed)</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {extras.length > 0 && (
            <p className="text-xs text-muted">
              Your extras stay as they are: {extras.map((extra) => `${extra.name} × ${extra.quantity}`).join(", ")}.
            </p>
          )}
        </div>
      )}

      <ProposalFooter {...response} status={status} expiresAt={expiresAt} notes={NOTES} />
    </section>
  );
}
