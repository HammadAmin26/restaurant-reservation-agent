// Runs the createCancellationProposal tool for Claude: a proposal to cancel an
// existing reservation, which the guest proves is theirs with its code and
// phone number. The proposal service decides everything; this checks the
// input's shape and describes the result. The reservation stays confirmed
// until the guest confirms the cancellation on its card.
const { DateTime } = require("luxon");
const restaurantPolicies = require("../config/restaurant-policies");
const { formatPkr } = require("../lib/money");
const { createCancellationProposal, ProposalServiceError } = require("../services/proposal.service");
const { ToolInputError } = require("./tool-errors");
const { guestGavePhone } = require("./create-reservation-proposal.tool");

const FIELDS = ["reservationCode", "guestPhone"];

// Only the tool's own fields are kept, so Claude can't add a conversationId or
// anything else. Values are checked by the service, not here.
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

const karachi = (iso) => DateTime.fromJSDate(new Date(iso), { zone: restaurantPolicies.timezone }).setLocale("en-GB");
const when = (startTime, endTime) =>
  `${karachi(startTime).toFormat("cccc d LLLL yyyy, HH:mm")}–${karachi(endTime).toFormat("HH:mm")} (Karachi time)`;

// A failure Claude can explain to the guest. Nothing was created or changed.
const notCreated = ({ code, message }) => JSON.stringify({ created: false, code, message });

// The tool's work. context is { conversationId, now? } from the server:
// conversationId never comes from Claude, and now is only set by tests.
// Returns a JSON string for Claude when nothing was created, or
// { content, ui } when a proposal was: content goes to Claude, and ui is the
// cancellation_proposal event that links the reply to its card.
async function runCreateCancellationProposal(input, context) {
  const { reservationCode, guestPhone } = parseInput(input);
  const now = context.now ?? new Date();

  if (!(await guestGavePhone(context.conversationId, guestPhone))) {
    return notCreated({
      code: "PHONE_NOT_FROM_GUEST",
      message:
        "This phone number isn't one the guest gave in this conversation. Use the number exactly as the guest typed it; if it looks wrong, ask the guest to send it again.",
    });
  }

  let result;
  try {
    result = await createCancellationProposal({ conversationId: context.conversationId, reservationCode, guestPhone, now });
  } catch (error) {
    // RESERVATION_NOT_FOUND (with the same message whichever part was wrong),
    // RESERVATION_NOT_CANCELLABLE or an inactive conversation
    if (error instanceof ProposalServiceError) return notCreated(error);
    throw error;
  }
  // For example CANCELLATION_CUTOFF_PASSED
  if (!result.valid) return notCreated(result);

  const { proposal } = result;
  const { current } = proposal.payload;

  // What Claude is told: no database ids, and prices in PKR
  const forClaude = {
    created: true,
    proposal: {
      id: proposal.id,
      actionType: proposal.actionType,
      status: proposal.status,
      expiresAt: proposal.expiresAt.toISOString(),
    },
    summary: {
      reservationCode: proposal.payload.reservationCode,
      reservation: {
        when: when(current.startTime, current.endTime),
        mealType: current.mealType,
        adults: current.adults,
        children: current.children,
        estimatedTotal: formatPkr(current.estimatedTotalPaisa),
      },
      expiresInMinutes: restaurantPolicies.conversation.proposalExpiryMinutes,
      nextStep:
        "The reservation is not cancelled. It stays confirmed unless the guest presses Confirm Cancellation on the card before the proposal expires.",
    },
  };

  return {
    content: JSON.stringify(forClaude),
    ui: { type: "cancellation_proposal", data: { proposalId: proposal.id } },
  };
}

module.exports = { runCreateCancellationProposal };
