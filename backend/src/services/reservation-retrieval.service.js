const prisma = require("../lib/prisma");
const { normalizeMobilePhone } = require("./guest-details-validation.service");

// Shown whenever a code-and-phone lookup fails, without saying which part was wrong,
// so a guest can't use it to find out whether a reservation code exists
const RESERVATION_NOT_FOUND_MESSAGE =
  "We couldn't find a reservation with that reservation code and phone number.";

// The reservation can't be retrieved. code is "RESERVATION_NOT_FOUND" or
// "CONVERSATION_NOT_FOUND"; message is safe to show.
class ReservationServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReservationServiceError";
    this.code = code;
  }
}

// The reservation with this code, if the phone number is the one it was booked with,
// or null. The code is matched in any case and the phone in either the 03... or
// +92... format. Anything malformed is simply not found.
// db is the Prisma client or a transaction client; include is passed to Prisma.
async function findOwnedReservation(db, reservationCode, guestPhone, include) {
  const phone = normalizeMobilePhone(guestPhone);
  if (typeof reservationCode !== "string" || reservationCode.trim() === "" || !phone) return null;

  const reservation = await db.reservation.findUnique({
    where: { reservationCode: reservationCode.trim().toUpperCase() },
    include,
  });
  return reservation && reservation.guestPhone === phone ? reservation : null;
}

// Tables with their details, and extras, for the shapes returned below
const DETAILS_INCLUDE = {
  tables: { include: { table: true } },
  extras: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
};

const byTableNumber = (a, b) => a.tableNumber.localeCompare(b.tableNumber, "en", { numeric: true });

// The reservation fields the backend needs, without database ids, the conversation
// it was made in, or its proposals. Guest details only when includeGuest is true.
// reservation must include tables (with their table) and extras.
function toReservationDetails(reservation, { includeGuest }) {
  return {
    reservationCode: reservation.reservationCode,
    status: reservation.status,
    mealType: reservation.mealType,
    startTime: reservation.startTime,
    endTime: reservation.endTime,
    adults: reservation.adults,
    children: reservation.children,
    estimatedTotalPaisa: reservation.estimatedTotalPaisa,
    specialRequest: reservation.specialRequest,
    cancelledAt: reservation.cancelledAt,
    ...(includeGuest && { guestName: reservation.guestName, guestPhone: reservation.guestPhone }),
    tables: reservation.tables
      .map(({ table }) => ({ tableNumber: table.tableNumber, section: table.section, capacity: table.capacity }))
      .sort(byTableNumber),
    extras: reservation.extras.map((extra) => ({
      extraKey: extra.extraKey,
      name: extra.name,
      quantity: extra.quantity,
      unitPricePaisa: extra.unitPricePaisa,
      lineTotalPaisa: extra.lineTotalPaisa,
      approvalStatus: extra.approvalStatus,
    })),
  };
}

// Look up a reservation by its code and the phone number it was booked with.
// Read-only. The guest has proved it's theirs, so the result includes their name
// and phone, along with:
//   { reservationCode, status, mealType, startTime, endTime, adults, children,
//     estimatedTotalPaisa (paisa), specialRequest, cancelledAt,
//     guestName, guestPhone,
//     tables: [{ tableNumber, section, capacity }]  (in table number order),
//     extras: [{ extraKey, name, quantity, unitPricePaisa, lineTotalPaisa,
//                approvalStatus }] }
// Any status is returned, so a guest can see that a reservation was cancelled.
// Throws ReservationServiceError (RESERVATION_NOT_FOUND) for a missing code, a
// wrong phone, or malformed values, always with the same message.
async function getReservationByCodeAndPhone({ reservationCode, guestPhone } = {}) {
  const reservation = await findOwnedReservation(prisma, reservationCode, guestPhone, DETAILS_INCLUDE);
  if (!reservation) {
    throw new ReservationServiceError("RESERVATION_NOT_FOUND", RESERVATION_NOT_FOUND_MESSAGE);
  }
  return toReservationDetails(reservation, { includeGuest: true });
}

// The reservations made in a conversation, earliest first. Read-only.
// Only confirmed reservations by default; includeCancelled adds cancelled ones.
// Other statuses (such as completed) are never included.
// Returns an array in the same shape as getReservationByCodeAndPhone, without
// guestName and guestPhone.
// Throws TypeError for an invalid conversationId or includeCancelled, and
// ReservationServiceError (CONVERSATION_NOT_FOUND) if there's no such conversation.
async function getReservationsByConversation({ conversationId, includeCancelled = false } = {}) {
  if (typeof conversationId !== "string" || conversationId.trim() === "") {
    throw new TypeError("conversationId must be a non-empty string");
  }
  if (typeof includeCancelled !== "boolean") {
    throw new TypeError("includeCancelled must be true or false");
  }

  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { id: true } });
  if (!conversation) {
    throw new ReservationServiceError("CONVERSATION_NOT_FOUND", "Conversation not found.");
  }

  const reservations = await prisma.reservation.findMany({
    where: { conversationId, status: { in: includeCancelled ? ["confirmed", "cancelled"] : ["confirmed"] } },
    include: DETAILS_INCLUDE,
    orderBy: [{ startTime: "asc" }, { reservationCode: "asc" }],
  });
  return reservations.map((reservation) => toReservationDetails(reservation, { includeGuest: false }));
}

module.exports = {
  getReservationByCodeAndPhone,
  getReservationsByConversation,
  findOwnedReservation,
  toReservationDetails,
  DETAILS_INCLUDE,
  ReservationServiceError,
  RESERVATION_NOT_FOUND_MESSAGE,
};
