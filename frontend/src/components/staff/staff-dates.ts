// Days for the staff dashboard, as YYYY-MM-DD in the restaurant's timezone.
// Only for choosing and showing days: the backend decides which reservations
// fall on a day.

const TIMEZONE = "Asia/Karachi";

// Today in Karachi
export function karachiToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(now);
}

// The day an instant falls on in Karachi
export const karachiDayOf = (iso: string) => karachiToday(new Date(iso));

// True for a real calendar date written as YYYY-MM-DD
export function isDay(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// The day `days` after (or before, when negative) a day
export function shiftDay(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

// "Tuesday 17 November 2026"
export function formatLongDay(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(`${value}T12:00:00+05:00`));
}

// "19:00–23:00" in Karachi
export function formatTimeRange(start: string, end: string) {
  const format = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit", hour12: false });
  return `${format.format(new Date(start))}–${format.format(new Date(end))}`;
}

// "Sun, 15 Nov 2026, 10:30" in Karachi
export function formatDateTime(iso: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}
