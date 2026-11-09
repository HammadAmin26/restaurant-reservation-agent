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
  acceptReservationProposal,
  generateUniqueReservationCode,
  ProposalServiceError,
} = require("../src/services/proposal.service");

// A fixed clock: Tuesday 10 November 2026, 12:00 in Karachi (07:00 UTC). Karachi is UTC+5.
const NOW = new Date("2026-11-10T07:00:00Z");
const minutesFrom = (date, minutes) => new Date(date.getTime() + minutes * 60 * 1000);
// November 2026: Tuesday 17th, Wednesday 18th ... Sunday 22nd, Tuesday 24th
const TUESDAY = "2026-11-17";

// A guest's request, as stored in a proposal's payload
const request = (overrides = {}) => ({
  date: TUESDAY,
  time: "19:00",
  mealType: "a_la_carte",
  adults: 2,
  children: 0,
  guestName: "  Hammad Amin ",
  guestPhone: "03001234567",
  extras: [],
  ...overrides,
});

const newConversation = (data = {}) => prisma.conversation.create({ data });

// A pending proposal made the normal way, at `now`
async function propose(overrides = {}, now = NOW) {
  const conversation = await newConversation();
  const proposal = await createReservationProposal({ conversationId: conversation.id, payload: request(overrides), now });
  return { conversationId: conversation.id, proposalId: proposal.id, expiresAt: proposal.expiresAt };
}

// A proposal row with any status or payload, created directly
async function proposalRow({ status = "pending", payload = JSON.stringify(request()), actionType = "create" } = {}) {
  const conversation = await newConversation();
  const proposal = await prisma.proposal.create({
    data: { conversationId: conversation.id, actionType, payload, status, expiresAt: minutesFrom(NOW, 5) },
  });
  return { conversationId: conversation.id, proposalId: proposal.id };
}

const accept = ({ conversationId, proposalId }, now = NOW) => acceptReservationProposal({ proposalId, conversationId, now });
const statusOf = async (id) => (await prisma.proposal.findUnique({ where: { id } })).status;
const reservationsFor = (conversationId) => prisma.reservation.count({ where: { conversationId } });
const tableNumbers = (reservation) => reservation.tables.map((t) => t.table.tableNumber).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
const failsWith = (code, proposalStatus) => (error) =>
  error instanceof ProposalServiceError &&
  error.code === code &&
  (proposalStatus === undefined || error.proposalStatus === proposalStatus);

// Book tables directly, outside any proposal
let fixtureCode = 0;
async function bookDirectly(conversationId, tableNumbersToBook, startTime, endTime) {
  const tables = await prisma.restaurantTable.findMany({ where: { tableNumber: { in: tableNumbersToBook } } });
  return prisma.reservation.create({
    data: {
      conversationId,
      reservationCode: `RSV-Z${String(++fixtureCode).padStart(3, "0")}`,
      guestName: "Booked",
      guestPhone: "+923000000000",
      startTime,
      endTime,
      mealType: "buffet_dinner",
      adults: 2,
      tables: { create: tables.map((t) => ({ tableId: t.id })) },
    },
  });
}

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

