// HTTP routes for reservations and their proposals. Only HTTP concerns live here:
// reading the request, checking value types, calling a service, and turning its
// result or error into a JSON response. Business rules stay in the services.
const express = require("express");
const {
  createReservationProposal,
  createModificationProposal,
  createCancellationProposal,
  acceptReservationProposal,
  declineReservationProposal,
  ProposalServiceError,
} = require("../services/proposal.service");
const {
  getReservationByCodeAndPhone,
  getReservationsByConversation,
  toReservationDetails,
  ReservationServiceError,
} = require("../services/reservation-retrieval.service");
const { saveProposalReply } = require("../services/proposal-reply.service");

// HTTP status for each error code the services throw
const ERROR_STATUS = {
  CONVERSATION_NOT_FOUND: 404,
  RESERVATION_NOT_FOUND: 404,
  PROPOSAL_NOT_FOUND: 404,
  // A blocked (or otherwise inactive) conversation
  CONVERSATION_NOT_ACTIVE: 403,
  PROPOSAL_NOT_PENDING: 409,
  RESERVATION_NOT_MODIFIABLE: 409,
  RESERVATION_NOT_CANCELLABLE: 409,
};

// Refusals that depend on time or bookings, not on what the guest typed
const CONFLICT_CODES = new Set(["MODIFICATION_CUTOFF_PASSED", "CANCELLATION_CUTOFF_PASSED"]);

const fail = (res, status, code, message, extra = {}) =>
  res.status(status).json({ success: false, code, message, ...extra });

const invalidRequest = (res, message) => fail(res, 400, "INVALID_REQUEST", message);

// Send a known service error, or rethrow anything else for the central error
// handler, which logs it and answers 500 without details
function sendServiceError(res, error) {
  const isServiceError = error instanceof ProposalServiceError || error instanceof ReservationServiceError;
  if (!isServiceError || !ERROR_STATUS[error.code]) throw error;
  const extra = error.proposalStatus ? { data: { proposalStatus: error.proposalStatus } } : {};
  return fail(res, ERROR_STATUS[error.code], error.code, error.message, extra);
}

// Run a service call, sending its known errors as responses
async function withServiceErrors(res, handler) {
  try {
    return await handler();
  } catch (error) {
    return sendServiceError(res, error);
  }
}

// A { valid: false, kind, code, message } result from a service:
// 409 for availability and cutoffs, 400 for details the guest needs to correct
function sendValidationFailure(res, result) {
  const status = result.kind === "availability" || CONFLICT_CODES.has(result.code) ? 409 : 400;
  return fail(res, status, result.code, result.message, { kind: result.kind });
}

const TYPE_CHECKS = {
  string: (value) => typeof value === "string",
  number: (value) => typeof value === "number",
  boolean: (value) => typeof value === "boolean",
  array: (value) => Array.isArray(value),
};

// Check the body's value types (not business rules, which the services check).
// fields maps each name to [type, required]. Returns an error message or null,
// and only the listed fields are passed on, so anything else in the body is ignored.
function readBody(body, fields) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "The request body must be a JSON object." };
  }
  const values = {};
  for (const [name, [type, required]] of Object.entries(fields)) {
    const value = body[name];
    if (value === undefined || value === null) {
      if (required) return { error: `${name} is required.` };
      continue;
    }
    if (!TYPE_CHECKS[type](value)) return { error: `${name} must be ${type === "array" ? "an" : "a"} ${type}.` };
    values[name] = value;
  }
  return { values };
}

