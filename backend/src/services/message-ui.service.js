const prisma = require("../lib/prisma");
const { toReservationDetails, DETAILS_INCLUDE } = require("./reservation-retrieval.service");

// What a message needs loaded to build its ui: pass as Prisma's include
const MESSAGE_UI_INCLUDE = {
  proposal: { include: { reservation: { include: DETAILS_INCLUDE } } },
  reservation: { include: DETAILS_INCLUDE },
};

// The proposal's payload as an object, or null if it can't be read
function parsePayload(payload) {
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

const byTableNumber = (a, b) => a.tableNumber.localeCompare(b.tableNumber, "en", { numeric: true });

// A table for the chat, without its database id
const publicTable = ({ tableNumber, section, capacity }) => ({ tableNumber, section, capacity });

// A modify proposal's card: the reservation as it was when the change was
// proposed (current), what it would become (proposed), and the extras it keeps.
// Built from the payload the proposal service stored; the current tables are
// looked up from their ids in tablesById. Null if the payload can't be read.
function modificationUi(proposal, tablesById) {
  const payload = parsePayload(proposal.payload);
  const { current, target } = payload ?? {};
  if (!current || !target || !Array.isArray(current.tableIds) || !Array.isArray(target.tables)) return null;

  const { reservation } = proposal;
  return {
    type: "modification_proposal",
    data: {
      proposalId: proposal.id,
      status: proposal.status,
      expiresAt: proposal.expiresAt.toISOString(),
      reservationCode: payload.reservationCode,
      current: {
        mealType: current.mealType,
        startTime: current.startTime,
        endTime: current.endTime,
        adults: current.adults,
        children: current.children,
        estimatedTotalPaisa: current.estimatedTotalPaisa,
        tables: snapshotTables(current.tableIds, tablesById),
      },
      proposed: {
        mealType: target.mealType,
        startTime: target.startTime,
        endTime: target.endTime,
        adults: target.adults,
        children: target.children,
        childrenUnder3: target.childrenUnder3,
        estimatedTotalPaisa: target.estimatedTotalPaisa,
        tables: target.tables.map(publicTable).sort(byTableNumber),
      },
      // The note before and after, only when the change includes it
      specialRequest: payload.specialRequestChange
        ? { current: payload.specialRequestChange.current, proposed: payload.specialRequestChange.proposed }
        : null,
      // A change keeps the reservation's extras as they are
      extras: (reservation?.extras ?? []).map(({ name, quantity, approvalStatus }) => ({ name, quantity, approvalStatus })),
      ...(proposal.status === "accepted" &&
        reservation && { reservation: toReservationDetails(reservation, { includeGuest: true }) }),
    },
  };
}

// A snapshot's tables for the chat, looked up from their ids in tablesById
const snapshotTables = (tableIds, tablesById) =>
  tableIds
    .map((id) => tablesById.get(id))
    .filter(Boolean)
    .map(publicTable)
    .sort(byTableNumber);

// A cancel proposal's card: the reservation as it was when the cancellation
// was proposed, and its status now (confirmed until the proposal is accepted).
// Null if the payload can't be read.
function cancellationUi(proposal, tablesById) {
  const payload = parsePayload(proposal.payload);
  const current = payload?.current;
  if (!current || !Array.isArray(current.tableIds)) return null;

  return {
    type: "cancellation_proposal",
    data: {
      proposalId: proposal.id,
      status: proposal.status,
      expiresAt: proposal.expiresAt.toISOString(),
      reservationCode: payload.reservationCode,
      reservation: {
        status: proposal.reservation?.status ?? null,
        mealType: current.mealType,
        startTime: current.startTime,
        endTime: current.endTime,
        adults: current.adults,
        children: current.children,
        estimatedTotalPaisa: current.estimatedTotalPaisa,
        tables: snapshotTables(current.tableIds, tablesById),
      },
    },
  };
}

// The component a message shows, built from the database as it is now, so a
// card loaded after a refresh has the latest status. Null for a plain message.
// message must be loaded with MESSAGE_UI_INCLUDE. related holds what
// toPublicMessages loads for some kinds:
// - confirmedReservations: the conversation's confirmed reservations, for a
//   reservation_list message
// - tablesById: restaurant tables by id, for a modification_proposal or
//   cancellation_proposal message
//
// A reservation_proposal ui is:
//   { type: "reservation_proposal",
//     data: { proposalId, actionType, status, expiresAt, payload,
//             reservation? (only once accepted, as toReservationDetails) } }
// A modification_proposal ui is:
//   { type: "modification_proposal",
//     data: { proposalId, status, expiresAt, reservationCode, current, proposed,
//             specialRequest ({ current, proposed } or null when unchanged),
//             extras, reservation? (only once accepted) } }
// A cancellation_proposal ui is:
//   { type: "cancellation_proposal",
//     data: { proposalId, status, expiresAt, reservationCode,
//             reservation: { status (now), mealType, startTime, endTime,
//                            adults, children, estimatedTotalPaisa, tables } } }
// A reservation_list ui is the confirmed reservations made up to the message,
// or null if none are confirmed any more:
//   { type: "reservation_list", data: { reservations: [toReservationDetails] } }
// A reservation_lookup message (found by code and phone, maybe from another
// conversation) shows its one reservation the same way, while it's confirmed.
function toMessageUi(message, { confirmedReservations = [], tablesById = new Map() } = {}) {
  if (message.uiType === "reservation_lookup") {
    if (message.reservation?.status !== "confirmed") return null;
    return {
      type: "reservation_list",
      data: { reservations: [toReservationDetails(message.reservation, { includeGuest: true })] },
    };
  }

  if (message.uiType === "reservation_list") {
    const shown = confirmedReservations.filter((reservation) => reservation.createdAt <= message.createdAt);
    if (shown.length === 0) return null;
    return {
      type: "reservation_list",
      data: { reservations: shown.map((reservation) => toReservationDetails(reservation, { includeGuest: true })) },
    };
  }

  if (message.uiType === "modification_proposal") {
    return message.proposal ? modificationUi(message.proposal, tablesById) : null;
  }

  if (message.uiType === "cancellation_proposal") {
    return message.proposal ? cancellationUi(message.proposal, tablesById) : null;
  }

  if (message.uiType !== "reservation_proposal" || !message.proposal) return null;

  const { proposal } = message;
  const payload = parsePayload(proposal.payload);
  if (!payload) return null;

  return {
    type: "reservation_proposal",
    data: {
      proposalId: proposal.id,
      actionType: proposal.actionType,
      status: proposal.status,
      expiresAt: proposal.expiresAt.toISOString(),
      payload,
      ...(proposal.status === "accepted" &&
        proposal.reservation && { reservation: toReservationDetails(proposal.reservation, { includeGuest: true }) }),
    },
  };
}

// A message as the API returns it: its ui instead of the uiType, proposalId and
// reservationId columns. related is as for toMessageUi.
function toPublicMessage(message, related) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    ui: toMessageUi(message, related),
  };
}

