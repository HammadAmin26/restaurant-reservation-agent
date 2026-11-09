// Run with: npm test
const { test, describe, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { useTestDatabase } = require("./support/test-database");

// Must run before the Prisma client is loaded
const removeTestDatabase = useTestDatabase();

const prisma = require("../src/lib/prisma");
const restaurantTables = require("../src/config/restaurant-tables");
const { findTablesForParty } = require("../src/services/table-allocation.service");
const {
  createCancellationProposal,
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
// Each fixture reservation gets its own GENERAL table and session, so none overlap
const fixtureSlots = ["2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04", "2026-12-05"].flatMap((date) =>
  [lunchOn, dinnerOn].flatMap((session) => ["T1", "T2", "T3", "T4", "T5", "T6"].map((table) => [session(date), table])),
);

const newConversation = (data = {}) => prisma.conversation.create({ data });

// A confirmed reservation with extras, created directly
async function book({ times, tables, extras, ...data } = {}) {
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
      reservationCode: `RSV-C${String(++codeCounter).padStart(3, "0")}`,
      guestName: "Hammad Amin",
      guestPhone: PHONE,
      startTime: slotTimes[0],
      endTime: slotTimes[1],
      mealType: "buffet_dinner",
      adults: 2,
      children: 1,
      estimatedTotalPaisa: 1224750,
      specialRequest: "Window seat",
      tables: { create: slotTables.map((number) => ({ tableId: tableIds[number] })) },
      extras: {
        create: extras ?? [
          { extraKey: "birthday_cake", name: "Birthday cake", unitPricePaisa: 300000, lineTotalPaisa: 300000 },
          { extraKey: "balloons", name: "Balloons", unitPricePaisa: 150000, lineTotalPaisa: 150000, approvalStatus: "approved" },
          {
            extraKey: "outside_cake",
            name: "Outside cake service fee",
            unitPricePaisa: 50000,
            lineTotalPaisa: 50000,
            approvalStatus: "pending",
          },
        ],
      },
      ...data,
    },
  });
}

// A cancellation proposal made the normal way, in a new conversation
async function proposeCancellation(reservation, now = NOW) {
  const conversation = await newConversation();
  const result = await createCancellationProposal({
    conversationId: conversation.id,
    reservationCode: reservation.reservationCode,
    guestPhone: reservation.guestPhone,
    now,
  });
  assert.equal(result.valid, true, JSON.stringify(result));
  return { conversationId: conversation.id, proposalId: result.proposal.id };
}

// A cancel proposal row with any payload or status, created directly
async function cancelProposalRow(reservation, payload, status = "pending") {
  const conversation = await newConversation();
  const proposal = await prisma.proposal.create({
    data: {
      conversationId: conversation.id,
      actionType: "cancel",
      reservationId: reservation ? reservation.id : null,
      payload,
      status,
      expiresAt: new Date(NOW.getTime() + 5 * 60 * 1000),
    },
  });
  return { conversationId: conversation.id, proposalId: proposal.id };
}

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

const accept = ({ conversationId, proposalId }, now = ONE_MINUTE_LATER) =>
  acceptReservationProposal({ proposalId, conversationId, now });

// The reservation with its tables and extras, to check what changed
const snapshot = (id) =>
  prisma.reservation.findUnique({
    where: { id },
    include: { tables: { orderBy: { id: "asc" } }, extras: { orderBy: { id: "asc" } } },
  });
const statusOf = async (id) => (await prisma.proposal.findUnique({ where: { id } })).status;
const failsWith = (code, proposalStatus) => (error) =>
  error instanceof ProposalServiceError &&
  error.code === code &&
  (proposalStatus === undefined || error.proposalStatus === proposalStatus);

async function assertRejectedAndUnchanged(result, ids, reservation, before, code) {
  assert.equal(result.outcome, "rejected");
  assert.equal(result.code, code);
  assert.ok(result.message.length > 0);
  assert.equal(await statusOf(ids.proposalId), "rejected");
  assert.deepEqual(await snapshot(reservation.id), before);
}

