const crypto = require("node:crypto");
const prisma = require("../lib/prisma");
const restaurantPolicies = require("../config/restaurant-policies");
const { validateReservationRequest } = require("./reservation-validation.service");
const { validateExtras } = require("./extras-validation.service");
const { findOwnedReservation, RESERVATION_NOT_FOUND_MESSAGE } = require("./reservation-retrieval.service");
const { calculateEstimatedTotal } = require("./pricing.service");

// A pending proposal must be accepted within this time
const PROPOSAL_EXPIRY_MS = restaurantPolicies.conversation.proposalExpiryMinutes * 60 * 1000;

// The request can't be done in the proposal's or conversation's current state.
// code is one of:
// - "CONVERSATION_NOT_FOUND" or "CONVERSATION_NOT_ACTIVE" (creating a proposal)
// - "PROPOSAL_NOT_FOUND": no such proposal in this conversation
// - "PROPOSAL_NOT_PENDING": it was already accepted, declined, expired or rejected;
//   proposalStatus says which
// message is safe to show.
class ProposalServiceError extends Error {
  constructor(code, message, proposalStatus) {
    super(message);
    this.name = "ProposalServiceError";
    this.code = code;
    if (proposalStatus !== undefined) this.proposalStatus = proposalStatus;
  }
}

