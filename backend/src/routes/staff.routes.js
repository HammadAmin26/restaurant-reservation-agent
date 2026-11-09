// HTTP routes for the staff dashboard. All read-only. They are public on
// purpose: this is a demo without staff accounts, so there's no login.
// Only HTTP concerns live here; the queries are in staff-dashboard.service.js.
const express = require("express");
const {
  getDashboardSummary,
  listReservations,
  getReservationForStaff,
  getPendingExtraApprovals,
  isValidDay,
  MEAL_FILTERS,
} = require("../services/staff-dashboard.service");

const STATUSES = ["confirmed", "cancelled"];
const MAX_SEARCH_LENGTH = 100;

const fail = (res, status, code, message) => res.status(status).json({ success: false, code, message });
const invalidQuery = (res, message) => fail(res, 400, "INVALID_QUERY", message);

// One query parameter given at most once, as text; "all" and "" mean not given
function readOptional(query, name) {
  const value = query[name];
  if (value === undefined) return { value: undefined };
  if (typeof value !== "string") return { error: `${name} must be given once.` };
  const trimmed = value.trim();
  return { value: trimmed === "" || trimmed === "all" ? undefined : trimmed };
}

// Check the list's query: date, status, mealType and search, each optional,
// but at least one of date and search
function readListQuery(query) {
  const values = {};
  for (const name of ["date", "status", "mealType", "search"]) {
    const { value, error } = readOptional(query, name);
    if (error) return { error };
    values[name] = value;
  }

  if (values.date !== undefined && !isValidDay(values.date)) {
    return { error: "date must be a real date written as YYYY-MM-DD." };
  }
  if (values.status !== undefined && !STATUSES.includes(values.status)) {
    return { error: 'status must be "confirmed", "cancelled" or "all".' };
  }
  if (values.mealType !== undefined && !Object.hasOwn(MEAL_FILTERS, values.mealType)) {
    return { error: 'mealType must be "buffet", "a_la_carte" or "all".' };
  }
  if (values.search !== undefined && values.search.length > MAX_SEARCH_LENGTH) {
    return { error: `search can be at most ${MAX_SEARCH_LENGTH} characters.` };
  }
  if (values.date === undefined && values.search === undefined) {
    return { error: "Give a date or a search." };
  }
  return { values };
}

// clock returns the current time; tests pass a fixed one
function createStaffRouter({ clock = () => new Date() } = {}) {
  const router = express.Router();

  // Counts for the overview cards
  router.get("/dashboard/summary", async (req, res) => {
    res.json({ success: true, data: await getDashboardSummary({ now: clock() }) });
  });

  // Reservations for a day, or matching a search, confirmed and cancelled
  router.get("/reservations", async (req, res) => {
    const { values, error } = readListQuery(req.query);
    if (error) return invalidQuery(res, error);
    res.json({ success: true, data: await listReservations(values) });
  });

  // One reservation, with the guest's details, extras and prices
  router.get("/reservations/:reservationCode", async (req, res) => {
    const reservation = await getReservationForStaff(req.params.reservationCode);
    if (!reservation) {
      return fail(res, 404, "RESERVATION_NOT_FOUND", "No reservation has that code.");
    }
    res.json({ success: true, data: reservation });
  });

  // Extras waiting for staff approval, from today on
  router.get("/extra-approvals", async (req, res) => {
    res.json({ success: true, data: await getPendingExtraApprovals({ now: clock() }) });
  });

  return router;
}

module.exports = { createStaffRouter };
