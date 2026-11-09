// Run with: npm test
// The createCancellationProposal tool and its card: called directly through the
// registry, and through the chat and proposal routes with a mock Anthropic API
// whose replies are scripted.
const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { useTestDatabase } = require("./support/test-database");

// Must run before the Prisma client is loaded
const removeTestDatabase = useTestDatabase();

const prisma = require("../src/lib/prisma");
const restaurantTables = require("../src/config/restaurant-tables");
const tools = require("../src/agent/tools");
const { executeTool, ToolInputError } = require("../src/tools/registry");
const { acceptReservationProposal } = require("../src/services/proposal.service");

// Scripted Claude responses, used in order, and the requests Claude received
let script = [];
let claudeRequests = [];
let mockServer;
let appServer;
let baseUrl;

const toolUse = (name, input, id = `toolu_${name}`) => ({
  stop_reason: "tool_use",
  content: [{ type: "tool_use", id, name, input }],
});
const reply = (text) => ({ stop_reason: "end_turn", content: [{ type: "text", text }] });

// The first tool result the backend sent back to Claude in its latest request
function lastToolResult() {
  const last = claudeRequests.at(-1).messages.at(-1);
  return last.content.find((block) => block.type === "tool_result");
}
const parsedResult = () => JSON.parse(lastToolResult().content);

// A Karachi YYYY-MM-DD `days` from today that isn't a Monday
function karachiDate(days) {
  for (let d = days; ; d++) {
    const date = new Date(Date.now() + d * 86400000);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Karachi",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "long",
    }).formatToParts(date);
    const part = (type) => parts.find((p) => p.type === type).value;
    if (part("weekday") !== "Monday") return `${part("year")}-${part("month")}-${part("day")}`;
  }
}

const PHONE = "03001234567";
const OTHER_PHONE = "03119999999";
const HOUR = 60 * 60 * 1000;
const karachiTime = (day, time) => new Date(`${day}T${time}:00+05:00`);

let api;
// The guest's message always includes PHONE, so the tool accepts it
const chat = (conversationId, content) =>
  api("POST", `/conversations/${conversationId}/chat`, { content: `${content} My mobile number is ${PHONE}.` });
const history = async (conversationId) => (await api("GET", `/conversations/${conversationId}`)).body.data.messages;
const newConversation = () => prisma.conversation.create({ data: {} });

let codeCounter = 0;
// Reservations are spread over days 5 to 28 ahead, inside the 30-day booking limit
let dayCounter = 0;

// A confirmed buffet dinner for 2 at 19:00–23:00 Karachi time on its own day,
// on table T1, with 2 candles. Returned with its tables and extras.
async function makeReservation(overrides = {}) {
  const conversation = await newConversation();
  const table = await prisma.restaurantTable.findUnique({ where: { tableNumber: "T1" } });
  codeCounter += 1;
  dayCounter += 1;
  const day = karachiDate(5 + (dayCounter % 24));
  return prisma.reservation.create({
    data: {
      conversationId: conversation.id,
      reservationCode: `RSV-C${String(codeCounter).padStart(3, "0")}`,
      guestName: "Private Guest Name",
      guestPhone: "+923001234567",
      startTime: karachiTime(day, "19:00"),
      endTime: karachiTime(day, "23:00"),
      mealType: "buffet_dinner",
      adults: 2,
      children: 0,
      estimatedTotalPaisa: 759800,
      specialRequest: "Window seat",
      tables: { create: [{ tableId: table.id }] },
      extras: {
        create: [{ extraKey: "candles", name: "Candles", quantity: 2, unitPricePaisa: 30000, lineTotalPaisa: 60000 }],
      },
      ...overrides,
    },
    include: { tables: { include: { table: true } }, extras: true },
  });
}

const cancelInput = (reservation, overrides = {}) => ({
  reservationCode: reservation.reservationCode,
  guestPhone: PHONE,
  ...overrides,
});

// The reservation as stored, for checking it didn't change
const storedReservation = (id) =>
  prisma.reservation.findUnique({ where: { id }, include: { tables: true, extras: true } });

// Claude proposes the cancellation in a new conversation
async function proposeCancellation(reservation, overrides = {}) {
  const conversation = await newConversation();
  script = [
    toolUse("createCancellationProposal", cancelInput(reservation, overrides)),
    reply("Your reservation isn't cancelled yet. Please confirm on the card below."),
  ];
  const { body } = await chat(conversation.id, `Please cancel ${reservation.reservationCode}.`);
  return { conversation, data: body.data };
}

const proposalPath = (conversation, data) =>
  `/conversations/${conversation.id}/proposals/${data.ui.data.proposalId}`;
