const restaurantPolicies = require("../config/restaurant-policies");
const { formatPkr } = require("../lib/money");
const { recordWarning } = require("../services/warning.service");
const { ToolInputError } = require("./tool-errors");
const { runCreateReservationProposal } = require("./create-reservation-proposal.tool");
const { runGetConversationReservations } = require("./get-conversation-reservations.tool");
const { runGetReservationByCodeAndPhone } = require("./get-reservation-by-code-and-phone.tool");
const { runCreateModificationProposal } = require("./create-modification-proposal.tool");
const { runCreateCancellationProposal } = require("./create-cancellation-proposal.tool");

const VIOLATION_CATEGORIES = ["off_topic", "abusive_or_manipulative"];
const MAX_REASON_LENGTH = 300;

// Maps each tool name to the function that runs it.
// Every function receives the tool input from Claude, plus a trusted context
// from the server ({ conversationId, messageId }) that Claude can't change.
const toolHandlers = {
  getRestaurantPolicies: async () => JSON.stringify(toAgentPolicies(restaurantPolicies)),

  // Returns { warningCount, conversationStatus, blocked }, not a string,
  // because the agent loop stops and replies itself after this tool
  reportPolicyViolation: async (input, context) => {
    const { category, reason } = parseViolationInput(input);

    return recordWarning({
      conversationId: context.conversationId,
      messageId: context.messageId,
      category,
      reason,
    });
  },

  // Checks the guest's request and creates a pending proposal; never a reservation
  createReservationProposal: runCreateReservationProposal,

  // Reads the reservations made in this conversation; changes nothing
  getConversationReservations: runGetConversationReservations,

  // Reads one reservation from any conversation by its code and phone; changes nothing
  getReservationByCodeAndPhone: runGetReservationByCodeAndPhone,

  // Proposes a change to an existing reservation; never changes it
  createModificationProposal: runCreateModificationProposal,

  // Proposes cancelling an existing reservation; never cancels it
  createCancellationProposal: runCreateCancellationProposal,
};

class UnknownToolError extends Error {
  constructor(toolName) {
    super(`Unknown tool: ${toolName}`);
    this.name = "UnknownToolError";
  }
}

// A copy of the policies for Claude, with paisa shown as PKR text, so Claude
// never reads 249900 as a price. For example adultPricePaisa: 249900
// becomes adultPrice: "PKR 2,499". The original config is not changed.
function toAgentPolicies(value) {
  if (Array.isArray(value)) {
    return value.map(toAgentPolicies);
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (key.endsWith("Paisa")) {
        return [key.slice(0, -"Paisa".length), item === 0 ? "Free" : formatPkr(item)];
      }
      return [key, toAgentPolicies(item)];
    }),
  );
}

// Check reportPolicyViolation's input on the server, instead of trusting Claude
function parseViolationInput(input) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ToolInputError("input must be an object");
  }

  const extraKeys = Object.keys(input).filter((key) => key !== "category" && key !== "reason");
  if (extraKeys.length > 0) {
    throw new ToolInputError(`unexpected input fields: ${extraKeys.join(", ")}`);
  }

  if (!VIOLATION_CATEGORIES.includes(input.category)) {
    throw new ToolInputError("category is not allowed");
  }

  if (typeof input.reason !== "string" || input.reason.trim() === "") {
    throw new ToolInputError("reason must be a non-empty string");
  }

  return {
    category: input.category,
    reason: input.reason.trim().slice(0, MAX_REASON_LENGTH),
  };
}

// Run the tool Claude asked for and return its result
async function executeTool(name, input, context) {
  // hasOwn stops names like "toString" from matching built-in object properties
  if (!Object.hasOwn(toolHandlers, name)) {
    throw new UnknownToolError(name);
  }

  if (!context?.conversationId || !context?.messageId) {
    throw new Error("Tool context is missing conversationId or messageId");
  }

  return toolHandlers[name](input, context);
}

module.exports = { executeTool, UnknownToolError, ToolInputError };
