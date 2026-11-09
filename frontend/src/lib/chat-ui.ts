// Structured events the chat API can send with an assistant reply, so the chat
// can show a component (such as a proposal card) next to the message. The
// backend builds them from its own data; nothing here comes from Claude's text.

import type {
  ExtraApprovalStatus,
  MealType,
  ProposalActionType,
  ProposalStatus,
  ReservationDetails,
  ReservationProposalPayload,
  ReservationTable,
} from "./reservation-api";

// A proposal Claude created in this turn, as the backend saved it
export type ReservationProposalUiEvent = {
  type: "reservation_proposal";
  data: {
    proposalId: string;
    actionType: ProposalActionType;
    status: ProposalStatus;
    expiresAt: string;
    // The guest's request, exactly as stored on the proposal
    payload: ReservationProposalPayload;
    // The confirmed reservation, once accepted: from the accept API's response,
    // or from the history after a refresh
    reservation?: ReservationDetails | null;
  };
};

// The conversation's confirmed reservations, after Claude looked them up.
// Built from the database each time, so a reservation cancelled since then
// is no longer listed.
export type ReservationListUiEvent = {
  type: "reservation_list";
  data: {
    reservations: ReservationDetails[];
  };
};

// A reservation's details as a change or cancellation shows them: times as ISO
// strings, amounts in paisa, tables without database ids
type ModificationDetails = {
  mealType: MealType;
  startTime: string;
  endTime: string;
  adults: number;
  children: number;
  estimatedTotalPaisa: number;
  tables: ReservationTable[];
};

// A change to an existing reservation Claude proposed, as the backend saved it
export type ModificationProposalUiEvent = {
  type: "modification_proposal";
  data: {
    proposalId: string;
    status: ProposalStatus;
    expiresAt: string;
    reservationCode: string;
    // The reservation when the change was proposed
    current: ModificationDetails;
    // What it would become
    proposed: ModificationDetails & { childrenUnder3: number };
    // The special request before and after, or null when the change keeps it
    specialRequest: { current: string | null; proposed: string | null } | null;
    // The extras it keeps, unchanged
    extras: { name: string; quantity: number; approvalStatus: ExtraApprovalStatus }[];
    // The changed reservation, once accepted
    reservation?: ReservationDetails | null;
  };
};

// A cancellation of an existing reservation Claude proposed, as the backend saved it
export type CancellationProposalUiEvent = {
  type: "cancellation_proposal";
  data: {
    proposalId: string;
    status: ProposalStatus;
    expiresAt: string;
    reservationCode: string;
    // The reservation when the cancellation was proposed, with its status now
    // ("cancelled" once the proposal is accepted; null if it can't be found)
    reservation: ModificationDetails & { status: ReservationDetails["status"] | null };
  };
};

// Every kind of event. Add new kinds here as the chat gets more components.
export type ChatUiEvent =
  | ReservationProposalUiEvent
  | ReservationListUiEvent
  | ModificationProposalUiEvent
  | CancellationProposalUiEvent;