const cardOn = async (conversation, data) =>
  (await history(conversation.id)).find((m) => m.id === data.agentMessage.id).ui;

describe("createCancellationProposal tool", () => {
  before(async () => {
    mockServer = http.createServer((req, res) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        const body = JSON.parse(data);
        claudeRequests.push(body);
        const next = script.shift() ?? reply("(no scripted response)");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: `msg_${claudeRequests.length}`,
            type: "message",
            role: "assistant",
            model: body.model,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
            ...next,
          }),
        );
      });
    });
    await new Promise((resolve) => mockServer.listen(0, resolve));

    process.env.ANTHROPIC_API_KEY = "sk-test-not-a-real-key";
    process.env.ANTHROPIC_MODEL = "claude-haiku-5-5";
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${mockServer.address().port}`;

    await prisma.restaurantTable.createMany({ data: restaurantTables });
    const { createApp } = require("../src/app");
    appServer = createApp().listen(0);
    await new Promise((resolve) => appServer.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${appServer.address().port}`;

    api = async (method, path, body) => {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: body ? { "content-type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, body: await response.json() };
    };
  });

  beforeEach(() => {
    script = [];
    claudeRequests = [];
  });

  after(async () => {
    await new Promise((resolve) => appServer.close(resolve));
    await new Promise((resolve) => mockServer.close(resolve));
    await prisma.$disconnect();
    removeTestDatabase();
  });

  describe("tool schema and trusted context", () => {
    test("the tool takes only the code and phone, both required", () => {
      const tool = tools.find((t) => t.name === "createCancellationProposal");
      assert.ok(tool);
      const { properties, required, additionalProperties } = tool.input_schema;
      assert.deepEqual(Object.keys(properties).sort(), ["guestPhone", "reservationCode"]);
      assert.deepEqual(required.sort(), ["guestPhone", "reservationCode"]);
      assert.equal(additionalProperties, false);
    });

    test("Claude can't send a conversationId, and nothing is created", async () => {
      const reservation = await makeReservation();
      const conversation = await newConversation();
      script = [
        toolUse("createCancellationProposal", { ...cancelInput(reservation), conversationId: reservation.conversationId }),
        reply("Sorry, something went wrong."),
      ];
      await chat(conversation.id, "Cancel it");

      assert.equal(lastToolResult().is_error, true);
      assert.equal(await prisma.proposal.count({ where: { reservationId: reservation.id } }), 0);
    });

    test("the proposal goes to the conversation the guest is chatting in", async () => {
      const reservation = await makeReservation();
      const { conversation } = await proposeCancellation(reservation);

      const [proposal] = await prisma.proposal.findMany({ where: { reservationId: reservation.id } });
      assert.equal(proposal.conversationId, conversation.id);
      assert.notEqual(proposal.conversationId, reservation.conversationId);
    });
  });

  describe("fields and ownership", () => {
    test("missing or malformed fields are refused and create nothing", async () => {
      const reservation = await makeReservation();
      const conversation = await newConversation();
      await prisma.message.create({ data: { conversationId: conversation.id, role: "guest", content: PHONE } });
      const context = { conversationId: conversation.id, messageId: "m" };

      for (const input of [
        {},
        { reservationCode: reservation.reservationCode },
        { guestPhone: PHONE },
        { reservationCode: null, guestPhone: PHONE },
        { reservationCode: 1234, guestPhone: PHONE },
        { ...cancelInput(reservation), reason: "Plans changed" },
        null,
        "RSV-C001",
        [],
      ]) {
        await assert.rejects(executeTool("createCancellationProposal", input, context), ToolInputError, JSON.stringify(input));
      }
      assert.equal(await prisma.proposal.count({ where: { reservationId: reservation.id } }), 0);
    });

    test("a wrong phone or an unknown code gives the same not-found answer", async () => {
      const reservation = await makeReservation();
      const results = [];
      for (const input of [cancelInput(reservation, { guestPhone: OTHER_PHONE }), cancelInput(reservation, { reservationCode: "RSV-ZZZZ" })]) {
        const conversation = await newConversation();
        script = [toolUse("createCancellationProposal", input), reply("I couldn't find that reservation.")];
        // The guest typed both numbers, so the phone check isn't what refuses it
        await api("POST", `/conversations/${conversation.id}/chat`, { content: `My number is ${PHONE}, or maybe ${OTHER_PHONE}.` });
        results.push(lastToolResult().content);
      }

      assert.equal(results[0], results[1]);
      assert.deepEqual(JSON.parse(results[0]), {
        created: false,
        code: "RESERVATION_NOT_FOUND",
        message: "We couldn't find a reservation with that reservation code and phone number.",
      });
      assert.equal(await prisma.proposal.count({ where: { reservationId: reservation.id } }), 0);
    });

    test("the phone must be one the guest typed in this conversation", async () => {
      const reservation = await makeReservation();
      const conversation = await newConversation();
      script = [toolUse("createCancellationProposal", cancelInput(reservation)), reply("Please confirm your number.")];
      await api("POST", `/conversations/${conversation.id}/chat`, { content: `Cancel ${reservation.reservationCode}` });

      assert.equal(parsedResult().code, "PHONE_NOT_FROM_GUEST");
      assert.equal(await prisma.proposal.count({ where: { reservationId: reservation.id } }), 0);
    });

    test("an already cancelled reservation can't be cancelled again", async () => {
      const reservation = await makeReservation({ status: "cancelled", cancelledAt: new Date() });
      const { data } = await proposeCancellation(reservation);
      assert.equal(parsedResult().code, "RESERVATION_NOT_CANCELLABLE");
      assert.equal(data.ui, null);
    });
  });

  describe("cutoff", () => {
    test("less than 3 hours before the start, no proposal is made", async () => {
      const start = new Date(Date.now() + 2 * HOUR);
      const reservation = await makeReservation({ startTime: start, endTime: new Date(start.getTime() + 2 * HOUR) });
      const before = await storedReservation(reservation.id);
      const { data } = await proposeCancellation(reservation);

      assert.deepEqual(parsedResult(), {
        created: false,
        code: "CANCELLATION_CUTOFF_PASSED",
        message: "Reservations can only be cancelled up to 3 hours before they start.",
      });
      assert.equal(data.ui, null);
      assert.equal(await prisma.proposal.count({ where: { reservationId: reservation.id } }), 0);
      assert.deepEqual(await storedReservation(reservation.id), before);
    });

    test("is checked again on acceptance", async () => {
      const reservation = await makeReservation();
      const before = await storedReservation(reservation.id);
      const conversation = await newConversation();
      await prisma.message.create({ data: { conversationId: conversation.id, role: "guest", content: PHONE } });

      // Proposed 1 minute before the cutoff, accepted 1 minute after it
      const proposedAt = new Date(reservation.startTime.getTime() - 3 * HOUR - 60000);
      const created = await executeTool("createCancellationProposal", cancelInput(reservation), {
        conversationId: conversation.id,
        messageId: "m",
        now: proposedAt,
      });
      assert.equal(JSON.parse(created.content).created, true);

      const result = await acceptReservationProposal({
        proposalId: created.ui.data.proposalId,
        conversationId: conversation.id,
        now: new Date(proposedAt.getTime() + 2 * 60000),
      });
      assert.equal(result.outcome, "rejected");
      assert.equal(result.code, "CANCELLATION_CUTOFF_PASSED");
      assert.deepEqual(await storedReservation(reservation.id), before);
    });
  });

  describe("successful proposal", () => {
    test("creates a pending cancel proposal and leaves the reservation confirmed", async () => {
      const reservation = await makeReservation();
      const before = await storedReservation(reservation.id);
      await proposeCancellation(reservation);

      const [proposal] = await prisma.proposal.findMany({ where: { reservationId: reservation.id } });
      assert.equal(proposal.actionType, "cancel");
      assert.equal(proposal.status, "pending");
      assert.deepEqual(await storedReservation(reservation.id), before);
      assert.equal(before.status, "confirmed");
    });

    test("tells Claude the reservation's details and that it isn't cancelled, without ids", async () => {
      const reservation = await makeReservation();
      await proposeCancellation(reservation);

      const content = lastToolResult().content;
      const parsed = JSON.parse(content);
      assert.equal(parsed.created, true);
      assert.equal(parsed.proposal.actionType, "cancel");
      assert.equal(parsed.summary.reservationCode, reservation.reservationCode);
      assert.equal(parsed.summary.reservation.adults, 2);
      assert.equal(parsed.summary.reservation.estimatedTotal, "PKR 7,598");
      assert.match(parsed.summary.reservation.when, /19:00–23:00 \(Karachi time\)/);
      assert.match(parsed.summary.nextStep, /not cancelled/);
      for (const secret of [reservation.id, reservation.conversationId, reservation.tables[0].tableId, "Private Guest Name", "3001234567"]) {
        assert.equal(content.includes(secret), false, secret);
      }
    });
  });

  describe("the card", () => {
    test("shows the reservation and its status, in the reply that announced it", async () => {
      const reservation = await makeReservation();
      const { data } = await proposeCancellation(reservation);

      assert.equal(data.agentMessage.content, "Your reservation isn't cancelled yet. Please confirm on the card below.");
      assert.deepEqual(data.agentMessage.ui, data.ui);
      assert.equal(data.ui.type, "cancellation_proposal");

      const card = data.ui.data;
      assert.deepEqual(Object.keys(card).sort(), ["expiresAt", "proposalId", "reservation", "reservationCode", "status"]);
      assert.equal(card.status, "pending");
      assert.equal(card.reservationCode, reservation.reservationCode);
      assert.ok(new Date(card.expiresAt) > new Date());
      assert.deepEqual(card.reservation, {
        status: "confirmed",
        mealType: "buffet_dinner",
        startTime: reservation.startTime.toISOString(),
        endTime: reservation.endTime.toISOString(),
        adults: 2,
        children: 0,
        estimatedTotalPaisa: 759800,
        tables: [{ tableNumber: "T1", section: "GENERAL", capacity: 2 }],
      });
    });

    test("never carries database ids or the guest's phone", async () => {
      const reservation = await makeReservation();
      const { data } = await proposeCancellation(reservation);
      const text = JSON.stringify(data.ui);
      for (const secret of [reservation.id, reservation.conversationId, reservation.tables[0].tableId, "+923001234567", PHONE]) {
        assert.equal(text.includes(secret), false, secret);
      }
    });

    test("is saved on that exact message, linked to the proposal, and comes back after a refresh", async () => {
      const reservation = await makeReservation();
      const { conversation, data } = await proposeCancellation(reservation);

      const stored = await prisma.message.findUnique({ where: { id: data.agentMessage.id } });
      assert.equal(stored.uiType, "cancellation_proposal");
      assert.equal(stored.proposalId, data.ui.data.proposalId);
      assert.equal(stored.reservationId, null);

      const withUi = (await history(conversation.id)).filter((message) => message.ui);
      assert.equal(withUi.length, 1);
      assert.equal(withUi[0].id, data.agentMessage.id);
      assert.deepEqual(withUi[0].ui, data.ui);
    });
  });

  describe("accepting", () => {
    test("cancels the reservation and keeps the rest of its record", async () => {
      const reservation = await makeReservation();
      const before = await storedReservation(reservation.id);
      const { conversation, data } = await proposeCancellation(reservation);

      const accepted = await api("POST", `${proposalPath(conversation, data)}/accept`);
      assert.equal(accepted.status, 200);
      assert.equal(accepted.body.data.reservation.status, "cancelled");

      const after = await storedReservation(reservation.id);
      assert.equal(after.status, "cancelled");
      assert.ok(after.cancelledAt instanceof Date);
      // Everything else is preserved: code, guest, time, party, total, tables, extras
      const { status: _s1, cancelledAt: _c1, updatedAt: _u1, ...keptBefore } = before;
      const { status: _s2, cancelledAt: _c2, updatedAt: _u2, ...keptAfter } = after;
      assert.deepEqual(keptAfter, keptBefore);
    });

    test("updates the same card and appends the backend's cancellation message", async () => {
      const reservation = await makeReservation();
      const { conversation, data } = await proposeCancellation(reservation);
      const accepted = await api("POST", `${proposalPath(conversation, data)}/accept`);

      const { message } = accepted.body.data;
      assert.equal(message.content, `Your reservation ${reservation.reservationCode} has been cancelled.`);

      const messages = await history(conversation.id);
      assert.deepEqual(messages.at(-1), message);
      const card = messages.find((m) => m.id === data.agentMessage.id).ui.data;
      assert.equal(card.status, "accepted");
      assert.equal(card.reservation.status, "cancelled");
      assert.equal(messages.filter((m) => m.ui).length, 1);

      // Claude sees the confirmation marked as the backend's
      script = [reply("You're welcome.")];
      await chat(conversation.id, "Thanks");
      assert.match(
        claudeRequests.at(-1).messages.at(-2).content,
        /\[Restaurant system, after the guest answered the proposal card\] Your reservation .* has been cancelled\./,
      );
    });

    test("a second click is refused and adds nothing", async () => {
      const reservation = await makeReservation();
      const { conversation, data } = await proposeCancellation(reservation);
      await api("POST", `${proposalPath(conversation, data)}/accept`);
      const count = (await history(conversation.id)).length;

      for (const action of ["accept", "decline"]) {
        const again = await api("POST", `${proposalPath(conversation, data)}/${action}`);
        assert.equal(again.status, 409, action);
        assert.equal(again.body.code, "PROPOSAL_NOT_PENDING");
      }
      assert.equal((await history(conversation.id)).length, count);
    });
  });

  test("declining keeps the reservation, updates the same card and appends a reply", async () => {
    const reservation = await makeReservation();
    const before = await storedReservation(reservation.id);
    const { conversation, data } = await proposeCancellation(reservation);

    const declined = await api("POST", `${proposalPath(conversation, data)}/decline`);
    assert.equal(declined.status, 200);
    assert.match(declined.body.data.message.content, /declined and nothing was changed/);

    const card = (await cardOn(conversation, data)).data;
    assert.equal(card.status, "declined");
    assert.equal(card.reservation.status, "confirmed");
    assert.deepEqual(await storedReservation(reservation.id), before);
  });

  describe("failed acceptance keeps the reservation", () => {
    test("an expired proposal", async () => {
      const reservation = await makeReservation();
      const before = await storedReservation(reservation.id);
      const { conversation, data } = await proposeCancellation(reservation);
      await prisma.proposal.update({ where: { id: data.ui.data.proposalId }, data: { expiresAt: new Date(Date.now() - 1000) } });

      const result = await api("POST", `${proposalPath(conversation, data)}/accept`);
      assert.equal(result.status, 409);
      assert.equal(result.body.code, "PROPOSAL_EXPIRED");
      assert.match(result.body.data.message.content, /expired, so nothing was changed/);
      assert.equal((await cardOn(conversation, data)).data.status, "expired");
      assert.deepEqual(await storedReservation(reservation.id), before);
    });

    test("a stale proposal, after the reservation changed", async () => {
      const reservation = await makeReservation();
      const { conversation, data } = await proposeCancellation(reservation);
      await prisma.reservation.update({ where: { id: reservation.id }, data: { adults: 3 } });
      const before = await storedReservation(reservation.id);

      const result = await api("POST", `${proposalPath(conversation, data)}/accept`);
      assert.equal(result.status, 409);
      assert.equal(result.body.code, "STALE_CANCELLATION_PROPOSAL");
      assert.match(result.body.data.message.content, /couldn't complete that proposal, so nothing was changed/);
      const card = (await cardOn(conversation, data)).data;
      assert.equal(card.status, "rejected");
      assert.equal(card.reservation.status, "confirmed");
      assert.deepEqual(await storedReservation(reservation.id), before);
    });
  });

  describe("existing behaviour", () => {
    test("the prompt explains cancelling", async () => {
      const conversation = await newConversation();
      script = [reply("Hello!")];
      await chat(conversation.id, "Hi");

      const { system } = claudeRequests[0];
      assert.match(system, /propose the cancellation with the createCancellationProposal tool/);
      assert.match(system, /the reservation stays confirmed until the guest confirms on its card/);
      assert.match(system, /If the tool returns created: false, explain the reason from its message, such as the cutoff having passed/);
      assert.match(system, /"Confirm Cancellation" and "Keep Reservation" buttons/);
      assert.match(system, /Never say a reservation was cancelled yourself/);
      assert.doesNotMatch(system, /You cannot cancel reservations yet/);
    });

    test("a proposal followed by a violation ends in the warning, with no card", async () => {
      const reservation = await makeReservation();
      const conversation = await newConversation();
      script = [
        toolUse("createCancellationProposal", cancelInput(reservation), "toolu_cancel"),
        toolUse("reportPolicyViolation", { category: "off_topic", reason: "Unrelated" }, "toolu_warn"),
      ];
      const { body } = await chat(conversation.id, "Cancel it, and solve 17 x 23");

      assert.equal(body.data.warningIssued, true);
      assert.equal(body.data.ui, null);
    });

    test("new bookings, lookups and changes still get their own cards", async () => {
      const reservation = await makeReservation();
      const conversation = await newConversation();

      script = [
        toolUse("createReservationProposal", {
          guestName: "Guest",
          guestPhone: PHONE,
          date: karachiDate(25),
          mealType: "buffet_lunch",
          adults: 2,
          children: 0,
        }),
        reply("Your proposal is ready."),
      ];
      assert.equal((await chat(conversation.id, "Book lunch")).body.data.ui.type, "reservation_proposal");

      script = [toolUse("getReservationByCodeAndPhone", cancelInput(reservation)), reply("Found it.")];
      assert.equal((await chat(conversation.id, "Find my booking")).body.data.ui.type, "reservation_list");

      script = [
        toolUse("createModificationProposal", {
          ...cancelInput(reservation),
          date: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(reservation.startTime),
          mealType: "buffet_dinner",
          adults: 3,
          children: 0,
        }),
        reply("Your change is ready."),
      ];
      assert.equal((await chat(conversation.id, "Make it 3 adults")).body.data.ui.type, "modification_proposal");
    });
  });
});
