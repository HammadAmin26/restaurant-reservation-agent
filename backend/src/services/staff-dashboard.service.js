// Read-only queries for the staff dashboard. Reservations are described with
// toReservationDetails, the same shape the guest-facing routes use, so no
// database ids leave the backend. Dates are days in the restaurant's timezone.
const { DateTime } = require("luxon");
const prisma = require("../lib/prisma");
const restaurantPolicies = require("../config/restaurant-policies");
const { toReservationDetails, DETAILS_INCLUDE } = require("./reservation-retrieval.service");

const { timezone } = restaurantPolicies;

// Search results without a date stop here, so a short search can't load everything
const SEARCH_LIMIT = 50;

// The meal filter's values and the meal types each one covers
const MEAL_FILTERS = {
  buffet: ["buffet_lunch", "buffet_dinner"],
  a_la_carte: ["a_la_carte"],
};

// The day an instant falls on in Karachi, as YYYY-MM-DD
const karachiDay = (instant) => DateTime.fromJSDate(instant, { zone: timezone }).toISODate();

// A Karachi day's first instant and the next day's first instant, as Dates.
// day is YYYY-MM-DD and must already be valid (see isValidDay).
function karachiDayRange(day) {
  const start = DateTime.fromISO(day, { zone: timezone }).startOf("day");
  return { start: start.toJSDate(), end: start.plus({ days: 1 }).toJSDate() };
}

// True for a real calendar date written as YYYY-MM-DD
const isValidDay = (value) =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && DateTime.fromISO(value, { zone: timezone }).isValid;

// The dashboard's counts, all from the database. now is the current instant.
// - todayReservations: confirmed reservations starting today (Karachi)
// - upcomingReservations: confirmed reservations that haven't started yet
// - confirmedReservations / cancelledReservations: all of them, any date
// - pendingExtraApprovals: extras awaiting staff approval on confirmed
//   reservations from today on (the same ones getPendingExtraApprovals lists)
async function getDashboardSummary({ now }) {
  const today = karachiDay(now);
  const { start, end } = karachiDayRange(today);

  const [todayReservations, upcomingReservations, confirmedReservations, cancelledReservations, pendingExtraApprovals] =
    await Promise.all([
      prisma.reservation.count({ where: { status: "confirmed", startTime: { gte: start, lt: end } } }),
      prisma.reservation.count({ where: { status: "confirmed", startTime: { gte: now } } }),
      prisma.reservation.count({ where: { status: "confirmed" } }),
      prisma.reservation.count({ where: { status: "cancelled" } }),
      prisma.reservationExtra.count({ where: pendingExtrasWhere(start) }),
    ]);

  return {
    today,
    todayReservations,
    upcomingReservations,
    confirmedReservations,
    cancelledReservations,
    pendingExtraApprovals,
  };
}

// One reservation in a list: its details without the guest's phone
function toListItem(reservation) {
  const { guestPhone: _guestPhone, ...details } = toReservationDetails(reservation, { includeGuest: true });
  return details;
}

// Reservations for the staff list, confirmed and cancelled alike.
// Every filter is optional, but date or search must be given:
// - date: YYYY-MM-DD, the Karachi day the reservation starts on
// - status: "confirmed" or "cancelled"
// - mealType: "buffet" (lunch or dinner) or "a_la_carte"
// - search: part of a reservation code or guest name, in any case
// With a date, every match that day is returned, earliest first. A search
// without a date covers every day, latest first, up to SEARCH_LIMIT.
// Returns { date, search, reservations, truncated }. Values must already be
// checked (see the staff routes).
async function listReservations({ date, status, mealType, search }) {
  const day = date ? karachiDayRange(date) : null;
  const where = {
    ...(day && { startTime: { gte: day.start, lt: day.end } }),
    ...(status && { status }),
    ...(mealType && { mealType: { in: MEAL_FILTERS[mealType] } }),
    // SQLite's LIKE ignores case for these letters; codes are stored in capitals
    ...(search && {
      OR: [{ reservationCode: { contains: search.toUpperCase() } }, { guestName: { contains: search } }],
    }),
  };

  const limit = date ? undefined : SEARCH_LIMIT;
  const reservations = await prisma.reservation.findMany({
    where,
    include: DETAILS_INCLUDE,
    orderBy: date
      ? [{ startTime: "asc" }, { reservationCode: "asc" }]
      : [{ startTime: "desc" }, { reservationCode: "asc" }],
    // One extra row says whether there were more than the limit
    ...(limit && { take: limit + 1 }),
  });

  const truncated = limit !== undefined && reservations.length > limit;
  return {
    date: date ?? null,
    search: search ?? null,
    reservations: reservations.slice(0, limit).map(toListItem),
    truncated,
  };
}

// One reservation by its code, in any case, with everything staff need:
// toReservationDetails with the guest's name and phone, plus when it was booked.
// Returns null if there's no such code.
async function getReservationForStaff(reservationCode) {
  const reservation = await prisma.reservation.findUnique({
    where: { reservationCode: reservationCode.trim().toUpperCase() },
    include: DETAILS_INCLUDE,
  });
  if (!reservation) return null;
  return { ...toReservationDetails(reservation, { includeGuest: true }), bookedAt: reservation.createdAt };
}

// Extras awaiting approval on confirmed reservations starting from dayStart on
const pendingExtrasWhere = (dayStart) => ({
  approvalStatus: "pending",
  reservation: { status: "confirmed", startTime: { gte: dayStart } },
});

// Extras awaiting staff approval, on confirmed reservations from today
// (Karachi) on, soonest first. Read-only. Each item is
//   { reservationCode, guestName, startTime, endTime, mealType,
//     extra: { extraKey, name, quantity, approvalStatus } }
async function getPendingExtraApprovals({ now }) {
  const { start } = karachiDayRange(karachiDay(now));
  const extras = await prisma.reservationExtra.findMany({
    where: pendingExtrasWhere(start),
    include: { reservation: true },
    orderBy: [{ reservation: { startTime: "asc" } }, { reservation: { reservationCode: "asc" } }, { createdAt: "asc" }],
  });

  return extras.map(({ reservation, extraKey, name, quantity, approvalStatus }) => ({
    reservationCode: reservation.reservationCode,
    guestName: reservation.guestName,
    startTime: reservation.startTime,
    endTime: reservation.endTime,
    mealType: reservation.mealType,
    extra: { extraKey, name, quantity, approvalStatus },
  }));
}

module.exports = {
  getDashboardSummary,
  listReservations,
  getReservationForStaff,
  getPendingExtraApprovals,
  isValidDay,
  MEAL_FILTERS,
  SEARCH_LIMIT,
};
