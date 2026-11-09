const { DateTime } = require("luxon");
const restaurantPolicies = require("../config/restaurant-policies");

// Every date and time a guest gives is local time in this zone,
// whatever timezone the server itself runs in
const RESTAURANT_TIMEZONE = restaurantPolicies.timezone;
const MAX_ADVANCE_DAYS = restaurantPolicies.reservations.maxAdvanceDays;

// Strict formats: YYYY-MM-DD and 24-hour HH:mm, with leading zeros
const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;
const TIME_FORMAT = /^([01]\d|2[0-3]):[0-5]\d$/;

const invalid = (code, message) => ({ valid: false, code, message });

// Check a guest's requested date and time, given as Karachi local time.
// now is the current instant; pass a fixed Date in tests.
// Returns { valid: true, startTime } where startTime is a Date for the correct UTC
// instant (ready for a Prisma DateTime field), or { valid: false, code, message }.
// Opening hours, closed days and meal sessions are not checked here.
function validateReservationDateTime({ date, time }, now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }

  if (typeof date !== "string" || !DATE_FORMAT.test(date)) {
    return invalid("INVALID_DATE", "Date must be in the format YYYY-MM-DD.");
  }
  if (typeof time !== "string" || !TIME_FORMAT.test(time)) {
    return invalid("INVALID_TIME", "Time must be in the 24-hour format HH:mm.");
  }

  // Read the date and time in the restaurant's timezone, never the server's
  const requested = DateTime.fromFormat(`${date} ${time}`, "yyyy-MM-dd HH:mm", {
    zone: RESTAURANT_TIMEZONE,
  });

  // Catches dates that don't exist, such as 2026-02-30 or 2026-13-01
  if (!requested.isValid) {
    return invalid("INVALID_DATE", "That date doesn't exist.");
  }

  const current = DateTime.fromJSDate(now, { zone: RESTAURANT_TIMEZONE });

  if (requested <= current) {
    return invalid("DATE_IN_PAST", "That date and time has already passed.");
  }

  // Exactly 30 days from now is still allowed; one minute later is not
  if (requested > current.plus({ days: MAX_ADVANCE_DAYS })) {
    return invalid(
      "TOO_FAR_AHEAD",
      `Reservations can be made at most ${MAX_ADVANCE_DAYS} days in advance.`,
    );
  }

  return { valid: true, startTime: requested.toJSDate() };
}

module.exports = { validateReservationDateTime, RESTAURANT_TIMEZONE, DATE_FORMAT, TIME_FORMAT };
