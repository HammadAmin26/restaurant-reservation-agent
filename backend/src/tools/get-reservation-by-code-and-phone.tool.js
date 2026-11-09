// Runs the getReservationByCodeAndPhone tool for Claude: one reservation from
// any conversation, found by its code and the phone number it was booked with.
// Read-only. The existing retrieval service does the lookup and the phone check.
const prisma = require("../lib/prisma");
const {
  getReservationByCodeAndPhone,
  ReservationServiceError,
} = require("../services/reservation-retrieval.service");
const { ToolInputError } = require("./tool-errors");
const { reservationForClaude } = require("./reservation-for-claude");

const FIELDS = ["reservationCode", "guestPhone"];

// Only the shape is checked here. Values that are the right type but malformed,
// such as "abc" for a phone, go to the service, which treats them as not found.
function parseInput(input) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ToolInputError("input must be an object");
  }

  const unexpected = Object.keys(input).filter((key) => !FIELDS.includes(key));
  if (unexpected.length > 0) {
    throw new ToolInputError(`unexpected input fields: ${unexpected.join(", ")}`);
  }

  const missing = FIELDS.filter((field) => input[field] === undefined || input[field] === null);
  if (missing.length > 0) throw new ToolInputError(`missing input fields: ${missing.join(", ")}`);

  for (const field of FIELDS) {
    if (typeof input[field] !== "string") throw new ToolInputError(`${field} must be a string`);
  }

  return { reservationCode: input.reservationCode, guestPhone: input.guestPhone };
}

// The tool's work. Nothing from the context is needed: the code and phone
// are the guest's proof that the reservation is theirs.
// The result for Claude is a JSON string:
//   { found: true, reservation }, or
//   { found: false, code: "RESERVATION_NOT_FOUND", message }, the same for an
//   unknown code, a wrong phone, or a malformed value, so Claude can't tell
//   whether the code exists.
// When a confirmed reservation was found it returns { content, ui }: content
// goes to Claude, and the reservation_lookup ui links the reply to the
// reservation so the chat shows it as a card. The id stays in the backend:
// the card the chat gets is built from the reservation when the message loads.
async function runGetReservationByCodeAndPhone(input) {
  const { reservationCode, guestPhone } = parseInput(input);

  let reservation;
  try {
    reservation = await getReservationByCodeAndPhone({ reservationCode, guestPhone });
  } catch (error) {
    if (!(error instanceof ReservationServiceError)) throw error;
    return JSON.stringify({ found: false, code: error.code, message: error.message });
  }

  const content = JSON.stringify({
    found: true,
    reservation: reservationForClaude(reservation, { withApprovalStatus: true }),
  });
  if (reservation.status !== "confirmed") return content;

  // The service leaves out the id; the code is unique and already checked
  const { id } = await prisma.reservation.findUnique({
    where: { reservationCode: reservation.reservationCode },
    select: { id: true },
  });
  return { content, ui: { type: "reservation_lookup", data: { reservationId: id } } };
}

module.exports = { runGetReservationByCodeAndPhone };
