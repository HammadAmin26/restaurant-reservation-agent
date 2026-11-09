// Run with: npm test
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { useTestDatabase } = require("./support/test-database");

// Must run before the Prisma client is loaded
const removeTestDatabase = useTestDatabase();

const prisma = require("../src/lib/prisma");
const restaurantTables = require("../src/config/restaurant-tables");
const {
  createCancellationProposal,
  createModificationProposal,
  ProposalServiceError,
} = require("../src/services/proposal.service");

// A fixed clock: Tuesday 10 November 2026, 12:00 in Karachi (07:00 UTC). Karachi is UTC+5.
const NOW = new Date("2026-11-10T07:00:00Z");
const FIVE_MINUTES = 5 * 60 * 1000;

// The reservation to cancel: buffet dinner on Tuesday 17 November, 19:00-23:00 Karachi
const DINNER_START = new Date("2026-11-17T14:00:00Z");
const DINNER_END = new Date("2026-11-17T18:00:00Z");
const CODE = "RSV-CXL1";
const PHONE = "+923001234567";

const newConversation = (data = {}) => prisma.conversation.create({ data });

async function cancel(overrides = {}) {
  const conversationId = overrides.conversationId ?? (await newConversation()).id;
  return createCancellationProposal({
    conversationId,
    reservationCode: CODE,
    guestPhone: "03001234567",
    now: NOW,
    ...overrides,
  });
}

const failsWith = (code) => (error) => error instanceof ProposalServiceError && error.code === code;
const proposalCount = (conversationId) => prisma.proposal.count({ where: { conversationId } });
const statusOf = async (id) => (await prisma.proposal.findUnique({ where: { id } })).status;

