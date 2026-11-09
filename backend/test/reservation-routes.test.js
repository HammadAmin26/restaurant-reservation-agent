// Run with: npm test
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { useTestDatabase } = require("./support/test-database");

// Must run before the Prisma client is loaded
const removeTestDatabase = useTestDatabase();

const prisma = require("../src/lib/prisma");
const restaurantTables = require("../src/config/restaurant-tables");
const { createApp } = require("../src/app");
const { createReservationProposal } = require("../src/services/proposal.service");

// A clock the tests control: Tuesday 10 November 2026, 12:00 in Karachi (07:00 UTC)
const NOW = new Date("2026-11-10T07:00:00Z");
let currentTime = NOW;
const minutesAfterNow = (minutes) => new Date(NOW.getTime() + minutes * 60 * 1000);

let server;
let baseUrl;

async function request(method, path, body) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers["content-type"] = "application/json";
    options.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const response = await fetch(baseUrl + path, options);
  return { status: response.status, body: await response.json() };
}
const get = (path) => request("GET", path);
const post = (path, body) => request("POST", path, body);

// A new reservation request: buffet dinner for 2 on Tuesday 17 November
const reservationRequest = (overrides = {}) => ({
  date: "2026-11-17",
  mealType: "buffet_dinner",
  adults: 2,
  children: 0,
  guestName: "Hammad Amin",
  guestPhone: "03001234567",
  extras: [],
  ...overrides,
});

const newConversation = async () => (await post("/conversations")).body.data.id;

// Propose and accept a reservation over HTTP; returns the conversation and reservation
async function bookOverHttp(overrides) {
  const conversationId = await newConversation();
  const proposal = await post(`/conversations/${conversationId}/reservations/proposals`, reservationRequest(overrides));
  assert.equal(proposal.status, 201, JSON.stringify(proposal.body));
  const accepted = await post(`/conversations/${conversationId}/proposals/${proposal.body.data.id}/accept`);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  return { conversationId, reservation: accepted.body.data.reservation };
}

const blockConversation = (id) => prisma.conversation.update({ where: { id }, data: { status: "blocked", warningCount: 3 } });

