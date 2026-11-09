// Run with: npm test
const { test, describe, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { useTestDatabase } = require("./support/test-database");

// Must run before the Prisma client is loaded
const removeTestDatabase = useTestDatabase();

const prisma = require("../src/lib/prisma");
const restaurantTables = require("../src/config/restaurant-tables");
const {
  createReservationProposal,
  createModificationProposal,
  acceptReservationProposal,
  ProposalServiceError,
} = require("../src/services/proposal.service");

// A fixed clock: Tuesday 10 November 2026, 12:00 in Karachi (07:00 UTC). Karachi is UTC+5.
const NOW = new Date("2026-11-10T07:00:00Z");
const ONE_MINUTE_LATER = new Date("2026-11-10T07:01:00Z");
const PHONE = "+923001234567";

// Buffet session times in UTC for a Karachi date
const lunchOn = (date) => [new Date(`${date}T07:00:00Z`), new Date(`${date}T10:30:00Z`)];
const dinnerOn = (date) => [new Date(`${date}T14:00:00Z`), new Date(`${date}T18:00:00Z`)];

let tableIds;
let codeCounter = 0;
// Fixture reservations sit on their own GENERAL table on a day no test moves to
const fixtureSlots = ["2026-12-08", "2026-12-09", "2026-12-10", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27"].flatMap((date) =>
  [lunchOn, dinnerOn].flatMap((session) => ["T1", "T2", "T3", "T4", "T5", "T6"].map((table) => [session(date), table])),
);

const newConversation = (data = {}) => prisma.conversation.create({ data });

// A confirmed reservation created directly, as acceptance of a create proposal would
async function book({ times, tables, mealType = "buffet_dinner", adults = 2, children = 0, extras = [], ...data } = {}) {
  let slotTimes = times;
  let slotTables = tables;
  if (!slotTimes) {
    const [nextTimes, nextTable] = fixtureSlots.shift();
    slotTimes = nextTimes;
    slotTables = slotTables ?? [nextTable];
  }
  const owner = await newConversation();
  return prisma.reservation.create({
    data: {
      conversationId: owner.id,
      reservationCode: `RSV-T${String(++codeCounter).padStart(3, "0")}`,
      guestName: "Hammad Amin",
      guestPhone: PHONE,
      startTime: slotTimes[0],
      endTime: slotTimes[1],
      mealType,
      adults,
      children,
      estimatedTotalPaisa: 123456,
      specialRequest: "Window seat",
      tables: { create: slotTables.map((number) => ({ tableId: tableIds[number] })) },
      extras: { create: extras },
      ...data,
    },
  });
}

const EXTRA_ROWS = {
  birthday_cake: { extraKey: "birthday_cake", name: "Birthday cake", unitPricePaisa: 300000, lineTotalPaisa: 300000 },
  candles: { extraKey: "candles", name: "Candles", quantity: 2, unitPricePaisa: 30000, lineTotalPaisa: 60000 },
  high_chair: { extraKey: "high_chair", name: "High chair", unitPricePaisa: 0, lineTotalPaisa: 0, approvalStatus: "pending" },
  balloons: { extraKey: "balloons", name: "Balloons", unitPricePaisa: 150000, lineTotalPaisa: 150000, approvalStatus: "pending" },
  birthday_decorations: {
    extraKey: "birthday_decorations",
    name: "Birthday decorations",
    unitPricePaisa: 400000,
    lineTotalPaisa: 400000,
    approvalStatus: "pending",
  },
  outside_cake: {
    extraKey: "outside_cake",
    name: "Outside cake service fee",
    unitPricePaisa: 50000,
    lineTotalPaisa: 50000,
    approvalStatus: "pending",
  },
};

// A modification proposal made the normal way, in a new conversation
async function proposeModification(reservation, details, now = NOW) {
  const conversation = await newConversation();
  const result = await createModificationProposal({
    conversationId: conversation.id,
    reservationCode: reservation.reservationCode,
    guestPhone: reservation.guestPhone,
    now,
    ...details,
  });
  assert.equal(result.valid, true, JSON.stringify(result));
  return { conversationId: conversation.id, proposalId: result.proposal.id };
}

const accept = ({ conversationId, proposalId }, now = ONE_MINUTE_LATER) =>
  acceptReservationProposal({ proposalId, conversationId, now });

// The reservation with its tables and extras, to check nothing changed
const snapshot = (id) =>
  prisma.reservation.findUnique({
    where: { id },
    include: { tables: { orderBy: { id: "asc" } }, extras: { orderBy: { id: "asc" } } },
  });
const tableNumbersOf = async (reservationId) =>
  (await prisma.reservationTable.findMany({ where: { reservationId }, include: { table: true } }))
    .map((t) => t.table.tableNumber)
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
const statusOf = async (id) => (await prisma.proposal.findUnique({ where: { id } })).status;
const failsWith = (code, proposalStatus) => (error) =>
  error instanceof ProposalServiceError &&
  error.code === code &&
  (proposalStatus === undefined || error.proposalStatus === proposalStatus);

// No table may be used by two confirmed reservations that overlap
async function assertNoDoubleBooking() {
  const links = await prisma.reservationTable.findMany({
    where: { reservation: { status: "confirmed" } },
    include: { reservation: true },
  });
  for (const a of links) {
    for (const b of links) {
      if (a.id >= b.id || a.tableId !== b.tableId) continue;
      const overlap = a.reservation.startTime < b.reservation.endTime && a.reservation.endTime > b.reservation.startTime;
      assert.ok(!overlap, `table ${a.tableId} is double-booked`);
    }
  }
}

// After a rejected modification, the reservation and its proposal
async function assertRejectedAndUnchanged(result, ids, reservation, before, code) {
  assert.equal(result.outcome, "rejected");
  assert.equal(result.code, code);
  assert.ok(result.message.length > 0);
  assert.equal(await statusOf(ids.proposalId), "rejected");
  assert.deepEqual(await snapshot(reservation.id), before);
}

describe("acceptReservationProposal for modify proposals", () => {
  before(async () => {
    await prisma.restaurantTable.createMany({ data: restaurantTables });
    tableIds = Object.fromEntries((await prisma.restaurantTable.findMany()).map((t) => [t.tableNumber, t.id]));
  });

  after(async () => {
    await prisma.$disconnect();
    removeTestDatabase();
  });

  describe("successful modification", () => {
    test("updates the times, meal, party, total and tables in place", async () => {
      const reservation = await book({
        times: dinnerOn("2026-12-01"),
        tables: ["T3"],
        extras: [EXTRA_ROWS.candles, { ...EXTRA_ROWS.balloons, approvalStatus: "approved" }],
      });
      const before = await snapshot(reservation.id);
      const reservationCount = await prisma.reservation.count();

      // Dinner for 2 -> lunch for 3 adults + 1 child the next day
      const ids = await proposeModification(reservation, {
        date: "2026-12-02",
        mealType: "buffet_lunch",
        adults: 3,
        children: 1,
      });
      const result = await accept(ids);

      assert.equal(result.outcome, "accepted");
      const updated = result.reservation;
      assert.equal(updated.id, reservation.id);
      assert.equal(updated.startTime.toISOString(), "2026-12-02T07:00:00.000Z");
      assert.equal(updated.endTime.toISOString(), "2026-12-02T10:30:00.000Z");
      assert.equal(updated.mealType, "buffet_lunch");
      assert.equal(updated.adults, 3);
      assert.equal(updated.children, 1);
      // 3 x 249900 + 124950 lunch, plus the unchanged extras (60000 + 150000)
      assert.equal(updated.estimatedTotalPaisa, 1084650);
      // With a child the party moves to FAMILY; the old GENERAL table is released
      assert.deepEqual(await tableNumbersOf(reservation.id), ["T7"]);
      assert.deepEqual(updated.tables.map((t) => t.table.tableNumber), ["T7"]);

      // No new reservation or code
      assert.equal(await prisma.reservation.count(), reservationCount);
      assert.equal(result.proposal.status, "accepted");
      assert.equal(result.proposal.reservationId, reservation.id);
      assert.equal(result.proposal.actionType, "modify");

      // Preserved fields
      for (const field of ["reservationCode", "conversationId", "guestName", "guestPhone", "specialRequest", "status", "cancelledAt"]) {
        assert.deepEqual(updated[field], before[field], field);
      }
      assert.equal(updated.createdAt.getTime(), before.createdAt.getTime());
      assert.ok(updated.updatedAt >= before.updatedAt);

      // Extras are the same rows, with the same prices and approval statuses
      const extrasNow = await prisma.reservationExtra.findMany({ where: { reservationId: reservation.id }, orderBy: { id: "asc" } });
      assert.deepEqual(extrasNow, before.extras);
      assert.equal(extrasNow.find((e) => e.extraKey === "balloons").approvalStatus, "approved");
    });

    test("prices à la carte as extras only, with a two-hour slot", async () => {
      const reservation = await book({ extras: [EXTRA_ROWS.birthday_cake] });
      const ids = await proposeModification(reservation, { date: "2026-12-03", mealType: "a_la_carte", time: "19:30", adults: 4, children: 0 });
      const { reservation: updated } = await accept(ids);

      assert.equal(updated.mealType, "a_la_carte");
      assert.equal(updated.startTime.toISOString(), "2026-12-03T14:30:00.000Z");
      assert.equal(updated.endTime.toISOString(), "2026-12-03T16:30:00.000Z");
      assert.equal(updated.estimatedTotalPaisa, 300000);
    });

    test("prices buffet dinner, half-rupee children and free under-3s", async () => {
      const reservation = await book({ mealType: "buffet_lunch" });
      // 2 adults + 2 children, 1 under 3: 2 x 349900 + 1 x 174950
      const ids = await proposeModification(reservation, {
        date: "2026-12-04",
        mealType: "buffet_dinner",
        adults: 2,
        children: 2,
        childrenUnder3: 1,
      });
      const { reservation: updated } = await accept(ids);
      assert.equal(updated.estimatedTotalPaisa, 874750);
      assert.equal(updated.children, 2);
    });

    test("can keep its own tables when the new time overlaps the old one", async () => {
      // Dinner on the 20th on T7, with every other FAMILY table booked for that dinner
      const reservation = await book({ times: dinnerOn("2026-11-20"), tables: ["T7"], adults: 2, children: 1 });
      for (const table of ["T8", "T9", "T10"]) await book({ times: dinnerOn("2026-11-20"), tables: [table] });

      const ids = await proposeModification(reservation, { date: "2026-11-20", mealType: "buffet_dinner", adults: 2, children: 2 });
      const result = await accept(ids);
      assert.equal(result.outcome, "accepted");
      assert.equal(result.reservation.children, 2);
      assert.deepEqual(await tableNumbersOf(reservation.id), ["T7"]);
      await assertNoDoubleBooking();
    });
  });

  describe("existing extras' notice is checked against the new start", () => {
    // [extra, a new time with too little notice, a new time with enough]
    const cases = [
      ["birthday_cake", { date: "2026-11-11", mealType: "buffet_lunch" }, { date: "2026-11-11", mealType: "buffet_dinner" }, "24 hours"],
      ["balloons", { date: "2026-11-11", mealType: "buffet_lunch" }, { date: "2026-11-11", mealType: "buffet_dinner" }, "24 hours"],
      ["outside_cake", { date: "2026-11-11", mealType: "buffet_lunch" }, { date: "2026-11-11", mealType: "buffet_dinner" }, "24 hours"],
      ["birthday_decorations", { date: "2026-11-11", mealType: "buffet_dinner" }, { date: "2026-11-12", mealType: "buffet_dinner" }, "48 hours"],
      ["candles", { date: "2026-11-10", mealType: "a_la_carte", time: "13:30" }, { date: "2026-11-10", mealType: "a_la_carte", time: "15:00" }, "2 hours"],
      ["high_chair", { date: "2026-11-10", mealType: "a_la_carte", time: "13:30" }, { date: "2026-11-10", mealType: "a_la_carte", time: "15:00" }, "2 hours"],
    ];

    for (const [extraKey, tooSoon, enough, notice] of cases) {
      test(`${extraKey}: too little notice rejects it and changes nothing`, async () => {
        const reservation = await book({ extras: [EXTRA_ROWS[extraKey]] });
        const before = await snapshot(reservation.id);
        const ids = await proposeModification(reservation, { ...tooSoon, adults: 2, children: 0 });

        const result = await accept(ids);
        await assertRejectedAndUnchanged(result, ids, reservation, before, "INSUFFICIENT_NOTICE");
        assert.equal(result.kind, "validation");
        assert.match(result.message, new RegExp(notice));
      });

      test(`${extraKey}: enough notice is accepted with the extra unchanged`, async () => {
        const reservation = await book({ extras: [EXTRA_ROWS[extraKey]] });
        const before = await snapshot(reservation.id);
        const ids = await proposeModification(reservation, { ...enough, adults: 2, children: 0 });

        const result = await accept(ids);
        assert.equal(result.outcome, "accepted");
        assert.deepEqual(result.reservation.extras, before.extras);
      });
    }

    test("one extra without enough notice rejects the change even if the others are fine", async () => {
      const reservation = await book({ extras: [EXTRA_ROWS.candles, EXTRA_ROWS.high_chair, EXTRA_ROWS.birthday_decorations] });
      const before = await snapshot(reservation.id);
      // 31 hours away: fine for candles and the high chair, not for decorations
      const ids = await proposeModification(reservation, { date: "2026-11-11", mealType: "buffet_dinner", adults: 2, children: 0 });
      const result = await accept(ids);
      await assertRejectedAndUnchanged(result, ids, reservation, before, "INSUFFICIENT_NOTICE");
      assert.match(result.message, /Birthday decorations/);
    });
  });

  describe("modification cutoff at acceptance", () => {
    test("exactly 3 hours before the current start is allowed", async () => {
      const reservation = await book({ times: dinnerOn("2026-11-13"), tables: ["T5"] });
      const ids = await proposeModification(
        reservation,
        { date: "2026-11-14", mealType: "buffet_lunch", adults: 2, children: 0 },
        new Date("2026-11-13T10:58:00Z"),
      );
      const result = await accept(ids, new Date("2026-11-13T11:00:00Z"));
      assert.equal(result.outcome, "accepted");
    });

    test("inside the 3 hours it is rejected and nothing changes", async () => {
      const reservation = await book({ times: dinnerOn("2026-11-13"), tables: ["T6"] });
      const before = await snapshot(reservation.id);
      const ids = await proposeModification(
        reservation,
        { date: "2026-11-14", mealType: "buffet_lunch", adults: 2, children: 0 },
        new Date("2026-11-13T10:58:00Z"),
      );
      const result = await accept(ids, new Date("2026-11-13T11:00:00.001Z"));
      await assertRejectedAndUnchanged(result, ids, reservation, before, "MODIFICATION_CUTOFF_PASSED");
      assert.equal(result.message, "Reservations can only be changed up to 3 hours before they start.");
    });
  });

  describe("modifications that can't be accepted", () => {
    test("new details that are no longer valid reject it", async () => {
      // Proposed at 12:28 for 12:30 today; by 12:31 it's in the past
      const reservation = await book();
      const before = await snapshot(reservation.id);
      const ids = await proposeModification(
        reservation,
        { date: "2026-11-10", mealType: "a_la_carte", time: "12:30", adults: 2, children: 0 },
        new Date("2026-11-10T07:28:00Z"),
      );
      const result = await accept(ids, new Date("2026-11-10T07:31:00Z"));
      await assertRejectedAndUnchanged(result, ids, reservation, before, "DATE_IN_PAST");
    });

    test("invalid stored details reject it", async () => {
      const cases = [
        [{ date: "2026-12-02", mealType: "brunch", adults: 2, children: 0 }, "INVALID_MEAL_TYPE"],
        [{ date: "2026-11-16", mealType: "buffet_lunch", adults: 2, children: 0 }, "RESTAURANT_CLOSED"],
        [{ date: "2026-12-02", mealType: "buffet_lunch", adults: 16, children: 0 }, "PARTY_TOO_LARGE"],
        [{ date: "2026-12-02", mealType: "buffet_lunch", adults: 1, children: 1, childrenUnder3: 2 }, "INVALID_CHILDREN_UNDER_3"],
      ];
      for (const [request, code] of cases) {
        const reservation = await book();
        const before = await snapshot(reservation.id);
        const ids = await modifyProposalRow(reservation, JSON.stringify({ request, current: await currentOf(reservation.id) }));
        const result = await accept(ids);
        await assertRejectedAndUnchanged(result, ids, reservation, before, code);
      }
    });

    test("an unreadable payload rejects it", async () => {
      for (const payload of ["not json", "[]", "{}", '{"request":null}', '{"request":"x"}']) {
        const reservation = await book();
        const before = await snapshot(reservation.id);
        const ids = await modifyProposalRow(reservation, payload);
        const result = await accept(ids);
        await assertRejectedAndUnchanged(result, ids, reservation, before, "INVALID_PROPOSAL_PAYLOAD");
      }
    });

    test("a missing reservation rejects it", async () => {
      const conversation = await newConversation();
      const proposal = await prisma.proposal.create({
        data: {
          conversationId: conversation.id,
          actionType: "modify",
          reservationId: null,
          payload: JSON.stringify({ request: { date: "2026-12-02", mealType: "buffet_lunch", adults: 2, children: 0 } }),
          expiresAt: new Date(NOW.getTime() + 5 * 60 * 1000),
        },
      });
      const result = await accept({ conversationId: conversation.id, proposalId: proposal.id });
      assert.equal(result.code, "RESERVATION_NOT_MODIFIABLE");
      assert.equal(await statusOf(proposal.id), "rejected");
    });

    test("a reservation cancelled after the proposal rejects it, leaving the reservation alone", async () => {
      const reservation = await book();
      const ids = await proposeModification(reservation, { date: "2026-12-02", mealType: "buffet_lunch", adults: 2, children: 0 });
      await prisma.reservation.update({ where: { id: reservation.id }, data: { status: "cancelled", cancelledAt: NOW } });
      const before = await snapshot(reservation.id);

      const result = await accept(ids);
      await assertRejectedAndUnchanged(result, ids, reservation, before, "RESERVATION_NOT_MODIFIABLE");
    });

    test("tables taken after the proposal reject it as unavailable", async () => {
      const reservation = await book({ times: lunchOn("2026-12-09"), tables: ["T8"], adults: 2, children: 1 });
      const before = await snapshot(reservation.id);
      // 10 children need T7 + T9 or bigger
      const ids = await proposeModification(reservation, { date: "2026-11-21", mealType: "buffet_dinner", adults: 0, children: 10 });
      for (const table of ["T7", "T9", "T10"]) await book({ times: dinnerOn("2026-11-21"), tables: [table] });

      const result = await accept(ids);
      await assertRejectedAndUnchanged(result, ids, reservation, before, "TABLES_UNAVAILABLE");
      assert.equal(result.kind, "availability");
      assert.deepEqual(await tableNumbersOf(reservation.id), ["T8"]);
    });

    test("expired, declined, rejected and accepted proposals are handled as before", async () => {
      const reservation = await book();
      const before = await snapshot(reservation.id);
      const ids = await proposeModification(reservation, { date: "2026-12-02", mealType: "buffet_lunch", adults: 2, children: 0 });

      const expired = await accept(ids, new Date(NOW.getTime() + 5 * 60 * 1000));
      assert.equal(expired.outcome, "expired");
      assert.equal(await statusOf(ids.proposalId), "expired");
      assert.deepEqual(await snapshot(reservation.id), before);

      for (const status of ["declined", "rejected", "accepted"]) {
        const row = await modifyProposalRow(reservation, JSON.stringify({ request: {} }), status);
        await assert.rejects(accept(row), failsWith("PROPOSAL_NOT_PENDING", status));
        assert.equal(await statusOf(row.proposalId), status);
      }
      assert.deepEqual(await snapshot(reservation.id), before);
    });

    test("another conversation, a blocked conversation and a missing proposal change nothing", async () => {
      const reservation = await book();
      const before = await snapshot(reservation.id);
      const ids = await proposeModification(reservation, { date: "2026-12-02", mealType: "buffet_lunch", adults: 2, children: 0 });

      const other = await newConversation();
      await assert.rejects(accept({ ...ids, conversationId: other.id }), failsWith("PROPOSAL_NOT_FOUND"));
      await assert.rejects(accept({ ...ids, proposalId: "missing" }), failsWith("PROPOSAL_NOT_FOUND"));

      await prisma.conversation.update({ where: { id: ids.conversationId }, data: { status: "blocked" } });
      await assert.rejects(accept(ids), failsWith("CONVERSATION_NOT_ACTIVE"));

      assert.equal(await statusOf(ids.proposalId), "pending");
      assert.deepEqual(await snapshot(reservation.id), before);
    });

    test("unknown proposal types are not supported", async () => {
      const reservation = await book();
      const ids = await modifyProposalRow(reservation, "{}", "pending", "transfer");
      const result = await accept(ids);
      assert.equal(result.code, "UNSUPPORTED_PROPOSAL");
    });
  });

  describe("concurrency", () => {
    test("accepting the same modification at once applies it once", async () => {
      const reservation = await book();
      const ids = await proposeModification(reservation, { date: "2026-12-05", mealType: "buffet_dinner", adults: 4, children: 0 });
      const results = await Promise.allSettled([1, 2, 3, 4].map(() => accept(ids)));

      assert.equal(results.filter((r) => r.status === "fulfilled" && r.value.outcome === "accepted").length, 1);
      for (const r of results.filter((r) => r.status === "rejected")) {
        assert.ok(failsWith("PROPOSAL_NOT_PENDING", "accepted")(r.reason));
      }
      // One set of new tables, not one per attempt
      assert.deepEqual(await tableNumbersOf(reservation.id), ["T3"]);
    });

    test("a modification and a new reservation competing for the same tables can't double-book", async () => {
      // 15 children need T7 + T8 + T10, the only FAMILY combination big enough
      const reservation = await book({ times: dinnerOn("2026-12-10"), tables: ["T9"], adults: 2, children: 1 });
      const before = await snapshot(reservation.id);
      const modifyIds = await proposeModification(reservation, { date: "2026-11-22", mealType: "buffet_dinner", adults: 0, children: 15 });

      const createConversation = await newConversation();
      const createProposal = await createReservationProposal({
        conversationId: createConversation.id,
        payload: {
          date: "2026-11-22",
          mealType: "buffet_dinner",
          adults: 0,
          children: 15,
          guestName: "Another Guest",
          guestPhone: "03110000000",
          extras: [],
        },
        now: NOW,
      });

      const [modified, created] = await Promise.all([
        accept(modifyIds),
        accept({ conversationId: createConversation.id, proposalId: createProposal.id }),
      ]);
      const outcomes = [modified, created].map((r) => r.outcome).sort();
      assert.deepEqual(outcomes, ["accepted", "rejected"]);
      assert.equal([modified, created].find((r) => r.outcome === "rejected").code, "TABLES_UNAVAILABLE");
      if (modified.outcome === "rejected") assert.deepEqual(await snapshot(reservation.id), before);
      await assertNoDoubleBooking();
    });
  });

  describe("rollback", () => {
    const originalTransaction = prisma.$transaction;

    afterEach(() => {
      prisma.$transaction = originalTransaction;
    });

    // Make one write inside the transaction fail, after the earlier writes have run
    function failInsideTransaction(model, method, shouldFail = () => true) {
      prisma.$transaction = (callback, options) =>
        originalTransaction.call(
          prisma,
          (tx) =>
            callback(
              new Proxy(tx, {
                get(target, property) {
                  if (property !== model) return target[property];
                  return new Proxy(target[model], {
                    get(delegate, name) {
                      return async (...args) => {
                        if (name === method && shouldFail(...args)) throw new Error(`simulated ${model}.${method} failure`);
                        return delegate[name](...args);
                      };
                    },
                  });
                },
              }),
            ),
          options,
        );
    }

    const failurePoints = [
      ["reservation", "updateMany"],
      ["reservationTable", "deleteMany"],
      ["reservationTable", "createMany"],
      ["proposal", "updateMany", (args) => args.data.status === "accepted"],
    ];

    for (const [model, method, shouldFail] of failurePoints) {
      test(`a failing ${model}.${method} leaves the reservation and proposal as they were`, async () => {
        const reservation = await book({ extras: [EXTRA_ROWS.candles] });
        const before = await snapshot(reservation.id);
        const ids = await proposeModification(reservation, { date: "2026-12-06", mealType: "buffet_lunch", adults: 2, children: 1 });

        failInsideTransaction(model, method, shouldFail);
        await assert.rejects(accept(ids), new RegExp(`simulated ${model}.${method} failure`));
        prisma.$transaction = originalTransaction;

        assert.deepEqual(await snapshot(reservation.id), before);
        assert.equal(await statusOf(ids.proposalId), "pending");

        // Nothing was left half-done: it can still be accepted normally
        const retry = await accept(ids);
        assert.equal(retry.outcome, "accepted");
        assert.equal(retry.reservation.children, 1);
        // Put it back on its own day so later tests have the same tables free
        await prisma.reservation.update({ where: { id: reservation.id }, data: { status: "cancelled" } });
      });
    }
  });

  describe("stale proposals", () => {
    const NEW_DETAILS = { date: "2026-12-03", mealType: "buffet_lunch", adults: 2, children: 0 };

    // A reservation with extras and a modification proposal made against it
    async function proposedReservation(bookOptions = {}) {
      const reservation = await book({ extras: [EXTRA_ROWS.candles, EXTRA_ROWS.outside_cake], ...bookOptions });
      const ids = await proposeModification(reservation, NEW_DETAILS);
      return { reservation, ids };
    }

    // Change the reservation after the proposal, then check acceptance refuses it
    async function assertStaleAfter(change, bookOptions) {
      const { reservation, ids } = await proposedReservation(bookOptions);
      await change(reservation);
      const before = await snapshot(reservation.id);

      const result = await accept(ids);
      await assertRejectedAndUnchanged(result, ids, reservation, before, "STALE_MODIFICATION_PROPOSAL");
      assert.equal(result.kind, "validation");
      assert.equal(result.message, "This reservation has changed since the proposal was made. Please ask for a new change.");
    }
    const update = (data) => (reservation) => prisma.reservation.update({ where: { id: reservation.id }, data });

    test("is accepted while the reservation still matches its snapshot", async () => {
      const { ids } = await proposedReservation();
      assert.equal((await accept(ids)).outcome, "accepted");
    });

    test("accepts a snapshot whose tables or times are written differently but mean the same", async () => {
      const reservation = await book({ times: dinnerOn("2026-11-24"), tables: ["T4", "T5"] });
      const current = await currentOf(reservation.id);
      const sameButReordered = {
        ...current,
        tableIds: [...current.tableIds].reverse(),
        // 19:00 Karachi, written with its offset instead of in UTC
        startTime: "2026-11-24T19:00:00+05:00",
        endTime: new Date(current.endTime).toISOString(),
      };
      const ids = await modifyProposalRow(reservation, JSON.stringify({ request: NEW_DETAILS, current: sameButReordered }));
      assert.equal((await accept(ids)).outcome, "accepted");
    });

    test("is rejected when the start or end time changed", async () => {
      const HALF_HOUR = 30 * 60 * 1000;
      await assertStaleAfter((r) => update({ startTime: new Date(r.startTime.getTime() - HALF_HOUR) })(r));
      await assertStaleAfter((r) => update({ endTime: new Date(r.endTime.getTime() + HALF_HOUR) })(r));
    });

    test("is rejected when the meal type, adults or children changed", async () => {
      await assertStaleAfter(update({ mealType: "a_la_carte" }));
      await assertStaleAfter(update({ adults: 3 }));
      await assertStaleAfter(update({ children: 1 }));
    });

    test("is rejected when the table assignments changed", async () => {
      // On 7 December, which no other test uses, so the changed tables don't clash
      // Moved to a different table
      await assertStaleAfter(
        async (reservation) => {
          await prisma.reservationTable.deleteMany({ where: { reservationId: reservation.id } });
          await prisma.reservationTable.create({ data: { reservationId: reservation.id, tableId: tableIds.T10 } });
        },
        { times: dinnerOn("2026-12-07"), tables: ["T1"] },
      );
      // An extra table added
      await assertStaleAfter(
        (reservation) => prisma.reservationTable.create({ data: { reservationId: reservation.id, tableId: tableIds.T9 } }),
        { times: lunchOn("2026-12-07"), tables: ["T2"] },
      );
    });

    test("is rejected when the estimated total changed", async () => {
      await assertStaleAfter(update({ estimatedTotalPaisa: 999 }));
    });

    test("is rejected when another modification was accepted first", async () => {
      const { reservation, ids: first } = await proposedReservation();
      const second = await proposeModification(reservation, { ...NEW_DETAILS, adults: 3 });
      assert.equal((await accept(second)).outcome, "accepted");
      const before = await snapshot(reservation.id);

      const result = await accept(first);
      await assertRejectedAndUnchanged(result, first, reservation, before, "STALE_MODIFICATION_PROPOSAL");
      assert.equal((await prisma.reservation.findUnique({ where: { id: reservation.id } })).adults, 3);
    });

    test("a missing or malformed snapshot is rejected and changes nothing", async () => {
      const reservation = await book({ extras: [EXTRA_ROWS.candles] });
      const good = await currentOf(reservation.id);
      const snapshots = [
        undefined,
        null,
        "current",
        [],
        { ...good, startTime: "not a date" },
        { ...good, endTime: 1767000000000 },
        { ...good, mealType: undefined },
        { ...good, adults: "2" },
        { ...good, children: null },
        { ...good, estimatedTotalPaisa: 1.5 },
        { ...good, tableIds: undefined },
        { ...good, tableIds: "T1" },
        { ...good, tableIds: [1] },
      ];
      for (const current of snapshots) {
        const before = await snapshot(reservation.id);
        const ids = await modifyProposalRow(reservation, JSON.stringify({ request: NEW_DETAILS, current }));
        const result = await accept(ids);
        await assertRejectedAndUnchanged(result, ids, reservation, before, "INVALID_PROPOSAL_PAYLOAD");
      }
    });
  });

  test("no table is double-booked after all of the above", async () => {
    await assertNoDoubleBooking();
  });
});

// The payload.current snapshot of a reservation as it is in the database now
async function currentOf(reservationId) {
  const reservation = await prisma.reservation.findUnique({ where: { id: reservationId }, include: { tables: true } });
  return {
    mealType: reservation.mealType,
    startTime: reservation.startTime.toISOString(),
    endTime: reservation.endTime.toISOString(),
    adults: reservation.adults,
    children: reservation.children,
    estimatedTotalPaisa: reservation.estimatedTotalPaisa,
    tableIds: reservation.tables.map((t) => t.tableId).sort(),
  };
}

// A modify proposal row with any payload or status, created directly
async function modifyProposalRow(reservation, payload, status = "pending", actionType = "modify") {
  const conversation = await newConversation();
  const proposal = await prisma.proposal.create({
    data: {
      conversationId: conversation.id,
      actionType,
      reservationId: reservation.id,
      payload,
      status,
      expiresAt: new Date(NOW.getTime() + 5 * 60 * 1000),
    },
  });
  return { conversationId: conversation.id, proposalId: proposal.id };
}