describe("acceptReservationProposal", () => {
  let unrelated;
  let snapshot;

  // Everything about the unrelated data, to compare at the end
  const takeSnapshot = async () => ({
    reservation: await prisma.reservation.findUnique({
      where: { id: unrelated.reservation.id },
      include: { tables: true, extras: true, proposals: true },
    }),
    conversation: await prisma.conversation.findUnique({ where: { id: unrelated.conversation.id }, include: { messages: true } }),
    tables: await prisma.restaurantTable.findMany({ orderBy: { tableNumber: "asc" } }),
  });

  before(async () => {
    await prisma.restaurantTable.createMany({ data: restaurantTables });

    // An existing reservation on another day, which no test may change
    const conversation = await newConversation();
    await prisma.message.create({ data: { conversationId: conversation.id, role: "guest", content: "Hello" } });
    const reservation = await bookDirectly(conversation.id, ["T6"], new Date("2026-12-01T14:00:00Z"), new Date("2026-12-01T18:00:00Z"));
    await prisma.reservationExtra.create({
      data: { reservationId: reservation.id, extraKey: "candles", name: "Candles", unitPricePaisa: 30000, lineTotalPaisa: 30000 },
    });
    unrelated = { conversation, reservation };
    snapshot = await takeSnapshot();
  });

  after(async () => {
    await prisma.$disconnect();
    removeTestDatabase();
  });

  describe("successful acceptance", () => {
    test("creates a confirmed à la carte reservation", async () => {
      const ids = await propose({ specialRequest: "  Window seat, please  " });
      const result = await accept(ids, minutesFrom(NOW, 2));

      assert.equal(result.outcome, "accepted");
      const { reservation } = result;
      assert.match(reservation.reservationCode, /^RSV-[A-Z0-9]{4}$/);
      assert.equal(reservation.conversationId, ids.conversationId);
      assert.equal(reservation.guestName, "Hammad Amin");
      assert.equal(reservation.guestPhone, "+923001234567");
      assert.equal(reservation.mealType, "a_la_carte");
      // 19:00-21:00 Karachi
      assert.equal(reservation.startTime.toISOString(), "2026-11-17T14:00:00.000Z");
      assert.equal(reservation.endTime.toISOString(), "2026-11-17T16:00:00.000Z");
      assert.equal(reservation.adults, 2);
      assert.equal(reservation.children, 0);
      assert.equal(reservation.status, "confirmed");
      assert.equal(reservation.estimatedTotalPaisa, 0);
      assert.equal(reservation.specialRequest, "Window seat, please");
      assert.equal(reservation.cancelledAt, null);
      assert.deepEqual(tableNumbers(reservation), ["T1"]);
      assert.deepEqual(reservation.extras, []);
    });

    test("links the proposal to the reservation", async () => {
      const ids = await propose();
      const { reservation, proposal } = await accept(ids);
      assert.equal(proposal.status, "accepted");
      assert.equal(proposal.reservationId, reservation.id);
      assert.equal(proposal.payload.guestName, "  Hammad Amin ");

      const stored = await prisma.proposal.findUnique({ where: { id: ids.proposalId }, include: { reservation: true } });
      assert.equal(stored.status, "accepted");
      assert.equal(stored.reservation.id, reservation.id);
    });

    test("prices buffet lunch and dinner for adults", async () => {
      const lunch = await accept(await propose({ mealType: "buffet_lunch", time: undefined }));
      assert.equal(lunch.reservation.estimatedTotalPaisa, 499800);
      assert.equal(lunch.reservation.startTime.toISOString(), "2026-11-17T07:00:00.000Z");
      assert.equal(lunch.reservation.endTime.toISOString(), "2026-11-17T10:30:00.000Z");

      const dinner = await accept(await propose({ mealType: "buffet_dinner", date: "2026-11-18" }));
      assert.equal(dinner.reservation.estimatedTotalPaisa, 699800);
    });

    test("prices children, including half-rupee totals and free under-3s", async () => {
      // 2 adults + 1 child at dinner: PKR 8,747.50
      const half = await accept(await propose({ mealType: "buffet_dinner", date: "2026-11-19", children: 1 }));
      assert.equal(half.reservation.estimatedTotalPaisa, 874750);
      assert.equal(half.reservation.children, 1);

      // 1 adult + 1 child at lunch: PKR 3,748.50
      const lunch = await accept(await propose({ mealType: "buffet_lunch", date: "2026-11-19", adults: 1, children: 1 }));
      assert.equal(lunch.reservation.estimatedTotalPaisa, 374850);

      // 2 adults + 3 children, 1 under 3: 2 x 349900 + 2 x 174950
      const under3 = await accept(
        await propose({ mealType: "buffet_dinner", date: "2026-11-20", children: 3, childrenUnder3: 1 }),
      );
      assert.equal(under3.reservation.estimatedTotalPaisa, 1049700);
      assert.equal(under3.reservation.children, 3);
    });

    test("saves several extras with their prices and approval statuses", async () => {
      const ids = await propose({
        mealType: "buffet_dinner",
        date: "2026-11-21",
        extras: [
          { extraKey: "birthday_cake", quantity: 1 },
          { extraKey: "candles", quantity: 2 },
          { extraKey: "balloons", quantity: 3 },
          { extraKey: "high_chair", quantity: 1 },
        ],
      });
      const { reservation } = await accept(ids);
      const extras = Object.fromEntries(reservation.extras.map((e) => [e.extraKey, e]));

      assert.equal(reservation.extras.length, 4);
      assert.deepEqual(
        [extras.birthday_cake.lineTotalPaisa, extras.candles.lineTotalPaisa, extras.balloons.lineTotalPaisa, extras.high_chair.lineTotalPaisa],
        [300000, 60000, 450000, 0],
      );
      assert.equal(extras.candles.quantity, 2);
      assert.equal(extras.candles.unitPricePaisa, 30000);
      assert.equal(extras.birthday_cake.approvalStatus, "not_required");
      assert.equal(extras.balloons.approvalStatus, "pending");
      assert.equal(extras.high_chair.approvalStatus, "pending");
      // 2 x 349900 dinner + 810000 extras
      assert.equal(reservation.estimatedTotalPaisa, 1509800);
    });

    test("keeps the outside cake fee as its own pending extra", async () => {
      const ids = await propose({
        mealType: "buffet_lunch",
        date: "2026-11-21",
        outsideCake: true,
        extras: [{ extraKey: "candles", quantity: 1 }],
      });
      const { reservation } = await accept(ids);
      const outsideCake = reservation.extras.find((e) => e.extraKey === "outside_cake");

      assert.deepEqual(
        {
          name: outsideCake.name,
          quantity: outsideCake.quantity,
          unitPricePaisa: outsideCake.unitPricePaisa,
          lineTotalPaisa: outsideCake.lineTotalPaisa,
          approvalStatus: outsideCake.approvalStatus,
        },
        { name: "Outside cake service fee", quantity: 1, unitPricePaisa: 50000, lineTotalPaisa: 50000, approvalStatus: "pending" },
      );
      // Not confused with our own birthday cake
      assert.equal(reservation.extras.some((e) => e.extraKey === "birthday_cake"), false);
      // 2 x 249900 lunch + 30000 candles + 50000 outside cake
      assert.equal(reservation.estimatedTotalPaisa, 579800);
    });

    test("assigns the right tables", async () => {
      // Children: FAMILY only
      const family = await accept(await propose({ date: "2026-11-22", adults: 2, children: 2 }));
      assert.deepEqual(tableNumbers(family.reservation), ["T7"]);
      assert.ok(family.reservation.tables.every((t) => t.table.section === "FAMILY"));

      // 10 adults: GENERAL T3 + T6
      const large = await accept(await propose({ date: "2026-11-22", time: "12:00", adults: 10 }));
      assert.deepEqual(tableNumbers(large.reservation), ["T3", "T6"]);
      assert.equal(await prisma.reservationTable.count({ where: { reservationId: large.reservation.id } }), 2);
    });
  });

  describe("proposals that can't be accepted", () => {
    test("an expired proposal is marked expired", async () => {
      const ids = await propose();
      const result = await accept(ids, ids.expiresAt);
      assert.equal(result.outcome, "expired");
      assert.equal(result.proposal.status, "expired");
      assert.equal(result.reservation, undefined);
      assert.equal(await statusOf(ids.proposalId), "expired");
      assert.equal(await reservationsFor(ids.conversationId), 0);
    });

    test("declined, rejected, expired and accepted proposals are refused unchanged", async () => {
      for (const status of ["declined", "rejected", "expired", "accepted"]) {
        const ids = await proposalRow({ status });
        await assert.rejects(accept(ids), failsWith("PROPOSAL_NOT_PENDING", status), status);
        assert.equal(await statusOf(ids.proposalId), status);
        assert.equal(await reservationsFor(ids.conversationId), 0);
      }
    });

    test("accepting again never creates a second reservation", async () => {
      const ids = await propose();
      await accept(ids);
      await assert.rejects(accept(ids), failsWith("PROPOSAL_NOT_PENDING", "accepted"));
      await assert.rejects(accept(ids, minutesFrom(NOW, 60)), failsWith("PROPOSAL_NOT_PENDING", "accepted"));
      assert.equal(await reservationsFor(ids.conversationId), 1);
    });

    test("a missing proposal or another conversation's proposal is not found", async () => {
      const conversation = await newConversation();
      await assert.rejects(
        acceptReservationProposal({ proposalId: "missing", conversationId: conversation.id, now: NOW }),
        failsWith("PROPOSAL_NOT_FOUND"),
      );

      const ids = await propose();
      await assert.rejects(
        acceptReservationProposal({ proposalId: ids.proposalId, conversationId: conversation.id, now: NOW }),
        failsWith("PROPOSAL_NOT_FOUND"),
      );
      assert.equal(await statusOf(ids.proposalId), "pending");
      assert.equal(await prisma.reservation.count({ where: { conversationId: { in: [conversation.id, ids.conversationId] } } }), 0);
    });

    test("a blocked conversation can't accept, and its proposal is left pending", async () => {
      const ids = await propose();
      await prisma.conversation.update({ where: { id: ids.conversationId }, data: { status: "blocked", warningCount: 3 } });
      await assert.rejects(accept(ids), failsWith("CONVERSATION_NOT_ACTIVE"));
      assert.equal(await statusOf(ids.proposalId), "pending");
      assert.equal(await reservationsFor(ids.conversationId), 0);
    });

    test("an unreadable payload rejects the proposal", async () => {
      for (const payload of ["not json", "[]", "null", "42", '"text"']) {
        const ids = await proposalRow({ payload });
        const result = await accept(ids);
        assert.equal(result.outcome, "rejected", payload);
        assert.equal(result.code, "INVALID_PROPOSAL_PAYLOAD");
        assert.equal(result.proposal.payload, null);
        assert.equal(await statusOf(ids.proposalId), "rejected");
        assert.equal(await reservationsFor(ids.conversationId), 0);
      }
    });

    test("a stored request that fails validation rejects the proposal", async () => {
      const cases = [
        [{ date: "2026-11-16" }, "RESTAURANT_CLOSED"],
        [{ guestPhone: "02134567890" }, "INVALID_PHONE"],
        [{ adults: 16 }, "PARTY_TOO_LARGE"],
        [{ time: "19:15" }, "INVALID_SLOT"],
        [{ extras: [{ extraKey: "fireworks", quantity: 1 }] }, "INVALID_EXTRA"],
        [{ extras: "none" }, "INVALID_EXTRA"],
        [{ outsideCake: "yes" }, "INVALID_OUTSIDE_CAKE"],
        [{ specialRequest: 42 }, "INVALID_SPECIAL_REQUEST"],
        [{ mealType: "buffet_lunch", children: 1, childrenUnder3: 2 }, "INVALID_CHILDREN_UNDER_3"],
      ];
      for (const [overrides, code] of cases) {
        const ids = await proposalRow({ payload: JSON.stringify(request(overrides)) });
        const result = await accept(ids);
        assert.equal(result.outcome, "rejected", code);
        assert.equal(result.kind, "validation", code);
        assert.equal(result.code, code);
        assert.ok(result.message.length > 0);
        assert.equal(await statusOf(ids.proposalId), "rejected");
        assert.equal(await reservationsFor(ids.conversationId), 0);
      }
    });

    test("a request that became invalid after the proposal was made is rejected", async () => {
      // Proposed exactly 24 hours before dinner with a birthday cake; accepted a minute later
      const dinnerStart = new Date("2026-11-11T14:00:00Z");
      const proposedAt = minutesFrom(dinnerStart, -24 * 60);
      const cake = await propose(
        { mealType: "buffet_dinner", date: "2026-11-11", extras: [{ extraKey: "birthday_cake", quantity: 1 }] },
        proposedAt,
      );
      const late = await accept(cake, minutesFrom(proposedAt, 1));
      assert.equal(late.code, "INSUFFICIENT_NOTICE");
      assert.equal(await statusOf(cake.proposalId), "rejected");

      // Proposed for 12:30 today at 12:28; by 12:31 it's in the past
      const proposedAt1228 = new Date("2026-11-10T07:28:00Z");
      const soon = await propose({ date: "2026-11-10", time: "12:30" }, proposedAt1228);
      const past = await accept(soon, new Date("2026-11-10T07:31:00Z"));
      assert.equal(past.code, "DATE_IN_PAST");
      assert.equal(await reservationsFor(soon.conversationId), 0);
    });
  });

  describe("availability", () => {
    test("tables taken after the proposal was made reject it as unavailable", async () => {
      // 15 children need T7 + T8 + T10, the only FAMILY combination big enough
      const first = await propose({ date: "2026-11-24", mealType: "buffet_dinner", adults: 0, children: 15 });
      const second = await propose({ date: "2026-11-24", mealType: "buffet_dinner", adults: 0, children: 15 });

      assert.equal((await accept(second)).outcome, "accepted");
      const result = await accept(first);
      assert.equal(result.outcome, "rejected");
      assert.equal(result.kind, "availability");
      assert.equal(result.code, "TABLES_UNAVAILABLE");
      assert.equal(await statusOf(first.proposalId), "rejected");
      assert.equal(await reservationsFor(first.conversationId), 0);
    });

    test("if only some tables were taken, other free tables are used", async () => {
      const ids = await propose({ date: "2026-11-25", adults: 2 });
      // T1 is booked over the same time after the proposal was made
      await bookDirectly(unrelated.conversation.id, ["T1"], new Date("2026-11-25T13:00:00Z"), new Date("2026-11-25T15:00:00Z"));
      const result = await accept(ids);
      assert.equal(result.outcome, "accepted");
      assert.deepEqual(tableNumbers(result.reservation), ["T2"]);
    });

    test("no table combination for the party rejects it as unavailable", async () => {
      // With T10 booked, FAMILY has only 4 + 4 + 6 = 14 seats for 15 children
      await bookDirectly(unrelated.conversation.id, ["T10"], new Date("2026-11-26T14:00:00Z"), new Date("2026-11-26T18:00:00Z"));
      const ids = await propose({ date: "2026-11-26", mealType: "buffet_dinner", adults: 0, children: 15 });
      const result = await accept(ids);
      assert.equal(result.code, "TABLES_UNAVAILABLE");
      assert.equal(result.kind, "availability");
      assert.equal(await reservationsFor(ids.conversationId), 0);
    });
  });

  describe("concurrency", () => {
    test("accepting the same proposal at once creates one reservation", async () => {
      const ids = await propose({ date: "2026-11-27" });
      const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => accept(ids)));

      const accepted = results.filter((r) => r.status === "fulfilled");
      assert.equal(accepted.length, 1);
      assert.equal(accepted[0].value.outcome, "accepted");
      for (const r of results.filter((r) => r.status === "rejected")) {
        assert.ok(failsWith("PROPOSAL_NOT_PENDING", "accepted")(r.reason));
      }
      assert.equal(await reservationsFor(ids.conversationId), 1);
      assert.equal(await statusOf(ids.proposalId), "accepted");
    });

    test("different proposals competing for the same tables can't double-book", async () => {
      // Three parties of 15 children; only one FAMILY combination can seat 15
      const proposals = await Promise.all(
        [1, 2, 3].map(() => propose({ date: "2026-11-28", mealType: "buffet_dinner", adults: 0, children: 15 })),
      );
      const results = await Promise.all(proposals.map((ids) => accept(ids)));

      assert.equal(results.filter((r) => r.outcome === "accepted").length, 1);
      assert.equal(results.filter((r) => r.code === "TABLES_UNAVAILABLE").length, 2);
      await assertNoDoubleBooking();
    });

    test("different proposals at once get separate tables", async () => {
      // Three parties of 10 adults at the same time: GENERAL fits two, FAMILY the third
      const proposals = await Promise.all(
        [1, 2, 3].map(() => propose({ date: "2026-11-29", time: "13:00", adults: 10 })),
      );
      const results = await Promise.all(proposals.map((ids) => accept(ids)));

      assert.ok(results.every((r) => r.outcome === "accepted"));
      const allTables = results.flatMap((r) => tableNumbers(r.reservation));
      assert.equal(new Set(allTables).size, allTables.length);
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
      ["reservation", "create"],
      ["reservationTable", "createMany"],
      ["reservationExtra", "createMany"],
      ["proposal", "updateMany", (args) => args.data.status === "accepted"],
    ];

    for (const [model, method, shouldFail] of failurePoints) {
      test(`a failing ${model}.${method} rolls everything back`, async () => {
        const ids = await propose({ date: "2026-11-21", time: "21:00", extras: [{ extraKey: "candles", quantity: 1 }], outsideCake: true });
        const counts = async () => [await prisma.reservation.count(), await prisma.reservationTable.count(), await prisma.reservationExtra.count()];
        const before = await counts();

        failInsideTransaction(model, method, shouldFail);
        await assert.rejects(accept(ids), new RegExp(`simulated ${model}.${method} failure`));
        prisma.$transaction = originalTransaction;

        assert.deepEqual(await counts(), before);
        assert.equal(await statusOf(ids.proposalId), "pending");
        assert.equal((await prisma.proposal.findUnique({ where: { id: ids.proposalId } })).reservationId, null);

        // Nothing was left half-done: it can still be accepted normally
        const retry = await accept(ids);
        assert.equal(retry.outcome, "accepted");
        assert.equal(retry.reservation.extras.length, 2);
      });
    }
  });

  describe("generateUniqueReservationCode", () => {
    test("tries again when a code is already taken", async () => {
      const taken = await prisma.reservation.findFirst();
      const codes = [taken.reservationCode, taken.reservationCode, "RSV-NEW1"];
      const code = await prisma.$transaction((tx) => generateUniqueReservationCode(tx, () => codes.shift()));
      assert.equal(code, "RSV-NEW1");
    });

    test("gives up with an error if every attempt collides", async () => {
      const taken = await prisma.reservation.findFirst();
      await assert.rejects(
        prisma.$transaction((tx) => generateUniqueReservationCode(tx, () => taken.reservationCode)),
        /No free reservation code/,
      );
    });

    test("random codes match RSV-XXXX", async () => {
      const codes = await prisma.$transaction(async (tx) => {
        const result = [];
        for (let i = 0; i < 50; i++) result.push(await generateUniqueReservationCode(tx));
        return result;
      });
      assert.ok(codes.every((code) => /^RSV-[A-Z0-9]{4}$/.test(code)));
    });
  });

  test("rejects invalid arguments", async () => {
    const ids = await propose();
    for (const bad of [undefined, null, "", "  ", 1, {}]) {
      await assert.rejects(acceptReservationProposal({ proposalId: bad, conversationId: ids.conversationId, now: NOW }), TypeError);
      await assert.rejects(acceptReservationProposal({ proposalId: ids.proposalId, conversationId: bad, now: NOW }), TypeError);
    }
    for (const now of [null, "2026-11-10", NOW.getTime(), new Date("x")]) {
      await assert.rejects(acceptReservationProposal({ ...ids, now }), TypeError);
    }
    await assert.rejects(acceptReservationProposal(), TypeError);
    assert.equal(await statusOf(ids.proposalId), "pending");
  });

  test("never creates a reservation without acceptance", async () => {
    const ids = await propose({ date: "2026-11-30" });
    assert.equal(await reservationsFor(ids.conversationId), 0);
  });

  test("leaves unrelated records unchanged", async () => {
    assert.deepEqual(await takeSnapshot(), snapshot);
    await assertNoDoubleBooking();
  });
});
