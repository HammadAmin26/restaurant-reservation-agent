// Run with: npm test
const { test, describe, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { useTestDatabase } = require("./support/test-database");

// Must run before the Prisma client is loaded
const removeTestDatabase = useTestDatabase();

const prisma = require("../src/lib/prisma");
const {
  createReservationProposal,
  getReservationProposal,
  declineReservationProposal,
  ProposalServiceError,
} = require("../src/services/proposal.service");

// A fixed clock: Tuesday 10 November 2026, 12:00 in Karachi (07:00 UTC)
const NOW = new Date("2026-11-10T07:00:00Z");
const FIVE_MINUTES = 5 * 60 * 1000;
const minutesFromNow = (minutes) => new Date(NOW.getTime() + minutes * 60 * 1000);

// Shaped like a successful validateReservationRequest result
const PAYLOAD = {
  valid: true,
  guest: { guestName: "Hammad Amin", guestPhone: "+923001234567" },
  party: { adults: 2, children: 1, total: 3, requiresFamilySection: true },
  mealType: "buffet_dinner",
  startTime: new Date("2026-11-17T14:00:00Z"),
  endTime: new Date("2026-11-17T18:00:00Z"),
  tables: [{ id: "table-id", tableNumber: "T7", section: "FAMILY", capacity: 4 }],
};

const newConversation = (data = {}) => prisma.conversation.create({ data });
// All the conversation's statuses, sorted, since rows made in the same millisecond have no fixed order
const statuses = async (conversationId) =>
  (await prisma.proposal.findMany({ where: { conversationId } })).map((p) => p.status).sort();
const statusOf = async (id) => (await prisma.proposal.findUnique({ where: { id } })).status;
const pendingCount = (conversationId) => prisma.proposal.count({ where: { conversationId, status: "pending" } });

// A pending proposal created directly, to set up a test
const addPending = (conversationId, expiresAt) =>
  prisma.proposal.create({
    data: { conversationId, actionType: "create", payload: "{}", status: "pending", expiresAt },
  });

describe("createReservationProposal", () => {
  before(async () => {
    // Some unrelated data that must not change
    await prisma.restaurantTable.create({ data: { tableNumber: "T1", section: "GENERAL", capacity: 2 } });
  });

  after(async () => {
    await prisma.$disconnect();
    removeTestDatabase();
  });

  test("creates a pending create proposal", async () => {
    const conversation = await newConversation();
    const proposal = await createReservationProposal({ conversationId: conversation.id, payload: PAYLOAD, now: NOW });

    assert.equal(proposal.conversationId, conversation.id);
    assert.equal(proposal.actionType, "create");
    assert.equal(proposal.status, "pending");
    assert.equal(proposal.reservationId, null);
    assert.equal(typeof proposal.id, "string");
  });

  test("returns the payload as an object and stores it as JSON", async () => {
    const conversation = await newConversation();
    const proposal = await createReservationProposal({ conversationId: conversation.id, payload: PAYLOAD, now: NOW });

    // Dates become ISO strings in JSON
    const expected = JSON.parse(JSON.stringify(PAYLOAD));
    assert.deepEqual(proposal.payload, expected);
    assert.equal(proposal.payload.startTime, "2026-11-17T14:00:00.000Z");

    const stored = await prisma.proposal.findUnique({ where: { id: proposal.id } });
    assert.equal(typeof stored.payload, "string");
    assert.equal(stored.payload, JSON.stringify(PAYLOAD));
  });

  test("expires exactly five minutes after now", async () => {
    const conversation = await newConversation();
    const proposal = await createReservationProposal({ conversationId: conversation.id, payload: PAYLOAD, now: NOW });
    assert.equal(proposal.expiresAt.getTime() - NOW.getTime(), FIVE_MINUTES);
    assert.equal(proposal.expiresAt.toISOString(), "2026-11-10T07:05:00.000Z");
  });

  test("rejects a missing conversation", async () => {
    await assert.rejects(
      createReservationProposal({ conversationId: "does-not-exist", payload: PAYLOAD, now: NOW }),
      (error) => error instanceof ProposalServiceError && error.code === "CONVERSATION_NOT_FOUND",
    );
    assert.equal(await prisma.proposal.count({ where: { conversationId: "does-not-exist" } }), 0);
  });

  test("rejects a blocked conversation and leaves its proposals alone", async () => {
    const conversation = await newConversation({ status: "blocked", warningCount: 3 });
    await addPending(conversation.id, minutesFromNow(2));

    await assert.rejects(
      createReservationProposal({ conversationId: conversation.id, payload: PAYLOAD, now: NOW }),
      (error) => error instanceof ProposalServiceError && error.code === "CONVERSATION_NOT_ACTIVE",
    );
    assert.deepEqual(await statuses(conversation.id), ["pending"]);
  });

  test("rejects an invalid conversationId", async () => {
    for (const conversationId of [undefined, null, "", "   ", 123, {}, ["id"]]) {
      await assert.rejects(
        createReservationProposal({ conversationId, payload: PAYLOAD, now: NOW }),
        TypeError,
        String(conversationId),
      );
    }
    await assert.rejects(createReservationProposal(), TypeError);
  });

  test("rejects an invalid payload, including a JSON string", async () => {
    const conversation = await newConversation();
    const circular = { a: 1 };
    circular.self = circular;
    for (const payload of [undefined, null, JSON.stringify(PAYLOAD), "{}", 1, true, [], [PAYLOAD], new Date(), new Map(), circular, { n: 1n }]) {
      await assert.rejects(
        createReservationProposal({ conversationId: conversation.id, payload, now: NOW }),
        TypeError,
      );
    }
    assert.equal(await prisma.proposal.count({ where: { conversationId: conversation.id } }), 0);
  });

  test("rejects an invalid now", async () => {
    const conversation = await newConversation();
    for (const now of ["2026-11-10T07:00:00Z", NOW.getTime(), null, new Date("x")]) {
      await assert.rejects(createReservationProposal({ conversationId: conversation.id, payload: PAYLOAD, now }), TypeError);
    }
  });

  test("an unexpired pending proposal is declined by a new one", async () => {
    const conversation = await newConversation();
    const old = await addPending(conversation.id, minutesFromNow(1));
    const proposal = await createReservationProposal({ conversationId: conversation.id, payload: PAYLOAD, now: NOW });

    assert.equal((await prisma.proposal.findUnique({ where: { id: old.id } })).status, "declined");
    assert.equal(proposal.status, "pending");
    assert.equal(await pendingCount(conversation.id), 1);
  });

  test("an expired pending proposal is marked expired, including one expiring exactly now", async () => {
    const conversation = await newConversation();
    const expiredEarlier = await addPending(conversation.id, minutesFromNow(-10));
    const expiringNow = await addPending(conversation.id, NOW);
    await createReservationProposal({ conversationId: conversation.id, payload: PAYLOAD, now: NOW });

    assert.equal((await prisma.proposal.findUnique({ where: { id: expiredEarlier.id } })).status, "expired");
    assert.equal((await prisma.proposal.findUnique({ where: { id: expiringNow.id } })).status, "expired");
  });

  test("resolves several pending proposals before creating the new one", async () => {
    const conversation = await newConversation();
    const expired = await addPending(conversation.id, minutesFromNow(-3));
    const unexpiredA = await addPending(conversation.id, minutesFromNow(2));
    const unexpiredB = await addPending(conversation.id, minutesFromNow(4));
    // Already-resolved proposals keep their status
    const accepted = await prisma.proposal.create({
      data: { conversationId: conversation.id, actionType: "create", payload: "{}", status: "accepted", expiresAt: minutesFromNow(-60) },
    });

    const proposal = await createReservationProposal({ conversationId: conversation.id, payload: PAYLOAD, now: NOW });
    assert.equal(await statusOf(expired.id), "expired");
    assert.equal(await statusOf(unexpiredA.id), "declined");
    assert.equal(await statusOf(unexpiredB.id), "declined");
    assert.equal(await statusOf(accepted.id), "accepted");
    assert.equal(await statusOf(proposal.id), "pending");
    assert.equal(await pendingCount(conversation.id), 1);
  });

  test("each conversation keeps its own pending proposal", async () => {
    const first = await newConversation();
    const second = await newConversation();
    await createReservationProposal({ conversationId: first.id, payload: PAYLOAD, now: NOW });
    await createReservationProposal({ conversationId: second.id, payload: PAYLOAD, now: NOW });
    assert.equal(await pendingCount(first.id), 1);
    assert.equal(await pendingCount(second.id), 1);
    // Creating another for the second conversation doesn't touch the first
    const replacement = await createReservationProposal({ conversationId: second.id, payload: PAYLOAD, now: NOW });
    assert.deepEqual(await statuses(first.id), ["pending"]);
    assert.deepEqual(await statuses(second.id), ["declined", "pending"]);
    assert.equal(await statusOf(replacement.id), "pending");
  });

  test("two requests at the same time leave exactly one pending proposal", async () => {
    const conversation = await newConversation();
    await Promise.all(
      [1, 2, 3].map(() => createReservationProposal({ conversationId: conversation.id, payload: PAYLOAD, now: NOW })),
    );
    assert.equal(await pendingCount(conversation.id), 1);
    assert.deepEqual(await statuses(conversation.id), ["declined", "declined", "pending"]);
  });

  describe("when creating the proposal fails", () => {
    const originalTransaction = prisma.$transaction;

    afterEach(() => {
      prisma.$transaction = originalTransaction;
    });

    test("rolls back, so the old pending proposals stay pending", async () => {
      const conversation = await newConversation();
      const unexpired = await addPending(conversation.id, minutesFromNow(3));
      const expired = await addPending(conversation.id, minutesFromNow(-3));

      // Let the updates run, then make proposal.create fail inside the same transaction
      prisma.$transaction = (callback, options) =>
        originalTransaction.call(
          prisma,
          (tx) =>
            callback(
              new Proxy(tx, {
                get(target, property) {
                  if (property !== "proposal") return target[property];
                  return new Proxy(target.proposal, {
                    get(delegate, method) {
                      if (method === "create") return async () => { throw new Error("simulated failure"); };
                      return (...args) => delegate[method](...args);
                    },
                  });
                },
              }),
            ),
          options,
        );

      await assert.rejects(
        createReservationProposal({ conversationId: conversation.id, payload: PAYLOAD, now: NOW }),
        /simulated failure/,
      );

      assert.equal((await prisma.proposal.findUnique({ where: { id: unexpired.id } })).status, "pending");
      assert.equal((await prisma.proposal.findUnique({ where: { id: expired.id } })).status, "pending");
      assert.equal(await prisma.proposal.count({ where: { conversationId: conversation.id } }), 2);
    });
  });

  // A proposal made by the service at NOW, so it expires at NOW + 5 minutes
  const freshProposal = async () => {
    const conversation = await newConversation();
    const proposal = await createReservationProposal({ conversationId: conversation.id, payload: PAYLOAD, now: NOW });
    return { conversationId: conversation.id, proposalId: proposal.id, expiresAt: proposal.expiresAt };
  };
  // A proposal in the given status, created directly
  const proposalWithStatus = async (status) => {
    const conversation = await newConversation();
    const proposal = await prisma.proposal.create({
      data: { conversationId: conversation.id, actionType: "create", payload: "{}", status, expiresAt: minutesFromNow(5) },
    });
    return { conversationId: conversation.id, proposalId: proposal.id };
  };
  const failsWith = (code, proposalStatus) => (error) =>
    error instanceof ProposalServiceError &&
    error.code === code &&
    (proposalStatus === undefined || error.proposalStatus === proposalStatus);

  describe("declineReservationProposal", () => {
    test("declines a pending proposal before it expires", async () => {
      const { conversationId, proposalId } = await freshProposal();
      const result = await declineReservationProposal({ proposalId, conversationId, now: minutesFromNow(4) });

      assert.equal(result.outcome, "declined");
      assert.equal(result.proposal.status, "declined");
      assert.equal(result.proposal.id, proposalId);
      assert.deepEqual(result.proposal.payload, JSON.parse(JSON.stringify(PAYLOAD)));
      assert.equal(await statusOf(proposalId), "declined");
    });

    test("marks it expired instead when declined exactly at expiry", async () => {
      const { conversationId, proposalId, expiresAt } = await freshProposal();
      const result = await declineReservationProposal({ proposalId, conversationId, now: expiresAt });
      assert.equal(result.outcome, "expired");
      assert.equal(await statusOf(proposalId), "expired");
    });

    test("marks it expired instead when declined after expiry", async () => {
      const { conversationId, proposalId } = await freshProposal();
      const result = await declineReservationProposal({ proposalId, conversationId, now: minutesFromNow(30) });
      assert.equal(result.outcome, "expired");
      assert.equal(result.proposal.status, "expired");
    });

    test("can't decline another conversation's proposal", async () => {
      const { proposalId } = await freshProposal();
      const other = await newConversation();
      await assert.rejects(
        declineReservationProposal({ proposalId, conversationId: other.id, now: NOW }),
        failsWith("PROPOSAL_NOT_FOUND"),
      );
      assert.equal(await statusOf(proposalId), "pending");
    });

    test("rejects a proposal that doesn't exist", async () => {
      const conversation = await newConversation();
      await assert.rejects(
        declineReservationProposal({ proposalId: "missing", conversationId: conversation.id, now: NOW }),
        failsWith("PROPOSAL_NOT_FOUND"),
      );
    });

    test("declining twice fails the second time and keeps it declined", async () => {
      const { conversationId, proposalId } = await freshProposal();
      await declineReservationProposal({ proposalId, conversationId, now: NOW });
      await assert.rejects(
        declineReservationProposal({ proposalId, conversationId, now: NOW }),
        failsWith("PROPOSAL_NOT_PENDING", "declined"),
      );
      assert.equal(await statusOf(proposalId), "declined");
    });

    test("never changes accepted, declined, expired or rejected proposals", async () => {
      for (const status of ["accepted", "declined", "expired", "rejected"]) {
        const { conversationId, proposalId } = await proposalWithStatus(status);
        // Before and after its expiry time
        for (const now of [NOW, minutesFromNow(60)]) {
          await assert.rejects(
            declineReservationProposal({ proposalId, conversationId, now }),
            failsWith("PROPOSAL_NOT_PENDING", status),
          );
        }
        assert.equal(await statusOf(proposalId), status);
      }
    });

    test("rejects invalid arguments", async () => {
      const { conversationId, proposalId } = await freshProposal();
      for (const bad of [undefined, null, "", "  ", 1, {}]) {
        await assert.rejects(declineReservationProposal({ proposalId: bad, conversationId, now: NOW }), TypeError);
        await assert.rejects(declineReservationProposal({ proposalId, conversationId: bad, now: NOW }), TypeError);
      }
      for (const now of [null, "2026-11-10", NOW.getTime(), new Date("x")]) {
        await assert.rejects(declineReservationProposal({ proposalId, conversationId, now }), TypeError);
      }
      await assert.rejects(declineReservationProposal(), TypeError);
      assert.equal(await statusOf(proposalId), "pending");
    });
  });

  describe("getReservationProposal", () => {
    test("returns a pending proposal before it expires, unchanged", async () => {
      const { conversationId, proposalId } = await freshProposal();
      const proposal = await getReservationProposal({ proposalId, conversationId, now: minutesFromNow(4) });
      assert.equal(proposal.status, "pending");
      assert.equal(proposal.actionType, "create");
      assert.deepEqual(proposal.payload, JSON.parse(JSON.stringify(PAYLOAD)));
      assert.equal(await statusOf(proposalId), "pending");
    });

    test("marks a pending proposal expired exactly at its expiry time", async () => {
      const { conversationId, proposalId, expiresAt } = await freshProposal();
      const proposal = await getReservationProposal({ proposalId, conversationId, now: expiresAt });
      assert.equal(proposal.status, "expired");
      assert.equal(await statusOf(proposalId), "expired");
    });

    test("returns an already expired proposal as it is", async () => {
      const { conversationId, proposalId } = await proposalWithStatus("expired");
      const before = await prisma.proposal.findUnique({ where: { id: proposalId } });
      const proposal = await getReservationProposal({ proposalId, conversationId, now: minutesFromNow(60) });
      assert.equal(proposal.status, "expired");
      // Not written again
      const after = await prisma.proposal.findUnique({ where: { id: proposalId } });
      assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime());
    });

    test("never changes accepted or declined proposals, even after expiry", async () => {
      for (const status of ["accepted", "declined", "rejected"]) {
        const { conversationId, proposalId } = await proposalWithStatus(status);
        const proposal = await getReservationProposal({ proposalId, conversationId, now: minutesFromNow(60) });
        assert.equal(proposal.status, status);
        assert.equal(await statusOf(proposalId), status);
      }
    });

    test("an expired or declined proposal never becomes pending again", async () => {
      const { conversationId, proposalId } = await freshProposal();
      await getReservationProposal({ proposalId, conversationId, now: minutesFromNow(10) });
      // Asking again with an earlier clock doesn't bring it back
      const proposal = await getReservationProposal({ proposalId, conversationId, now: NOW });
      assert.equal(proposal.status, "expired");
    });

    test("only returns proposals from the given conversation", async () => {
      const { proposalId } = await freshProposal();
      const other = await newConversation();
      await assert.rejects(
        getReservationProposal({ proposalId, conversationId: other.id, now: minutesFromNow(10) }),
        failsWith("PROPOSAL_NOT_FOUND"),
      );
      // The other conversation's request didn't expire it either
      assert.equal(await statusOf(proposalId), "pending");
    });

    test("rejects a proposal that doesn't exist", async () => {
      const conversation = await newConversation();
      await assert.rejects(
        getReservationProposal({ proposalId: "missing", conversationId: conversation.id, now: NOW }),
        failsWith("PROPOSAL_NOT_FOUND"),
      );
    });

    test("rejects invalid arguments", async () => {
      const { conversationId, proposalId } = await freshProposal();
      for (const bad of [undefined, null, "", "  ", 1, {}]) {
        await assert.rejects(getReservationProposal({ proposalId: bad, conversationId, now: NOW }), TypeError);
        await assert.rejects(getReservationProposal({ proposalId, conversationId: bad, now: NOW }), TypeError);
      }
      for (const now of [null, "2026-11-10", NOW.getTime(), new Date("x")]) {
        await assert.rejects(getReservationProposal({ proposalId, conversationId, now }), TypeError);
      }
      await assert.rejects(getReservationProposal(), TypeError);
    });
  });

  describe("concurrent requests", () => {
    test("several declines at once: exactly one succeeds", async () => {
      const { conversationId, proposalId } = await freshProposal();
      const results = await Promise.allSettled(
        [1, 2, 3, 4].map(() => declineReservationProposal({ proposalId, conversationId, now: NOW })),
      );
      const succeeded = results.filter((r) => r.status === "fulfilled");
      const failed = results.filter((r) => r.status === "rejected");
      assert.equal(succeeded.length, 1);
      assert.equal(succeeded[0].value.outcome, "declined");
      assert.ok(failed.every((r) => failsWith("PROPOSAL_NOT_PENDING", "declined")(r.reason)));
      assert.equal(await statusOf(proposalId), "declined");
    });

    test("declines and expiry checks at expiry time all end in expired", async () => {
      const { conversationId, proposalId, expiresAt } = await freshProposal();
      const results = await Promise.allSettled([
        declineReservationProposal({ proposalId, conversationId, now: expiresAt }),
        getReservationProposal({ proposalId, conversationId, now: expiresAt }),
        declineReservationProposal({ proposalId, conversationId, now: expiresAt }),
        getReservationProposal({ proposalId, conversationId, now: expiresAt }),
      ]);
      assert.equal(await statusOf(proposalId), "expired");
      for (const result of results) {
        if (result.status === "fulfilled") {
          // A decline that got there first reports expired; reads see expired
          const status = result.value.outcome ?? result.value.status;
          assert.equal(status, "expired");
        } else {
          assert.ok(failsWith("PROPOSAL_NOT_PENDING", "expired")(result.reason));
        }
      }
    });

    test("a decline racing a new proposal leaves a consistent result", async () => {
      const { conversationId, proposalId } = await freshProposal();
      const [decline, created] = await Promise.allSettled([
        declineReservationProposal({ proposalId, conversationId, now: NOW }),
        createReservationProposal({ conversationId, payload: PAYLOAD, now: NOW }),
      ]);
      // Either way the old proposal ends up declined and only the new one is pending
      assert.equal(await statusOf(proposalId), "declined");
      assert.equal(created.status, "fulfilled");
      assert.equal(await pendingCount(conversationId), 1);
      if (decline.status === "rejected") {
        assert.ok(failsWith("PROPOSAL_NOT_PENDING", "declined")(decline.reason));
      }
    });
  });

  test("never creates reservations, table assignments or extras", async () => {
    assert.equal(await prisma.reservation.count(), 0);
    assert.equal(await prisma.reservationTable.count(), 0);
    assert.equal(await prisma.reservationExtra.count(), 0);
    // Unrelated data is unchanged
    assert.equal(await prisma.restaurantTable.count(), 1);
  });
});