describe("acceptReservationProposal for cancel proposals", () => {
  before(async () => {
    await prisma.restaurantTable.createMany({ data: restaurantTables });
    tableIds = Object.fromEntries((await prisma.restaurantTable.findMany()).map((t) => [t.tableNumber, t.id]));
  });

  after(async () => {
    await prisma.$disconnect();
    removeTestDatabase();
  });

  describe("successful cancellation", () => {
    test("marks the reservation cancelled at now and keeps everything else", async () => {
      const reservation = await book({ times: dinnerOn("2026-11-17"), tables: ["T7", "T8"] });
      const before = await snapshot(reservation.id);
      const ids = await proposeCancellation(reservation);

      const result = await accept(ids);
      assert.equal(result.outcome, "accepted");

      const after = await snapshot(reservation.id);
      assert.equal(after.status, "cancelled");
      assert.equal(after.cancelledAt.toISOString(), ONE_MINUTE_LATER.toISOString());
      assert.equal(result.reservation.status, "cancelled");
      assert.equal(result.reservation.id, reservation.id);

      // Every other field is the same
      const { status: _s, cancelledAt: _c, updatedAt: _u, tables: tablesAfter, extras: extrasAfter, ...fieldsAfter } = after;
      const { status: _s2, cancelledAt: _c2, updatedAt: _u2, tables: tablesBefore, extras: extrasBefore, ...fieldsBefore } = before;
      assert.deepEqual(fieldsAfter, fieldsBefore);
      assert.equal(after.reservationCode, reservation.reservationCode);
      assert.equal(after.specialRequest, "Window seat");
      assert.equal(after.estimatedTotalPaisa, 1224750);

      // Tables stay attached and extras keep their rows and approval statuses
      assert.deepEqual(tablesAfter, tablesBefore);
      assert.equal(tablesAfter.length, 2);
      assert.deepEqual(extrasAfter, extrasBefore);
      assert.deepEqual(extrasAfter.map((e) => e.approvalStatus).sort(), ["approved", "not_required", "pending"]);

      // The proposal is accepted and linked
      assert.equal(result.proposal.status, "accepted");
      assert.equal(result.proposal.reservationId, reservation.id);
      assert.equal(await statusOf(ids.proposalId), "accepted");
    });

    test("frees the tables for new bookings", async () => {
      // A party of 15 children needs the FAMILY tables this reservation holds
      const times = dinnerOn("2026-11-18");
      const reservation = await book({ times, tables: ["T7", "T8", "T9", "T10"], adults: 0, children: 15 });
      const party = { startTime: times[0], endTime: times[1], adults: 0, children: 15 };
      assert.equal(await findTablesForParty(party), null);

      await accept(await proposeCancellation(reservation));

      const tables = await findTablesForParty(party);
      assert.deepEqual(tables.map((t) => t.tableNumber), ["T7", "T8", "T10"]);
      // The cancelled reservation keeps its own table assignments as history
      assert.equal(await prisma.reservationTable.count({ where: { reservationId: reservation.id } }), 4);
    });

    test("accepting again never cancels twice or changes cancelledAt", async () => {
      const reservation = await book();
      const ids = await proposeCancellation(reservation);
      await accept(ids);
      const afterFirst = await snapshot(reservation.id);

      await assert.rejects(accept(ids, new Date("2026-11-10T07:03:00Z")), failsWith("PROPOSAL_NOT_PENDING", "accepted"));
      assert.deepEqual(await snapshot(reservation.id), afterFirst);
    });
  });

  describe("proposals that can't be accepted", () => {
    test("an expired proposal is marked expired and the reservation stays confirmed", async () => {
      const reservation = await book();
      const before = await snapshot(reservation.id);
      const ids = await proposeCancellation(reservation);
      const result = await accept(ids, new Date(NOW.getTime() + 5 * 60 * 1000));
      assert.equal(result.outcome, "expired");
      assert.equal(await statusOf(ids.proposalId), "expired");
      assert.deepEqual(await snapshot(reservation.id), before);
    });

    test("declined, rejected, expired and accepted proposals are refused unchanged", async () => {
      const reservation = await book();
      const before = await snapshot(reservation.id);
      const payload = JSON.stringify({ current: await currentOf(reservation.id) });
      for (const status of ["declined", "rejected", "expired", "accepted"]) {
        const ids = await cancelProposalRow(reservation, payload, status);
        await assert.rejects(accept(ids), failsWith("PROPOSAL_NOT_PENDING", status), status);
        assert.equal(await statusOf(ids.proposalId), status);
      }
      assert.deepEqual(await snapshot(reservation.id), before);
    });

    test("a missing proposal, another conversation or a blocked conversation change nothing", async () => {
      const reservation = await book();
      const before = await snapshot(reservation.id);
      const ids = await proposeCancellation(reservation);

      await assert.rejects(accept({ ...ids, proposalId: "missing" }), failsWith("PROPOSAL_NOT_FOUND"));
      const other = await newConversation();
      await assert.rejects(accept({ ...ids, conversationId: other.id }), failsWith("PROPOSAL_NOT_FOUND"));
      await prisma.conversation.update({ where: { id: ids.conversationId }, data: { status: "blocked" } });
      await assert.rejects(accept(ids), failsWith("CONVERSATION_NOT_ACTIVE"));

      assert.equal(await statusOf(ids.proposalId), "pending");
      assert.deepEqual(await snapshot(reservation.id), before);
    });

    test("a reservation already cancelled or completed rejects it, leaving the reservation alone", async () => {
      for (const data of [{ status: "cancelled", cancelledAt: new Date("2026-11-10T06:00:00Z") }, { status: "completed" }]) {
        const reservation = await book();
        const ids = await proposeCancellation(reservation);
        await prisma.reservation.update({ where: { id: reservation.id }, data });
        const before = await snapshot(reservation.id);

        const result = await accept(ids);
        await assertRejectedAndUnchanged(result, ids, reservation, before, "RESERVATION_NOT_CANCELLABLE");
        assert.equal(result.message, "This reservation can't be cancelled because it isn't confirmed.");
      }
    });

    test("a missing reservation rejects it", async () => {
      const ids = await cancelProposalRow(null, JSON.stringify({ current: {} }));
      const result = await accept(ids);
      assert.equal(result.code, "RESERVATION_NOT_CANCELLABLE");
      assert.equal(await statusOf(ids.proposalId), "rejected");
    });
  });

  describe("snapshots", () => {
    test("a missing or malformed snapshot is rejected and changes nothing", async () => {
      const reservation = await book();
      const good = await currentOf(reservation.id);
      const payloads = [
        "not json",
        "[]",
        JSON.stringify({}),
        JSON.stringify({ current: null }),
        JSON.stringify({ current: "x" }),
        JSON.stringify({ current: { ...good, startTime: "soon" } }),
        JSON.stringify({ current: { ...good, adults: "2" } }),
        JSON.stringify({ current: { ...good, estimatedTotalPaisa: 1.5 } }),
        JSON.stringify({ current: { ...good, tableIds: undefined } }),
        JSON.stringify({ current: { ...good, tableIds: [1] } }),
      ];
      for (const payload of payloads) {
        const before = await snapshot(reservation.id);
        const ids = await cancelProposalRow(reservation, payload);
        const result = await accept(ids);
        await assertRejectedAndUnchanged(result, ids, reservation, before, "INVALID_PROPOSAL_PAYLOAD");
      }
      assert.equal((await prisma.reservation.findUnique({ where: { id: reservation.id } })).status, "confirmed");
    });

    test("tables in a different order or times written differently still match", async () => {
      const reservation = await book({ times: dinnerOn("2026-11-19"), tables: ["T9", "T10"] });
      const current = await currentOf(reservation.id);
      const ids = await cancelProposalRow(
        reservation,
        JSON.stringify({ current: { ...current, tableIds: [...current.tableIds].reverse(), startTime: "2026-11-19T19:00:00+05:00" } }),
      );
      assert.equal((await accept(ids)).outcome, "accepted");
    });

    const HALF_HOUR = 30 * 60 * 1000;
    const changes = {
      "start time": (r) => ({ startTime: new Date(r.startTime.getTime() - HALF_HOUR) }),
      "end time": (r) => ({ endTime: new Date(r.endTime.getTime() + HALF_HOUR) }),
      "meal type": () => ({ mealType: "a_la_carte" }),
      adults: () => ({ adults: 3 }),
      children: () => ({ children: 0 }),
      "estimated total": () => ({ estimatedTotalPaisa: 999 }),
    };

    for (const [field, change] of Object.entries(changes)) {
      test(`is stale when the ${field} changed`, async () => {
        const reservation = await book();
        const ids = await proposeCancellation(reservation);
        await prisma.reservation.update({ where: { id: reservation.id }, data: change(reservation) });
        const before = await snapshot(reservation.id);

        const result = await accept(ids);
        await assertRejectedAndUnchanged(result, ids, reservation, before, "STALE_CANCELLATION_PROPOSAL");
        assert.equal(result.message, "This reservation has changed since the cancellation was requested. Please ask to cancel it again.");
        assert.equal((await prisma.reservation.findUnique({ where: { id: reservation.id } })).status, "confirmed");
      });
    }

    test("is stale when the table assignments changed", async () => {
      const reservation = await book({ times: lunchOn("2026-11-19"), tables: ["T7"] });
      const ids = await proposeCancellation(reservation);
      await prisma.reservationTable.create({ data: { reservationId: reservation.id, tableId: tableIds.T8 } });
      const before = await snapshot(reservation.id);

      const result = await accept(ids);
      await assertRejectedAndUnchanged(result, ids, reservation, before, "STALE_CANCELLATION_PROPOSAL");
    });

    test("is stale when the reservation was modified after the cancellation was requested", async () => {
      const reservation = await book();
      const cancelIds = await proposeCancellation(reservation);
      const conversation = await newConversation();
      const modification = await createModificationProposal({
        conversationId: conversation.id,
        reservationCode: reservation.reservationCode,
        guestPhone: PHONE,
        date: "2026-11-20",
        mealType: "buffet_lunch",
        adults: 2,
        children: 0,
        now: NOW,
      });
      assert.equal((await accept({ conversationId: conversation.id, proposalId: modification.proposal.id })).outcome, "accepted");
      const before = await snapshot(reservation.id);

      const result = await accept(cancelIds);
      await assertRejectedAndUnchanged(result, cancelIds, reservation, before, "STALE_CANCELLATION_PROPOSAL");
    });
  });

  describe("cancellation cutoff at acceptance", () => {
    test("exactly 3 hours before the start is allowed", async () => {
      const reservation = await book({ times: dinnerOn("2026-11-13"), tables: ["T5"] });
      const ids = await proposeCancellation(reservation, new Date("2026-11-13T10:58:00Z"));
      const result = await accept(ids, new Date("2026-11-13T11:00:00Z"));
      assert.equal(result.outcome, "accepted");
      assert.equal(result.reservation.cancelledAt.toISOString(), "2026-11-13T11:00:00.000Z");
    });

    test("inside the 3 hours it is rejected and the reservation stays confirmed", async () => {
      const reservation = await book({ times: dinnerOn("2026-11-13"), tables: ["T6"] });
      const before = await snapshot(reservation.id);
      const ids = await proposeCancellation(reservation, new Date("2026-11-13T10:58:00Z"));
      const result = await accept(ids, new Date("2026-11-13T11:00:00.001Z"));
      await assertRejectedAndUnchanged(result, ids, reservation, before, "CANCELLATION_CUTOFF_PASSED");
      assert.equal(result.message, "Reservations can only be cancelled up to 3 hours before they start.");
    });
  });

  describe("concurrency", () => {
    test("accepting the same cancellation at once cancels once", async () => {
      const reservation = await book();
      const ids = await proposeCancellation(reservation);
      const times = [1, 2, 3, 4].map((minutes) => new Date(NOW.getTime() + minutes * 60 * 1000));
      const results = await Promise.allSettled(times.map((now) => accept(ids, now)));

      const accepted = results.filter((r) => r.status === "fulfilled");
      assert.equal(accepted.length, 1);
      for (const r of results.filter((r) => r.status === "rejected")) {
        assert.ok(failsWith("PROPOSAL_NOT_PENDING", "accepted")(r.reason));
      }
      // cancelledAt is the time of the one attempt that won
      const stored = await prisma.reservation.findUnique({ where: { id: reservation.id } });
      assert.equal(stored.cancelledAt.getTime(), accepted[0].value.reservation.cancelledAt.getTime());
    });

    test("a cancellation and a modification of the same reservation at once can't both apply", async () => {
      const reservation = await book();
      const cancelIds = await proposeCancellation(reservation);
      const conversation = await newConversation();
      const modification = await createModificationProposal({
        conversationId: conversation.id,
        reservationCode: reservation.reservationCode,
        guestPhone: PHONE,
        date: "2026-11-20",
        mealType: "buffet_dinner",
        adults: 2,
        children: 0,
        now: NOW,
      });
      const modifyIds = { conversationId: conversation.id, proposalId: modification.proposal.id };

      const [cancelled, modified] = await Promise.all([accept(cancelIds), accept(modifyIds)]);
      assert.deepEqual([cancelled.outcome, modified.outcome].sort(), ["accepted", "rejected"]);
      const stored = await prisma.reservation.findUnique({ where: { id: reservation.id } });
      if (cancelled.outcome === "accepted") {
        // The modification found a cancelled reservation and changed nothing
        assert.equal(modified.code, "RESERVATION_NOT_MODIFIABLE");
        assert.equal(stored.status, "cancelled");
        assert.equal(stored.startTime.getTime(), reservation.startTime.getTime());
      } else {
        // The cancellation found a changed reservation
        assert.equal(cancelled.code, "STALE_CANCELLATION_PROPOSAL");
        assert.equal(stored.status, "confirmed");
      }
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

    for (const [model, method, shouldFail] of [
      ["reservation", "updateMany"],
      ["proposal", "updateMany", (args) => args.data.status === "accepted"],
    ]) {
      test(`a failing ${model}.${method} leaves the reservation confirmed and the proposal pending`, async () => {
        const reservation = await book();
        const before = await snapshot(reservation.id);
        const ids = await proposeCancellation(reservation);

        failInsideTransaction(model, method, shouldFail);
        await assert.rejects(accept(ids), new RegExp(`simulated ${model}.${method} failure`));
        prisma.$transaction = originalTransaction;

        assert.deepEqual(await snapshot(reservation.id), before);
        assert.equal(await statusOf(ids.proposalId), "pending");

        // Nothing was left half-done: it can still be accepted normally
        const retry = await accept(ids);
        assert.equal(retry.outcome, "accepted");
        assert.equal(retry.reservation.status, "cancelled");
      });
    }
  });

  test("never deletes reservations, table assignments or extras", async () => {
    // Every reservation made in this file is still there, each with its tables and extras
    assert.equal(await prisma.reservation.count(), codeCounter);
    const reservations = await prisma.reservation.findMany({ include: { tables: true, extras: true } });
    assert.ok(reservations.every((r) => r.tables.length > 0 && r.extras.length === 3));
  });
});
