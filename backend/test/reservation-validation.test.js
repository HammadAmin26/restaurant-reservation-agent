// Run with: npm test
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { useTestDatabase } = require("./support/test-database");

// Must run before the Prisma client is loaded
const removeTestDatabase = useTestDatabase();

const prisma = require("../src/lib/prisma");
const restaurantTables = require("../src/config/restaurant-tables");
const { validateReservationRequest } = require("../src/services/reservation-validation.service");

// A fixed clock: Tuesday 10 November 2026, 12:00 in Karachi (07:00 UTC)
const NOW = new Date("2026-11-10T07:00:00Z");
// Karachi is UTC+5. November 2026: Monday the 16th, Tuesday the 17th.
const TUESDAY = "2026-11-17";
const MONDAY = "2026-11-16";
// Every FAMILY table is booked for dinner on this day
const FAMILY_FULL_DAY = "2026-11-18";
// Every GENERAL table is booked for dinner on this day
const GENERAL_FULL_DAY = "2026-11-19";

const request = (overrides = {}) => ({
  date: TUESDAY,
  time: "19:00",
  mealType: "a_la_carte",
  adults: 2,
  children: 0,
  guestName: "Hammad Amin",
  guestPhone: "03001234567",
  ...overrides,
});
const validate = (overrides, now = NOW) => validateReservationRequest(request(overrides), now);
const numbers = (result) => result.tables.map((t) => t.tableNumber);
const times = (result) => [result.startTime.toISOString(), result.endTime.toISOString()];

