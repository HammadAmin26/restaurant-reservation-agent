// Runs the createModificationProposal tool for Claude: a proposal to change an
// existing reservation, which the guest proves is theirs with its code and
// phone number. The proposal service decides everything; this checks the
// input's shape and describes the result. Nothing about the reservation
// changes until the guest accepts the proposal on its card.
const { DateTime } = require("luxon");
const restaurantPolicies = require("../config/restaurant-policies");
const { formatPkr } = require("../lib/money");
const { createModificationProposal, ProposalServiceError } = require("../services/proposal.service");
const { ToolInputError } = require("./tool-errors");
const { guestGavePhone } = require("./create-reservation-proposal.tool");

// Each allowed field and the JSON type it must have
const FIELDS = {
  reservationCode: "string",
  guestPhone: "string",
  date: "string",
  time: "string",
  mealType: "string",
  adults: "number",
  children: "number",
  childrenUnder3: "number",
  specialRequest: "string",
};
const REQUIRED = ["reservationCode", "guestPhone", "date", "mealType", "adults", "children"];

// Only the tool's own fields are kept, so Claude can't add a conversationId or
// anything else. Values are checked by the service, not here.
function parseInput(input) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ToolInputError("input must be an object");
  }

  const unexpected = Object.keys(input).filter((key) => !Object.hasOwn(FIELDS, key));
  if (unexpected.length > 0) {
    throw new ToolInputError(`unexpected input fields: ${unexpected.join(", ")}`);
  }

  const request = {};
  for (const [field, type] of Object.entries(FIELDS)) {
    const value = input[field];
    // Claude sometimes sends null for an optional field it has no value for
    if (value === undefined || value === null) continue;
    if (typeof value !== type) throw new ToolInputError(`${field} must be a ${type}`);
    request[field] = value;
  }

  const missing = REQUIRED.filter((field) => !(field in request));
  if (missing.length > 0) throw new ToolInputError(`missing input fields: ${missing.join(", ")}`);

  return request;
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
// modification_proposal event that links the reply to its card.
async function runCreateModificationProposal(input, context) {
  const request = parseInput(input);
  const now = context.now ?? new Date();

  if (!(await guestGavePhone(context.conversationId, request.guestPhone))) {
    return notCreated({
      code: "PHONE_NOT_FROM_GUEST",
      message:
        "This phone number isn't one the guest gave in this conversation. Use the number exactly as the guest typed it; if it looks wrong, ask the guest to send it again.",
    });
  }

  let result;
  try {
    result = await createModificationProposal({ conversationId: context.conversationId, ...request, now });
  } catch (error) {
    // RESERVATION_NOT_FOUND (with the same message whichever part was wrong),
    // RESERVATION_NOT_MODIFIABLE or an inactive conversation
    if (error instanceof ProposalServiceError) return notCreated(error);
    throw error;
  }
  if (!result.valid) return notCreated(result);

  const { proposal } = result;
  const { reservationCode, current, target, specialRequestChange } = proposal.payload;

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
      reservationCode,
      current: {
        when: when(current.startTime, current.endTime),
        mealType: current.mealType,
        adults: current.adults,
        children: current.children,
        estimatedTotal: formatPkr(current.estimatedTotalPaisa),
      },
      proposed: {
        when: when(target.startTime, target.endTime),
        mealType: target.mealType,
        adults: target.adults,
        children: target.children,
        childrenUnder3: target.childrenUnder3,
        tables: target.tables.map(({ tableNumber, section }) => ({ tableNumber, section })),
        estimatedTotal: formatPkr(target.estimatedTotalPaisa),
      },
      ...(specialRequestChange && {
        specialRequest: { current: specialRequestChange.current, proposed: specialRequestChange.proposed },
      }),
      extras: specialRequestChange
        ? "The reservation keeps its extras and code."
        : "The reservation keeps its extras, special request and code.",
      expiresInMinutes: restaurantPolicies.conversation.proposalExpiryMinutes,
      nextStep:
        "Nothing has changed yet. The reservation keeps its current details unless the guest accepts this change on the card before it expires.",
    },
  };

  return {
    content: JSON.stringify(forClaude),
    ui: { type: "modification_proposal", data: { proposalId: proposal.id } },
  };
}

module.exports = { runCreateModificationProposal };
