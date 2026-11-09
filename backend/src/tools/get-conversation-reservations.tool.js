// Runs the getConversationReservations tool for Claude: the reservations made
// in the conversation the guest is chatting in. Read-only. The conversation
// always comes from the server's context, never from Claude.
const {
  getReservationsByConversation,
  ReservationServiceError,
} = require("../services/reservation-retrieval.service");
const { ToolInputError } = require("./tool-errors");
const { reservationForClaude } = require("./reservation-for-claude");

// The tool's only field is optional, so an empty object is valid input
function parseInput(input) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ToolInputError("input must be an object");
  }

  const unexpected = Object.keys(input).filter((key) => key !== "includeCancelled");
  if (unexpected.length > 0) {
    throw new ToolInputError(`unexpected input fields: ${unexpected.join(", ")}`);
  }

  // Claude sometimes sends null for an optional field it has no value for
  const { includeCancelled } = input;
  if (includeCancelled === undefined || includeCancelled === null) return { includeCancelled: false };
  if (typeof includeCancelled !== "boolean") throw new ToolInputError("includeCancelled must be a boolean");
  return { includeCancelled };
}

// The tool's work. context is { conversationId } from the server.
// The result for Claude is a JSON string:
//   { found: true, reservations: [...] }, with an empty list and a note when
//   there are none, or { found: false, code, message } if the conversation is missing.
// When a confirmed reservation was found it returns { content, ui }: content
// goes to Claude, and the reservation_list ui shows the conversation's
// confirmed reservations as cards with the reply. The cards are built from the
// database when the message is loaded, so the ui carries no data itself.
async function runGetConversationReservations(input, context) {
  const { includeCancelled } = parseInput(input);

  let reservations;
  try {
    reservations = await getReservationsByConversation({ conversationId: context.conversationId, includeCancelled });
  } catch (error) {
    if (!(error instanceof ReservationServiceError)) throw error;
    return JSON.stringify({ found: false, code: error.code, message: error.message });
  }

  const content = JSON.stringify({
    found: true,
    reservations: reservations.map((reservation) => reservationForClaude(reservation)),
    ...(reservations.length === 0 && {
      note: includeCancelled
        ? "No reservations were made in this conversation."
        : "No confirmed reservations were made in this conversation.",
    }),
  });

  const anyConfirmed = reservations.some((reservation) => reservation.status === "confirmed");
  return anyConfirmed ? { content, ui: { type: "reservation_list" } } : content;
}

module.exports = { runGetConversationReservations };
