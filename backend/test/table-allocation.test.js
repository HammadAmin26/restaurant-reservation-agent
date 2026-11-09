// Run with: npm test
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { useTestDatabase } = require("./support/test-database");

// Must run before the Prisma client is loaded
const removeTestDatabase = useTestDatabase();

const prisma = require("../src/lib/prisma");
const {
  getAvailableTables,
  findBestTableCombination,
  findTablesForParty,
} = require("../src/services/table-allocation.service");

const table = (tableNumber, section, capacity) => ({ tableNumber, section, capacity });
const numbers = (tables) => tables.map((t) => t.tableNumber);

describe("findBestTableCombination", () => {
  test("picks a single exact fit", () => {
    const tables = [table("T1", "GENERAL", 2), table("T3", "GENERAL", 4), table("T6", "GENERAL", 6)];
    assert.deepEqual(numbers(findBestTableCombination(tables, 4)), ["T3"]);
  });

  test("prefers fewer unused seats over fewer tables", () => {
    // 4 guests: T6 alone leaves 2 empty seats, T1 + T2 leaves none
    const tables = [table("T1", "GENERAL", 2), table("T2", "GENERAL", 2), table("T6", "GENERAL", 6)];
    assert.deepEqual(numbers(findBestTableCombination(tables, 4)), ["T1", "T2"]);
  });

  test("with equal unused seats, prefers fewer tables", () => {
    // 6 guests: T6 alone and T1 + T3 both fit exactly
    const tables = [table("T1", "GENERAL", 2), table("T3", "GENERAL", 4), table("T6", "GENERAL", 6)];
    assert.deepEqual(numbers(findBestTableCombination(tables, 6)), ["T6"]);
  });

  test("combines tables when no single table is big enough", () => {
    const tables = [table("T3", "GENERAL", 4), table("T4", "GENERAL", 4), table("T5", "GENERAL", 4)];
    assert.deepEqual(numbers(findBestTableCombination(tables, 8)), ["T3", "T4"]);
  });

  test("never mixes sections", () => {
    // GENERAL 6 + FAMILY 4 would seat 10, but they can't be combined
    const tables = [table("T6", "GENERAL", 6), table("T7", "FAMILY", 4)];
    assert.equal(findBestTableCombination(tables, 10), null);

    const mixed = [table("T6", "GENERAL", 6), table("T7", "FAMILY", 4), table("T8", "FAMILY", 4)];
    const result = findBestTableCombination(mixed, 8);
    assert.deepEqual(numbers(result), ["T7", "T8"]);
    assert.equal(new Set(result.map((t) => t.section)).size, 1);
  });

  test("prefers GENERAL when both sections can seat the party", () => {
    const tables = [table("T7", "FAMILY", 4), table("T3", "GENERAL", 4)];
    assert.deepEqual(numbers(findBestTableCombination(tables, 4)), ["T3"]);
  });

  test("prefers GENERAL even when FAMILY would leave fewer empty seats", () => {
    // 4 guests: FAMILY T7 fits exactly, GENERAL T6 leaves 2 empty, GENERAL still wins
    const tables = [table("T6", "GENERAL", 6), table("T7", "FAMILY", 4)];
    assert.deepEqual(numbers(findBestTableCombination(tables, 4)), ["T6"]);
  });

  test("falls back to FAMILY only when GENERAL can't seat the whole party", () => {
    // 8 guests: GENERAL has only 2 + 4 = 6 seats
    const tables = [table("T1", "GENERAL", 2), table("T3", "GENERAL", 4), table("T10", "FAMILY", 8)];
    assert.deepEqual(numbers(findBestTableCombination(tables, 8)), ["T10"]);
  });

  test("keeps table order on a full tie", () => {
    // 4 guests: T3, T4 and T5 are equally good, so the first by number wins
    const tables = [table("T5", "GENERAL", 4), table("T4", "GENERAL", 4), table("T3", "GENERAL", 4)];
    assert.deepEqual(numbers(findBestTableCombination(tables, 4)), ["T3"]);
  });

  test("seats 15 children using the full FAMILY inventory", () => {
    // The seeded FAMILY tables: 4 + 4 + 6 + 8 = 22 seats. Best for 15 is 4 + 4 + 8 = 16.
    const family = [table("T7", "FAMILY", 4), table("T8", "FAMILY", 4), table("T9", "FAMILY", 6), table("T10", "FAMILY", 8)];
    assert.deepEqual(numbers(findBestTableCombination(family, 15)), ["T7", "T8", "T10"]);
  });

  test("returns null when capacity is not enough", () => {
    const tables = [table("T1", "GENERAL", 2), table("T2", "GENERAL", 2)];
    assert.equal(findBestTableCombination(tables, 5), null);
    assert.equal(findBestTableCombination([], 1), null);
  });

  test("rejects an invalid party size", () => {
    assert.throws(() => findBestTableCombination([], 0), RangeError);
    assert.throws(() => findBestTableCombination([], 2.5), RangeError);
  });
});