// A required query parameter given once as text
function readQueryString(query, name) {
  const value = query[name];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

const RESERVATION_REQUEST_FIELDS = {
  date: ["string", true],
  time: ["string", false],
  mealType: ["string", true],
  adults: ["number", true],
  children: ["number", true],
  childrenUnder3: ["number", false],
  guestName: ["string", true],
  guestPhone: ["string", true],
  extras: ["array", false],
  outsideCake: ["boolean", false],
  specialRequest: ["string", false],
};

const MODIFICATION_FIELDS = {
  reservationCode: ["string", true],
  guestPhone: ["string", true],
  date: ["string", true],
  time: ["string", false],
  mealType: ["string", true],
  adults: ["number", true],
  children: ["number", true],
  childrenUnder3: ["number", false],
  // Left out keeps the reservation's note; "" removes it
  specialRequest: ["string", false],
};

const CANCELLATION_FIELDS = {
  reservationCode: ["string", true],
  guestPhone: ["string", true],
};

// clock returns the current time; tests pass a fixed one
function createReservationRouter({ clock = () => new Date() } = {}) {
  const router = express.Router();

  // Look up a reservation by its code and the phone number it was booked with
  router.get("/reservations/lookup", async (req, res) => {
    const reservationCode = readQueryString(req.query, "reservationCode");
    const guestPhone = readQueryString(req.query, "guestPhone");
    if (!reservationCode || !guestPhone) {
      return invalidRequest(res, "reservationCode and guestPhone are required.");
    }

    return withServiceErrors(res, async () => {
      const reservation = await getReservationByCodeAndPhone({ reservationCode, guestPhone });
      res.json({ success: true, data: reservation });
    });
  });

  // The conversation's reservations; includeCancelled=true adds cancelled ones
  router.get("/conversations/:id/reservations", async (req, res) => {
    const { includeCancelled = "false" } = req.query;
    if (includeCancelled !== "true" && includeCancelled !== "false") {
      return invalidRequest(res, "includeCancelled must be true or false.");
    }

    return withServiceErrors(res, async () => {
      const reservations = await getReservationsByConversation({
        conversationId: req.params.id,
        includeCancelled: includeCancelled === "true",
      });
      res.json({ success: true, data: reservations });
    });
  });

  // Propose a new reservation; it's checked again and created only on acceptance
  router.post("/conversations/:id/reservations/proposals", async (req, res) => {
    const { values, error } = readBody(req.body, RESERVATION_REQUEST_FIELDS);
    if (error) return invalidRequest(res, error);

    return withServiceErrors(res, async () => {
      const proposal = await createReservationProposal({ conversationId: req.params.id, payload: values, now: clock() });
      res.status(201).json({ success: true, data: proposal });
    });
  });

  // Propose changes to an existing reservation
  router.post("/conversations/:id/reservations/modifications", async (req, res) => {
    const { values, error } = readBody(req.body, MODIFICATION_FIELDS);
    if (error) return invalidRequest(res, error);

    return withServiceErrors(res, async () => {
      const result = await createModificationProposal({ conversationId: req.params.id, ...values, now: clock() });
      if (!result.valid) return sendValidationFailure(res, result);
      res.status(201).json({ success: true, data: result.proposal });
    });
  });

  // Propose cancelling an existing reservation
  router.post("/conversations/:id/reservations/cancellations", async (req, res) => {
    const { values, error } = readBody(req.body, CANCELLATION_FIELDS);
    if (error) return invalidRequest(res, error);

    return withServiceErrors(res, async () => {
      const result = await createCancellationProposal({ conversationId: req.params.id, ...values, now: clock() });
      if (!result.valid) return sendValidationFailure(res, result);
      res.status(201).json({ success: true, data: result.proposal });
    });
  });

  // Accept a pending proposal: creates, changes or cancels the reservation.
  // When it's accepted, expired or rejected, message is the agent's reply saved
  // in the chat (null if it couldn't be saved). A proposal that was already
  // resolved changes nothing, so it gets no reply.
  router.post("/conversations/:id/proposals/:proposalId/accept", async (req, res) => {
    return withServiceErrors(res, async () => {
      const result = await acceptReservationProposal({
        proposalId: req.params.proposalId,
        conversationId: req.params.id,
        now: clock(),
      });

      const message = await saveProposalReply({
        conversationId: req.params.id,
        proposalId: result.proposal.id,
        outcome: result.outcome,
        actionType: result.proposal.actionType,
        reservation: result.reservation,
        reason: result.message,
      });

      if (result.outcome === "accepted") {
        return res.json({
          success: true,
          data: {
            reservation: toReservationDetails(result.reservation, { includeGuest: true }),
            proposal: result.proposal,
            message,
          },
        });
      }
      if (result.outcome === "expired") {
        return fail(res, 409, "PROPOSAL_EXPIRED", "That proposal has expired. Please ask for a new one.", {
          data: { proposal: result.proposal, message },
        });
      }
      // Rejected: the proposal can no longer be accepted, and is now rejected
      return fail(res, 409, result.code, result.message, {
        kind: result.kind,
        data: { proposal: result.proposal, message },
      });
    });
  });

  // Decline a pending proposal. When it's declined or found expired, message is
  // the agent's reply saved in the chat (null if it couldn't be saved).
  router.post("/conversations/:id/proposals/:proposalId/decline", async (req, res) => {
    return withServiceErrors(res, async () => {
      const result = await declineReservationProposal({
        proposalId: req.params.proposalId,
        conversationId: req.params.id,
        now: clock(),
      });

      const message = await saveProposalReply({
        conversationId: req.params.id,
        proposalId: result.proposal.id,
        outcome: result.outcome,
        actionType: result.proposal.actionType,
      });

      if (result.outcome === "expired") {
        return fail(res, 409, "PROPOSAL_EXPIRED", "That proposal has expired. Please ask for a new one.", {
          data: { proposal: result.proposal, message },
        });
      }
      res.json({ success: true, data: { proposal: result.proposal, message } });
    });
  });

  return router;
}

module.exports = { createReservationRouter };
