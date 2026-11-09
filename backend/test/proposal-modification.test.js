// Run with: npm test
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { useTestDatabase } = require("./support/test-database");

// Must run before the Prisma client is loaded
const removeTestDatabase = useTestDatabase();

const prisma = require("../src/lib/prisma");
const restaurantTables = require("../src/config/restaurant-tables");
const { findTablesForParty } = require("../src/services/table-allocation.service");
const { createModificationProposal, ProposalServiceError } = require("../src/services/proposal.service");

// A fixed clock: Tuesday 10 November 2026, 12:00 in Karachi (07:00 UTC). Karachi is UTC+5.
const NOW = new Date("2026-11-10T07:00:00Z");
const FIVE_MINUTES = 5 * 60 * 1000;

// The reservation being modified: buffet dinner on Tuesday 17 November, 19:00-23:00 Karachi
const DINNER_START = new Date("2026-11-17T14:00:00Z");
const DINNER_END = new Date("2026-11-17T18:00:00Z");
const CODE = "RSV-MOD1";
const PHONE = "+923001234567";

const newConversation = (data = {}) => prisma.conversation.create({ data });

// The new details, by default buffet lunch for 3 adults + 1 child on Thursday 19 November
async function modify(overrides = {}) {
  const conversationId = overrides.conversationId ?? (await newConversation()).id;
  return createModificationProposal({
    conversationId,
    reservationCode: CODE,
    guestPhone: "03001234567",
    date: "2026-11-19",
    mealType: "buffet_lunch",
    adults: 3,
    children: 1,
    now: NOW,
    ...overrides,
  });
}

const notFound = (error) => error instanceof ProposalServiceError && error.code === "RESERVATION_NOT_FOUND";
const failsWith = (code) => (error) => error instanceof ProposalServiceError && error.code === code;
const tableNumbers = (tables) => tables.map((t) => t.tableNumber);

