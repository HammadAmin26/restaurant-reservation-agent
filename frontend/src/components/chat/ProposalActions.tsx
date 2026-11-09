"use client";

// The Accept and Decline handling every proposal card shares. The backend
// decides everything: a card only changes after the backend answers.

import { useEffect, useRef, useState } from "react";
import { ApiError, getApiErrorMessage, type Message } from "@/lib/api";
import { acceptProposal, declineProposal, type ProposalStatus, type ReservationDetails } from "@/lib/reservation-api";
import { formatExpiry } from "./reservation-display";

// The parts of a card's data the actions read
export type ProposalCardData = {
  proposalId: string;
  status: ProposalStatus;
  expiresAt: string;
};

// What the backend's answer changed: the proposal's status, and the
// reservation it created, changed or cancelled once accepted
export type ProposalUpdate = {
  status: ProposalStatus;
  reservation?: ReservationDetails;
};

type ProposalResponseOptions = {
  conversationId: string;
  proposal: ProposalCardData;
  // Called with what changed, only after the backend answers; the card merges
  // it into its own data
  onChange: (update: ProposalUpdate) => void;
  // Called with the agent's reply the backend saved after an answer
  onReply: (message: Message) => void;
};

type ResponseError = { code?: string; message: string };

// The proposal's status as the backend reported it in an error, if it did:
// a refused acceptance sends the proposal, a resolved one sends its status
function statusFromError(error: unknown): ProposalStatus | null {
  if (!(error instanceof ApiError) || !error.data || typeof error.data !== "object") return null;
  const data = error.data as { proposal?: { status?: ProposalStatus }; proposalStatus?: ProposalStatus };
  return data.proposal?.status ?? data.proposalStatus ?? null;
}

// The agent's reply the backend saved when it refused an answer, such as for
// an expired proposal, if it sent one
function replyFromError(error: unknown): Message | null {
  if (!(error instanceof ApiError) || !error.data || typeof error.data !== "object") return null;
  return (error.data as { message?: Message | null }).message ?? null;
}

// Accept or decline a proposal through the backend's proposal routes
export function useProposalResponse({ conversationId, proposal, onChange, onReply }: ProposalResponseOptions) {
  const { status, expiresAt } = proposal;
  const [action, setAction] = useState<"accept" | "decline" | null>(null);
  const [error, setError] = useState<ResponseError | null>(null);
  // Set before the request starts, so a second click in the same moment is ignored
  const busy = useRef(false);

  // True once expiresAt has passed, so the buttons stop. The backend still
  // decides: it refuses an expired proposal whatever the card shows.
  const [timeIsUp, setTimeIsUp] = useState(false);
  useEffect(() => {
    if (status !== "pending") return;
    const timer = setTimeout(() => setTimeIsUp(true), Math.max(0, new Date(expiresAt).getTime() - Date.now()));
    return () => clearTimeout(timer);
  }, [status, expiresAt]);

  const isOpen = status === "pending" && !timeIsUp;

  async function respond(kind: "accept" | "decline") {
    if (busy.current || !isOpen) return;
    busy.current = true;
    setAction(kind);
    setError(null);

    try {
      if (kind === "accept") {
        const result = await acceptProposal(conversationId, proposal.proposalId);
        onChange({ status: result.proposal.status, reservation: result.reservation });
        if (result.message) onReply(result.message);
      } else {
        const result = await declineProposal(conversationId, proposal.proposalId);
        onChange({ status: result.proposal.status });
        if (result.message) onReply(result.message);
      }
    } catch (failure) {
      // Show what the backend now says the proposal is; a network failure leaves it as it was
      const reported = statusFromError(failure);
      if (reported && reported !== status) onChange({ status: reported });
      const reply = replyFromError(failure);
      if (reply) onReply(reply);
      setError({ code: failure instanceof ApiError ? failure.code : undefined, message: getApiErrorMessage(failure) });
    } finally {
      busy.current = false;
      setAction(null);
    }
  }

  return { isOpen, timeIsUp, action, error, respond };
}

const STATUS_LABELS: Record<string, string> = {
  pending: "Awaiting your answer",
  declined: "Declined",
  rejected: "Couldn't be accepted",
  expired: "Expired",
};

// The badge in a proposal card's header. acceptedLabel differs by kind, such
// as "Confirmed" for a new reservation and "Changed" for a change.
export function ProposalStatusBadge({
  status,
  timeIsUp,
  isOpen,
  acceptedLabel,
}: {
  status: ProposalStatus;
  timeIsUp: boolean;
  isOpen: boolean;
  acceptedLabel: string;
}) {
  const label =
    status === "pending" && timeIsUp ? "Expired" : status === "accepted" ? acceptedLabel : (STATUS_LABELS[status] ?? status);
  return (
    <span
      role="status"
      className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
        isOpen || status === "accepted" ? "bg-brand/10 text-brand" : "bg-ink/5 text-muted"
      }`}
    >
      {label}
    </span>
  );
}

// What the footer says in each state, for one kind of proposal
export type ProposalNotes = {
  // Before "Please answer by …"
  pending: string;
  // After "This proposal expired at …"
  expired: string;
  accepted: string;
  declined: string;
  // Rejected, or expired after an answer was refused
  failed: string;
};

// The buttons' text, at rest and while their request runs
export type ProposalButtonLabels = { accept: string; accepting: string; decline: string; declining: string };

const DEFAULT_LABELS: ProposalButtonLabels = {
  accept: "Yes, Accept",
  accepting: "Accepting...",
  decline: "No, Decline",
  declining: "Declining...",
};

type ProposalFooterProps = ReturnType<typeof useProposalResponse> & {
  status: ProposalStatus;
  expiresAt: string;
  notes: ProposalNotes;
  labels?: ProposalButtonLabels;
};

// The backend's error, the state in words, and the buttons while it's pending
export function ProposalFooter({
  status,
  expiresAt,
  notes,
  labels = DEFAULT_LABELS,
  isOpen,
  timeIsUp,
  action,
  error,
  respond,
}: ProposalFooterProps) {
  return (
    <footer className="flex flex-col gap-3 border-t border-line px-4 py-3">
      {error && (
        <p role="alert" className="rounded-xl border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
          {error.message}
          {error.code && <span className="mt-0.5 block font-mono text-xs opacity-80">{error.code}</span>}
        </p>
      )}

      <p className="text-xs text-muted">
        {status === "pending"
          ? timeIsUp
            ? `This proposal expired at ${formatExpiry(expiresAt)}. ${notes.expired}`
            : `${notes.pending} Please answer by ${formatExpiry(expiresAt)}.`
          : status === "accepted"
            ? notes.accepted
            : status === "declined"
              ? notes.declined
              : notes.failed}
      </p>

      {status === "pending" && (
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={() => respond("decline")}
            disabled={!isOpen || action !== null}
            className="rounded-full border border-line bg-surface px-5 py-2 text-sm font-semibold whitespace-nowrap text-ink transition-colors hover:bg-cream disabled:cursor-not-allowed disabled:opacity-50"
          >
            {action === "decline" ? labels.declining : labels.decline}
          </button>
          <button
            type="button"
            onClick={() => respond("accept")}
            disabled={!isOpen || action !== null}
            className="rounded-full bg-brand px-5 py-2 text-sm font-semibold whitespace-nowrap text-white transition-colors hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
          >
            {action === "accept" ? labels.accepting : labels.accept}
          </button>
        </div>
      )}
    </footer>
  );
}
