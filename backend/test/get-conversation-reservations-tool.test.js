// Run with: npm test
// The getConversationReservations tool: called directly through the registry,
// and through the chat route with a mock Anthropic API whose replies are scripted.
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

async function chat(conversationId, content) {
  const response = await fetch(`${baseUrl}/conversations/${conversationId}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  return { status: response.status, body: await response.json() };
}

// Run the tool as the agent loop does, with the server's trusted context.
// It returns a string, or { content, ui } when it found a confirmed reservation.
const runToolRaw = (conversationId, input = {}) =>
  executeTool("getConversationReservations", input, { conversationId, messageId: "message-1" });
const contentOf = (result) => (typeof result === "string" ? result : result.content);
// What Claude reads, parsed
const runTool = async (conversationId, input) => JSON.parse(contentOf(await runToolRaw(conversationId, input)));

async function history(conversationId) {
  const response = await fetch(`${baseUrl}/conversations/${conversationId}`);
  return (await response.json()).data.messages;
}

const newConversation = () => prisma.conversation.create({ data: {} });

let codeCounter = 0;

// A confirmed buffet dinner on Friday 13 November 2026, 19:00–23:00 Karachi
// time, with one table and 2 candles
async function makeReservation(conversationId, overrides = {}) {
  const table = await prisma.restaurantTable.findFirst({ orderBy: { tableNumber: "asc" } });
  codeCounter += 1;
  return prisma.reservation.create({
    data: {
      conversationId,
      reservationCode: `RSV-T${String(codeCounter).padStart(3, "0")}`,
      guestName: "Hammad Amin",
      guestPhone: "+923001234567",
      startTime: new Date("2026-11-13T14:00:00Z"),
      endTime: new Date("2026-11-13T18:00:00Z"),
      mealType: "buffet_dinner",
      adults: 2,
      children: 1,
      estimatedTotalPaisa: 984750,
      specialRequest: "Window seat",
      tables: { create: [{ tableId: table.id }] },
      extras: {
        create: [{ extraKey: "candles", name: "Candles", quantity: 2, unitPricePaisa: 30000, lineTotalPaisa: 60000 }],
      },
      ...overrides,
    },
    include: { tables: { include: { table: true } } },
  });
}

describe("getConversationReservations tool", () => {
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

  test("the tool is defined with only includeCancelled, and no conversation id", () => {
    const tool = tools.find((t) => t.name === "getConversationReservations");
    assert.ok(tool);
    const { properties, required, additionalProperties } = tool.input_schema;
    assert.deepEqual(Object.keys(properties), ["includeCancelled"]);
    assert.equal(properties.includeCancelled.type, "boolean");
    assert.equal(required, undefined);
    assert.equal(additionalProperties, false);
  });

  describe("successful retrieval", () => {
    test("returns the conversation's reservation with its details for Claude", async () => {
      const conversation = await newConversation();
      const reservation = await makeReservation(conversation.id);
      const [{ table }] = reservation.tables;

      assert.deepEqual(await runTool(conversation.id), {
        found: true,
        reservations: [
          {
            reservationCode: reservation.reservationCode,
            status: "confirmed",
            date: "Friday 13 November 2026",
            time: "19:00–23:00 (Karachi time)",
            mealType: "buffet_dinner",
            adults: 2,
            children: 1,
            tables: [{ tableNumber: table.tableNumber, section: table.section }],
            extras: [{ name: "Candles", quantity: 2, price: "PKR 600", needsStaffApproval: false }],
            estimatedTotal: "PKR 9,847.50",
            specialRequest: "Window seat",
          },
        ],
      });
    });

    test("never includes database ids, the guest's name or phone, or paisa", async () => {
      const conversation = await newConversation();
      const reservation = await makeReservation(conversation.id);
      const text = contentOf(await runToolRaw(conversation.id));

      for (const secret of [reservation.id, conversation.id, reservation.tables[0].tableId, "Hammad Amin", "3001234567"]) {
        assert.equal(text.includes(secret), false, secret);
      }
      assert.doesNotMatch(text, /Paisa|"id"|conversationId|guestPhone|guestName/);
    });

    test("several reservations come earliest first", async () => {
      const conversation = await newConversation();
      const later = await makeReservation(conversation.id, {
        startTime: new Date("2026-11-20T14:00:00Z"),
        endTime: new Date("2026-11-20T18:00:00Z"),
      });
      const earlier = await makeReservation(conversation.id);

      const { reservations } = await runTool(conversation.id);
      assert.deepEqual(
        reservations.map((r) => r.reservationCode),
        [earlier.reservationCode, later.reservationCode],
      );
    });
  });

  describe("empty results", () => {
    test("a conversation with no reservations gets an empty list and a note", async () => {
      const conversation = await newConversation();
      assert.deepEqual(await runTool(conversation.id), {
        found: true,
        reservations: [],
        note: "No confirmed reservations were made in this conversation.",
      });
    });

    test("a pending proposal is not a reservation", async () => {
      const conversation = await newConversation();
      await prisma.proposal.create({
        data: {
          conversationId: conversation.id,
          actionType: "create",
          payload: "{}",
          expiresAt: new Date(Date.now() + 300000),
        },
      });
      assert.deepEqual((await runTool(conversation.id)).reservations, []);
    });
  });

  describe("cancelled reservations", () => {
    test("are left out by default", async () => {
      const conversation = await newConversation();
      const confirmed = await makeReservation(conversation.id);
      await makeReservation(conversation.id, { status: "cancelled", cancelledAt: new Date("2026-11-05T10:00:00Z") });

      const { reservations } = await runTool(conversation.id);
      assert.deepEqual(reservations.map((r) => r.reservationCode), [confirmed.reservationCode]);
    });

    test("are included when includeCancelled is true, with the day they were cancelled", async () => {
      const conversation = await newConversation();
      const cancelled = await makeReservation(conversation.id, {
        status: "cancelled",
        cancelledAt: new Date("2026-11-05T10:00:00Z"),
      });

      const { reservations } = await runTool(conversation.id, { includeCancelled: true });
      assert.equal(reservations.length, 1);
      assert.equal(reservations[0].reservationCode, cancelled.reservationCode);
      assert.equal(reservations[0].status, "cancelled");
      assert.equal(reservations[0].cancelledOn, "Thursday 5 November 2026");
    });

    test("only cancelled ones, without includeCancelled, give the empty note", async () => {
      const conversation = await newConversation();
      await makeReservation(conversation.id, { status: "cancelled", cancelledAt: new Date() });
      const result = await runTool(conversation.id);
      assert.deepEqual(result.reservations, []);
      assert.match(result.note, /No confirmed reservations/);
    });

    test("null includeCancelled means the default", async () => {
      const conversation = await newConversation();
      await makeReservation(conversation.id, { status: "cancelled", cancelledAt: new Date() });
      assert.deepEqual((await runTool(conversation.id, { includeCancelled: null })).reservations, []);
    });
  });

  test("a missing conversation is reported, not thrown", async () => {
    assert.deepEqual(await runTool("no-such-conversation"), {
      found: false,
      code: "CONVERSATION_NOT_FOUND",
      message: "Conversation not found.",
    });
  });

  describe("trusted conversationId", () => {
    test("Claude can't send a conversationId or other fields", async () => {
      const conversation = await newConversation();
      const other = await newConversation();
      await makeReservation(other.id);

      for (const input of [{ conversationId: other.id }, { reservationCode: "RSV-T001" }]) {
        await assert.rejects(runTool(conversation.id, input), ToolInputError);
      }
      await assert.rejects(runTool(conversation.id, { includeCancelled: "yes" }), ToolInputError);
      await assert.rejects(runTool(conversation.id, []), ToolInputError);
    });

    test("through the chat, only the guest's own conversation is searched", async () => {
      const conversation = await newConversation();
      const other = await newConversation();
      const mine = await makeReservation(conversation.id);
      const theirs = await makeReservation(other.id);

      script = [toolUse("getConversationReservations", {}), reply("Here is your reservation.")];
      const { status, body } = await chat(conversation.id, "Do you know about my reservation?");

      assert.equal(status, 201);
      assert.equal(body.data.agentMessage.content, "Here is your reservation.");
      // Only this conversation's reservation is on the card too
      assert.deepEqual(body.data.ui.data.reservations.map((r) => r.reservationCode), [mine.reservationCode]);
      const result = lastToolResult();
      assert.equal(result.is_error, undefined);
      const parsed = JSON.parse(result.content);
      assert.deepEqual(parsed.reservations.map((r) => r.reservationCode), [mine.reservationCode]);
      assert.equal(result.content.includes(theirs.reservationCode), false);
    });

    test("a conversationId sent by Claude through the chat is refused as an error result", async () => {
      const conversation = await newConversation();
      const other = await newConversation();
      const theirs = await makeReservation(other.id);

      script = [toolUse("getConversationReservations", { conversationId: other.id }), reply("Sorry, something went wrong.")];
      await chat(conversation.id, "Show me that reservation");

      const result = lastToolResult();
      assert.equal(result.is_error, true);
      assert.equal(JSON.stringify(result).includes(theirs.reservationCode), false);
    });
  });

  describe("reservation cards with the reply", () => {
    // Claude looks up the reservations and replies
    async function lookUp(conversationId, input = {}) {
      script = [toolUse("getConversationReservations", input), reply("You have a reservation with us.")];
      return (await chat(conversationId, "Do you know about my reservation?")).body.data;
    }

    test("the tool gives a reservation_list ui only when a confirmed reservation was found", async () => {
      const conversation = await newConversation();
      assert.equal(typeof (await runToolRaw(conversation.id)), "string");

      await makeReservation(conversation.id, { status: "cancelled", cancelledAt: new Date() });
      assert.equal(typeof (await runToolRaw(conversation.id, { includeCancelled: true })), "string");

      await makeReservation(conversation.id);
      const result = await runToolRaw(conversation.id);
      assert.deepEqual(result.ui, { type: "reservation_list" });
      assert.equal(JSON.parse(result.content).found, true);
      // Claude only gets the text, never the ui
      assert.doesNotMatch(result.content, /reservation_list/);
    });

    test("the reply carries the confirmed reservations, in the same shape as the accept API", async () => {
      const conversation = await newConversation();
      const reservation = await makeReservation(conversation.id);
      const data = await lookUp(conversation.id);

      assert.equal(data.ui.type, "reservation_list");
      assert.deepEqual(data.agentMessage.ui, data.ui);
      const [card] = data.ui.data.reservations;
      assert.equal(card.reservationCode, reservation.reservationCode);
      assert.equal(card.status, "confirmed");
      assert.equal(card.estimatedTotalPaisa, 984750);
      assert.equal(card.guestName, "Hammad Amin");
      assert.deepEqual(card.extras.map((e) => e.extraKey), ["candles"]);
      assert.equal("id" in card, false);

      const stored = await prisma.message.findUnique({ where: { id: data.agentMessage.id } });
      assert.equal(stored.uiType, "reservation_list");
      assert.equal(stored.proposalId, null);
    });

    test("cancelled reservations are never on the cards, even when Claude asked for them", async () => {
      const conversation = await newConversation();
      const confirmed = await makeReservation(conversation.id);
      await makeReservation(conversation.id, { status: "cancelled", cancelledAt: new Date() });

      const data = await lookUp(conversation.id, { includeCancelled: true });
      assert.deepEqual(data.ui.data.reservations.map((r) => r.reservationCode), [confirmed.reservationCode]);
    });

    test("no confirmed reservation means a plain reply with no card", async () => {
      const conversation = await newConversation();
      await makeReservation(conversation.id, { status: "cancelled", cancelledAt: new Date() });

      const data = await lookUp(conversation.id, { includeCancelled: true });
      assert.equal(data.ui, null);
      const stored = await prisma.message.findUnique({ where: { id: data.agentMessage.id } });
      assert.equal(stored.uiType, null);
    });

    test("the cards come back after a refresh", async () => {
      const conversation = await newConversation();
      await makeReservation(conversation.id);
      const data = await lookUp(conversation.id);

      const messages = await history(conversation.id);
      const withUi = messages.filter((message) => message.ui);
      assert.equal(withUi.length, 1);
      assert.equal(withUi[0].id, data.agentMessage.id);
      assert.deepEqual(withUi[0].ui, data.ui);
    });

    test("a reservation cancelled later leaves the card; with none left, the message has no card", async () => {
      const conversation = await newConversation();
      const first = await makeReservation(conversation.id);
      const second = await makeReservation(conversation.id, {
        startTime: new Date("2026-11-20T14:00:00Z"),
        endTime: new Date("2026-11-20T18:00:00Z"),
      });
      const data = await lookUp(conversation.id);
      assert.equal(data.ui.data.reservations.length, 2);

      await prisma.reservation.update({ where: { id: first.id }, data: { status: "cancelled", cancelledAt: new Date() } });
      let [message] = (await history(conversation.id)).filter((m) => m.id === data.agentMessage.id);
      assert.deepEqual(message.ui.data.reservations.map((r) => r.reservationCode), [second.reservationCode]);

      await prisma.reservation.update({ where: { id: second.id }, data: { status: "cancelled", cancelledAt: new Date() } });
      [message] = (await history(conversation.id)).filter((m) => m.id === data.agentMessage.id);
      assert.equal(message.ui, null);
    });

    test("a reservation made after the reply isn't added to its cards", async () => {
      const conversation = await newConversation();
      const before = await makeReservation(conversation.id);
      const data = await lookUp(conversation.id);
      await makeReservation(conversation.id, { createdAt: new Date(Date.now() + 1000) });

      const [message] = (await history(conversation.id)).filter((m) => m.id === data.agentMessage.id);
      assert.deepEqual(message.ui.data.reservations.map((r) => r.reservationCode), [before.reservationCode]);
    });

    test("the prompt keeps the reply short because of the cards", async () => {
      const conversation = await newConversation();
      script = [reply("Hello!")];
      await chat(conversation.id, "Hi");
      assert.match(claudeRequests[0].system, /shows each one as a card right under your reply, so don't list every detail again/);
    });
  });

  describe("existing behaviour", () => {
    test("the prompt tells Claude to use the tool and not invent details", async () => {
      const conversation = await newConversation();
      script = [reply("Hello!")];
      await chat(conversation.id, "Hi");

      const { system } = claudeRequests[0];
      assert.match(system, /call it instead of saying you can't look reservations up/);
      assert.match(system, /Never invent or guess a reservation code, date, time, table, extra, or price/);
      assert.match(system, /Only call a reservation confirmed when this tool returns it with status confirmed/);
      // Changes and cancellations are proposed with their own tools now
      assert.match(system, /createCancellationProposal tool/);
      assert.doesNotMatch(system, /You cannot (modify or )?cancel reservations yet/);
      assert.doesNotMatch(system, /You cannot look up/);
    });

    test("a lookup followed by a violation still ends in the backend's warning", async () => {
      const conversation = await newConversation();
      script = [
        toolUse("getConversationReservations", {}, "toolu_lookup"),
        toolUse("reportPolicyViolation", { category: "off_topic", reason: "Unrelated" }, "toolu_warn"),
      ];
      const { body } = await chat(conversation.id, "What's my booking, and solve 17 x 23");

      assert.equal(body.data.warningIssued, true);
      assert.equal(body.data.warningCount, 1);
      assert.match(body.data.agentMessage.content, /warning 1 of 3/);
      assert.equal(body.data.ui, null);
    });

    test("looking up changes nothing", async () => {
      const conversation = await newConversation();
      const reservation = await makeReservation(conversation.id);
      const before = await prisma.reservation.findUnique({ where: { id: reservation.id } });
      await runTool(conversation.id);
      await runTool(conversation.id, { includeCancelled: true });
      assert.deepEqual(await prisma.reservation.findUnique({ where: { id: reservation.id } }), before);
    });
  });
});
