// Run with: npm test
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { useTestDatabase } = require("./support/test-database");

// Must run before the Prisma client is loaded
const removeTestDatabase = useTestDatabase();

const prisma = require("../src/lib/prisma");
const restaurantTables = require("../src/config/restaurant-tables");
const {
  getReservationByCodeAndPhone,
  getReservationsByConversation,
  ReservationServiceError,
} = require("../src/services/reservation-retrieval.service");

const PHONE = "+923001234567";
const NOT_FOUND_MESSAGE = "We couldn't find a reservation with that reservation code and phone number.";

const at = (iso) => new Date(iso);
const failsWith = (code) => (error) => error instanceof ReservationServiceError && error.code === code;

describe("reservation retrieval", () => {
  let conversationA;
  let conversationB;
  let emptyConversation;
  // A second connection to the same database file, to see whether the service writes
  let observer;

  before(async () => {
    await prisma.restaurantTable.createMany({ data: restaurantTables });
    const tableIds = Object.fromEntries((await prisma.restaurantTable.findMany()).map((t) => [t.tableNumber, t.id]));
    conversationA = await prisma.conversation.create({ data: {} });
    conversationB = await prisma.conversation.create({ data: {} });
    emptyConversation = await prisma.conversation.create({ data: {} });

    const book = (conversation, reservationCode, startTime, endTime, tables, data = {}) =>
      prisma.reservation.create({
        data: {
          conversationId: conversation.id,
          reservationCode,
          guestName: "Hammad Amin",
          guestPhone: PHONE,
          startTime: at(startTime),
          endTime: at(endTime),
          mealType: "buffet_dinner",
          adults: 2,
          tables: { create: tables.map((table) => ({ tableId: tableIds[table] })) },
          ...data,
        },
      });

    // Conversation A, deliberately created out of time order
    await book(conversationA, "RSV-A001", "2026-11-20T14:00:00Z", "2026-11-20T18:00:00Z", ["T10", "T7"], {
      adults: 6,
      children: 2,
      estimatedTotalPaisa: 2799300,
      specialRequest: "Window seat",
      extras: {
        create: [
          { extraKey: "birthday_cake", name: "Birthday cake", unitPricePaisa: 300000, lineTotalPaisa: 300000 },
          { extraKey: "candles", name: "Candles", quantity: 3, unitPricePaisa: 30000, lineTotalPaisa: 90000 },
          {
            extraKey: "outside_cake",
            name: "Outside cake service fee",
            unitPricePaisa: 50000,
            lineTotalPaisa: 50000,
            approvalStatus: "pending",
          },
        ],
      },
    });
    await book(conversationA, "RSV-A002", "2026-11-18T07:00:00Z", "2026-11-18T10:30:00Z", ["T1"], { mealType: "buffet_lunch" });
    // Same start time as RSV-A002, so the code decides the order
    await book(conversationA, "RSV-A000", "2026-11-18T07:00:00Z", "2026-11-18T10:30:00Z", ["T2"], { mealType: "buffet_lunch" });
    await book(conversationA, "RSV-A003", "2026-11-19T14:00:00Z", "2026-11-19T18:00:00Z", ["T3"], {
      status: "cancelled",
      cancelledAt: at("2026-11-10T07:00:00Z"),
    });
    await book(conversationA, "RSV-A004", "2026-11-17T14:00:00Z", "2026-11-17T18:00:00Z", ["T4"], { status: "completed" });
    await book(conversationA, "RSV-A005", "2026-11-16T14:00:00Z", "2026-11-16T18:00:00Z", ["T5"], { status: "no_show" });

    // Conversation B, with another guest's phone
    await book(conversationB, "RSV-B001", "2026-11-21T14:00:00Z", "2026-11-21T18:00:00Z", ["T6"], {
      guestName: "Another Guest",
      guestPhone: "+923110000000",
    });

    observer = new Database(process.env.DATABASE_URL.replace(/^file:/, ""), { readonly: true });
  });

  after(async () => {
    observer.close();
    await prisma.$disconnect();
    removeTestDatabase();
  });

  describe("getReservationByCodeAndPhone", () => {
    test("returns the reservation with its tables, extras and guest details", async () => {
      const reservation = await getReservationByCodeAndPhone({ reservationCode: "RSV-A001", guestPhone: PHONE });
      assert.deepEqual(reservation, {
        reservationCode: "RSV-A001",
        status: "confirmed",
        mealType: "buffet_dinner",
        startTime: at("2026-11-20T14:00:00Z"),
        endTime: at("2026-11-20T18:00:00Z"),
        adults: 6,
        children: 2,
        estimatedTotalPaisa: 2799300,
        specialRequest: "Window seat",
        cancelledAt: null,
        guestName: "Hammad Amin",
        guestPhone: PHONE,
        // In table number order, whatever order they were assigned in
        tables: [
          { tableNumber: "T7", section: "FAMILY", capacity: 4 },
          { tableNumber: "T10", section: "FAMILY", capacity: 8 },
        ],
        extras: [
          { extraKey: "birthday_cake", name: "Birthday cake", quantity: 1, unitPricePaisa: 300000, lineTotalPaisa: 300000, approvalStatus: "not_required" },
          { extraKey: "candles", name: "Candles", quantity: 3, unitPricePaisa: 30000, lineTotalPaisa: 90000, approvalStatus: "not_required" },
          { extraKey: "outside_cake", name: "Outside cake service fee", quantity: 1, unitPricePaisa: 50000, lineTotalPaisa: 50000, approvalStatus: "pending" },
        ],
      });
    });

    test("doesn't expose ids, the conversation, messages or proposals", async () => {
      const reservation = await getReservationByCodeAndPhone({ reservationCode: "RSV-A001", guestPhone: PHONE });
      for (const field of ["id", "conversationId", "conversation", "proposals", "messages", "createdAt", "updatedAt"]) {
        assert.equal(field in reservation, false, field);
      }
      assert.deepEqual(Object.keys(reservation.tables[0]).sort(), ["capacity", "section", "tableNumber"]);
      assert.equal("id" in reservation.extras[0] || "reservationId" in reservation.extras[0], false);
    });

    test("accepts the phone in either format and the code in any case", async () => {
      for (const [reservationCode, guestPhone] of [
        ["RSV-A002", "+923001234567"],
        ["RSV-A002", "03001234567"],
        ["rsv-a002", " 03001234567 "],
        ["  RSV-A002  ", "+923001234567"],
      ]) {
        const reservation = await getReservationByCodeAndPhone({ reservationCode, guestPhone });
        assert.equal(reservation.reservationCode, "RSV-A002", `${reservationCode} / ${guestPhone}`);
      }
    });

    test("returns cancelled and completed reservations too, with their status", async () => {
      const cancelled = await getReservationByCodeAndPhone({ reservationCode: "RSV-A003", guestPhone: PHONE });
      assert.equal(cancelled.status, "cancelled");
      assert.deepEqual(cancelled.cancelledAt, at("2026-11-10T07:00:00Z"));
      assert.equal((await getReservationByCodeAndPhone({ reservationCode: "RSV-A004", guestPhone: PHONE })).status, "completed");
    });

    test("a wrong code, wrong phone, someone else's reservation or malformed input give the same error", async () => {
      const cases = [
        { reservationCode: "RSV-NONE", guestPhone: PHONE },
        { reservationCode: "RSV-A001", guestPhone: "03009999999" },
        { reservationCode: "RSV-NONE", guestPhone: "03009999999" },
        { reservationCode: "RSV-B001", guestPhone: PHONE },
        { reservationCode: "RSV-A001", guestPhone: "0300-1234567" },
        { reservationCode: "RSV-A001", guestPhone: "+447911123456" },
        { reservationCode: "RSV-A001", guestPhone: 3001234567 },
        { reservationCode: "RSV-A001" },
        { guestPhone: PHONE },
        { reservationCode: "", guestPhone: PHONE },
        { reservationCode: "   ", guestPhone: PHONE },
        { reservationCode: null, guestPhone: PHONE },
        { reservationCode: ["RSV-A001"], guestPhone: PHONE },
        {},
        undefined,
      ];
      const messages = new Set();
      for (const input of cases) {
        await assert.rejects(getReservationByCodeAndPhone(input), (error) => {
          assert.ok(failsWith("RESERVATION_NOT_FOUND")(error), JSON.stringify(input));
          messages.add(error.message);
          return true;
        });
      }
      assert.deepEqual([...messages], [NOT_FOUND_MESSAGE]);
    });
  });

  describe("getReservationsByConversation", () => {
    const codes = (reservations) => reservations.map((r) => r.reservationCode);

    test("returns the conversation's confirmed reservations, earliest first", async () => {
      const reservations = await getReservationsByConversation({ conversationId: conversationA.id });
      // RSV-A000 and RSV-A002 start at the same time, so they're in code order
      assert.deepEqual(codes(reservations), ["RSV-A000", "RSV-A002", "RSV-A001"]);
      assert.ok(reservations.every((r) => r.status === "confirmed"));
      for (let i = 1; i < reservations.length; i++) {
        assert.ok(reservations[i - 1].startTime <= reservations[i].startTime);
      }
    });

    test("includes tables and extras, without guest details", async () => {
      const reservations = await getReservationsByConversation({ conversationId: conversationA.id });
      const large = reservations.find((r) => r.reservationCode === "RSV-A001");
      assert.deepEqual(large.tables.map((t) => t.tableNumber), ["T7", "T10"]);
      assert.equal(large.extras.length, 3);
      assert.deepEqual(large.extras.map((e) => e.approvalStatus), ["not_required", "not_required", "pending"]);
      assert.equal(large.estimatedTotalPaisa, 2799300);
      for (const reservation of reservations) {
        for (const field of ["guestName", "guestPhone", "id", "conversationId"]) {
          assert.equal(field in reservation, false, field);
        }
      }
    });

    test("excludes cancelled reservations by default and includes them when asked", async () => {
      const withoutCancelled = await getReservationsByConversation({ conversationId: conversationA.id, includeCancelled: false });
      assert.equal(codes(withoutCancelled).includes("RSV-A003"), false);

      const withCancelled = await getReservationsByConversation({ conversationId: conversationA.id, includeCancelled: true });
      assert.deepEqual(codes(withCancelled), ["RSV-A000", "RSV-A002", "RSV-A003", "RSV-A001"]);
      assert.equal(withCancelled.find((r) => r.reservationCode === "RSV-A003").status, "cancelled");
    });

    test("never includes completed, no-show or other statuses", async () => {
      for (const includeCancelled of [false, true]) {
        const reservations = await getReservationsByConversation({ conversationId: conversationA.id, includeCancelled });
        assert.equal(codes(reservations).includes("RSV-A004"), false);
        assert.equal(codes(reservations).includes("RSV-A005"), false);
      }
    });

    test("only returns the given conversation's reservations", async () => {
      const a = await getReservationsByConversation({ conversationId: conversationA.id, includeCancelled: true });
      const b = await getReservationsByConversation({ conversationId: conversationB.id, includeCancelled: true });
      assert.equal(codes(a).includes("RSV-B001"), false);
      assert.deepEqual(codes(b), ["RSV-B001"]);
    });

    test("returns an empty list for a conversation without reservations", async () => {
      assert.deepEqual(await getReservationsByConversation({ conversationId: emptyConversation.id }), []);
    });

    test("a missing conversation is refused", async () => {
      await assert.rejects(getReservationsByConversation({ conversationId: "missing" }), failsWith("CONVERSATION_NOT_FOUND"));
    });

    test("rejects an invalid conversationId or includeCancelled", async () => {
      for (const conversationId of [undefined, null, "", "  ", 1, {}, ["id"]]) {
        await assert.rejects(getReservationsByConversation({ conversationId }), TypeError, String(conversationId));
      }
      for (const includeCancelled of ["true", 1, null, {}]) {
        await assert.rejects(
          getReservationsByConversation({ conversationId: conversationA.id, includeCancelled }),
          TypeError,
          String(includeCancelled),
        );
      }
      await assert.rejects(getReservationsByConversation(), TypeError);
    });
  });

  test("never writes to the database", async () => {
    const dump = () => ({
      reservations: observer.prepare("SELECT * FROM Reservation ORDER BY id").all(),
      tables: observer.prepare("SELECT * FROM ReservationTable ORDER BY id").all(),
      extras: observer.prepare("SELECT * FROM ReservationExtra ORDER BY id").all(),
      conversations: observer.prepare("SELECT * FROM Conversation ORDER BY id").all(),
      proposals: observer.prepare("SELECT * FROM Proposal ORDER BY id").all(),
    });
    // data_version changes whenever another connection commits a change
    const version = () => observer.pragma("data_version", { simple: true });

    const before = dump();
    const versionBefore = version();

    await getReservationByCodeAndPhone({ reservationCode: "RSV-A001", guestPhone: PHONE });
    await getReservationByCodeAndPhone({ reservationCode: "rsv-a003", guestPhone: "03001234567" });
    await assert.rejects(getReservationByCodeAndPhone({ reservationCode: "RSV-NONE", guestPhone: PHONE }));
    await getReservationsByConversation({ conversationId: conversationA.id });
    await getReservationsByConversation({ conversationId: conversationA.id, includeCancelled: true });
    await assert.rejects(getReservationsByConversation({ conversationId: "missing" }));

    assert.equal(version(), versionBefore);
    assert.deepEqual(dump(), before);

    // The check works: a real write is noticed
    await prisma.conversation.create({ data: {} });
    assert.notEqual(version(), versionBefore);
  });
});