describe("reservation routes", () => {
  before(async () => {
    await prisma.restaurantTable.createMany({ data: restaurantTables });
    server = createApp({ clock: () => currentTime }).listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
    removeTestDatabase();
  });

  test("uses a throwaway database, never dev.db", () => {
    assert.match(process.env.DATABASE_URL, /hammad-foods-test-.*test\.db$/);
    assert.doesNotMatch(process.env.DATABASE_URL, /dev\.db/);
  });

  describe("existing routes", () => {
    test("health and conversation endpoints still work", async () => {
      const health = await get("/health");
      assert.equal(health.status, 200);
      assert.deepEqual(health.body, { success: true, message: "Hammad Foods API is running!" });

      const created = await post("/conversations");
      assert.equal(created.status, 201);
      const fetched = await get(`/conversations/${created.body.data.id}`);
      assert.equal(fetched.status, 200);
      assert.deepEqual(fetched.body.data.messages, []);

      const message = await post(`/conversations/${created.body.data.id}/messages`, { role: "guest", content: "Hi" });
      assert.equal(message.status, 201);
    });

    test("unknown routes and invalid JSON keep their responses", async () => {
      assert.deepEqual((await get("/nothing-here")).body, { success: false, message: "Route not found" });
      const badJson = await post(`/conversations/${await newConversation()}/reservations/proposals`, "{not json");
      assert.equal(badJson.status, 400);
      assert.equal(badJson.body.success, false);
    });
  });

  describe("POST /conversations/:id/reservations/proposals", () => {
    test("creates a pending create proposal", async () => {
      const conversationId = await newConversation();
      const response = await post(`/conversations/${conversationId}/reservations/proposals`, reservationRequest({ time: "19:00" }));

      assert.equal(response.status, 201);
      assert.equal(response.body.success, true);
      const proposal = response.body.data;
      assert.equal(proposal.actionType, "create");
      assert.equal(proposal.status, "pending");
      assert.equal(proposal.conversationId, conversationId);
      assert.equal(proposal.expiresAt, "2026-11-10T07:05:00.000Z");
      assert.equal(proposal.payload.guestName, "Hammad Amin");
    });

    test("ignores fields that aren't part of a reservation request", async () => {
      const conversationId = await newConversation();
      const response = await post(
        `/conversations/${conversationId}/reservations/proposals`,
        reservationRequest({ status: "accepted", reservationId: "x", warningCount: 0 }),
      );
      assert.equal(response.status, 201);
      assert.equal(response.body.data.status, "pending");
      for (const field of ["status", "reservationId", "warningCount"]) {
        assert.equal(field in response.body.data.payload, false, field);
      }
    });

    test("rejects malformed bodies with 400", async () => {
      const conversationId = await newConversation();
      const path = `/conversations/${conversationId}/reservations/proposals`;
      const cases = [
        [["not", "an", "object"], "The request body must be a JSON object."],
        [{ ...reservationRequest(), date: undefined }, "date is required."],
        [{ ...reservationRequest(), guestName: null }, "guestName is required."],
        [reservationRequest({ adults: "2" }), "adults must be a number."],
        [reservationRequest({ extras: "cake" }), "extras must be an array."],
        [reservationRequest({ outsideCake: "yes" }), "outsideCake must be a boolean."],
        [reservationRequest({ time: 1900 }), "time must be a string."],
      ];
      for (const [body, message] of cases) {
        const response = await post(path, body);
        assert.equal(response.status, 400, message);
        assert.deepEqual(response.body, { success: false, code: "INVALID_REQUEST", message });
      }
      // No body at all
      const empty = await post(path);
      assert.equal(empty.status, 400);
      assert.equal(await prisma.proposal.count({ where: { conversationId } }), 0);
    });

    test("a missing conversation is 404 and a blocked one 403", async () => {
      const missing = await post("/conversations/missing/reservations/proposals", reservationRequest());
      assert.equal(missing.status, 404);
      assert.equal(missing.body.code, "CONVERSATION_NOT_FOUND");

      const conversationId = await newConversation();
      await blockConversation(conversationId);
      const blocked = await post(`/conversations/${conversationId}/reservations/proposals`, reservationRequest());
      assert.equal(blocked.status, 403);
      assert.equal(blocked.body.code, "CONVERSATION_NOT_ACTIVE");
    });
  });

  describe("POST /conversations/:id/proposals/:proposalId/accept", () => {
    test("accepting a create proposal returns the new reservation", async () => {
      const conversationId = await newConversation();
      const proposal = await post(
        `/conversations/${conversationId}/reservations/proposals`,
        reservationRequest({ date: "2026-11-18", children: 1, extras: [{ extraKey: "candles", quantity: 2 }] }),
      );
      currentTime = minutesAfterNow(1);
      const response = await post(`/conversations/${conversationId}/proposals/${proposal.body.data.id}/accept`);
      currentTime = NOW;

      assert.equal(response.status, 200);
      const { reservation, proposal: accepted } = response.body.data;
      assert.match(reservation.reservationCode, /^RSV-[A-Z0-9]{4}$/);
      assert.equal(reservation.status, "confirmed");
      assert.equal(reservation.guestPhone, "+923001234567");
      assert.equal(reservation.startTime, "2026-11-18T14:00:00.000Z");
      // 2 x 349900 + 174950 + 2 candles
      assert.equal(reservation.estimatedTotalPaisa, 934750);
      assert.deepEqual(reservation.tables, [{ tableNumber: "T7", section: "FAMILY", capacity: 4 }]);
      assert.equal(reservation.extras[0].lineTotalPaisa, 60000);
      assert.equal("id" in reservation, false);
      assert.equal(accepted.status, "accepted");
    });

    test("invalid details are rejected at acceptance with their code", async () => {
      const conversationId = await newConversation();
      // Monday 16 November: accepted as a proposal, refused on acceptance
      const proposal = await post(`/conversations/${conversationId}/reservations/proposals`, reservationRequest({ date: "2026-11-16" }));
      assert.equal(proposal.status, 201);

      const response = await post(`/conversations/${conversationId}/proposals/${proposal.body.data.id}/accept`);
      assert.equal(response.status, 409);
      assert.equal(response.body.code, "RESTAURANT_CLOSED");
      assert.equal(response.body.kind, "validation");
      assert.match(response.body.message, /closed on Mondays/);
      assert.equal(response.body.data.proposal.status, "rejected");

      // Now it's rejected, accepting again is a conflict
      const again = await post(`/conversations/${conversationId}/proposals/${proposal.body.data.id}/accept`);
      assert.equal(again.status, 409);
      assert.equal(again.body.code, "PROPOSAL_NOT_PENDING");
      assert.equal(again.body.data.proposalStatus, "rejected");
    });

    test("unavailable tables are 409 TABLES_UNAVAILABLE", async () => {
      // 15 children need T7 + T8 + T10; the second party can't be seated
      await bookOverHttp({ date: "2026-11-19", adults: 0, children: 15 });
      const conversationId = await newConversation();
      const proposal = await post(
        `/conversations/${conversationId}/reservations/proposals`,
        reservationRequest({ date: "2026-11-19", adults: 0, children: 15 }),
      );
      const response = await post(`/conversations/${conversationId}/proposals/${proposal.body.data.id}/accept`);
      assert.equal(response.status, 409);
      assert.equal(response.body.code, "TABLES_UNAVAILABLE");
      assert.equal(response.body.kind, "availability");
    });

    test("expired, declined and already accepted proposals are 409", async () => {
      const conversationId = await newConversation();
      const path = `/conversations/${conversationId}/reservations/proposals`;

      const expiring = await post(path, reservationRequest({ date: "2026-11-20" }));
      currentTime = minutesAfterNow(5);
      const expired = await post(`/conversations/${conversationId}/proposals/${expiring.body.data.id}/accept`);
      currentTime = NOW;
      assert.equal(expired.status, 409);
      assert.equal(expired.body.code, "PROPOSAL_EXPIRED");
      assert.equal(expired.body.data.proposal.status, "expired");

      const declining = await post(path, reservationRequest({ date: "2026-11-20" }));
      await post(`/conversations/${conversationId}/proposals/${declining.body.data.id}/decline`);
      const declined = await post(`/conversations/${conversationId}/proposals/${declining.body.data.id}/accept`);
      assert.equal(declined.status, 409);
      assert.equal(declined.body.code, "PROPOSAL_NOT_PENDING");
      assert.equal(declined.body.data.proposalStatus, "declined");

      const accepting = await post(path, reservationRequest({ date: "2026-11-20" }));
      assert.equal((await post(`/conversations/${conversationId}/proposals/${accepting.body.data.id}/accept`)).status, 200);
      const twice = await post(`/conversations/${conversationId}/proposals/${accepting.body.data.id}/accept`);
      assert.equal(twice.status, 409);
      assert.equal(twice.body.data.proposalStatus, "accepted");
      assert.equal(await prisma.reservation.count({ where: { conversationId } }), 1);
    });

    test("a missing proposal or another conversation's proposal is 404, a blocked conversation 403", async () => {
      const conversationId = await newConversation();
      const proposal = await post(`/conversations/${conversationId}/reservations/proposals`, reservationRequest());

      assert.equal((await post(`/conversations/${conversationId}/proposals/missing/accept`)).status, 404);
      const other = await newConversation();
      const wrong = await post(`/conversations/${other}/proposals/${proposal.body.data.id}/accept`);
      assert.equal(wrong.status, 404);
      assert.equal(wrong.body.code, "PROPOSAL_NOT_FOUND");

      await blockConversation(conversationId);
      const blocked = await post(`/conversations/${conversationId}/proposals/${proposal.body.data.id}/accept`);
      assert.equal(blocked.status, 403);
      assert.equal(blocked.body.code, "CONVERSATION_NOT_ACTIVE");
    });
  });

  describe("POST /conversations/:id/proposals/:proposalId/decline", () => {
    test("declines a pending proposal", async () => {
      const conversationId = await newConversation();
      const proposal = await post(`/conversations/${conversationId}/reservations/proposals`, reservationRequest());
      const response = await post(`/conversations/${conversationId}/proposals/${proposal.body.data.id}/decline`);
      assert.equal(response.status, 200);
      assert.equal(response.body.data.proposal.status, "declined");
    });

    test("an expired, already declined or missing proposal can't be declined", async () => {
      const conversationId = await newConversation();
      const proposal = await post(`/conversations/${conversationId}/reservations/proposals`, reservationRequest());
      currentTime = minutesAfterNow(10);
      const expired = await post(`/conversations/${conversationId}/proposals/${proposal.body.data.id}/decline`);
      currentTime = NOW;
      assert.equal(expired.status, 409);
      assert.equal(expired.body.code, "PROPOSAL_EXPIRED");

      const again = await post(`/conversations/${conversationId}/proposals/${proposal.body.data.id}/decline`);
      assert.equal(again.status, 409);
      assert.equal(again.body.data.proposalStatus, "expired");

      assert.equal((await post(`/conversations/${conversationId}/proposals/missing/decline`)).status, 404);
    });
  });

  describe("GET /reservations/lookup", () => {
    test("returns the reservation for the right code and phone, in either format", async () => {
      const { reservation } = await bookOverHttp({ date: "2026-11-21", specialRequest: "Window seat" });
      for (const guestPhone of ["03001234567", "%2B923001234567"]) {
        const response = await get(`/reservations/lookup?reservationCode=${reservation.reservationCode}&guestPhone=${guestPhone}`);
        assert.equal(response.status, 200);
        assert.equal(response.body.data.reservationCode, reservation.reservationCode);
        assert.equal(response.body.data.specialRequest, "Window seat");
        assert.equal(response.body.data.guestName, "Hammad Amin");
      }
    });

    test("a wrong code or wrong phone give the same 404", async () => {
      const { reservation } = await bookOverHttp({ date: "2026-11-21" });
      const wrongCode = await get("/reservations/lookup?reservationCode=RSV-NONE&guestPhone=03001234567");
      const wrongPhone = await get(`/reservations/lookup?reservationCode=${reservation.reservationCode}&guestPhone=03009999999`);
      const badPhone = await get(`/reservations/lookup?reservationCode=${reservation.reservationCode}&guestPhone=12345`);
      for (const response of [wrongCode, wrongPhone, badPhone]) {
        assert.equal(response.status, 404);
        assert.deepEqual(response.body, {
          success: false,
          code: "RESERVATION_NOT_FOUND",
          message: "We couldn't find a reservation with that reservation code and phone number.",
        });
      }
    });

    test("missing or repeated parameters are 400", async () => {
      for (const query of ["", "?reservationCode=RSV-AAAA", "?guestPhone=03001234567", "?reservationCode=&guestPhone=03001234567", "?reservationCode=A&reservationCode=B&guestPhone=03001234567"]) {
        const response = await get(`/reservations/lookup${query}`);
        assert.equal(response.status, 400, query);
        assert.equal(response.body.code, "INVALID_REQUEST");
      }
    });
  });

  describe("GET /conversations/:id/reservations", () => {
    test("lists the conversation's reservations, and only its own", async () => {
      const { conversationId, reservation } = await bookOverHttp({ date: "2026-11-22" });
      const { reservation: other } = await bookOverHttp({ date: "2026-11-22" });

      const response = await get(`/conversations/${conversationId}/reservations`);
      assert.equal(response.status, 200);
      assert.deepEqual(response.body.data.map((r) => r.reservationCode), [reservation.reservationCode]);
      assert.equal(response.body.data.some((r) => r.reservationCode === other.reservationCode), false);
      assert.equal("guestPhone" in response.body.data[0], false);
    });

    test("parses includeCancelled strictly", async () => {
      const conversationId = await newConversation();
      for (const value of ["true", "false"]) {
        assert.equal((await get(`/conversations/${conversationId}/reservations?includeCancelled=${value}`)).status, 200);
      }
      for (const value of ["TRUE", "1", "yes", "", "true&includeCancelled=false"]) {
        const response = await get(`/conversations/${conversationId}/reservations?includeCancelled=${value}`);
        assert.equal(response.status, 400, value);
        assert.equal(response.body.message, "includeCancelled must be true or false.");
      }
    });

    test("a missing conversation is 404", async () => {
      const response = await get("/conversations/missing/reservations");
      assert.equal(response.status, 404);
      assert.equal(response.body.code, "CONVERSATION_NOT_FOUND");
    });
  });

  describe("POST /conversations/:id/reservations/modifications", () => {
    const modification = (reservation, overrides = {}) => ({
      reservationCode: reservation.reservationCode,
      guestPhone: "03001234567",
      date: "2026-11-25",
      mealType: "buffet_lunch",
      adults: 3,
      children: 0,
      ...overrides,
    });

    test("creates a modify proposal that changes the reservation when accepted", async () => {
      const { reservation } = await bookOverHttp({ date: "2026-11-24" });
      const conversationId = await newConversation();

      const proposal = await post(`/conversations/${conversationId}/reservations/modifications`, modification(reservation));
      assert.equal(proposal.status, 201);
      assert.equal(proposal.body.data.actionType, "modify");
      assert.equal(proposal.body.data.payload.target.startTime, "2026-11-25T07:00:00.000Z");

      const accepted = await post(`/conversations/${conversationId}/proposals/${proposal.body.data.id}/accept`);
      assert.equal(accepted.status, 200);
      assert.equal(accepted.body.data.reservation.reservationCode, reservation.reservationCode);
      assert.equal(accepted.body.data.reservation.mealType, "buffet_lunch");
      assert.equal(accepted.body.data.reservation.adults, 3);
      assert.equal(accepted.body.data.reservation.estimatedTotalPaisa, 3 * 249900);
    });

    test("invalid details are 400 and unavailable tables 409, with their codes", async () => {
      const { reservation } = await bookOverHttp({ date: "2026-11-24", children: 1 });
      const conversationId = await newConversation();
      const path = `/conversations/${conversationId}/reservations/modifications`;

      const closed = await post(path, modification(reservation, { date: "2026-11-23" }));
      assert.equal(closed.status, 400);
      assert.deepEqual([closed.body.code, closed.body.kind], ["RESTAURANT_CLOSED", "validation"]);

      const tooMany = await post(path, modification(reservation, { adults: 20 }));
      assert.equal(tooMany.status, 400);
      assert.equal(tooMany.body.code, "PARTY_TOO_LARGE");

      // 15 children on the 19th: the FAMILY tables are already taken that night
      const full = await post(path, modification(reservation, { date: "2026-11-19", mealType: "buffet_dinner", adults: 0, children: 15 }));
      assert.equal(full.status, 409);
      assert.deepEqual([full.body.code, full.body.kind], ["TABLES_UNAVAILABLE", "availability"]);
      assert.equal(await prisma.proposal.count({ where: { conversationId } }), 0);
    });

    test("wrong credentials are 404, malformed bodies 400, a blocked conversation 403", async () => {
      const { reservation } = await bookOverHttp({ date: "2026-11-24" });
      const conversationId = await newConversation();
      const path = `/conversations/${conversationId}/reservations/modifications`;

      for (const overrides of [{ reservationCode: "RSV-NONE" }, { guestPhone: "03009999999" }]) {
        const response = await post(path, modification(reservation, overrides));
        assert.equal(response.status, 404);
        assert.equal(response.body.code, "RESERVATION_NOT_FOUND");
      }

      for (const body of [modification(reservation, { adults: "3" }), { ...modification(reservation), reservationCode: undefined }, "[1]"]) {
        const response = await post(path, body);
        assert.equal(response.status, 400);
        assert.equal(response.body.code, "INVALID_REQUEST");
      }

      await blockConversation(conversationId);
      assert.equal((await post(path, modification(reservation))).status, 403);
    });

    test("the cutoff is 409", async () => {
      const { reservation } = await bookOverHttp({ date: "2026-11-24" });
      const conversationId = await newConversation();
      // 2 hours before dinner on the 24th
      currentTime = new Date("2026-11-24T12:00:00Z");
      const response = await post(`/conversations/${conversationId}/reservations/modifications`, modification(reservation));
      currentTime = NOW;
      assert.equal(response.status, 409);
      assert.equal(response.body.code, "MODIFICATION_CUTOFF_PASSED");
    });
  });

  describe("POST /conversations/:id/reservations/cancellations", () => {
    test("creates a cancel proposal that cancels the reservation when accepted", async () => {
      const { conversationId: bookingConversation, reservation } = await bookOverHttp({ date: "2026-11-26" });
      const conversationId = await newConversation();
      const body = { reservationCode: reservation.reservationCode, guestPhone: "+923001234567" };

      const proposal = await post(`/conversations/${conversationId}/reservations/cancellations`, body);
      assert.equal(proposal.status, 201);
      assert.equal(proposal.body.data.actionType, "cancel");
      assert.equal(proposal.body.data.payload.reservationCode, reservation.reservationCode);

      const accepted = await post(`/conversations/${conversationId}/proposals/${proposal.body.data.id}/accept`);
      assert.equal(accepted.status, 200);
      assert.equal(accepted.body.data.reservation.status, "cancelled");
      assert.equal(accepted.body.data.reservation.cancelledAt, NOW.toISOString());

      // Seen through the other endpoints
      const lookup = await get(`/reservations/lookup?reservationCode=${reservation.reservationCode}&guestPhone=03001234567`);
      assert.equal(lookup.body.data.status, "cancelled");
      assert.deepEqual((await get(`/conversations/${bookingConversation}/reservations`)).body.data, []);
      const withCancelled = await get(`/conversations/${bookingConversation}/reservations?includeCancelled=true`);
      assert.equal(withCancelled.body.data[0].status, "cancelled");

      // Cancelling again is a conflict
      const again = await post(`/conversations/${conversationId}/reservations/cancellations`, body);
      assert.equal(again.status, 409);
      assert.equal(again.body.code, "RESERVATION_NOT_CANCELLABLE");
    });

    test("wrong credentials are 404, malformed bodies 400, the cutoff 409", async () => {
      const { reservation } = await bookOverHttp({ date: "2026-11-27" });
      const conversationId = await newConversation();
      const path = `/conversations/${conversationId}/reservations/cancellations`;

      const wrong = await post(path, { reservationCode: reservation.reservationCode, guestPhone: "03009999999" });
      assert.equal(wrong.status, 404);
      assert.equal(wrong.body.code, "RESERVATION_NOT_FOUND");

      for (const body of [{ reservationCode: reservation.reservationCode }, { reservationCode: 5, guestPhone: "03001234567" }, "[]"]) {
        assert.equal((await post(path, body)).status, 400);
      }

      currentTime = new Date("2026-11-27T12:00:00Z");
      const late = await post(path, { reservationCode: reservation.reservationCode, guestPhone: "03001234567" });
      currentTime = NOW;
      assert.equal(late.status, 409);
      assert.deepEqual(late.body, {
        success: false,
        code: "CANCELLATION_CUTOFF_PASSED",
        message: "Reservations can only be cancelled up to 3 hours before they start.",
        kind: "validation",
      });
    });

    test("a missing conversation is 404 and a blocked one 403", async () => {
      const { reservation } = await bookOverHttp({ date: "2026-11-27" });
      const body = { reservationCode: reservation.reservationCode, guestPhone: "03001234567" };
      assert.equal((await post("/conversations/missing/reservations/cancellations", body)).status, 404);
      const conversationId = await newConversation();
      await blockConversation(conversationId);
      assert.equal((await post(`/conversations/${conversationId}/reservations/cancellations`, body)).status, 403);
    });
  });

  test("unexpected errors are 500 with no internal details", async () => {
    const conversationId = await newConversation();
    const originalTransaction = prisma.$transaction;
    const originalConsoleError = console.error;
    prisma.$transaction = async () => {
      throw new Error("SQLITE_IOERR: secret internal detail at /var/db/file");
    };
    console.error = () => {};
    try {
      const response = await post(`/conversations/${conversationId}/reservations/proposals`, reservationRequest());
      assert.equal(response.status, 500);
      assert.deepEqual(response.body, { success: false, message: "Internal server error" });
    } finally {
      prisma.$transaction = originalTransaction;
      console.error = originalConsoleError;
    }
  });

  test("a proposal made by the service directly can be accepted over HTTP", async () => {
    // The routes and the services share one Prisma client and database
    const conversationId = await newConversation();
    const proposal = await createReservationProposal({ conversationId, payload: reservationRequest({ date: "2026-11-28" }), now: NOW });
    const response = await post(`/conversations/${conversationId}/proposals/${proposal.id}/accept`);
    assert.equal(response.status, 200);
  });
});