describe("createCancellationProposal", () => {
  let reservation;
  let tableIds;
  let fullSnapshot;

  // Every reservation, table assignment and extra, to compare at the end
  const snapshotAll = async () => ({
    reservations: await prisma.reservation.findMany({ orderBy: { reservationCode: "asc" } }),
    tables: await prisma.reservationTable.findMany({ orderBy: { id: "asc" } }),
    extras: await prisma.reservationExtra.findMany({ orderBy: { id: "asc" } }),
  });

  before(async () => {
    await prisma.restaurantTable.createMany({ data: restaurantTables });
    tableIds = Object.fromEntries((await prisma.restaurantTable.findMany()).map((t) => [t.tableNumber, t.id]));
    const owner = await newConversation();

    const book = (reservationCode, tables, data = {}) =>
      prisma.reservation.create({
        data: {
          conversationId: owner.id,
          reservationCode,
          guestName: "Hammad Amin",
          guestPhone: PHONE,
          startTime: DINNER_START,
          endTime: DINNER_END,
          mealType: "buffet_dinner",
          adults: 2,
          tables: { create: tables.map((table) => ({ tableId: tableIds[table] })) },
          ...data,
        },
      });

    // 6 adults + 2 children at dinner on T8 + T7, with a birthday cake and an outside cake fee
    reservation = await book(CODE, ["T8", "T7"], {
      adults: 6,
      children: 2,
      estimatedTotalPaisa: 2799300,
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

    // Reservations with the same phone that aren't confirmed
    await book("RSV-CXL2", ["T1"], { status: "cancelled", cancelledAt: NOW });
    await book("RSV-CXL3", ["T2"], { status: "completed" });
    // Someone else's reservation
    await book("RSV-OTHR", ["T3"], { guestPhone: "+923110000000" });

    fullSnapshot = await snapshotAll();
  });

  after(async () => {
    await prisma.$disconnect();
    removeTestDatabase();
  });

  describe("successful proposals", () => {
    test("creates a pending cancel proposal with a snapshot of the reservation", async () => {
      const conversation = await newConversation();
      const result = await cancel({ conversationId: conversation.id });

      assert.equal(result.valid, true);
      const { proposal } = result;
      assert.equal(proposal.actionType, "cancel");
      assert.equal(proposal.reservationId, reservation.id);
      assert.equal(proposal.status, "pending");
      // The reservation was booked in another conversation; the proposal is in this one
      assert.equal(proposal.conversationId, conversation.id);

      assert.deepEqual(proposal.payload, {
        reservationCode: CODE,
        current: {
          mealType: "buffet_dinner",
          startTime: "2026-11-17T14:00:00.000Z",
          endTime: "2026-11-17T18:00:00.000Z",
          adults: 6,
          children: 2,
          estimatedTotalPaisa: 2799300,
          // Sorted, whatever order the tables were assigned in
          tableIds: [tableIds.T7, tableIds.T8].sort(),
        },
      });

      const stored = await prisma.proposal.findUnique({ where: { id: proposal.id } });
      assert.equal(typeof stored.payload, "string");
      assert.deepEqual(JSON.parse(stored.payload), proposal.payload);
    });

    test("expires exactly five minutes after now", async () => {
      const { proposal } = await cancel();
      assert.equal(proposal.expiresAt.getTime() - NOW.getTime(), FIVE_MINUTES);
      assert.equal(proposal.expiresAt.toISOString(), "2026-11-10T07:05:00.000Z");
    });

    test("accepts the phone in either format and the code in any case", async () => {
      for (const [reservationCode, guestPhone] of [
        [CODE, PHONE],
        ["rsv-cxl1", "03001234567"],
        ["  RSV-CXL1 ", "  +923001234567 "],
      ]) {
        const result = await cancel({ reservationCode, guestPhone });
        assert.equal(result.valid, true, `${reservationCode} / ${guestPhone}`);
        assert.equal(result.proposal.reservationId, reservation.id);
      }
    });
  });

  describe("ownership", () => {
    test("a wrong code, wrong phone, invalid phone or missing reservation give the same error", async () => {
      const messages = new Set();
      for (const [reservationCode, guestPhone] of [
        ["RSV-NONE", "03001234567"], // no such reservation
        [CODE, "03009999999"], // wrong phone
        ["RSV-NONE", "03009999999"], // both wrong
        ["RSV-OTHR", "03001234567"], // someone else's reservation
        [CODE, "0300-1234567"], // invalid phone
        [CODE, "+447911123456"],
        [CODE, undefined],
        ["", "03001234567"],
        [null, "03001234567"],
        [42, "03001234567"],
      ]) {
        const conversation = await newConversation();
        await assert.rejects(cancel({ conversationId: conversation.id, reservationCode, guestPhone }), (error) => {
          assert.ok(failsWith("RESERVATION_NOT_FOUND")(error), `${reservationCode} / ${guestPhone}`);
          messages.add(error.message);
          return true;
        });
        assert.equal(await proposalCount(conversation.id), 0);
      }
      assert.deepEqual([...messages], ["We couldn't find a reservation with that reservation code and phone number."]);
    });

    test("only confirmed reservations can be cancelled", async () => {
      for (const reservationCode of ["RSV-CXL2", "RSV-CXL3"]) {
        const conversation = await newConversation();
        await assert.rejects(
          cancel({ conversationId: conversation.id, reservationCode }),
          (error) => failsWith("RESERVATION_NOT_CANCELLABLE")(error) && error.message.includes("isn't confirmed"),
        );
        assert.equal(await proposalCount(conversation.id), 0);
      }
    });
  });

  describe("cancellation cutoff", () => {
    test("allows a request exactly 3 hours before the start", async () => {
      const result = await cancel({ now: new Date("2026-11-17T11:00:00Z") });
      assert.equal(result.valid, true);
      assert.equal(result.proposal.expiresAt.toISOString(), "2026-11-17T11:05:00.000Z");
    });

    test("refuses a request inside the 3 hours", async () => {
      for (const now of [
        new Date("2026-11-17T11:00:00.001Z"),
        new Date("2026-11-17T13:59:00Z"),
        DINNER_START,
        new Date("2026-11-18T00:00:00Z"),
      ]) {
        const conversation = await newConversation();
        const result = await cancel({ conversationId: conversation.id, now });
        assert.deepEqual(result, {
          valid: false,
          kind: "validation",
          code: "CANCELLATION_CUTOFF_PASSED",
          message: "Reservations can only be cancelled up to 3 hours before they start.",
        });
        assert.equal(await proposalCount(conversation.id), 0);
      }
    });
  });

  describe("conversation", () => {
    test("a missing conversation is refused", async () => {
      await assert.rejects(cancel({ conversationId: "missing" }), failsWith("CONVERSATION_NOT_FOUND"));
    });

    test("a blocked conversation is refused before the reservation is looked up", async () => {
      const blocked = await newConversation({ status: "blocked", warningCount: 3 });
      await assert.rejects(cancel({ conversationId: blocked.id }), failsWith("CONVERSATION_NOT_ACTIVE"));
      // Wrong details give the same error, so a blocked conversation can't probe codes
      await assert.rejects(cancel({ conversationId: blocked.id, reservationCode: "RSV-NONE" }), failsWith("CONVERSATION_NOT_ACTIVE"));
      assert.equal(await proposalCount(blocked.id), 0);
    });

    test("rejects an invalid conversationId or now", async () => {
      for (const conversationId of [undefined, null, "", "  ", 1, {}]) {
        await assert.rejects(cancel({ conversationId }), TypeError);
      }
      for (const now of [null, "2026-11-10", NOW.getTime(), new Date("x")]) {
        await assert.rejects(cancel({ now }), TypeError);
      }
      await assert.rejects(createCancellationProposal(), TypeError);
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

      const { proposal } = await cancel({ conversationId: conversation.id });
      assert.equal(await statusOf(unexpired.id), "declined");
      assert.equal(await statusOf(expired.id), "expired");
      assert.equal(await statusOf(proposal.id), "pending");
      assert.equal(await prisma.proposal.count({ where: { conversationId: conversation.id, status: "pending" } }), 1);
    });

    test("replaces a pending modification of the same reservation", async () => {
      const conversation = await newConversation();
      const modification = await createModificationProposal({
        conversationId: conversation.id,
        reservationCode: CODE,
        guestPhone: PHONE,
        date: "2026-11-19",
        mealType: "buffet_lunch",
        adults: 2,
        children: 0,
        now: NOW,
      });
      assert.equal(modification.valid, true);

      const { proposal } = await cancel({ conversationId: conversation.id });
      assert.equal(await statusOf(modification.proposal.id), "declined");
      assert.equal(proposal.actionType, "cancel");
    });

    test("a refused cancellation leaves the older pending proposal alone", async () => {
      const conversation = await newConversation();
      const old = await prisma.proposal.create({
        data: {
          conversationId: conversation.id,
          actionType: "create",
          payload: "{}",
          status: "pending",
          expiresAt: new Date("2026-11-17T12:00:00Z"),
        },
      });
      const result = await cancel({ conversationId: conversation.id, now: new Date("2026-11-17T12:00:00Z") });
      assert.equal(result.code, "CANCELLATION_CUTOFF_PASSED");
      assert.equal(await statusOf(old.id), "pending");
    });
  });

  test("never changes or deletes reservations, their tables, extras or special request", async () => {
    assert.deepEqual(await snapshotAll(), fullSnapshot);
    const original = await prisma.reservation.findUnique({ where: { id: reservation.id }, include: { extras: true, tables: true } });
    assert.equal(original.status, "confirmed");
    assert.equal(original.specialRequest, "Window seat");
    assert.equal(original.extras.length, 2);
    assert.equal(original.tables.length, 2);
  });
});
