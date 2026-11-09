// Run with: npm test
// The staff dashboard's read-only routes, against a fixed "now" and
// reservations written straight to a throwaway database.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { useTestDatabase } = require("./support/test-database");

// Must run before the Prisma client is loaded
const removeTestDatabase = useTestDatabase();

const prisma = require("../src/lib/prisma");
const restaurantTables = require("../src/config/restaurant-tables");
const { formatPkr } = require("../src/lib/money");

// Tuesday 17 November 2026, 09:00 in Karachi
const NOW = new Date("2026-11-17T09:00:00+05:00");
const at = (isoInKarachi) => new Date(`${isoInKarachi}+05:00`);

let server;
let baseUrl;

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: await response.json() };
}
const list = async (query) => (await get(`/staff/reservations?${query}`)).body.data;
const codes = (data) => data.reservations.map((r) => r.reservationCode);

// The reservations every test reads; created once in before()
const R = {};

async function makeReservation(key, { code, guestName, start, end, mealType, status = "confirmed", table = "T1", extras = [], ...rest }) {
  const conversation = await prisma.conversation.create({ data: {} });
  const restaurantTable = await prisma.restaurantTable.findUnique({ where: { tableNumber: table } });
  R[key] = await prisma.reservation.create({
    data: {
      conversationId: conversation.id,
      reservationCode: code,
      guestName,
      guestPhone: "+923001234567",
      startTime: at(start),
      endTime: at(end),
      mealType,
      adults: 2,
      children: 1,
      status,
      estimatedTotalPaisa: 1224950,
      tables: { create: [{ tableId: restaurantTable.id }] },
      extras: { create: extras },
      ...rest,
    },
  });
}

const CANDLES = { extraKey: "candles", name: "Candles", quantity: 2, unitPricePaisa: 30000, lineTotalPaisa: 60000 };
const pendingCake = { extraKey: "birthday_cake", name: "Birthday cake", quantity: 1, unitPricePaisa: 350000, lineTotalPaisa: 350000, approvalStatus: "pending" };