describe("createModificationProposal", () => {
  let reservation;
  let fullSnapshot;

  // Every reservation, table assignment and extra, to compare at the end
  const snapshotAll = async () => ({
    reservations: await prisma.reservation.findMany({ orderBy: { reservationCode: "asc" } }),
    tables: await prisma.reservationTable.findMany({ orderBy: { id: "asc" } }),
    extras: await prisma.reservationExtra.findMany({ orderBy: { id: "asc" } }),
  });

  before(async () => {
    await prisma.restaurantTable.createMany({ data: restaurantTables });
    const tables = Object.fromEntries((await prisma.restaurantTable.findMany()).map((t) => [t.tableNumber, t.id]));
    const owner = await newConversation();

    const book = (reservationCode, tableNumber, data = {}) =>
      prisma.reservation.create({
        data: {
          conversationId: owner.id,
          reservationCode,
          guestName: "Another Guest",
          guestPhone: "+923110000000",
          startTime: DINNER_START,
          endTime: DINNER_END,
          mealType: "buffet_dinner",
          adults: 2,
          tables: { create: [{ tableId: tables[tableNumber] }] },
          ...data,
        },
      });

    // 2 adults + 1 child at dinner on T7, with a birthday cake and an outside cake fee
    reservation = await book(CODE, "T7", {
      guestName: "Hammad Amin",
      guestPhone: PHONE,
      children: 1,
      estimatedTotalPaisa: 1224750,
      specialRequest: "Window seat",
      extras: {
        create: [
          { extraKey: "birthday_cake", name: "Birthday cake", unitPricePaisa: 300000, lineTotalPaisa: 300000 },
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

    // Every other FAMILY table is booked for the same dinner
    await book("RSV-OTH8", "T8");
    await book("RSV-OTH9", "T9");
    await book("RSV-OTHX", "T10");

    // A cancelled reservation with the same phone number
    await book("RSV-CAN1", "T1", { guestPhone: PHONE, status: "cancelled", cancelledAt: NOW });

    fullSnapshot = await snapshotAll();
  });

  after(async () => {
    await prisma.$disconnect();
    removeTestDatabase();
  });

  describe("successful proposals", () => {
    test("creates a pending modify proposal for the reservation", async () => {
      const conversation = await newConversation();
      const result = await modify({ conversationId: conversation.id });

      assert.equal(result.valid, true);
      const { proposal } = result;
      assert.equal(proposal.actionType, "modify");
      assert.equal(proposal.reservationId, reservation.id);
      assert.equal(proposal.status, "pending");
      assert.equal(proposal.conversationId, conversation.id);
    });

    test("expires five minutes after now", async () => {
      const { proposal } = await modify();
      assert.equal(proposal.expiresAt.getTime() - NOW.getTime(), FIVE_MINUTES);
    });

    test("stores the requested details, the resulting reservation and the current one", async () => {
      const { proposal } = await modify();
      const stored = await prisma.proposal.findUnique({ where: { id: proposal.id } });
      assert.equal(typeof stored.payload, "string");
      assert.deepEqual(JSON.parse(stored.payload), proposal.payload);

      const { payload } = proposal;
      assert.equal(payload.reservationCode, CODE);
      assert.deepEqual(payload.request, {
        date: "2026-11-19",
        mealType: "buffet_lunch",
        adults: 3,
        children: 1,
        childrenUnder3: 0,
      });
      assert.equal(payload.target.mealType, "buffet_lunch");
      // Lunch on the 19th, 12:00-15:30 Karachi
      assert.equal(payload.target.startTime, "2026-11-19T07:00:00.000Z");
      assert.equal(payload.target.endTime, "2026-11-19T10:30:00.000Z");
      assert.equal(payload.target.adults, 3);
      assert.equal(payload.target.children, 1);
      assert.deepEqual(tableNumbers(payload.target.tables), ["T7"]);
      // 3 x 249900 + 1 x 124950 for lunch, plus the unchanged extras (300000 + 50000)
      assert.equal(payload.target.estimatedTotalPaisa, 1224650);
      const [ownTable] = await prisma.reservationTable.findMany({ where: { reservationId: reservation.id } });
      assert.deepEqual(payload.current, {
        mealType: "buffet_dinner",
        startTime: "2026-11-17T14:00:00.000Z",
        endTime: "2026-11-17T18:00:00.000Z",
        adults: 2,
        children: 1,
        estimatedTotalPaisa: 1224750,
        tableIds: [ownTable.tableId],
      });
      // Name, phone, extras and special request aren't part of the change
      assert.equal(JSON.stringify(payload).includes("Window seat"), false);
      assert.equal(JSON.stringify(payload).includes(PHONE), false);
    });

    test("prices under-3s as free and à la carte as extras only", async () => {
      const under3 = await modify({ childrenUnder3: 1 });
      assert.equal(under3.proposal.payload.target.estimatedTotalPaisa, 3 * 249900 + 350000);

      const aLaCarte = await modify({ mealType: "a_la_carte", time: "13:30" });
      assert.equal(aLaCarte.proposal.payload.target.estimatedTotalPaisa, 350000);
      assert.equal(aLaCarte.proposal.payload.request.time, "13:30");
      assert.equal(aLaCarte.proposal.payload.target.endTime, "2026-11-19T10:30:00.000Z");
    });

    test("accepts the phone in either format and the code in any case", async () => {
      for (const [reservationCode, guestPhone] of [
        [CODE, PHONE],
        ["rsv-mod1", "03001234567"],
        ["  RSV-MOD1 ", "  +923001234567 "],
      ]) {
        const result = await modify({ reservationCode, guestPhone });
        assert.equal(result.valid, true, `${reservationCode} / ${guestPhone}`);
        assert.equal(result.proposal.reservationId, reservation.id);
      }
    });
  });

  describe("ownership", () => {
    test("a wrong code, wrong phone or both give the same error", async () => {
      const messages = new Set();
      for (const [reservationCode, guestPhone] of [
        ["RSV-NONE", "03001234567"], // wrong code
        [CODE, "03009999999"], // wrong phone
        ["RSV-NONE", "03009999999"], // both wrong
        ["RSV-OTH8", "03001234567"], // a real code with someone else's phone
        [CODE, "0300-1234567"], // invalid phone
        [CODE, "+447911123456"],
        ["", "03001234567"],
        [null, "03001234567"],
        [123, "03001234567"],
        [CODE, undefined],
      ]) {
        const conversation = await newConversation();
        await assert.rejects(
          modify({ conversationId: conversation.id, reservationCode, guestPhone }),
          (error) => {
            assert.ok(notFound(error), `${reservationCode} / ${guestPhone}`);
            messages.add(error.message);
            return true;
          },
        );
        assert.equal(await prisma.proposal.count({ where: { conversationId: conversation.id } }), 0);
      }
      // One message for every case, which doesn't say which part was wrong
      assert.equal(messages.size, 1);
      assert.equal([...messages][0], "We couldn't find a reservation with that reservation code and phone number.");
    });

    test("a cancelled reservation can't be modified", async () => {
      await assert.rejects(modify({ reservationCode: "RSV-CAN1" }), failsWith("RESERVATION_NOT_MODIFIABLE"));
    });
  });

  describe("modification cutoff", () => {
    test("allows a request exactly 3 hours before the start", async () => {
      const result = await modify({ now: new Date("2026-11-17T11:00:00Z") });
      assert.equal(result.valid, true);
    });

    test("refuses a request inside the 3 hours", async () => {
      for (const now of [
        new Date("2026-11-17T11:00:00.001Z"),
        new Date("2026-11-17T11:01:00Z"),
        DINNER_START,
        new Date("2026-11-18T00:00:00Z"),
      ]) {
        const conversation = await newConversation();
        const result = await modify({ conversationId: conversation.id, now });
        assert.deepEqual(result, {
          valid: false,
          kind: "validation",
          code: "MODIFICATION_CUTOFF_PASSED",
          message: "Reservations can only be changed up to 3 hours before they start.",
        });
        assert.equal(await prisma.proposal.count({ where: { conversationId: conversation.id } }), 0);
      }
    });
  });

  describe("invalid new details", () => {
    test("rejects invalid dates, times, meal types and party sizes", async () => {
      const cases = [
        [{ date: "2026-02-30" }, "INVALID_DATE"],
        [{ date: "19-11-2026" }, "INVALID_DATE"],
        [{ date: "2026-11-16" }, "RESTAURANT_CLOSED"],
        [{ date: "2026-11-08" }, "DATE_IN_PAST"],
        [{ date: "2026-12-15" }, "TOO_FAR_AHEAD"],
        [{ mealType: "a_la_carte", time: "19:15" }, "INVALID_SLOT"],
        [{ mealType: "a_la_carte", time: "7pm" }, "INVALID_TIME"],
        [{ mealType: "a_la_carte", time: "21:30" }, "OUTSIDE_OPENING_HOURS"],
        [{ mealType: "brunch" }, "INVALID_MEAL_TYPE"],
        [{ mealType: undefined }, "INVALID_MEAL_TYPE"],
        [{ adults: 16 }, "PARTY_TOO_LARGE"],
        [{ adults: 0, children: 0 }, "PARTY_EMPTY"],
        [{ adults: "2" }, "INVALID_ADULTS"],
        [{ children: -1 }, "INVALID_CHILDREN"],
        [{ children: 1, childrenUnder3: 2 }, "INVALID_CHILDREN_UNDER_3"],
      ];
      for (const [overrides, code] of cases) {
        const conversation = await newConversation();
        const result = await modify({ conversationId: conversation.id, ...overrides });
        assert.equal(result.valid, false, code);
        assert.equal(result.code, code);
        assert.equal(result.kind, "validation");
        assert.ok(result.message.length > 0);
        assert.equal(await prisma.proposal.count({ where: { conversationId: conversation.id } }), 0, code);
      }
    });
  });

  describe("availability", () => {
    test("the reservation's own tables count as free", async () => {
      // The same dinner with one more child: T8, T9 and T10 are taken, but T7 is its own
      const result = await modify({ date: "2026-11-17", mealType: "buffet_dinner", adults: 2, children: 2 });
      assert.equal(result.valid, true);
      assert.deepEqual(tableNumbers(result.proposal.payload.target.tables), ["T7"]);

      // Without excluding it, T7 would look taken and nothing would fit
      const withoutExclusion = await findTablesForParty({ startTime: DINNER_START, endTime: DINNER_END, adults: 2, children: 2 });
      assert.equal(withoutExclusion, null);
    });

    test("other reservations' tables still count as taken", async () => {
      // 10 children need more FAMILY seats than T7 alone has
      const conversation = await newConversation();
      const result = await modify({
        conversationId: conversation.id,
        date: "2026-11-17",
        mealType: "buffet_dinner",
        adults: 0,
        children: 10,
      });
      assert.equal(result.valid, false);
      assert.equal(result.kind, "availability");
      assert.equal(result.code, "TABLES_UNAVAILABLE");
      assert.equal(await prisma.proposal.count({ where: { conversationId: conversation.id } }), 0);
    });
  });

  describe("conversation", () => {
    test("a missing conversation is refused", async () => {
      await assert.rejects(modify({ conversationId: "missing" }), failsWith("CONVERSATION_NOT_FOUND"));
    });

    test("a blocked conversation is refused, before the reservation is looked up", async () => {
      const blocked = await newConversation({ status: "blocked", warningCount: 3 });
      await assert.rejects(modify({ conversationId: blocked.id }), failsWith("CONVERSATION_NOT_ACTIVE"));
      // The same error even with wrong reservation details
      await assert.rejects(
        modify({ conversationId: blocked.id, reservationCode: "RSV-NONE" }),
        failsWith("CONVERSATION_NOT_ACTIVE"),
      );
      assert.equal(await prisma.proposal.count({ where: { conversationId: blocked.id } }), 0);
    });

    test("rejects an invalid conversationId or now", async () => {
      for (const conversationId of [undefined, null, "", "  ", 1]) {
        await assert.rejects(modify({ conversationId }), TypeError);
      }
      for (const now of [null, "2026-11-10", NOW.getTime(), new Date("x")]) {
        await assert.rejects(modify({ now }), TypeError);
      }
      await assert.rejects(createModificationProposal(), TypeError);
    });
  });

  describe("pending proposals", () => {
    test("older pending proposals are expired or declined", async () => {
      const conversation = await newConversation();
      const addPending = (expiresAt) =>
        prisma.proposal.create({
          data: { conversationId: conversation.id, actionType: "create", payload: "{}", status: "pending", expiresAt },
        });
      const unexpired = await addPending(new Date(NOW.getTime() + 60 * 1000));
      const expired = await addPending(NOW);

      const { proposal } = await modify({ conversationId: conversation.id });
      const statusOf = async (id) => (await prisma.proposal.findUnique({ where: { id } })).status;
      assert.equal(await statusOf(unexpired.id), "declined");
      assert.equal(await statusOf(expired.id), "expired");
      assert.equal(await statusOf(proposal.id), "pending");
      assert.equal(await prisma.proposal.count({ where: { conversationId: conversation.id, status: "pending" } }), 1);
    });

    test("a refused modification leaves the older pending proposal alone", async () => {
      const conversation = await newConversation();
      const old = await prisma.proposal.create({
        data: {
          conversationId: conversation.id,
          actionType: "create",
          payload: "{}",
          status: "pending",
          expiresAt: new Date(NOW.getTime() + 60 * 1000),
        },
      });
      const result = await modify({ conversationId: conversation.id, adults: 16 });
      assert.equal(result.valid, false);
      assert.equal((await prisma.proposal.findUnique({ where: { id: old.id } })).status, "pending");
    });

    test("a second modification in the same conversation replaces the first", async () => {
      const conversation = await newConversation();
      const first = await modify({ conversationId: conversation.id });
      const second = await modify({ conversationId: conversation.id, adults: 2 });
      assert.equal((await prisma.proposal.findUnique({ where: { id: first.proposal.id } })).status, "declined");
      assert.equal(second.proposal.status, "pending");
    });
  });

  test("never changes reservations, their tables or extras, and creates no new reservation", async () => {
    assert.deepEqual(await snapshotAll(), fullSnapshot);
    const original = await prisma.reservation.findUnique({ where: { id: reservation.id }, include: { extras: true } });
    assert.equal(original.specialRequest, "Window seat");
    assert.equal(original.extras.length, 2);
  });
});
