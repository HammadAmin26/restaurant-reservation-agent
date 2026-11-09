// Run with: npm test
// The createModificationProposal tool and its card: called directly through the
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
const karachiTime = (day, time) => new Date(`${day}T${time}:00+05:00`);

let api;
// The guest's message always includes PHONE, so the tool accepts it
const chat = (conversationId, content) =>
  api("POST", `/conversations/${conversationId}/chat`, { content: `${content} My mobile number is ${PHONE}.` });
const history = async (conversationId) => (await api("GET", `/conversations/${conversationId}`)).body.data.messages;
const newConversation = () => prisma.conversation.create({ data: {} });

let codeCounter = 0;
// Reservations are spread over days 5 to 28 ahead, inside the 30-day booking
// limit, so a day's tables are always free for them
let dayCounter = 0;

// A confirmed buffet dinner for 2 at 19:00–23:00 Karachi time, on table T1,
// with 2 candles. Returned with its tables and extras.
async function makeReservation(overrides = {}) {
  const conversation = await newConversation();
  const table = await prisma.restaurantTable.findUnique({ where: { tableNumber: "T1" } });
  codeCounter += 1;
  dayCounter += 1;
  const day = karachiDate(5 + (dayCounter % 24));
  const { extras, ...rest } = overrides;
  return prisma.reservation.create({
    data: {
      conversationId: conversation.id,
      reservationCode: `RSV-M${String(codeCounter).padStart(3, "0")}`,
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
        create: extras ?? [{ extraKey: "candles", name: "Candles", quantity: 2, unitPricePaisa: 30000, lineTotalPaisa: 60000 }],
      },
      ...rest,
    },
    include: { tables: { include: { table: true } }, extras: true },
  });
}

// The reservation's day as YYYY-MM-DD in Karachi
const dayOf = (reservation) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(reservation.startTime);

// New details for the reservation: 3 adults on the same day, unless overridden
const changeInput = (reservation, overrides = {}) => ({
  reservationCode: reservation.reservationCode,
  guestPhone: PHONE,
  date: dayOf(reservation),
  mealType: "buffet_dinner",
  adults: 3,
  children: 0,
  ...overrides,
});

// The reservation as stored, for checking it didn't change
const storedReservation = (id) =>
  prisma.reservation.findUnique({ where: { id }, include: { tables: true, extras: true } });

// Claude proposes the change in a new conversation; returns the conversation and the chat data
async function proposeChange(reservation, overrides = {}) {
  const conversation = await newConversation();
  script = [toolUse("createModificationProposal", changeInput(reservation, overrides)), reply("Your change is ready below.")];
  const { body } = await chat(conversation.id, `Please change ${reservation.reservationCode} to 3 adults.`);
  return { conversation, data: body.data };
}

const proposalPath = (conversation, data) =>
  `/conversations/${conversation.id}/proposals/${data.ui.data.proposalId}`;