function requireId(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function requireDate(value, name) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${name} must be a valid Date`);
  }
}

const notFound = () =>
  new ProposalServiceError("PROPOSAL_NOT_FOUND", "We couldn't find that proposal.");

const notPending = (status) =>
  new ProposalServiceError(
    "PROPOSAL_NOT_PENDING",
    status === "expired"
      ? "That proposal has expired. Please ask for a new one."
      : "That proposal is no longer open.",
    status,
  );

// Only ever moves a proposal out of "pending", so a resolved proposal can never
// become pending again. Returns false if another request resolved it first.
async function resolvePending(tx, proposalId, status) {
  const { count } = await tx.proposal.updateMany({
    where: { id: proposalId, status: "pending" },
    data: { status },
  });
  return count === 1;
}

const isPlainObject = (value) =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

// Turn the stored JSON string back into an object for the caller
const withParsedPayload = (proposal) => ({ ...proposal, payload: JSON.parse(proposal.payload) });

async function requireActiveConversation(tx, conversationId) {
  const conversation = await tx.conversation.findUnique({ where: { id: conversationId } });
  if (!conversation) {
    throw new ProposalServiceError("CONVERSATION_NOT_FOUND", "Conversation not found.");
  }
  if (conversation.status !== "active") {
    throw new ProposalServiceError("CONVERSATION_NOT_ACTIVE", "This conversation is no longer active.");
  }
}

// Keep one pending proposal per conversation: older pending ones become "expired"
// if their time is up, or "declined" otherwise, then the new one is created.
// Run inside the transaction that creates the proposal.
async function replacePendingProposal(tx, { conversationId, actionType, reservationId, serializedPayload, now }) {
  await tx.proposal.updateMany({
    where: { conversationId, status: "pending", expiresAt: { lte: now } },
    data: { status: "expired" },
  });
  await tx.proposal.updateMany({
    where: { conversationId, status: "pending" },
    data: { status: "declined" },
  });

  return tx.proposal.create({
    data: {
      conversationId,
      actionType,
      reservationId,
      payload: serializedPayload,
      status: "pending",
      expiresAt: new Date(now.getTime() + PROPOSAL_EXPIRY_MS),
    },
  });
}

// Create a pending "create" proposal for a reservation the guest still has to accept.
// payload is the validated reservation request, as an object (not a JSON string);
// Dates in it are stored as ISO strings. now is the current instant; pass a fixed
// Date in tests.
// The conversation keeps one pending proposal: older pending ones become "expired"
// if their time is up, or "declined" otherwise. This and the new proposal are
// saved in one transaction, so a failure leaves the old proposals as they were.
// Creates no Reservation and doesn't hold any tables.
// Returns the new proposal, with payload as an object.
// Throws TypeError for invalid arguments, and ProposalServiceError if the
// conversation is missing or not active.
async function createReservationProposal({ conversationId, payload, now = new Date() } = {}) {
  requireId(conversationId, "conversationId");
  if (!isPlainObject(payload)) {
    throw new TypeError("payload must be a plain object, not a JSON string or other value");
  }
  requireDate(now, "now");

  let serializedPayload;
  try {
    serializedPayload = JSON.stringify(payload);
  } catch {
    // For example a circular reference or a BigInt
    throw new TypeError("payload can't be saved as JSON");
  }

  // SQLite transactions are serializable and the adapter runs them one at a time,
  // so two requests at once can't both leave a pending proposal
  const proposal = await prisma.$transaction(async (tx) => {
    await requireActiveConversation(tx, conversationId);
    return replacePendingProposal(tx, {
      conversationId,
      actionType: "create",
      reservationId: null,
      serializedPayload,
      now,
    });
  });

  return withParsedPayload(proposal);
}

// Get a proposal from this conversation. A pending proposal whose time is up
// (expiresAt at or before now) is marked "expired" first; other statuses are
// never changed. Returns the proposal, with payload as an object.
// Throws TypeError for invalid arguments, and ProposalServiceError
// (PROPOSAL_NOT_FOUND) if the conversation has no such proposal.
async function getReservationProposal({ proposalId, conversationId, now = new Date() } = {}) {
  requireId(proposalId, "proposalId");
  requireId(conversationId, "conversationId");
  requireDate(now, "now");

  const proposal = await prisma.$transaction(async (tx) => {
    // Matching on conversationId too, so one conversation can't read another's proposal
    const found = await tx.proposal.findFirst({ where: { id: proposalId, conversationId } });
    if (!found) throw notFound();

    if (found.status === "pending" && found.expiresAt <= now) {
      await resolvePending(tx, proposalId, "expired");
      return tx.proposal.findUnique({ where: { id: proposalId } });
    }
    return found;
  });

  return withParsedPayload(proposal);
}

// The guest said no to a pending proposal. If its time was already up, it is
// marked "expired" instead. Creates and changes no Reservation.
// Returns { outcome: "declined" | "expired", proposal }, with payload as an object.
// Throws TypeError for invalid arguments, and ProposalServiceError with
// PROPOSAL_NOT_FOUND, or PROPOSAL_NOT_PENDING if it was no longer pending
// (accepted, declined, expired or rejected), which leaves it unchanged.
async function declineReservationProposal({ proposalId, conversationId, now = new Date() } = {}) {
  requireId(proposalId, "proposalId");
  requireId(conversationId, "conversationId");
  requireDate(now, "now");

  return prisma.$transaction(async (tx) => {
    const found = await tx.proposal.findFirst({ where: { id: proposalId, conversationId } });
    if (!found) throw notFound();
    if (found.status !== "pending") throw notPending(found.status);

    const outcome = found.expiresAt <= now ? "expired" : "declined";

    // Only succeeds while it's still pending, in case another request changed it
    if (!(await resolvePending(tx, proposalId, outcome))) {
      const current = await tx.proposal.findUnique({ where: { id: proposalId } });
      throw notPending(current.status);
    }

    const proposal = await tx.proposal.findUnique({ where: { id: proposalId } });
    return { outcome, proposal: withParsedPayload(proposal) };
  });
}

// Reservation codes are RSV- plus 4 characters (36^4, about 1.7 million codes)
const CODE_CHARACTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const CODE_LENGTH = 4;
const MAX_CODE_ATTEMPTS = 20;

const randomReservationCode = () =>
  `RSV-${Array.from({ length: CODE_LENGTH }, () => CODE_CHARACTERS[crypto.randomInt(CODE_CHARACTERS.length)]).join("")}`;

// A code no reservation uses yet. Run inside the transaction that creates the
// reservation: transactions run one at a time, so the code can't be taken between
// the check and the insert. The unique index on reservationCode is a second guard.
async function generateUniqueReservationCode(tx, randomCode = randomReservationCode) {
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const code = randomCode();
    const taken = await tx.reservation.findUnique({ where: { reservationCode: code }, select: { id: true } });
    if (!taken) return code;
  }
  throw new Error(`No free reservation code after ${MAX_CODE_ATTEMPTS} attempts`);
}

// The proposal's payload as an object, or null if it isn't valid JSON for one
function parseStoredPayload(payload) {
  try {
    const parsed = JSON.parse(payload);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// An optional note from the guest: trimmed, and null when empty or missing
function parseSpecialRequest(value) {
  if (value === undefined || value === null) return { valid: true, specialRequest: null };
  if (typeof value !== "string") {
    return { valid: false, code: "INVALID_SPECIAL_REQUEST", message: "The special request must be text." };
  }
  return { valid: true, specialRequest: value.trim() === "" ? null : value.trim() };
}

// Accept a pending proposal.
// - "create": check its request again and create the confirmed reservation,
//   its table assignments and its extras.
// - "modify": check the new details, the 3-hour cutoff (from the current start)
//   and the existing extras' notice again, then change the reservation in place
//   and replace its tables. See acceptModify.
// - "cancel": check the reservation hasn't changed and the 3-hour cutoff again,
//   then mark it cancelled. See acceptCancel.
// A "create" proposal's payload is the guest's request:
//   { date, time, mealType, adults, children, childrenUnder3?, guestName, guestPhone,
//     extras?, outsideCake?, specialRequest? }
// extras defaults to [] and childrenUnder3 to 0 (every child paying the 3-11 price).
// Tables are chosen again now, so they may differ from when the proposal was made.
//
// Everything runs in one transaction. The SQLite adapter runs transactions one at
// a time, so no other acceptance can book the same tables between the
// availability check and the table assignment. If any write fails, everything is
// rolled back and the proposal stays pending.
//
// Returns one of:
// - { outcome: "accepted", reservation, proposal }: reservation (new, modified or
//   cancelled) includes its tables and extras; an outside cake is an extra with
//   extraKey "outside_cake"
// - { outcome: "expired", proposal }: its time was up, so it is now expired
// - { outcome: "rejected", kind, code, message, proposal }: the request no longer
//   passes (kind "validation") or no tables are free (kind "availability",
//   code "TABLES_UNAVAILABLE"); the proposal is now rejected. Modify proposals
//   can also be rejected with RESERVATION_NOT_MODIFIABLE or
//   MODIFICATION_CUTOFF_PASSED or STALE_MODIFICATION_PROPOSAL, and cancel
//   proposals with RESERVATION_NOT_CANCELLABLE, CANCELLATION_CUTOFF_PASSED or
//   STALE_CANCELLATION_PROPOSAL; either can be rejected with
//   INVALID_PROPOSAL_PAYLOAD. A rejected modification or cancellation changes
//   nothing else.
// Throws TypeError for invalid arguments, and ProposalServiceError with
// PROPOSAL_NOT_FOUND, PROPOSAL_NOT_PENDING or CONVERSATION_NOT_ACTIVE, which
// change nothing.
async function acceptReservationProposal({ proposalId, conversationId, now = new Date() } = {}) {
  requireId(proposalId, "proposalId");
  requireId(conversationId, "conversationId");
  requireDate(now, "now");

  return prisma.$transaction(async (tx) => {
    const found = await tx.proposal.findFirst({ where: { id: proposalId, conversationId } });
    if (!found) throw notFound();
    if (found.status !== "pending") throw notPending(found.status);

    const conversation = await tx.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation || conversation.status !== "active") {
      throw new ProposalServiceError("CONVERSATION_NOT_ACTIVE", "This conversation is no longer active.");
    }

    // Each of these ends the attempt; returning (not throwing) keeps the status change
    const finish = async (status, result) => {
      if (!(await resolvePending(tx, proposalId, status))) {
        // Can't happen while transactions run one at a time, but never overwrite
        throw new Error("Proposal changed during acceptance");
      }
      const proposal = await tx.proposal.findUnique({ where: { id: proposalId } });
      const payload = parseStoredPayload(proposal.payload);
      return { ...result, outcome: status, proposal: { ...proposal, payload } };
    };
    const reject = (failure) =>
      finish("rejected", { kind: failure.kind ?? "validation", code: failure.code, message: failure.message });

    if (found.expiresAt <= now) return finish("expired", {});

    const payload = parseStoredPayload(found.payload);
    if (!payload) {
      return reject({ code: "INVALID_PROPOSAL_PAYLOAD", message: "This proposal's details can't be read." });
    }

    const context = { tx, proposalId, conversationId, now, reject };
    if (found.actionType === "create") return acceptCreate(context, payload);
    if (found.actionType === "modify") return acceptModify(context, found, payload);
    if (found.actionType === "cancel") return acceptCancel(context, found, payload);
    return reject({ code: "UNSUPPORTED_PROPOSAL", message: "This kind of proposal can't be accepted yet." });
  });
}

// Mark the proposal accepted and linked to the reservation, and return both.
// Only a still-pending proposal can be accepted; anything else rolls back.
async function finishAccepted(tx, proposalId, reservationId) {
  const { count } = await tx.proposal.updateMany({
    where: { id: proposalId, status: "pending" },
    data: { status: "accepted", reservationId },
  });
  if (count !== 1) throw new Error("Proposal changed during acceptance");

  const [reservation, proposal] = await Promise.all([
    tx.reservation.findUnique({
      where: { id: reservationId },
      include: {
        tables: { include: { table: true }, orderBy: { createdAt: "asc" } },
        extras: { orderBy: { createdAt: "asc" } },
      },
    }),
    tx.proposal.findUnique({ where: { id: proposalId } }),
  ]);

  return { outcome: "accepted", reservation, proposal: withParsedPayload(proposal) };
}

// The "create" part of acceptReservationProposal: request is the guest's request
async function acceptCreate({ tx, proposalId, conversationId, now, reject }, request) {
  // Check everything again, including table availability, inside this transaction
  const validated = await validateReservationRequest(request, now, { db: tx });
  if (!validated.valid) return reject(validated);

  const extras = validateExtras({
    extras: request.extras === undefined ? [] : request.extras,
    outsideCake: request.outsideCake,
    reservationStartTime: validated.startTime,
    now,
  });
  if (!extras.valid) return reject(extras);

  const note = parseSpecialRequest(request.specialRequest);
  if (!note.valid) return reject(note);

  const price = calculateEstimatedTotal({
    mealType: validated.mealType,
    adults: validated.party.adults,
    children: validated.party.children,
    childrenUnder3: request.childrenUnder3,
    extrasTotalPaisa: extras.totalExtrasPaisa,
  });
  if (!price.valid) return reject(price);

  const reservation = await tx.reservation.create({
    data: {
      conversationId,
      reservationCode: await generateUniqueReservationCode(tx),
      guestName: validated.guest.guestName,
      guestPhone: validated.guest.guestPhone,
      startTime: validated.startTime,
      endTime: validated.endTime,
      mealType: validated.mealType,
      adults: validated.party.adults,
      children: validated.party.children,
      status: "confirmed",
      estimatedTotalPaisa: price.estimatedTotalPaisa,
      specialRequest: note.specialRequest,
    },
  });

  await tx.reservationTable.createMany({
    data: validated.tables.map((table) => ({ reservationId: reservation.id, tableId: table.id })),
  });

  // The outside cake fee is stored as its own extra, so its price and pending
  // approval are kept separately from any birthday cake we provide
  const extraRows = extras.extras.map((extra) => ({ reservationId: reservation.id, ...extra }));
  if (extras.outsideCake) {
    extraRows.push({
      reservationId: reservation.id,
      extraKey: "outside_cake",
      name: extras.outsideCake.name,
      quantity: 1,
      unitPricePaisa: extras.outsideCake.serviceFeePaisa,
      lineTotalPaisa: extras.outsideCake.serviceFeePaisa,
      approvalStatus: extras.outsideCake.approvalStatus,
    });
  }
  if (extraRows.length > 0) {
    await tx.reservationExtra.createMany({ data: extraRows });
  }

  return finishAccepted(tx, proposalId, reservation.id);
}

// The parts of a reservation a modify proposal is based on, in a form that can be
// stored as JSON and compared: times as ISO strings, table ids sorted.
// reservation must include its tables.
function reservationSnapshot(reservation) {
  return {
    mealType: reservation.mealType,
    startTime: reservation.startTime.toISOString(),
    endTime: reservation.endTime.toISOString(),
    adults: reservation.adults,
    children: reservation.children,
    estimatedTotalPaisa: reservation.estimatedTotalPaisa,
    tableIds: reservation.tables.map((table) => table.tableId).sort(),
  };
}

// A stored snapshot in the same form as reservationSnapshot, or null if any part
// is missing or malformed
function parseReservationSnapshot(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { mealType, startTime, endTime, adults, children, estimatedTotalPaisa, tableIds } = value;

  const toIso = (time) => {
    if (typeof time !== "string") return null;
    const date = new Date(time);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  };
  const start = toIso(startTime);
  const end = toIso(endTime);

  if (
    typeof mealType !== "string" ||
    !start ||
    !end ||
    !Number.isInteger(adults) ||
    !Number.isInteger(children) ||
    !Number.isInteger(estimatedTotalPaisa) ||
    !Array.isArray(tableIds) ||
    !tableIds.every((id) => typeof id === "string")
  ) {
    return null;
  }

  return { mealType, startTime: start, endTime: end, adults, children, estimatedTotalPaisa, tableIds: [...tableIds].sort() };
}

function sameSnapshot(a, b) {
  return (
    a.mealType === b.mealType &&
    a.startTime === b.startTime &&
    a.endTime === b.endTime &&
    a.adults === b.adults &&
    a.children === b.children &&
    a.estimatedTotalPaisa === b.estimatedTotalPaisa &&
    a.tableIds.length === b.tableIds.length &&
    a.tableIds.every((id, index) => id === b.tableIds[index])
  );
}

// Compare a proposal's stored snapshot with the reservation as it is now.
// Returns null if they match, or the failure to reject the proposal with:
// INVALID_PROPOSAL_PAYLOAD if the snapshot is missing or malformed, or staleCode
// if the reservation has changed. reservation must include its tables.
function checkSnapshot(storedSnapshot, reservation, { staleCode, staleMessage, invalidMessage }) {
  const snapshot = parseReservationSnapshot(storedSnapshot);
  if (!snapshot) return { code: "INVALID_PROPOSAL_PAYLOAD", message: invalidMessage };
  if (!sameSnapshot(snapshot, reservationSnapshot(reservation))) return { code: staleCode, message: staleMessage };
  return null;
}

// The "cancel" part of acceptReservationProposal: payload is what
// createCancellationProposal stored. Marks the reservation cancelled, at now.
// Everything else about it is kept: its fields, its table assignments (which no
// longer block other bookings, as only confirmed reservations do) and its extras.
async function acceptCancel({ tx, proposalId, now, reject }, found, payload) {
  const reservation = found.reservationId
    ? await tx.reservation.findUnique({ where: { id: found.reservationId }, include: { tables: true } })
    : null;
  if (!reservation || reservation.status !== "confirmed") {
    return reject({
      code: "RESERVATION_NOT_CANCELLABLE",
      message: "This reservation can't be cancelled because it isn't confirmed.",
    });
  }

  const snapshotFailure = checkSnapshot(payload.current, reservation, {
    staleCode: "STALE_CANCELLATION_PROPOSAL",
    staleMessage: "This reservation has changed since the cancellation was requested. Please ask to cancel it again.",
    invalidMessage: "This cancellation's details can't be checked. Please ask to cancel it again.",
  });
  if (snapshotFailure) return reject(snapshotFailure);

  // Exactly 3 hours before the start is still allowed
  if (isInsideCutoff(reservation, now)) return reject(cancellationCutoffPassed());

  // Only a still-confirmed reservation is cancelled; anything else rolls back
  const { count } = await tx.reservation.updateMany({
    where: { id: reservation.id, status: "confirmed" },
    data: { status: "cancelled", cancelledAt: now },
  });
  if (count !== 1) throw new Error("Reservation changed during acceptance");

  return finishAccepted(tx, proposalId, reservation.id);
}

// The "modify" part of acceptReservationProposal: payload is what
// createModificationProposal stored, and its request holds the new details.
// Changes the existing reservation in place: its times, meal type, party,
// estimated total and tables, and its special request when the proposal
// changes it. Its code, guest details, status and extras (including their
// approval statuses) are kept as they are.
async function acceptModify({ tx, proposalId, now, reject }, found, payload) {
  const { request } = payload;
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    return reject({ code: "INVALID_PROPOSAL_PAYLOAD", message: "This proposal's details can't be read." });
  }

  const reservation = found.reservationId
    ? await tx.reservation.findUnique({
        where: { id: found.reservationId },
        include: { extras: true, tables: true },
      })
    : null;
  if (!reservation || reservation.status !== "confirmed") {
    return reject({
      code: "RESERVATION_NOT_MODIFIABLE",
      message: "This reservation can't be changed because it isn't confirmed.",
    });
  }

  // Refuse a proposal made against an older version of the reservation
  const snapshotFailure = checkSnapshot(payload.current, reservation, {
    staleCode: "STALE_MODIFICATION_PROPOSAL",
    staleMessage: "This reservation has changed since the proposal was made. Please ask for a new change.",
    invalidMessage: "This proposal's details can't be checked. Please ask for a new change.",
  });
  if (snapshotFailure) return reject(snapshotFailure);

  // A note change is refused too if the note changed since it was proposed
  const changesNote = Object.hasOwn(request, "specialRequest");
  if (changesNote && payload.specialRequestChange?.current !== reservation.specialRequest) {
    return reject({
      code: "STALE_MODIFICATION_PROPOSAL",
      message: "This reservation has changed since the proposal was made. Please ask for a new change.",
    });
  }

  // The cutoff is measured from the reservation's current start; exactly 3 hours is allowed
  if (isInsideCutoff(reservation, now)) {
    return reject(modificationCutoffPassed());
  }

  // Check the new details again, with the reservation's own tables counting as free
  const validated = await validateReservationRequest(
    {
      date: request.date,
      time: request.time,
      mealType: request.mealType,
      adults: request.adults,
      children: request.children,
      guestName: reservation.guestName,
      guestPhone: reservation.guestPhone,
    },
    now,
    { db: tx, excludeReservationId: reservation.id },
  );
  if (!validated.valid) return reject(validated);

  // The existing extras must still have enough notice before the new start.
  // They are only checked: their rows, prices and approval statuses stay as they are.
  const extras = validateExtras({
    extras: reservation.extras
      .filter((extra) => extra.extraKey !== "outside_cake")
      .map(({ extraKey, quantity }) => ({ extraKey, quantity })),
    outsideCake: reservation.extras.some((extra) => extra.extraKey === "outside_cake"),
    reservationStartTime: validated.startTime,
    now,
  });
  if (!extras.valid) return reject(extras);

  // The extras keep the prices they were booked at
  const price = calculateEstimatedTotal({
    mealType: validated.mealType,
    adults: validated.party.adults,
    children: validated.party.children,
    childrenUnder3: request.childrenUnder3,
    extrasTotalPaisa: reservation.extras.reduce((sum, extra) => sum + extra.lineTotalPaisa, 0),
  });
  if (!price.valid) return reject(price);

  // Only a still-confirmed reservation is changed; anything else rolls back
  const { count } = await tx.reservation.updateMany({
    where: { id: reservation.id, status: "confirmed" },
    data: {
      startTime: validated.startTime,
      endTime: validated.endTime,
      mealType: validated.mealType,
      adults: validated.party.adults,
      children: validated.party.children,
      estimatedTotalPaisa: price.estimatedTotalPaisa,
      // Stored as createModificationProposal cleaned it: trimmed text, or null
      ...(changesNote && { specialRequest: request.specialRequest }),
    },
  });
  if (count !== 1) throw new Error("Reservation changed during acceptance");

  // Replace the table assignments with the newly chosen tables
  await tx.reservationTable.deleteMany({ where: { reservationId: reservation.id } });
  await tx.reservationTable.createMany({
    data: validated.tables.map((table) => ({ reservationId: reservation.id, tableId: table.id })),
  });

  return finishAccepted(tx, proposalId, reservation.id);
}

// Changes and cancellations must be asked for at least this long before the start
const CUTOFF_HOURS = restaurantPolicies.reservations.modificationAndCancellationCutoffHours;
const CUTOFF_MS = CUTOFF_HOURS * 60 * 60 * 1000;

// True when less than the cutoff remains; exactly the cutoff is still allowed
const isInsideCutoff = (reservation, now) => reservation.startTime.getTime() - now.getTime() < CUTOFF_MS;

const modificationCutoffPassed = () => ({
  valid: false,
  kind: "validation",
  code: "MODIFICATION_CUTOFF_PASSED",
  message: `Reservations can only be changed up to ${CUTOFF_HOURS} hours before they start.`,
});

const cancellationCutoffPassed = () => ({
  valid: false,
  kind: "validation",
  code: "CANCELLATION_CUTOFF_PASSED",
  message: `Reservations can only be cancelled up to ${CUTOFF_HOURS} hours before they start.`,
});

// The reservation the guest proved is theirs with its code and phone number,
// including its extras and tables. Throws RESERVATION_NOT_FOUND otherwise, with
// the same message whichever part was wrong.
async function requireOwnedReservation(tx, reservationCode, guestPhone) {
  const reservation = await findOwnedReservation(tx, reservationCode, guestPhone, { extras: true, tables: true });
  if (!reservation) throw new ProposalServiceError("RESERVATION_NOT_FOUND", RESERVATION_NOT_FOUND_MESSAGE);
  return reservation;
}

// Create a pending "modify" proposal to change an existing reservation.
// The guest proves the reservation is theirs with its code and phone number
// (03... or +92...). The reservation may belong to an earlier conversation.
// date, time, mealType, adults, children and childrenUnder3 are the new details,
// as for a new reservation; the guest's name and phone stay as stored, and the
// reservation's extras stay attached to it, unchanged.
// specialRequest is optional: left out (undefined), the reservation keeps its
// note; a string replaces it, and an empty string or null removes it.
// now is the current instant; pass a fixed Date in tests.
//
// Nothing about the reservation is changed here. Availability is checked as if
// the reservation weren't booked, so it can keep its own tables. The tables found
// aren't held: accepting the proposal must check again.
//
// Returns { valid: true, proposal } with payload as an object:
//   { reservationCode, request, target, current, specialRequestChange? }
// where request is the new details as given (to check again on acceptance),
// target is the resulting reservation (times, party, tables, estimated total)
// and current is the reservation as it is now. Only when specialRequest was
// given, request.specialRequest is the new note (or null) and
// specialRequestChange is { current, proposed }. Older pending proposals in the
// conversation are expired or declined, as for new reservations.
// Returns { valid: false, kind, code, message } if the change isn't allowed:
// MODIFICATION_CUTOFF_PASSED, any code from validateReservationRequest (kind
// "availability" with TABLES_UNAVAILABLE when no tables fit),
// INVALID_CHILDREN_UNDER_3 or INVALID_SPECIAL_REQUEST. No proposal is created then.
// Throws TypeError for an invalid conversationId or now, and ProposalServiceError
// with CONVERSATION_NOT_FOUND, CONVERSATION_NOT_ACTIVE, RESERVATION_NOT_FOUND or
// RESERVATION_NOT_MODIFIABLE (for example a cancelled reservation).
async function createModificationProposal({
  conversationId,
  reservationCode,
  guestPhone,
  date,
  time,
  mealType,
  adults,
  children,
  childrenUnder3,
  specialRequest,
  now = new Date(),
} = {}) {
  requireId(conversationId, "conversationId");
  requireDate(now, "now");

  return prisma.$transaction(async (tx) => {
    await requireActiveConversation(tx, conversationId);

    const reservation = await requireOwnedReservation(tx, reservationCode, guestPhone);

    if (reservation.status !== "confirmed") {
      throw new ProposalServiceError(
        "RESERVATION_NOT_MODIFIABLE",
        "This reservation can't be changed because it isn't confirmed.",
      );
    }

    // Allowed up to and including exactly 3 hours before the start
    if (isInsideCutoff(reservation, now)) {
      return modificationCutoffPassed();
    }

    // Only a note that was given is part of the change
    const changesNote = specialRequest !== undefined;
    const note = parseSpecialRequest(specialRequest);
    if (!note.valid) return { ...note, kind: "validation" };

    const request = {
      date,
      time,
      mealType,
      adults,
      children,
      childrenUnder3: childrenUnder3 ?? 0,
      ...(changesNote && { specialRequest: note.specialRequest }),
    };
    const validated = await validateReservationRequest(
      { ...request, guestName: reservation.guestName, guestPhone: reservation.guestPhone },
      now,
      { db: tx, excludeReservationId: reservation.id },
    );
    if (!validated.valid) return validated;

    // The extras stay the same, so their total carries over to the new estimate
    const extrasTotalPaisa = reservation.extras.reduce((sum, extra) => sum + extra.lineTotalPaisa, 0);
    const price = calculateEstimatedTotal({
      mealType: validated.mealType,
      adults: validated.party.adults,
      children: validated.party.children,
      childrenUnder3: request.childrenUnder3,
      extrasTotalPaisa,
    });
    if (!price.valid) return { valid: false, kind: "validation", code: price.code, message: price.message };

    const payload = {
      reservationCode: reservation.reservationCode,
      request,
      target: {
        mealType: validated.mealType,
        startTime: validated.startTime,
        endTime: validated.endTime,
        adults: validated.party.adults,
        children: validated.party.children,
        childrenUnder3: request.childrenUnder3,
        tables: validated.tables,
        estimatedTotalPaisa: price.estimatedTotalPaisa,
      },
      // Checked again on acceptance, to refuse the change if the reservation moved on
      current: reservationSnapshot(reservation),
      // The note before and after; current is checked again on acceptance too
      ...(changesNote && {
        specialRequestChange: { current: reservation.specialRequest, proposed: note.specialRequest },
      }),
    };

    const created = await replacePendingProposal(tx, {
      conversationId,
      actionType: "modify",
      reservationId: reservation.id,
      serializedPayload: JSON.stringify(payload),
      now,
    });
    return { valid: true, proposal: withParsedPayload(created) };
  });
}

// Create a pending "cancel" proposal for an existing reservation. The guest proves
// it's theirs with its code and phone number, as for a modification; it may
// belong to an earlier conversation. now is the current instant; pass a fixed
// Date in tests.
// Nothing about the reservation is changed here: it stays confirmed, with its
// tables, extras and special request, until the proposal is accepted.
// Returns { valid: true, proposal } with payload { reservationCode, current },
// where current is the reservation as it is now (times, meal type, party,
// estimated total and sorted table ids), to check again on acceptance. Older
// pending proposals in the conversation are expired or declined, as for others.
// Returns { valid: false, kind, code, message } with CANCELLATION_CUTOFF_PASSED
// when less than 3 hours remain before the start; no proposal is created then.
// Throws TypeError for an invalid conversationId or now, and ProposalServiceError
// with CONVERSATION_NOT_FOUND, CONVERSATION_NOT_ACTIVE, RESERVATION_NOT_FOUND or
// RESERVATION_NOT_CANCELLABLE (a reservation that isn't confirmed).
async function createCancellationProposal({ conversationId, reservationCode, guestPhone, now = new Date() } = {}) {
  requireId(conversationId, "conversationId");
  requireDate(now, "now");

  return prisma.$transaction(async (tx) => {
    await requireActiveConversation(tx, conversationId);
    const reservation = await requireOwnedReservation(tx, reservationCode, guestPhone);

    if (reservation.status !== "confirmed") {
      throw new ProposalServiceError(
        "RESERVATION_NOT_CANCELLABLE",
        "This reservation can't be cancelled because it isn't confirmed.",
      );
    }

    // Allowed up to and including exactly 3 hours before the start
    if (isInsideCutoff(reservation, now)) return cancellationCutoffPassed();

    const created = await replacePendingProposal(tx, {
      conversationId,
      actionType: "cancel",
      reservationId: reservation.id,
      serializedPayload: JSON.stringify({
        reservationCode: reservation.reservationCode,
        current: reservationSnapshot(reservation),
      }),
      now,
    });
    return { valid: true, proposal: withParsedPayload(created) };
  });
}

module.exports = {
  createReservationProposal,
  createModificationProposal,
  createCancellationProposal,
  getReservationProposal,
  declineReservationProposal,
  acceptReservationProposal,
  generateUniqueReservationCode,
  ProposalServiceError,
};
