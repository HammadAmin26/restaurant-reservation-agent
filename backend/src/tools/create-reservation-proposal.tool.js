// Runs the createReservationProposal tool for Claude. The backend's services
// decide everything: this checks the input's shape, runs the existing checks,
// and only then creates the proposal. It never creates a reservation.
const { DateTime } = require("luxon");
const prisma = require("../lib/prisma");
const restaurantPolicies = require("../config/restaurant-policies");
const { formatPkr } = require("../lib/money");
const { validateReservationRequest } = require("../services/reservation-validation.service");
const { validateExtras } = require("../services/extras-validation.service");
const { calculateEstimatedTotal } = require("../services/pricing.service");
const { createReservationProposal, ProposalServiceError } = require("../services/proposal.service");
const { ToolInputError } = require("./tool-errors");

// Each allowed field and the JSON type it must have
const FIELDS = {
  guestName: "string",
  guestPhone: "string",
  date: "string",
  time: "string",
  mealType: "string",
  adults: "number",
  children: "number",
  childrenUnder3: "number",
  extras: "array",
  outsideCake: "boolean",
  specialRequest: "string",
};
const REQUIRED = ["guestName", "guestPhone", "date", "mealType", "adults", "children"];

const hasType = (value, type) => (type === "array" ? Array.isArray(value) : typeof value === type);

// The guest's request in the shape the proposal services expect. Only the
// tool's own fields are kept, so Claude can't add a conversationId or anything
// else. Values are checked by the services, not here.
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
    if (!hasType(value, type)) throw new ToolInputError(`${field} must be a ${type}`);
    request[field] = value;
  }

  const missing = REQUIRED.filter((field) => !(field in request));
  if (missing.length > 0) throw new ToolInputError(`missing input fields: ${missing.join(", ")}`);

  return request;
}

// A phone number as comparable digits: 0300 123-4567 and +923001234567 both
// become 923001234567
function phoneDigits(text) {
  const digits = text.replace(/\D/g, "");
  return digits.startsWith("0") ? `92${digits.slice(1)}` : digits;
}

// True if a guest message in the conversation contains this phone number,
// in either format and with any spacing. Claude must use the number the guest
// typed, so a number it changed or made up is refused.
async function guestGavePhone(conversationId, guestPhone) {
  const wanted = phoneDigits(guestPhone);
  const messages = await prisma.message.findMany({
    where: { conversationId, role: "guest" },
    select: { content: true },
  });
  // Runs of digits, which may be split by spaces or dashes, with an optional +
  const numberPattern = /\+?\d(?:[\s-]?\d){6,}/g;
  return messages.some(({ content }) =>
    (content.match(numberPattern) ?? []).some((candidate) => phoneDigits(candidate) === wanted),
  );
}

// A failure Claude can explain to the guest. Nothing was created.
const notCreated = ({ code, message }) => JSON.stringify({ created: false, code, message });

const karachi = (date) => DateTime.fromJSDate(date, { zone: restaurantPolicies.timezone }).setLocale("en-GB");

// The tool's work. context is { conversationId, now? } from the server:
// conversationId never comes from Claude, and now is only set by tests.
// Returns a JSON string for Claude when nothing was created, or
// { content, ui } when a proposal was: content goes to Claude, and ui is the
// reservation_proposal event for the chat response.
async function runCreateReservationProposal(input, context) {
  const request = parseInput(input);
  const now = context.now ?? new Date();

  if (!(await guestGavePhone(context.conversationId, request.guestPhone))) {
    return notCreated({
      code: "PHONE_NOT_FROM_GUEST",
      message:
        "This phone number isn't one the guest gave in this conversation. Use the number exactly as the guest typed it; if it looks wrong, ask the guest to send it again.",
    });
  }

  // The same checks acceptance runs, so Claude hears about problems before a
  // proposal exists. They only read; tables aren't held.
  const validated = await validateReservationRequest(request, now);
  if (!validated.valid) return notCreated(validated);

  const extras = validateExtras({
    extras: request.extras ?? [],
    outsideCake: request.outsideCake,
    reservationStartTime: validated.startTime,
    now,
  });
  if (!extras.valid) return notCreated(extras);

  const price = calculateEstimatedTotal({
    mealType: validated.mealType,
    adults: validated.party.adults,
    children: validated.party.children,
    childrenUnder3: request.childrenUnder3,
    extrasTotalPaisa: extras.totalExtrasPaisa,
  });
  if (!price.valid) return notCreated(price);

  let proposal;
  try {
    proposal = await createReservationProposal({ conversationId: context.conversationId, payload: request, now });
  } catch (error) {
    // For example the conversation was blocked; anything else is a real failure
    if (error instanceof ProposalServiceError) return notCreated(error);
    throw error;
  }

  const start = karachi(validated.startTime);
  const end = karachi(validated.endTime);

  // Sent to the chat UI, built only from the proposal the backend saved
  const ui = {
    type: "reservation_proposal",
    data: {
      proposalId: proposal.id,
      actionType: proposal.actionType,
      status: proposal.status,
      expiresAt: proposal.expiresAt.toISOString(),
      payload: proposal.payload,
    },
  };

  // What Claude is told
  const forClaude = {
    created: true,
    proposal: {
      id: proposal.id,
      actionType: proposal.actionType,
      status: proposal.status,
      expiresAt: proposal.expiresAt.toISOString(),
      payload: proposal.payload,
    },
    // For explaining the proposal to the guest. Prices are estimates in PKR.
    summary: {
      when: `${start.toFormat("cccc d LLLL yyyy")}, ${start.toFormat("HH:mm")}–${end.toFormat("HH:mm")} (Karachi time)`,
      mealType: validated.mealType,
      guestName: validated.guest.guestName,
      guestPhone: validated.guest.guestPhone,
      adults: validated.party.adults,
      children: validated.party.children,
      mealPrice: formatPkr(price.mealPaisa),
      extras: extras.extras.map((extra) => ({
        name: extra.name,
        quantity: extra.quantity,
        price: formatPkr(extra.lineTotalPaisa),
        needsStaffApproval: extra.approvalStatus === "pending",
      })),
      outsideCakeFee: extras.outsideCake ? formatPkr(extras.outsideCake.serviceFeePaisa) : null,
      estimatedTotal: formatPkr(price.estimatedTotalPaisa),
      pricesIncludeTax: restaurantPolicies.buffet.pricesIncludeTax,
      expiresInMinutes: restaurantPolicies.conversation.proposalExpiryMinutes,
      nextStep: "This is not a reservation yet. The guest must accept the proposal before it expires.",
    },
  };

  return { content: JSON.stringify(forClaude), ui };
}

module.exports = { runCreateReservationProposal, guestGavePhone };