describe("createModificationProposal tool", () => {
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
    test("the tool takes the code, phone and new details, and no conversation id", () => {
      const tool = tools.find((t) => t.name === "createModificationProposal");
      assert.ok(tool);
      const { properties, required, additionalProperties } = tool.input_schema;
      assert.deepEqual(Object.keys(properties).sort(), [
        "adults",
        "children",
        "childrenUnder3",
        "date",
        "guestPhone",
        "mealType",
        "reservationCode",
        "specialRequest",
        "time",
      ]);
      assert.deepEqual(required.sort(), ["adults", "children", "date", "guestPhone", "mealType", "reservationCode"]);
      assert.equal(additionalProperties, false);
      for (const field of ["conversationId", "reservationId", "status", "messageId"]) {
        assert.equal(field in properties, false, field);
      }
    });

    test("Claude can't send a conversationId, and nothing is created", async () => {
      const reservation = await makeReservation();
      const conversation = await newConversation();
      script = [
        toolUse("createModificationProposal", { ...changeInput(reservation), conversationId: reservation.conversationId }),
        reply("Sorry, something went wrong."),
      ];
      await chat(conversation.id, "Change it");

      assert.equal(lastToolResult().is_error, true);
      assert.equal(await prisma.proposal.count({ where: { reservationId: reservation.id } }), 0);
    });

    test("the proposal goes to the conversation the guest is chatting in, not the reservation's", async () => {
      const reservation = await makeReservation();
      const { conversation } = await proposeChange(reservation);

      const proposals = await prisma.proposal.findMany({ where: { reservationId: reservation.id } });
      assert.equal(proposals.length, 1);
      assert.equal(proposals[0].conversationId, conversation.id);
      assert.notEqual(proposals[0].conversationId, reservation.conversationId);
    });
  });

  describe("missing details", () => {
    test("when Claude asks for details instead, no proposal is made", async () => {
      const reservation = await makeReservation();
      const conversation = await newConversation();
      script = [reply("What would you like to change?")];
      const { body } = await chat(conversation.id, `I want to change ${reservation.reservationCode}.`);

      assert.equal(body.data.ui, null);
      assert.equal(await prisma.proposal.count({ where: { reservationId: reservation.id } }), 0);
    });

    test("a call missing required details or with wrong types is refused and creates nothing", async () => {
      const reservation = await makeReservation();
      const conversation = await newConversation();
      await prisma.message.create({ data: { conversationId: conversation.id, role: "guest", content: PHONE } });
      const context = { conversationId: conversation.id, messageId: "m" };

      const { date, ...withoutDate } = changeInput(reservation);
      assert.ok(date);
      for (const input of [
        withoutDate,
        { reservationCode: reservation.reservationCode, guestPhone: PHONE },
        { ...changeInput(reservation), adults: "3" },
        { ...changeInput(reservation), reservationCode: null },
        null,
        [],
      ]) {
        await assert.rejects(executeTool("createModificationProposal", input, context), ToolInputError, JSON.stringify(input));
      }
      assert.equal(await prisma.proposal.count({ where: { reservationId: reservation.id } }), 0);
    });
  });

  describe("ownership", () => {
    test("a wrong phone or an unknown code gives the same not-found answer and no proposal", async () => {
      const reservation = await makeReservation();
      const results = [];
      for (const input of [
        changeInput(reservation, { guestPhone: OTHER_PHONE }),
        changeInput(reservation, { reservationCode: "RSV-ZZZZ" }),
      ]) {
        const conversation = await newConversation();
        script = [toolUse("createModificationProposal", input), reply("I couldn't find that reservation.")];
        // The guest typed both numbers, so the phone check isn't what refuses it
        await api("POST", `/conversations/${conversation.id}/chat`, {
          content: `My number is ${PHONE}, or maybe ${OTHER_PHONE}.`,
        });
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

    test("a phone number the guest never typed is refused", async () => {
      const reservation = await makeReservation();
      const conversation = await newConversation();
      script = [toolUse("createModificationProposal", changeInput(reservation)), reply("Please confirm your number.")];
      await api("POST", `/conversations/${conversation.id}/chat`, { content: `Change ${reservation.reservationCode}` });

      assert.equal(parsedResult().code, "PHONE_NOT_FROM_GUEST");
      assert.equal(await prisma.proposal.count({ where: { reservationId: reservation.id } }), 0);
    });

    test("a cancelled reservation can't be changed", async () => {
      const reservation = await makeReservation({ status: "cancelled", cancelledAt: new Date() });
      const { data } = await proposeChange(reservation);
      assert.equal(parsedResult().code, "RESERVATION_NOT_MODIFIABLE");
      assert.equal(data.ui, null);
    });

    test("backend validation failures come back to Claude, with no card", async () => {
      const reservation = await makeReservation();
      // 16 guests is more than can book online
      const { data } = await proposeChange(reservation, { adults: 16 });
      assert.equal(parsedResult().created, false);
      assert.equal(data.ui, null);
      assert.equal(await prisma.proposal.count({ where: { reservationId: reservation.id } }), 0);
    });
  });

  describe("successful proposal", () => {
    test("creates a pending modify proposal and leaves the reservation as it is", async () => {
      const reservation = await makeReservation();
      const before = await storedReservation(reservation.id);
      await proposeChange(reservation);

      const [proposal] = await prisma.proposal.findMany({ where: { reservationId: reservation.id } });
      assert.equal(proposal.actionType, "modify");
      assert.equal(proposal.status, "pending");
      assert.deepEqual(await storedReservation(reservation.id), before);
      assert.equal(await prisma.reservation.count({ where: { reservationCode: reservation.reservationCode } }), 1);
    });

    test("tells Claude the current and proposed details, without ids", async () => {
      const reservation = await makeReservation();
      await proposeChange(reservation);

      const content = lastToolResult().content;
      const parsed = JSON.parse(content);
      assert.equal(parsed.created, true);
      assert.equal(parsed.proposal.actionType, "modify");
      assert.equal(parsed.summary.reservationCode, reservation.reservationCode);
      assert.equal(parsed.summary.current.adults, 2);
      assert.equal(parsed.summary.proposed.adults, 3);
      assert.equal(parsed.summary.current.estimatedTotal, "PKR 7,598");
      // 3 x PKR 3,499 plus the candles kept at PKR 600
      assert.equal(parsed.summary.proposed.estimatedTotal, "PKR 11,097");
      assert.match(parsed.summary.nextStep, /Nothing has changed yet/);
      for (const secret of [reservation.id, reservation.conversationId, reservation.tables[0].tableId, "Private Guest Name"]) {
        assert.equal(content.includes(secret), false, secret);
      }
    });
  });

  describe("the card", () => {
    test("shows the current and proposed details, in the reply that announced it", async () => {
      const reservation = await makeReservation();
      const { data } = await proposeChange(reservation);

      assert.equal(data.agentMessage.content, "Your change is ready below.");
      assert.deepEqual(data.agentMessage.ui, data.ui);
      assert.equal(data.ui.type, "modification_proposal");

      const card = data.ui.data;
      assert.equal(card.status, "pending");
      assert.equal(card.reservationCode, reservation.reservationCode);
      assert.ok(new Date(card.expiresAt) > new Date());
      assert.deepEqual(card.current, {
        mealType: "buffet_dinner",
        startTime: reservation.startTime.toISOString(),
        endTime: reservation.endTime.toISOString(),
        adults: 2,
        children: 0,
        estimatedTotalPaisa: 759800,
        tables: [{ tableNumber: "T1", section: "GENERAL", capacity: 2 }],
      });
      assert.equal(card.proposed.adults, 3);
      assert.equal(card.proposed.startTime, reservation.startTime.toISOString());
      assert.equal(card.proposed.estimatedTotalPaisa, 1109700);
      assert.ok(card.proposed.tables.length > 0);
      assert.ok(card.proposed.tables.every((table) => Object.keys(table).sort().join() === "capacity,section,tableNumber"));
      assert.deepEqual(card.extras, [{ name: "Candles", quantity: 2, approvalStatus: "not_required" }]);
      assert.equal("reservation" in card, false);
    });

    test("never carries database ids or the guest's phone", async () => {
      const reservation = await makeReservation();
      const { data } = await proposeChange(reservation);
      const text = JSON.stringify(data.ui);
      for (const secret of [reservation.id, reservation.conversationId, reservation.tables[0].tableId, "+923001234567"]) {
        assert.equal(text.includes(secret), false, secret);
      }
    });

    test("is saved on that exact message, linked to the proposal", async () => {
      const reservation = await makeReservation();
      const { data } = await proposeChange(reservation);

      const stored = await prisma.message.findUnique({ where: { id: data.agentMessage.id } });
      assert.equal(stored.uiType, "modification_proposal");
      assert.equal(stored.proposalId, data.ui.data.proposalId);
      assert.equal(stored.reservationId, null);
    });

    test("comes back unchanged after a refresh, on the same message only", async () => {
      const reservation = await makeReservation();
      const { conversation, data } = await proposeChange(reservation);

      const withUi = (await history(conversation.id)).filter((message) => message.ui);
      assert.equal(withUi.length, 1);
      assert.equal(withUi[0].id, data.agentMessage.id);
      assert.deepEqual(withUi[0].ui, data.ui);
    });
  });

  describe("accepting", () => {
    test("changes the reservation in place, keeps its code, and updates the same card", async () => {
      const reservation = await makeReservation();
      const { conversation, data } = await proposeChange(reservation);

      const accepted = await api("POST", `${proposalPath(conversation, data)}/accept`);
      assert.equal(accepted.status, 200);
      assert.equal(accepted.body.data.reservation.reservationCode, reservation.reservationCode);
      assert.equal(accepted.body.data.reservation.adults, 3);

      const stored = await storedReservation(reservation.id);
      assert.equal(stored.reservationCode, reservation.reservationCode);
      assert.equal(stored.adults, 3);
      assert.equal(stored.estimatedTotalPaisa, 1109700);
      // Extras and special request are kept
      assert.deepEqual(stored.extras.map((e) => e.extraKey), ["candles"]);
      assert.equal(stored.specialRequest, "Window seat");

      // The same card, now accepted, with the changed reservation; the proposed details stay
      const messages = await history(conversation.id);
      const card = messages.find((m) => m.id === data.agentMessage.id).ui.data;
      assert.equal(card.status, "accepted");
      assert.equal(card.reservation.adults, 3);
      assert.equal(card.current.adults, 2);
      assert.equal(messages.filter((m) => m.ui).length, 1);
    });

    test("appends the backend's update message, marked as the backend's for Claude", async () => {
      const reservation = await makeReservation();
      const { conversation, data } = await proposeChange(reservation);
      const accepted = await api("POST", `${proposalPath(conversation, data)}/accept`);

      const { message } = accepted.body.data;
      assert.match(message.content, new RegExp(`^Your reservation ${reservation.reservationCode} has been updated\\.`));
      assert.deepEqual((await history(conversation.id)).at(-1), message);

      script = [reply("Glad to help!")];
      await chat(conversation.id, "Thanks");
      const sent = claudeRequests.at(-1).messages;
      assert.match(sent.at(-2).content, /\[Restaurant system, after the guest answered the proposal card\] Your reservation .* has been updated/);
    });

    test("a second click is refused and adds nothing", async () => {
      const reservation = await makeReservation();
      const { conversation, data } = await proposeChange(reservation);
      await api("POST", `${proposalPath(conversation, data)}/accept`);
      const count = (await history(conversation.id)).length;

      const again = await api("POST", `${proposalPath(conversation, data)}/accept`);
      assert.equal(again.status, 409);
      assert.equal(again.body.code, "PROPOSAL_NOT_PENDING");
      assert.equal((await history(conversation.id)).length, count);
    });
  });

  test("declining updates the same card, leaves the reservation, and appends a reply", async () => {
    const reservation = await makeReservation();
    const before = await storedReservation(reservation.id);
    const { conversation, data } = await proposeChange(reservation);

    const declined = await api("POST", `${proposalPath(conversation, data)}/decline`);
    assert.equal(declined.status, 200);
    assert.match(declined.body.data.message.content, /declined and nothing was changed/);

    const card = (await history(conversation.id)).find((m) => m.id === data.agentMessage.id).ui.data;
    assert.equal(card.status, "declined");
    assert.deepEqual(await storedReservation(reservation.id), before);
  });

  describe("failed acceptance leaves the reservation unchanged", () => {
    test("an expired proposal", async () => {
      const reservation = await makeReservation();
      const before = await storedReservation(reservation.id);
      const { conversation, data } = await proposeChange(reservation);
      await prisma.proposal.update({ where: { id: data.ui.data.proposalId }, data: { expiresAt: new Date(Date.now() - 1000) } });

      const result = await api("POST", `${proposalPath(conversation, data)}/accept`);
      assert.equal(result.status, 409);
      assert.equal(result.body.code, "PROPOSAL_EXPIRED");
      assert.match(result.body.data.message.content, /expired, so nothing was changed/);
      assert.equal((await history(conversation.id)).find((m) => m.id === data.agentMessage.id).ui.data.status, "expired");
      assert.deepEqual(await storedReservation(reservation.id), before);
    });

    test("a stale proposal, after the reservation changed", async () => {
      const reservation = await makeReservation();
      const { conversation, data } = await proposeChange(reservation);
      // Changed some other way after the proposal was made
      await prisma.reservation.update({ where: { id: reservation.id }, data: { children: 1 } });
      const before = await storedReservation(reservation.id);

      const result = await api("POST", `${proposalPath(conversation, data)}/accept`);
      assert.equal(result.status, 409);
      assert.equal(result.body.code, "STALE_MODIFICATION_PROPOSAL");
      assert.equal((await history(conversation.id)).find((m) => m.id === data.agentMessage.id).ui.data.status, "rejected");
      assert.deepEqual(await storedReservation(reservation.id), before);
    });

    test("no free tables any more", async () => {
      const reservation = await makeReservation();
      const before = await storedReservation(reservation.id);
      const { conversation, data } = await proposeChange(reservation);

      await prisma.restaurantTable.updateMany({ data: { isActive: false } });
      try {
        const result = await api("POST", `${proposalPath(conversation, data)}/accept`);
        assert.equal(result.status, 409);
        assert.equal(result.body.code, "TABLES_UNAVAILABLE");
        assert.equal(
          result.body.data.message.content,
          `Sorry, I couldn't complete that proposal, so nothing was changed. ${result.body.message} Would you like to try something different?`,
        );
      } finally {
        await prisma.restaurantTable.updateMany({ data: { isActive: true } });
      }
      assert.equal((await history(conversation.id)).find((m) => m.id === data.agentMessage.id).ui.data.status, "rejected");
      assert.deepEqual(await storedReservation(reservation.id), before);
    });

    test("an extra that needs more notice than the new time allows", async () => {
      // Birthday decorations need 48 hours' notice. The change is proposed a
      // day before the reservation, to lunch on the same day: only 24 hours away.
      const reservation = await makeReservation({
        extras: [
          {
            extraKey: "birthday_decorations",
            name: "Birthday decorations",
            quantity: 1,
            unitPricePaisa: 500000,
            lineTotalPaisa: 500000,
          },
        ],
      });
      const day = dayOf(reservation);
      const now = new Date(karachiTime(day, "12:00").getTime() - 24 * 60 * 60 * 1000);
      const before = await storedReservation(reservation.id);

      const conversation = await newConversation();
      await prisma.message.create({ data: { conversationId: conversation.id, role: "guest", content: PHONE } });
      const created = await executeTool(
        "createModificationProposal",
        changeInput(reservation, { mealType: "buffet_lunch", adults: 2 }),
        { conversationId: conversation.id, messageId: "m", now },
      );
      // Creating the proposal doesn't check the extras; accepting does
      assert.equal(JSON.parse(created.content).created, true);

      const result = await acceptReservationProposal({
        proposalId: created.ui.data.proposalId,
        conversationId: conversation.id,
        now,
      });
      assert.equal(result.outcome, "rejected");
      assert.equal(result.code, "INSUFFICIENT_NOTICE");
      assert.deepEqual(await storedReservation(reservation.id), before);
    });
  });

  describe("changing the special request", () => {
    // Only the note changes; everything else is copied from the reservation
    const noteChange = (reservation, specialRequest) => changeInput(reservation, { adults: 2, specialRequest });

    test("a new note is proposed, shown on the card, and saved only on acceptance", async () => {
      const reservation = await makeReservation();
      const before = await storedReservation(reservation.id);
      const { conversation, data } = await proposeChange(reservation, { adults: 2, specialRequest: "  Please keep the AC low  " });

      // Claude is told the note's change
      const summary = JSON.parse(lastToolResult().content).summary;
      assert.deepEqual(summary.specialRequest, { current: "Window seat", proposed: "Please keep the AC low" });
      assert.equal(summary.extras, "The reservation keeps its extras and code.");

      // The card shows it, and nothing is saved yet
      assert.deepEqual(data.ui.data.specialRequest, { current: "Window seat", proposed: "Please keep the AC low" });
      assert.deepEqual(await storedReservation(reservation.id), before);

      const accepted = await api("POST", `${proposalPath(conversation, data)}/accept`);
      assert.equal(accepted.status, 200);
      assert.equal(accepted.body.data.reservation.specialRequest, "Please keep the AC low");

      const after = await storedReservation(reservation.id);
      assert.equal(after.specialRequest, "Please keep the AC low");
      // The rest of the reservation stays as it was
      assert.equal(after.reservationCode, reservation.reservationCode);
      assert.equal(after.adults, 2);
      assert.equal(after.estimatedTotalPaisa, 759800);
      assert.deepEqual(after.extras, before.extras);
    });

    test("an empty note removes it", async () => {
      const reservation = await makeReservation();
      const { conversation, data } = await proposeChange(reservation, { adults: 2, specialRequest: "" });
      assert.deepEqual(data.ui.data.specialRequest, { current: "Window seat", proposed: null });

      await api("POST", `${proposalPath(conversation, data)}/accept`);
      assert.equal((await storedReservation(reservation.id)).specialRequest, null);
    });

    test("without specialRequest the note is kept and isn't part of the change", async () => {
      const reservation = await makeReservation();
      const { conversation, data } = await proposeChange(reservation);

      assert.equal(data.ui.data.specialRequest, null);
      const proposal = await prisma.proposal.findUnique({ where: { id: data.ui.data.proposalId } });
      assert.equal(proposal.payload.includes("Window seat"), false);
      assert.equal(proposal.payload.includes("specialRequest"), false);

      await api("POST", `${proposalPath(conversation, data)}/accept`);
      assert.equal((await storedReservation(reservation.id)).specialRequest, "Window seat");
    });

    test("a note changed since the proposal makes it stale", async () => {
      const reservation = await makeReservation();
      const { conversation, data } = await proposeChange(reservation, { adults: 2, specialRequest: "AC low" });
      await prisma.reservation.update({ where: { id: reservation.id }, data: { specialRequest: "Near the window" } });

      const result = await api("POST", `${proposalPath(conversation, data)}/accept`);
      assert.equal(result.status, 409);
      assert.equal(result.body.code, "STALE_MODIFICATION_PROPOSAL");
      assert.equal((await storedReservation(reservation.id)).specialRequest, "Near the window");
    });

    test("a note that isn't text is refused", async () => {
      const reservation = await makeReservation();
      const conversation = await newConversation();
      await prisma.message.create({ data: { conversationId: conversation.id, role: "guest", content: PHONE } });
      await assert.rejects(
        executeTool("createModificationProposal", noteChange(reservation, 5), { conversationId: conversation.id, messageId: "m" }),
        ToolInputError,
      );
    });

    test("the modification route takes the note too", async () => {
      const reservation = await makeReservation();
      const conversation = await newConversation();
      const { status, body } = await api("POST", `/conversations/${conversation.id}/reservations/modifications`, noteChange(reservation, "AC low"));

      assert.equal(status, 201);
      assert.deepEqual(body.data.payload.specialRequestChange, { current: "Window seat", proposed: "AC low" });
      assert.equal(body.data.payload.request.specialRequest, "AC low");
    });

    test("the prompt explains the note, and that extras can't be changed in the chat", async () => {
      const conversation = await newConversation();
      script = [reply("Hello!")];
      await chat(conversation.id, "Hi");

      const { system, tools: sent } = claudeRequests[0];
      assert.match(system, /A change can also add, replace, or remove the reservation's special request/);
      assert.match(system, /Extras and bringing their own cake can't be added to or removed from an existing reservation in the chat/);
      const tool = sent.find((t) => t.name === "createModificationProposal");
      assert.equal(tool.input_schema.properties.specialRequest.type, "string");
    });
  });

  describe("existing behaviour", () => {
    test("the prompt explains changes", async () => {
      const conversation = await newConversation();
      script = [reply("Hello!")];
      await chat(conversation.id, "Hi");

      const { system } = claudeRequests[0];
      assert.match(system, /You can propose a change to an existing confirmed reservation with the createModificationProposal tool/);
      assert.match(system, /First look the reservation up with getReservationByCodeAndPhone/);
      assert.match(system, /Copy every detail the guest isn't changing from the lookup result/);
      assert.match(system, /Never say a reservation was changed yourself/);
    });

    test("a proposal followed by a violation ends in the warning, with no card", async () => {
      const reservation = await makeReservation();
      const conversation = await newConversation();
      script = [
        toolUse("createModificationProposal", changeInput(reservation), "toolu_change"),
        toolUse("reportPolicyViolation", { category: "off_topic", reason: "Unrelated" }, "toolu_warn"),
      ];
      const { body } = await chat(conversation.id, "Change it, and solve 17 x 23");

      assert.equal(body.data.warningIssued, true);
      assert.equal(body.data.ui, null);
      const stored = await prisma.message.findUnique({ where: { id: body.data.agentMessage.id } });
      assert.equal(stored.uiType, null);
    });

    test("a new reservation proposal still gets its own card type", async () => {
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
      const { body } = await chat(conversation.id, "Book lunch");
      assert.equal(body.data.ui.type, "reservation_proposal");
    });
  });
});