// The conversation's confirmed reservations, earliest first, with what
// toReservationDetails needs
const loadConfirmedReservations = (conversationId) =>
  prisma.reservation.findMany({
    where: { conversationId, status: "confirmed" },
    include: DETAILS_INCLUDE,
    orderBy: [{ startTime: "asc" }, { reservationCode: "asc" }],
  });

// Cards that show a reservation snapshot, whose tables are stored as ids
const SNAPSHOT_UI_TYPES = ["modification_proposal", "cancellation_proposal"];

// The tables the modification and cancellation cards' snapshots use, by id
async function loadSnapshotTables(messages) {
  const ids = new Set();
  for (const message of messages) {
    if (!SNAPSHOT_UI_TYPES.includes(message.uiType) || !message.proposal) continue;
    const tableIds = parsePayload(message.proposal.payload)?.current?.tableIds;
    if (Array.isArray(tableIds)) tableIds.forEach((id) => ids.add(id));
  }
  if (ids.size === 0) return new Map();

  const tables = await prisma.restaurantTable.findMany({ where: { id: { in: [...ids] } } });
  return new Map(tables.map((table) => [table.id, table]));
}

// Messages from one conversation in the public shape. What the cards need
// beyond the message's include is loaded once, and only when a message uses it.
async function toPublicMessages(messages) {
  const listMessage = messages.find((message) => message.uiType === "reservation_list");
  const [confirmedReservations, tablesById] = await Promise.all([
    listMessage ? loadConfirmedReservations(listMessage.conversationId) : [],
    loadSnapshotTables(messages),
  ]);
  return messages.map((message) => toPublicMessage(message, { confirmedReservations, tablesById }));
}

module.exports = { MESSAGE_UI_INCLUDE, toMessageUi, toPublicMessage, toPublicMessages };