describe("staff dashboard routes", () => {
  before(async () => {
    await prisma.restaurantTable.createMany({ data: restaurantTables });

    // Today, the 17th
    await makeReservation("todayDinner", {
      code: "RSV-AAA1",
      guestName: "Ayesha Khan",
      start: "2026-11-17T19:00:00",
      end: "2026-11-17T23:00:00",
      mealType: "buffet_dinner",
      table: "T3",
      specialRequest: "Window seat, please",
      extras: [CANDLES, pendingCake],
    });
    await makeReservation("todayLunchCancelled", {
      code: "RSV-BBB2",
      guestName: "Bilal Ahmed",
      start: "2026-11-17T12:00:00",
      end: "2026-11-17T15:30:00",
      mealType: "buffet_lunch",
      status: "cancelled",
      cancelledAt: at("2026-11-15T10:30:00"),
    });
    // Just after midnight on the 17th in Karachi, which is still the 16th in UTC
    await makeReservation("justAfterMidnight", {
      code: "RSV-CCC3",
      guestName: "Danish Ali",
      start: "2026-11-17T00:30:00",
      end: "2026-11-17T02:30:00",
      mealType: "a_la_carte",
    });
    // Just before midnight on the 16th
    await makeReservation("justBeforeMidnight", {
      code: "RSV-DDD4",
      guestName: "Erum Shah",
      start: "2026-11-16T23:30:00",
      end: "2026-11-17T01:30:00",
      mealType: "a_la_carte",
    });
    // In the past
    await makeReservation("past", {
      code: "RSV-EEE5",
      guestName: "Sara Malik",
      start: "2026-11-10T13:00:00",
      end: "2026-11-10T15:00:00",
      mealType: "a_la_carte",
    });
    await makeReservation("pastWithPendingExtra", {
      code: "RSV-FFF6",
      guestName: "Usman Tariq",
      start: "2026-11-10T19:00:00",
      end: "2026-11-10T23:00:00",
      mealType: "buffet_dinner",
      table: "T2",
      extras: [pendingCake],
    });
    // In the future
    await makeReservation("future", {
      code: "RSV-GGG7",
      guestName: "Ayesha Raza",
      start: "2026-11-25T12:00:00",
      end: "2026-11-25T15:30:00",
      mealType: "buffet_lunch",
      extras: [{ extraKey: "outside_cake", name: "Outside cake service fee", quantity: 1, unitPricePaisa: 50000, lineTotalPaisa: 50000, approvalStatus: "pending" }],
    });
    await makeReservation("futureCancelledWithPendingExtra", {
      code: "RSV-HHH8",
      guestName: "Hina Javed",
      start: "2026-11-20T19:00:00",
      end: "2026-11-20T23:00:00",
      mealType: "buffet_dinner",
      status: "cancelled",
      cancelledAt: at("2026-11-16T09:00:00"),
      extras: [pendingCake],
    });

    const { createApp } = require("../src/app");
    server = createApp({ clock: () => NOW }).listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
    removeTestDatabase();
  });

  describe("summary", () => {
    test("counts come from the database", async () => {
      const { status, body } = await get("/staff/dashboard/summary");
      assert.equal(status, 200);
      assert.deepEqual(body, {
        success: true,
        data: {
          today: "2026-11-17",
          // Confirmed and starting on the 17th in Karachi: the dinner and the 00:30 one
          todayReservations: 2,
          // Confirmed and not started yet at 09:00: the dinner and the one on the 25th
          upcomingReservations: 2,
          confirmedReservations: 6,
          cancelledReservations: 2,
          // Today's cake and the 25th's outside cake; not the past one or the cancelled one
          pendingExtraApprovals: 2,
        },
      });
    });

    test("follows new records", async () => {
      const before = (await get("/staff/dashboard/summary")).body.data;
      await makeReservation("added", {
        code: "RSV-ZZZ9",
        guestName: "Temporary Guest",
        start: "2026-11-17T21:00:00",
        end: "2026-11-17T23:00:00",
        mealType: "a_la_carte",
        table: "T5",
      });
      try {
        const after = (await get("/staff/dashboard/summary")).body.data;
        assert.equal(after.todayReservations, before.todayReservations + 1);
        assert.equal(after.upcomingReservations, before.upcomingReservations + 1);
        assert.equal(after.confirmedReservations, before.confirmedReservations + 1);
      } finally {
        await prisma.reservationTable.deleteMany({ where: { reservationId: R.added.id } });
        await prisma.reservation.delete({ where: { id: R.added.id } });
      }
    });
  });

  describe("reservations by date", () => {
    test("a day lists confirmed and cancelled reservations, earliest first", async () => {
      const data = await list("date=2026-11-17");
      assert.deepEqual(codes(data), ["RSV-CCC3", "RSV-BBB2", "RSV-AAA1"]);
      assert.deepEqual(data.reservations.map((r) => r.status), ["confirmed", "cancelled", "confirmed"]);
      assert.equal(data.date, "2026-11-17");
      assert.equal(data.truncated, false);
    });

    test("Karachi midnight decides the day, not UTC", async () => {
      assert.deepEqual(codes(await list("date=2026-11-16")), ["RSV-DDD4"]);
      assert.ok(codes(await list("date=2026-11-17")).includes("RSV-CCC3"));
    });

    test("past and future days work", async () => {
      assert.deepEqual(codes(await list("date=2026-11-10")), ["RSV-EEE5", "RSV-FFF6"]);
      assert.deepEqual(codes(await list("date=2026-11-25")), ["RSV-GGG7"]);
      assert.deepEqual(codes(await list("date=2025-01-01")), []);
    });

    test("a day with no reservations is a valid empty result", async () => {
      const { status, body } = await get("/staff/reservations?date=2027-02-03");
      assert.equal(status, 200);
      assert.deepEqual(body, { success: true, data: { date: "2027-02-03", search: null, reservations: [], truncated: false } });
    });

    test("list items carry what the cards show, without the phone or ids", async () => {
      const [item] = (await list("date=2026-11-17&search=AAA1")).reservations;
      assert.deepEqual(Object.keys(item).sort(), [
        "adults",
        "cancelledAt",
        "children",
        "endTime",
        "estimatedTotalPaisa",
        "extras",
        "guestName",
        "mealType",
        "reservationCode",
        "specialRequest",
        "startTime",
        "status",
        "tables",
      ]);
      assert.equal(item.guestName, "Ayesha Khan");
      assert.equal(item.startTime, R.todayDinner.startTime.toISOString());
      assert.deepEqual(item.tables, [{ tableNumber: "T3", section: "GENERAL", capacity: 4 }]);
      assert.equal(JSON.stringify(item).includes(R.todayDinner.id), false);
    });
  });

  describe("filters and search", () => {
    test("status", async () => {
      assert.deepEqual(codes(await list("date=2026-11-17&status=confirmed")), ["RSV-CCC3", "RSV-AAA1"]);
      assert.deepEqual(codes(await list("date=2026-11-17&status=cancelled")), ["RSV-BBB2"]);
      assert.deepEqual(codes(await list("date=2026-11-17&status=all")), ["RSV-CCC3", "RSV-BBB2", "RSV-AAA1"]);
    });

    test("meal type: buffet covers lunch and dinner", async () => {
      assert.deepEqual(codes(await list("date=2026-11-17&mealType=buffet")), ["RSV-BBB2", "RSV-AAA1"]);
      assert.deepEqual(codes(await list("date=2026-11-17&mealType=a_la_carte")), ["RSV-CCC3"]);
    });

    test("search by reservation code, in any case and in part", async () => {
      assert.deepEqual(codes(await list("search=rsv-aaa1")), ["RSV-AAA1"]);
      assert.deepEqual(codes(await list("search=ggg")), ["RSV-GGG7"]);
    });

    test("search by guest name across every day, latest first", async () => {
      const data = await list("search=ayesha");
      assert.deepEqual(codes(data), ["RSV-GGG7", "RSV-AAA1"]);
      assert.equal(data.date, null);
      assert.equal(data.search, "ayesha");
    });

    test("combined: search, date, status and meal type", async () => {
      assert.deepEqual(codes(await list("date=2026-11-17&search=Ayesha")), ["RSV-AAA1"]);
      assert.deepEqual(codes(await list("search=ayesha&mealType=buffet&status=confirmed")), ["RSV-GGG7", "RSV-AAA1"]);
      assert.deepEqual(codes(await list("search=ayesha&mealType=a_la_carte")), []);
      assert.deepEqual(codes(await list("date=2026-11-17&status=cancelled&mealType=buffet")), ["RSV-BBB2"]);
      assert.deepEqual(codes(await list("date=2026-11-17&status=cancelled&mealType=a_la_carte")), []);
    });
  });

  describe("invalid queries", () => {
    for (const [label, query] of [
      ["no date and no search", ""],
      ["a date that doesn't exist", "date=2026-02-30"],
      ["a date in another format", "date=17-11-2026"],
      ["an unknown status", "date=2026-11-17&status=pending"],
      ["an unknown meal type", "date=2026-11-17&mealType=dinner"],
      ["a search that's too long", `search=${"a".repeat(101)}`],
      ["a date given twice", "date=2026-11-17&date=2026-11-18"],
    ]) {
      test(label, async () => {
        const { status, body } = await get(`/staff/reservations?${query}`);
        assert.equal(status, 400);
        assert.equal(body.success, false);
        assert.equal(body.code, "INVALID_QUERY");
        assert.equal(typeof body.message, "string");
      });
    }
  });

  describe("reservation details", () => {
    test("return every field staff need, by code in any case", async () => {
      const { status, body } = await get("/staff/reservations/rsv-aaa1");
      assert.equal(status, 200);
      assert.deepEqual(body.data, {
        reservationCode: "RSV-AAA1",
        status: "confirmed",
        mealType: "buffet_dinner",
        startTime: R.todayDinner.startTime.toISOString(),
        endTime: R.todayDinner.endTime.toISOString(),
        adults: 2,
        children: 1,
        estimatedTotalPaisa: 1224950,
        specialRequest: "Window seat, please",
        cancelledAt: null,
        guestName: "Ayesha Khan",
        guestPhone: "+923001234567",
        tables: [{ tableNumber: "T3", section: "GENERAL", capacity: 4 }],
        extras: [
          { extraKey: "candles", name: "Candles", quantity: 2, unitPricePaisa: 30000, lineTotalPaisa: 60000, approvalStatus: "not_required" },
          { extraKey: "birthday_cake", name: "Birthday cake", quantity: 1, unitPricePaisa: 350000, lineTotalPaisa: 350000, approvalStatus: "pending" },
        ],
        bookedAt: R.todayDinner.createdAt.toISOString(),
      });
    });

    test("a cancelled reservation shows when it was cancelled", async () => {
      const { body } = await get("/staff/reservations/RSV-BBB2");
      assert.equal(body.data.status, "cancelled");
      assert.equal(body.data.cancelledAt, at("2026-11-15T10:30:00").toISOString());
    });

    test("an outside cake shows as its own extra", async () => {
      const { body } = await get("/staff/reservations/RSV-GGG7");
      assert.deepEqual(body.data.extras.map((e) => [e.extraKey, e.approvalStatus]), [["outside_cake", "pending"]]);
      assert.equal(body.data.specialRequest, null);
    });

    test("an unknown code is a 404", async () => {
      const { status, body } = await get("/staff/reservations/RSV-NONE");
      assert.equal(status, 404);
      assert.deepEqual(body, { success: false, code: "RESERVATION_NOT_FOUND", message: "No reservation has that code." });
    });
  });

  test("pending extra approvals: confirmed reservations from today on, soonest first", async () => {
    const { status, body } = await get("/staff/extra-approvals");
    assert.equal(status, 200);
    assert.deepEqual(body.data, [
      {
        reservationCode: "RSV-AAA1",
        guestName: "Ayesha Khan",
        startTime: R.todayDinner.startTime.toISOString(),
        endTime: R.todayDinner.endTime.toISOString(),
        mealType: "buffet_dinner",
        extra: { extraKey: "birthday_cake", name: "Birthday cake", quantity: 1, approvalStatus: "pending" },
      },
      {
        reservationCode: "RSV-GGG7",
        guestName: "Ayesha Raza",
        startTime: R.future.startTime.toISOString(),
        endTime: R.future.endTime.toISOString(),
        mealType: "buffet_lunch",
        extra: { extraKey: "outside_cake", name: "Outside cake service fee", quantity: 1, approvalStatus: "pending" },
      },
    ]);
  });

  test("prices stay exact paisa, including half rupees, for the PKR display", async () => {
    const { body } = await get("/staff/reservations/RSV-AAA1");
    assert.equal(body.data.estimatedTotalPaisa, 1224950);
    // The shared rule for showing paisa as PKR: half rupees keep two decimals
    assert.equal(formatPkr(body.data.estimatedTotalPaisa), "PKR 12,249.50");
    assert.equal(formatPkr(124950), "PKR 1,249.50");
    assert.equal(formatPkr(350000), "PKR 3,500");
  });

  test("the staff routes are read-only", async () => {
    const snapshot = async () => ({
      reservations: await prisma.reservation.findMany({ orderBy: { id: "asc" } }),
      extras: await prisma.reservationExtra.findMany({ orderBy: { id: "asc" } }),
    });
    const before = await snapshot();
    for (const path of [
      "/staff/dashboard/summary",
      "/staff/reservations?date=2026-11-17",
      "/staff/reservations?search=a",
      "/staff/reservations/RSV-AAA1",
      "/staff/extra-approvals",
    ]) {
      assert.equal((await get(path)).status, 200, path);
    }
    assert.deepEqual(await snapshot(), before);

    // And there's no way to change anything through them
    const response = await fetch(`${baseUrl}/staff/reservations/RSV-AAA1`, { method: "DELETE" });
    assert.equal(response.status, 404);
  });
});