describe("getAvailableTables", () => {
  // Tuesday 10 November 2026, buffet dinner 19:00-23:00 Karachi time (UTC+5)
  const dinnerStart = new Date("2026-11-10T14:00:00Z");
  const dinnerEnd = new Date("2026-11-10T18:00:00Z");
  let conversation;
  let tableIds;

  before(async () => {
    await prisma.restaurantTable.createMany({
      data: [
        { tableNumber: "T1", section: "GENERAL", capacity: 2 },
        { tableNumber: "T3", section: "GENERAL", capacity: 4 },
        { tableNumber: "T6", section: "GENERAL", capacity: 6 },
        { tableNumber: "T7", section: "FAMILY", capacity: 4 },
        { tableNumber: "T9", section: "FAMILY", capacity: 6 },
        { tableNumber: "T10", section: "FAMILY", capacity: 8, isActive: false },
      ],
    });
    tableIds = Object.fromEntries(
      (await prisma.restaurantTable.findMany()).map((t) => [t.tableNumber, t.id]),
    );
    conversation = await prisma.conversation.create({ data: {} });

    let code = 0;
    const book = (tableNumber, startTime, endTime, status = "confirmed") =>
      prisma.reservation.create({
        data: {
          conversationId: conversation.id,
          reservationCode: `RSV-T${++code}`,
          guestName: "Test",
          guestPhone: "0300",
          startTime: new Date(startTime),
          endTime: new Date(endTime),
          mealType: "a_la_carte",
          adults: 2,
          status,
          tables: { create: [{ tableId: tableIds[tableNumber] }] },
        },
      });

    // T1: overlaps the start of dinner (18:00-20:00 Karachi)
    await book("T1", "2026-11-10T13:00:00Z", "2026-11-10T15:00:00Z");
    // T3: ends exactly when dinner starts (17:00-19:00 Karachi), so it doesn't overlap
    await book("T3", "2026-11-10T12:00:00Z", "2026-11-10T14:00:00Z");
    // T6: cancelled reservation during dinner, so it doesn't block the table
    await book("T6", "2026-11-10T14:00:00Z", "2026-11-10T18:00:00Z", "cancelled");
    // T7: confirmed reservation inside dinner
    await book("T7", "2026-11-10T15:00:00Z", "2026-11-10T17:00:00Z");
    // T9: confirmed reservation on another day
    await book("T9", "2026-11-11T14:00:00Z", "2026-11-11T18:00:00Z");
  });

  after(async () => {
    await prisma.$disconnect();
    removeTestDatabase();
  });

  test("excludes overlapping confirmed reservations and inactive tables", async () => {
    const tables = await getAvailableTables({ startTime: dinnerStart, endTime: dinnerEnd, children: 0 });
    // T1 and T7 overlap; T10 is inactive
    assert.deepEqual(numbers(tables), ["T3", "T6", "T9"]);
  });

  test("a reservation ending exactly at the start time doesn't block", async () => {
    const tables = await getAvailableTables({ startTime: dinnerStart, endTime: dinnerEnd, children: 0 });
    assert.ok(numbers(tables).includes("T3"));
  });

  test("cancelled reservations don't block", async () => {
    const tables = await getAvailableTables({ startTime: dinnerStart, endTime: dinnerEnd, children: 0 });
    assert.ok(numbers(tables).includes("T6"));
  });

  test("parties with children only get FAMILY tables", async () => {
    const tables = await getAvailableTables({ startTime: dinnerStart, endTime: dinnerEnd, children: 1 });
    assert.deepEqual(numbers(tables), ["T9"]);
    assert.ok(tables.every((t) => t.section === "FAMILY"));
  });

  test("a different time frees the overlapping tables", async () => {
    // Tuesday lunch 12:00-15:30 Karachi
    const tables = await getAvailableTables({
      startTime: new Date("2026-11-10T07:00:00Z"),
      endTime: new Date("2026-11-10T10:30:00Z"),
      children: 0,
    });
    assert.deepEqual(numbers(tables), ["T1", "T3", "T6", "T7", "T9"]);
  });

  test("rejects invalid times and children", async () => {
    await assert.rejects(getAvailableTables({ startTime: dinnerEnd, endTime: dinnerStart, children: 0 }), RangeError);
    await assert.rejects(getAvailableTables({ startTime: "2026-11-10", endTime: dinnerEnd, children: 0 }), RangeError);
    await assert.rejects(getAvailableTables({ startTime: dinnerStart, endTime: dinnerEnd, children: -1 }), RangeError);
  });

  test("findTablesForParty combines availability and selection", async () => {
    const times = { startTime: dinnerStart, endTime: dinnerEnd };
    // 4 adults: T3 fits exactly
    assert.deepEqual(numbers(await findTablesForParty({ ...times, adults: 4, children: 0 })), ["T3"]);
    // 2 adults + 2 children: FAMILY only, T7 is taken, so T9
    assert.deepEqual(numbers(await findTablesForParty({ ...times, adults: 2, children: 2 })), ["T9"]);
    // 10 adults: T3 + T6
    assert.deepEqual(numbers(await findTablesForParty({ ...times, adults: 10, children: 0 })), ["T3", "T6"]);
    // 5 adults + 2 children: FAMILY has only T9 (6 seats) free
    assert.equal(await findTablesForParty({ ...times, adults: 5, children: 2 }), null);
  });

  test("adults-only parties get GENERAL when both sections have room", async () => {
    // Lunch: GENERAL T1, T3, T6 and FAMILY T7, T9 are all free.
    // 4 adults: GENERAL T3 and FAMILY T7 both fit exactly; GENERAL wins.
    const lunch = { startTime: new Date("2026-11-10T07:00:00Z"), endTime: new Date("2026-11-10T10:30:00Z") };
    const result = await findTablesForParty({ ...lunch, adults: 4, children: 0 });
    assert.deepEqual(numbers(result), ["T3"]);
    assert.equal(result[0].section, "GENERAL");
  });

  test("parties with children never fall back to GENERAL", async () => {
    const times = { startTime: dinnerStart, endTime: dinnerEnd };
    // 3 adults + 1 child: GENERAL T3 is free and fits exactly, but FAMILY T9 is used
    const result = await findTablesForParty({ ...times, adults: 3, children: 1 });
    assert.deepEqual(numbers(result), ["T9"]);
    // 6 adults + 1 child: GENERAL has 10 free seats, but FAMILY only 6, so no tables
    assert.equal(await findTablesForParty({ ...times, adults: 6, children: 1 }), null);
  });

  test("children-only party: 0 adults + 1 child gets a FAMILY table", async () => {
    const times = { startTime: dinnerStart, endTime: dinnerEnd };
    const result = await findTablesForParty({ ...times, adults: 0, children: 1 });
    // T7 is booked, so T9 is the only free FAMILY table
    assert.deepEqual(numbers(result), ["T9"]);
    assert.equal(result[0].section, "FAMILY");
  });

  test("children-only party can't use GENERAL tables", async () => {
    const times = { startTime: dinnerStart, endTime: dinnerEnd };
    // 0 adults + 7 children: GENERAL T3 + T6 has 10 free seats, but FAMILY only 6
    assert.equal(await findTablesForParty({ ...times, adults: 0, children: 7 }), null);
    // At lunch every FAMILY table here is free: T7 + T9 for 0 adults + 10 children
    const lunch = { startTime: new Date("2026-11-10T07:00:00Z"), endTime: new Date("2026-11-10T10:30:00Z") };
    const result = await findTablesForParty({ ...lunch, adults: 0, children: 10 });
    assert.deepEqual(numbers(result), ["T7", "T9"]);
    assert.ok(result.every((t) => t.section === "FAMILY"));
  });

  test("0 adults + 15 children is a valid party", async () => {
    // Accepted as a party; this test inventory has only 10 FAMILY seats, so no tables
    const lunch = { startTime: new Date("2026-11-10T07:00:00Z"), endTime: new Date("2026-11-10T10:30:00Z") };
    assert.equal(await findTablesForParty({ ...lunch, adults: 0, children: 15 }), null);
  });

  test("rejects an empty or invalid party", async () => {
    const times = { startTime: dinnerStart, endTime: dinnerEnd };
    await assert.rejects(findTablesForParty({ ...times, adults: 0, children: 0 }), /PARTY_EMPTY/);
    await assert.rejects(findTablesForParty({ ...times, adults: -1, children: 2 }), /INVALID_ADULTS/);
    await assert.rejects(findTablesForParty({ ...times, adults: 1.5, children: 0 }), /INVALID_ADULTS/);
    await assert.rejects(findTablesForParty({ ...times, adults: 2, children: "1" }), /INVALID_CHILDREN/);
    await assert.rejects(findTablesForParty({ ...times, adults: 0, children: 16 }), /PARTY_TOO_LARGE/);
    await assert.rejects(findTablesForParty({ ...times, adults: 0, children: 0 }), RangeError);
  });

  test("doesn't create or change reservations", async () => {
    const before = await prisma.reservation.count();
    await findTablesForParty({ startTime: dinnerStart, endTime: dinnerEnd, adults: 2, children: 0 });
    assert.equal(await prisma.reservation.count(), before);
    assert.equal(await prisma.reservationTable.count(), 5);
  });
});