describe("validateReservationRequest", () => {
  let reservationCountAtStart;

  before(async () => {
    await prisma.restaurantTable.createMany({ data: restaurantTables });
    const tables = await prisma.restaurantTable.findMany();
    const conversation = await prisma.conversation.create({ data: {} });

    // Book the given tables for dinner (19:00-23:00 Karachi) on a day
    let code = 0;
    const bookDinner = (date, section) =>
      Promise.all(
        tables
          .filter((t) => t.section === section)
          .map((t) =>
            prisma.reservation.create({
              data: {
                conversationId: conversation.id,
                reservationCode: `RSV-F${++code}`,
                guestName: "Booked",
                guestPhone: "+923000000000",
                startTime: new Date(`${date}T14:00:00Z`),
                endTime: new Date(`${date}T18:00:00Z`),
                mealType: "buffet_dinner",
                adults: t.capacity,
                tables: { create: [{ tableId: t.id }] },
              },
            }),
          ),
      );

    await bookDinner(FAMILY_FULL_DAY, "FAMILY");
    await bookDinner(GENERAL_FULL_DAY, "GENERAL");
    reservationCountAtStart = await prisma.reservation.count();
  });

  after(async () => {
    await prisma.$disconnect();
    removeTestDatabase();
  });

  test("a valid adults-only à la carte request", async () => {
    const result = await validate({ adults: 4, guestName: "  Hammad Amin ", guestPhone: "03001234567" });
    assert.equal(result.valid, true);
    assert.deepEqual(result.guest, { guestName: "Hammad Amin", guestPhone: "+923001234567" });
    assert.deepEqual(result.party, { adults: 4, children: 0, total: 4, requiresFamilySection: false });
    assert.equal(result.mealType, "a_la_carte");
    // 19:00-21:00 Karachi, a GENERAL 4-seater
    assert.deepEqual(times(result), ["2026-11-17T14:00:00.000Z", "2026-11-17T16:00:00.000Z"]);
    assert.deepEqual(numbers(result), ["T3"]);
    assert.equal(result.tables[0].section, "GENERAL");
    assert.equal(typeof result.tables[0].id, "string");
  });

  test("a party with children gets FAMILY tables for the whole buffet session", async () => {
    const result = await validate({ mealType: "buffet_dinner", time: undefined, adults: 2, children: 2 });
    assert.equal(result.valid, true);
    assert.equal(result.party.requiresFamilySection, true);
    assert.deepEqual(times(result), ["2026-11-17T14:00:00.000Z", "2026-11-17T18:00:00.000Z"]);
    assert.deepEqual(numbers(result), ["T7"]);
    assert.ok(result.tables.every((t) => t.section === "FAMILY"));
  });

  test("a children-only party is valid and uses FAMILY tables", async () => {
    const result = await validate({ mealType: "buffet_lunch", time: undefined, adults: 0, children: 3 });
    assert.equal(result.valid, true);
    assert.deepEqual(result.party, { adults: 0, children: 3, total: 3, requiresFamilySection: true });
    assert.deepEqual(times(result), ["2026-11-17T07:00:00.000Z", "2026-11-17T10:30:00.000Z"]);
    assert.deepEqual(numbers(result), ["T7"]);
  });

  test("adults-only parties use GENERAL first and need enough seats in one section", async () => {
    // 10 adults: GENERAL T3 + T6 fits exactly
    const result = await validate({ adults: 10 });
    assert.deepEqual(numbers(result), ["T3", "T6"]);
    assert.ok(result.tables.every((t) => t.section === "GENERAL"));
  });

  test("adults-only parties move to FAMILY only when GENERAL is full", async () => {
    const result = await validate({ date: GENERAL_FULL_DAY, mealType: "buffet_dinner", adults: 4 });
    assert.deepEqual(numbers(result), ["T7"]);
  });

  test("rejects an invalid guest name or phone", async () => {
    const name = await validate({ guestName: "   " });
    assert.deepEqual(Object.keys(name).sort(), ["code", "kind", "message", "valid"]);
    assert.equal(name.code, "INVALID_NAME");
    assert.equal(name.kind, "validation");

    for (const guestPhone of ["02134567890", "+447911123456", "0300-1234567", undefined]) {
      const phone = await validate({ guestPhone });
      assert.equal(phone.code, "INVALID_PHONE", String(guestPhone));
      assert.equal(phone.kind, "validation");
    }
  });

  test("rejects an invalid party size", async () => {
    assert.equal((await validate({ adults: 16 })).code, "PARTY_TOO_LARGE");
    assert.equal((await validate({ adults: 10, children: 6 })).code, "PARTY_TOO_LARGE");
    assert.equal((await validate({ adults: 0, children: 0 })).code, "PARTY_EMPTY");
    assert.equal((await validate({ adults: "2" })).code, "INVALID_ADULTS");
    assert.equal((await validate({ children: -1 })).code, "INVALID_CHILDREN");
  });

  test("rejects a past date or time", async () => {
    // Sunday 8 November
    assert.equal((await validate({ date: "2026-11-08" })).code, "DATE_IN_PAST");
    // Today's buffet lunch started at 12:00, which is now
    const lunchToday = await validate({ date: "2026-11-10", mealType: "buffet_lunch" });
    assert.equal(lunchToday.code, "DATE_IN_PAST");
    assert.equal(lunchToday.kind, "validation");
    // Tonight's à la carte is still in the future
    assert.equal((await validate({ date: "2026-11-10", time: "19:00" })).valid, true);
  });

  test("rejects a date beyond the 30-day limit", async () => {
    // Tuesday 15 December is 35 days ahead
    assert.equal((await validate({ date: "2026-12-15", mealType: "buffet_dinner" })).code, "TOO_FAR_AHEAD");
    // Thursday 10 December at 12:00 is exactly 30 days ahead
    assert.equal((await validate({ date: "2026-12-10", time: "12:00" })).valid, true);
  });

  test("rejects Monday for every meal type", async () => {
    for (const mealType of ["buffet_lunch", "buffet_dinner", "a_la_carte"]) {
      const result = await validate({ date: MONDAY, mealType });
      assert.equal(result.code, "RESTAURANT_CLOSED", mealType);
      assert.equal(result.kind, "validation");
    }
  });

  test("rejects an invalid meal type and keeps buffets to their sessions", async () => {
    assert.equal((await validate({ mealType: "buffet_brunch" })).code, "INVALID_MEAL_TYPE");
    assert.equal((await validate({ mealType: undefined })).code, "INVALID_MEAL_TYPE");
    // A time given for a buffet doesn't change the session
    const dinner = await validate({ mealType: "buffet_dinner", time: "21:15" });
    assert.deepEqual(times(dinner), ["2026-11-17T14:00:00.000Z", "2026-11-17T18:00:00.000Z"]);
  });

  test("rejects an invalid à la carte slot or time", async () => {
    assert.equal((await validate({ time: "19:15" })).code, "INVALID_SLOT");
    assert.equal((await validate({ time: "21:30" })).code, "OUTSIDE_OPENING_HOURS");
    assert.equal((await validate({ time: "7pm" })).code, "INVALID_TIME");
    assert.equal((await validate({ date: "2026-02-30" })).code, "INVALID_DATE");
  });

  test("returns TABLES_UNAVAILABLE when the request is valid but no tables fit", async () => {
    // Every FAMILY table is booked for dinner, and children can't sit in GENERAL
    const result = await validate({ date: FAMILY_FULL_DAY, mealType: "buffet_dinner", adults: 2, children: 1 });
    assert.deepEqual(result, {
      valid: false,
      kind: "availability",
      code: "TABLES_UNAVAILABLE",
      message: "Sorry, we don't have a table for 3 guests at that time. Please try another time or date.",
    });

    // The same day still has GENERAL tables for adults
    const adults = await validate({ date: FAMILY_FULL_DAY, mealType: "buffet_dinner", adults: 2 });
    assert.deepEqual(numbers(adults), ["T1"]);

    // Lunch that day doesn't overlap the dinner bookings
    const lunch = await validate({ date: FAMILY_FULL_DAY, mealType: "buffet_lunch", adults: 2, children: 1 });
    assert.deepEqual(numbers(lunch), ["T7"]);
  });

  test("stops at the first failure, checking guest details first", async () => {
    // Everything is wrong; the name is reported
    const result = await validate({ guestName: "", guestPhone: "x", adults: 99, date: MONDAY, mealType: "brunch" });
    assert.equal(result.code, "INVALID_NAME");
    // Then party, then meal timing, then date limits
    assert.equal((await validate({ adults: 99, date: MONDAY })).code, "PARTY_TOO_LARGE");
    assert.equal((await validate({ date: "2026-11-09" })).code, "RESTAURANT_CLOSED");
  });

  test("handles a missing or empty request", async () => {
    assert.equal((await validateReservationRequest(undefined, NOW)).code, "INVALID_NAME");
    assert.equal((await validateReservationRequest(null, NOW)).code, "INVALID_NAME");
  });

  test("never creates a Reservation, Proposal or table assignment", async () => {
    await validate({ adults: 4 });
    await validate({ date: FAMILY_FULL_DAY, mealType: "buffet_dinner", children: 1 });
    assert.equal(await prisma.reservation.count(), reservationCountAtStart);
    assert.equal(await prisma.reservationTable.count(), reservationCountAtStart);
    assert.equal(await prisma.proposal.count(), 0);
  });
});
