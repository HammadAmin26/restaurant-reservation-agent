const { DateTime } = require("luxon");
const restaurantPolicies = require("../config/restaurant-policies");
const {
  RESTAURANT_TIMEZONE,
  DATE_FORMAT,
  TIME_FORMAT,
} = require("./datetime-validation.service");

const { openingHours, buffet, aLaCarte } = restaurantPolicies;

// Buffets have fixed sessions; à la carte has a start time the guest chooses
const BUFFET_SESSIONS = {
  buffet_lunch: buffet.sessions.lunch,
  buffet_dinner: buffet.sessions.dinner,
};
const A_LA_CARTE = "a_la_carte";
const MEAL_TYPES = [...Object.keys(BUFFET_SESSIONS), A_LA_CARTE];

const invalid = (code, message) => ({ valid: false, code, message });

// "19:30" -> 1170 minutes after midnight
function toMinutes(hhmm) {
  const [hours, minutes] = hhmm.split(":").map(Number);
  return hours * 60 + minutes;
}

// A time on the given Karachi day. day is midnight at the start of that day.
const atTime = (day, hhmm) => day.plus({ minutes: toMinutes(hhmm) });

// 19:00 -> "7:00 PM", for guest messages
const toDisplayTime = (dateTime) => dateTime.setLocale("en-US").toFormat("h:mm a");

// Check that a meal type can be booked on a date (and, for à la carte, at a time),
// and work out when the reservation starts and ends.
// date is YYYY-MM-DD and time is HH:mm, both Karachi local time. Buffets ignore
// time, because a buffet reservation always covers the whole session.
// Returns { valid: true, mealType, startTime, endTime } with Dates for Prisma,
// or { valid: false, code, message }.
// Past dates and the 30-day limit are checked by datetime-validation.service.js.
function validateMealTiming({ date, mealType, time }) {
  if (typeof date !== "string" || !DATE_FORMAT.test(date)) {
    return invalid("INVALID_DATE", "Date must be in the format YYYY-MM-DD.");
  }

  // Midnight at the start of the date, in Karachi (which has no daylight saving)
  const day = DateTime.fromFormat(date, "yyyy-MM-dd", { zone: RESTAURANT_TIMEZONE });
  if (!day.isValid) {
    return invalid("INVALID_DATE", "That date doesn't exist.");
  }

  if (!MEAL_TYPES.includes(mealType)) {
    return invalid("INVALID_MEAL_TYPE", "Please choose buffet lunch, buffet dinner, or à la carte.");
  }

  const isALaCarte = mealType === A_LA_CARTE;
  if (isALaCarte && (typeof time !== "string" || !TIME_FORMAT.test(time))) {
    return invalid("INVALID_TIME", "Time must be in the 24-hour format HH:mm.");
  }

  const weekday = day.setLocale("en-US").weekdayLong;
  if (openingHours.closedDays.includes(weekday)) {
    return invalid("RESTAURANT_CLOSED", `Hammad Foods is closed on ${weekday}s.`);
  }

  if (!isALaCarte) {
    const session = BUFFET_SESSIONS[mealType];
    const start = atTime(day, session.start);
    const end = atTime(day, session.end);

    // A safeguard in case the policies are changed so a session doesn't fit
    if (start < atTime(day, openingHours.open) || end > atTime(day, openingHours.close)) {
      return invalid("OUTSIDE_OPENING_HOURS", "This session is outside our opening hours.");
    }

    return { valid: true, mealType, startTime: start.toJSDate(), endTime: end.toJSDate() };
  }

  if (toMinutes(time) % aLaCarte.slotIntervalMinutes !== 0) {
    return invalid(
      "INVALID_SLOT",
      `À la carte reservations start every ${aLaCarte.slotIntervalMinutes} minutes, such as 19:00 or 19:30.`,
    );
  }

  const start = atTime(day, time);
  const end = start.plus({ minutes: aLaCarte.reservationDurationMinutes });

  if (end > day.endOf("day")) {
    return invalid("CROSSES_MIDNIGHT", "A reservation can't continue past midnight.");
  }

  // The whole reservation must fit inside both the opening hours and à la carte hours
  const opensAt = DateTime.max(atTime(day, openingHours.open), atTime(day, aLaCarte.start));
  const closesAt = DateTime.min(atTime(day, openingHours.close), atTime(day, aLaCarte.end));

  if (start < opensAt || end > closesAt) {
    const latestStart = closesAt.minus({ minutes: aLaCarte.reservationDurationMinutes });
    return invalid(
      "OUTSIDE_OPENING_HOURS",
      `À la carte reservations last ${aLaCarte.reservationDurationMinutes / 60} hours, so they can start between ${toDisplayTime(opensAt)} and ${toDisplayTime(latestStart)}.`,
    );
  }

  return { valid: true, mealType, startTime: start.toJSDate(), endTime: end.toJSDate() };
}

module.exports = { validateMealTiming, MEAL_TYPES, BUFFET_SESSIONS };
