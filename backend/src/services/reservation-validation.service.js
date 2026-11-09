const { DateTime } = require("luxon");
const { validateGuestDetails } = require("./guest-details-validation.service");
const { validateParty } = require("./party-validation.service");
const {
  validateReservationDateTime,
  RESTAURANT_TIMEZONE,
} = require("./datetime-validation.service");
const { validateMealTiming } = require("./meal-timing-validation.service");
const { findTablesForParty } = require("./table-allocation.service");

// Every failure has { valid: false, code, message } like the individual services,
// plus kind, so callers can tell the two types apart:
// - "validation": the guest's details need correcting
// - "availability": the request is valid, but no tables are free
const validationFailure = (result) => ({
  valid: false,
  kind: "validation",
  code: result.code,
  message: result.message,
});

// Check a whole reservation request and find tables for it.
// input is { date, time, mealType, adults, children, guestName, guestPhone };
// date and time are Karachi local time, and buffets don't need a time.
// now is the current instant; pass a fixed Date in tests.
// Stops at the first failure. Reads tables and reservations, but never creates
// a Reservation or Proposal. The tables it finds aren't held, so whatever creates
// the reservation must check availability again.
// options.db is a Prisma transaction client to check availability inside a
// transaction; by default the main Prisma client is used.
// options.excludeReservationId is a reservation being modified, whose own tables
// count as free.
async function validateReservationRequest(input = {}, now = new Date(), { db, excludeReservationId } = {}) {
  const { date, time, mealType, adults, children, guestName, guestPhone } = input ?? {};

  const guest = validateGuestDetails({ guestName, guestPhone });
  if (!guest.valid) return validationFailure(guest);

  const party = validateParty({ adults, children });
  if (!party.valid) return validationFailure(party);

  // Meal timing runs before the past and 30-day checks because it decides the start
  // time: a buffet always starts at its session start, whatever time was given.
  const meal = validateMealTiming({ date, mealType, time });
  if (!meal.valid) return validationFailure(meal);

  // Check the real start time against now, as Karachi local date and time
  const localStart = DateTime.fromJSDate(meal.startTime, { zone: RESTAURANT_TIMEZONE });
  const when = validateReservationDateTime(
    { date: localStart.toFormat("yyyy-MM-dd"), time: localStart.toFormat("HH:mm") },
    now,
  );
  if (!when.valid) return validationFailure(when);

  // FAMILY only for parties with children; GENERAL first for adults-only parties
  const tables = await findTablesForParty(
    {
      startTime: meal.startTime,
      endTime: meal.endTime,
      adults: party.adults,
      children: party.children,
      excludeReservationId,
    },
    db,
  );

  if (!tables) {
    return {
      valid: false,
      kind: "availability",
      code: "TABLES_UNAVAILABLE",
      message: `Sorry, we don't have a table for ${party.total} ${party.total === 1 ? "guest" : "guests"} at that time. Please try another time or date.`,
    };
  }

  return {
    valid: true,
    guest: { guestName: guest.guestName, guestPhone: guest.guestPhone },
    party: {
      adults: party.adults,
      children: party.children,
      total: party.total,
      requiresFamilySection: party.requiresFamilySection,
    },
    mealType: meal.mealType,
    startTime: meal.startTime,
    endTime: meal.endTime,
    tables: tables.map(({ id, tableNumber, section, capacity }) => ({ id, tableNumber, section, capacity })),
  };
}

module.exports = { validateReservationRequest };
