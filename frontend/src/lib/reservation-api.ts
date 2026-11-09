// Client for the Express reservation routes. Types match what the backend sends:
// dates arrive as ISO strings, and every amount is integer paisa (PKR 1 = 100).
// Failures throw ApiError with the backend's status, message, code, kind and data.

import { request, type Message } from "./api";

export type MealType = "buffet_lunch" | "buffet_dinner" | "a_la_carte";
export type ReservationStatus = "confirmed" | "cancelled";
export type ExtraApprovalStatus = "not_required" | "pending" | "approved" | "rejected";
export type ProposalStatus = "pending" | "accepted" | "rejected" | "expired" | "declined";
export type ProposalActionType = "create" | "modify" | "cancel";
// The extras a guest can ask for. Stored extras can also be "outside_cake",
// the service fee for a cake the guest brings.
export type ExtraKey = "birthday_cake" | "candles" | "high_chair" | "balloons" | "birthday_decorations";

export type ReservationTable = {
  tableNumber: string;
  section: string;
  capacity: number;
};

export type ReservationExtra = {
  extraKey: string;
  name: string;
  quantity: number;
  unitPricePaisa: number;
  lineTotalPaisa: number;
  approvalStatus: ExtraApprovalStatus;
};

// A reservation as the lookup and accept routes return it, with guest details
export type ReservationDetails = {
  reservationCode: string;
  // Lookup returns any status; the conversation list only these two
  status: ReservationStatus | (string & {});
  mealType: MealType;
  startTime: string;
  endTime: string;
  adults: number;
  children: number;
  estimatedTotalPaisa: number;
  specialRequest: string | null;
  cancelledAt: string | null;
  guestName: string;
  guestPhone: string;
  // In table number order
  tables: ReservationTable[];
  extras: ReservationExtra[];
};

// The conversation list leaves out the guest's name and phone
export type ConversationReservation = Omit<ReservationDetails, "guestName" | "guestPhone">;

// Request bodies

// A new reservation. Buffets don't need a time; childrenUnder3 (default 0) is how
// many of the children eat free.
export type ReservationProposalPayload = {
  date: string; // YYYY-MM-DD, Karachi time
  time?: string; // HH:mm, needed for à la carte
  mealType: MealType;
  adults: number;
  children: number;
  childrenUnder3?: number;
  guestName: string;
  guestPhone: string;
  extras?: { extraKey: ExtraKey; quantity: number }[];
  outsideCake?: boolean;
  specialRequest?: string;
};

// New details for an existing reservation, which the guest proves is theirs
export type ModificationProposalPayload = {
  reservationCode: string;
  guestPhone: string;
  date: string;
  time?: string;
  mealType: MealType;
  adults: number;
  children: number;
  childrenUnder3?: number;
  // Left out keeps the reservation's note; "" removes it
  specialRequest?: string;
};

export type CancellationProposalPayload = {
  reservationCode: string;
  guestPhone: string;
};

// What a proposal stores

// The reservation as it was when a modify or cancel proposal was made
export type ReservationSnapshot = {
  mealType: MealType;
  startTime: string;
  endTime: string;
  adults: number;
  children: number;
  estimatedTotalPaisa: number;
  // Sorted table ids
  tableIds: string[];
};

export type StoredModificationPayload = {
  reservationCode: string;
  // The new details as given, checked again on acceptance
  request: {
    date: string;
    time?: string;
    mealType: MealType;
    adults: number;
    children: number;
    childrenUnder3: number;
    // Only when the change includes the note: the new note, or null to remove it
    specialRequest?: string | null;
  };
  // What the reservation would become
  target: {
    mealType: MealType;
    startTime: string;
    endTime: string;
    adults: number;
    children: number;
    childrenUnder3: number;
    tables: (ReservationTable & { id: string })[];
    estimatedTotalPaisa: number;
  };
  current: ReservationSnapshot;
  // Only when the change includes the note
  specialRequestChange?: { current: string | null; proposed: string | null };
};

export type StoredCancellationPayload = {
  reservationCode: string;
  current: ReservationSnapshot;
};

type ProposalBase = {
  id: string;
  conversationId: string;
  status: ProposalStatus;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

// The payload is null only on a proposal rejected because its payload couldn't be read
export type Proposal = ProposalBase &
  (
    | { actionType: "create"; reservationId: string | null; payload: ReservationProposalPayload | null }
    | { actionType: "modify"; reservationId: string; payload: StoredModificationPayload | null }
    | { actionType: "cancel"; reservationId: string; payload: StoredCancellationPayload | null }
  );

// A new, changed or cancelled reservation, and the now accepted proposal.
// message is the agent's reply the backend saved in the chat, or null if it
// couldn't be saved.
export type AcceptResult = {
  reservation: ReservationDetails;
  proposal: Proposal;
  message: Message | null;
};

export type DeclineResult = {
  proposal: Proposal;
  message: Message | null;
};

const conversationPath = (conversationId: string) => `/conversations/${encodeURIComponent(conversationId)}`;

function postJson<T>(path: string, body?: object) {
  return request<T>(path, {
    method: "POST",
    ...(body && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
}

// Find a reservation by its code and the phone number it was booked with.
// A wrong code or phone both fail with 404 RESERVATION_NOT_FOUND.
export function lookupReservation({ reservationCode, guestPhone }: { reservationCode: string; guestPhone: string }) {
  const query = new URLSearchParams({ reservationCode, guestPhone });
  return request<ReservationDetails>(`/reservations/lookup?${query}`);
}

// The conversation's reservations, earliest first: confirmed ones, plus cancelled
// ones when includeCancelled is true
export function getConversationReservations(conversationId: string, includeCancelled = false) {
  const query = new URLSearchParams({ includeCancelled: String(includeCancelled) });
  return request<ConversationReservation[]>(`${conversationPath(conversationId)}/reservations?${query}`);
}

// Propose a new reservation. Its details are only checked when it's accepted.
export function proposeReservation(conversationId: string, payload: ReservationProposalPayload) {
  return postJson<Proposal>(`${conversationPath(conversationId)}/reservations/proposals`, payload);
}

// Propose changes to a reservation. Fails with the backend's code, for example
// 400 RESTAURANT_CLOSED or 409 TABLES_UNAVAILABLE.
export function proposeModification(conversationId: string, payload: ModificationProposalPayload) {
  return postJson<Proposal>(`${conversationPath(conversationId)}/reservations/modifications`, payload);
}

export function proposeCancellation(conversationId: string, payload: CancellationProposalPayload) {
  return postJson<Proposal>(`${conversationPath(conversationId)}/reservations/cancellations`, payload);
}

// Accept a pending proposal. A refusal is a 409 whose ApiError.data is
// { proposal } (PROPOSAL_EXPIRED, TABLES_UNAVAILABLE, ...) or { proposalStatus }
// (PROPOSAL_NOT_PENDING).
export function acceptProposal(conversationId: string, proposalId: string) {
  return postJson<AcceptResult>(
    `${conversationPath(conversationId)}/proposals/${encodeURIComponent(proposalId)}/accept`,
  );
}

export function declineProposal(conversationId: string, proposalId: string) {
  return postJson<DeclineResult>(
    `${conversationPath(conversationId)}/proposals/${encodeURIComponent(proposalId)}/decline`,
  );
}
