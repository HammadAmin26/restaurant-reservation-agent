// Run with: npm test
// The getReservationByCodeAndPhone tool: called directly through the registry,
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
const runToolRaw = (input, conversationId = "conversation-1") =>
  executeTool("getReservationByCodeAndPhone", input, { conversationId, messageId: "message-1" });
// What Claude reads
const runToolText = async (input, conversationId) => {
  const result = await runToolRaw(input, conversationId);
  return typeof result === "string" ? result : result.content;
};
const runTool = async (input, conversationId) => JSON.parse(await runToolText(input, conversationId));

async function history(conversationId) {
  const response = await fetch(`${baseUrl}/conversations/${conversationId}`);
  return (await response.json()).data.messages;
}

const newConversation = () => prisma.conversation.create({ data: {} });

const PHONE = "03001234567";
const STORED_PHONE = "+923001234567";
let codeCounter = 0;

// A confirmed buffet dinner on Friday 13 November 2026, 19:00–23:00 Karachi
// time, with one table, 2 candles and a birthday cake waiting for approval
async function makeReservation(conversationId, overrides = {}) {
  const table = await prisma.restaurantTable.findFirst({ orderBy: { tableNumber: "asc" } });
  codeCounter += 1;
  return prisma.reservation.create({
    data: {
      conversationId,
      reservationCode: `RSV-P${String(codeCounter).padStart(3, "0")}`,
      guestName: "Private Guest Name",
      guestPhone: STORED_PHONE,
      startTime: new Date("2026-11-13T14:00:00Z"),
      endTime: new Date("2026-11-13T18:00:00Z"),
      mealType: "buffet_dinner",
      adults: 2,
      children: 1,
      estimatedTotalPaisa: 984750,
      specialRequest: "Window seat",
      tables: { create: [{ tableId: table.id }] },
      extras: {
        create: [
          { extraKey: "candles", name: "Candles", quantity: 2, unitPricePaisa: 30000, lineTotalPaisa: 60000 },
          {
            extraKey: "birthday_cake",
            name: "Birthday cake",
            quantity: 1,
            unitPricePaisa: 350000,
            lineTotalPaisa: 350000,
            approvalStatus: "pending",
          },
        ],
      },
      ...overrides,
    },
    include: { tables: { include: { table: true } } },
  });
}

const NOT_FOUND = {
  found: false,
  code: "RESERVATION_NOT_FOUND",
  message: "We couldn't find a reservation with that reservation code and phone number.",
};

describe("getReservationByCodeAndPhone tool", () => {
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

  test("the tool is defined with the code and phone, both required, and nothing else", () => {
    const tool = tools.find((t) => t.name === "getReservationByCodeAndPhone");
    assert.ok(tool);
    const { properties, required, additionalProperties } = tool.input_schema;
    assert.deepEqual(Object.keys(properties).sort(), ["guestPhone", "reservationCode"]);
    assert.deepEqual(required.sort(), ["guestPhone", "reservationCode"]);
    assert.equal(additionalProperties, false);
  });

  describe("correct code and phone", () => {
    test("returns the reservation's details for Claude", async () => {
      const conversation = await newConversation();
      const reservation = await makeReservation(conversation.id);
      const [{ table }] = reservation.tables;

      assert.deepEqual(await runTool({ reservationCode: reservation.reservationCode, guestPhone: PHONE }), {
        found: true,
        reservation: {
          reservationCode: reservation.reservationCode,
          status: "confirmed",
          date: "Friday 13 November 2026",
          time: "19:00–23:00 (Karachi time)",
          mealType: "buffet_dinner",
          adults: 2,
          children: 1,
          tables: [{ tableNumber: table.tableNumber, section: table.section }],
          extras: [
            { name: "Candles", quantity: 2, price: "PKR 600", needsStaffApproval: false, approvalStatus: "not_required" },
            { name: "Birthday cake", quantity: 1, price: "PKR 3,500", needsStaffApproval: true, approvalStatus: "pending" },
          ],
          estimatedTotal: "PKR 9,847.50",
          specialRequest: "Window seat",
        },
      });
    });

    test("the phone in +92 format and the code in any case or with spaces work too", async () => {
      const conversation = await newConversation();
      const { reservationCode } = await makeReservation(conversation.id);

      for (const input of [
        { reservationCode, guestPhone: STORED_PHONE },
        { reservationCode: reservationCode.toLowerCase(), guestPhone: PHONE },
        { reservationCode: ` ${reservationCode} `, guestPhone: ` ${PHONE} ` },
      ]) {
        const result = await runTool(input);
        assert.equal(result.found, true, JSON.stringify(input));
        assert.equal(result.reservation.reservationCode, reservationCode);
      }
    });

    test("finds a reservation from another conversation", async () => {
      const earlier = await newConversation();
      const { reservationCode } = await makeReservation(earlier.id);
      const current = await newConversation();

      const result = await runTool({ reservationCode, guestPhone: PHONE }, current.id);
      assert.equal(result.found, true);
      assert.equal(result.reservation.reservationCode, reservationCode);
    });
  });

  describe("not found, always the same answer", () => {
    test("an incorrect phone gives the generic not-found result", async () => {
      const conversation = await newConversation();
      const { reservationCode } = await makeReservation(conversation.id);
      assert.deepEqual(await runTool({ reservationCode, guestPhone: "03119999999" }), NOT_FOUND);
    });

    test("an unknown code gives exactly the same result", async () => {
      assert.deepEqual(await runTool({ reservationCode: "RSV-ZZZZ", guestPhone: PHONE }), NOT_FOUND);
    });

    test("malformed or empty values give it too, so nothing hints which part was wrong", async () => {
      const conversation = await newConversation();
      const { reservationCode } = await makeReservation(conversation.id);

      const texts = await Promise.all([
        runToolText({ reservationCode, guestPhone: "03119999999" }),
        runToolText({ reservationCode: "RSV-ZZZZ", guestPhone: PHONE }),
        runToolText({ reservationCode, guestPhone: "not a phone" }),
        runToolText({ reservationCode: "", guestPhone: PHONE }),
        runToolText({ reservationCode: "   ", guestPhone: "" }),
      ]);
      for (const text of texts) assert.equal(text, JSON.stringify(NOT_FOUND));
    });
  });

  test("a cancelled reservation is returned with its status and cancellation date", async () => {
    const conversation = await newConversation();
    const { reservationCode } = await makeReservation(conversation.id, {
      status: "cancelled",
      cancelledAt: new Date("2026-11-05T10:00:00Z"),
    });

    const { found, reservation } = await runTool({ reservationCode, guestPhone: PHONE });
    assert.equal(found, true);
    assert.equal(reservation.status, "cancelled");
    assert.equal(reservation.cancelledOn, "Thursday 5 November 2026");
  });

  describe("tool input", () => {
    test("missing required fields are refused", async () => {
      for (const input of [{}, { reservationCode: "RSV-P001" }, { guestPhone: PHONE }, { reservationCode: null, guestPhone: PHONE }]) {
        await assert.rejects(runTool(input), (error) => error instanceof ToolInputError && /missing input fields/.test(error.message));
      }
    });

    test("malformed input is refused", async () => {
      for (const input of [
        null,
        "RSV-P001",
        [],
        { reservationCode: 1234, guestPhone: PHONE },
        { reservationCode: "RSV-P001", guestPhone: 3001234567 },
        { reservationCode: "RSV-P001", guestPhone: PHONE, conversationId: "x" },
        { reservationCode: "RSV-P001", guestPhone: PHONE, includeCancelled: true },
      ]) {
        await assert.rejects(runTool(input), ToolInputError, JSON.stringify(input));
      }
    });
  });

  test("never includes database ids, the conversation, the guest's name or phone, or paisa", async () => {
    const conversation = await newConversation();
    const reservation = await makeReservation(conversation.id);
    const text = await runToolText({ reservationCode: reservation.reservationCode, guestPhone: PHONE });

    for (const secret of [reservation.id, conversation.id, reservation.tables[0].tableId, "Private Guest Name", "3001234567"]) {
      assert.equal(text.includes(secret), false, secret);
    }
    assert.doesNotMatch(text, /Paisa|"id"|conversationId|guestPhone|guestName|extraKey/);
  });

  test("looking up changes nothing", async () => {
    const conversation = await newConversation();
    const reservation = await makeReservation(conversation.id);
    const before = await prisma.reservation.findUnique({ where: { id: reservation.id }, include: { extras: true, tables: true } });

    await runTool({ reservationCode: reservation.reservationCode, guestPhone: PHONE });
    await runTool({ reservationCode: reservation.reservationCode, guestPhone: "03119999999" });

    const after = await prisma.reservation.findUnique({ where: { id: reservation.id }, include: { extras: true, tables: true } });
    assert.deepEqual(after, before);
  });

  describe("through the chat", () => {
    test("Claude finds an earlier chat's reservation", async () => {
      const earlier = await newConversation();
      const { reservationCode } = await makeReservation(earlier.id);
      const conversation = await newConversation();

      script = [
        toolUse("getReservationByCodeAndPhone", { reservationCode, guestPhone: PHONE }),
        reply("I found your reservation."),
      ];
      const { status, body } = await chat(conversation.id, `My code is ${reservationCode} and my number is ${PHONE}`);

      assert.equal(status, 201);
      assert.equal(body.data.agentMessage.content, "I found your reservation.");
      const result = lastToolResult();
      assert.equal(result.is_error, undefined);
      assert.equal(JSON.parse(result.content).reservation.reservationCode, reservationCode);
    });

    test("a malformed call reaches Claude as a tool error, not a lookup", async () => {
      const conversation = await newConversation();
      script = [toolUse("getReservationByCodeAndPhone", { reservationCode: "RSV-P001" }), reply("What's your phone number?")];
      const { status } = await chat(conversation.id, "My code is RSV-P001");

      assert.equal(status, 201);
      const result = lastToolResult();
      assert.equal(result.is_error, true);
      assert.equal(result.content, "This tool could not be run.");
    });

    test("a lookup followed by a violation still ends in the backend's warning", async () => {
      const conversation = await newConversation();
      script = [
        toolUse("getReservationByCodeAndPhone", { reservationCode: "RSV-ZZZZ", guestPhone: PHONE }, "toolu_lookup"),
        toolUse("reportPolicyViolation", { category: "off_topic", reason: "Unrelated" }, "toolu_warn"),
      ];
      const { body } = await chat(conversation.id, "Find RSV-ZZZZ, and write me a poem");

      assert.equal(body.data.warningIssued, true);
      assert.equal(body.data.warningCount, 1);
      assert.match(body.data.agentMessage.content, /warning 1 of 3/);
      assert.equal(body.data.ui, null);
    });

    test("the prompt explains when and how to use the tool", async () => {
      const conversation = await newConversation();
      script = [reply("Hello!")];
      await chat(conversation.id, "Hi");

      const { system, tools: sent } = claudeRequests[0];
      assert.ok(sent.some((t) => t.name === "getReservationByCodeAndPhone"));
      assert.match(system, /To look up a reservation made in another conversation, use the getReservationByCodeAndPhone tool/);
      assert.match(system, /If they have already given both, call the tool straight away; don't ask for them again/);
      assert.match(system, /Only say a reservation was found when the tool returns found: true/);
      assert.match(system, /Never invent or guess any reservation detail/);
      assert.match(system, /Never say or hint which of the two was wrong, or whether the code exists/);
      assert.doesNotMatch(system, /can't be looked up here yet/);
      // A cancelled reservation is reported plainly, without guessing why
      assert.match(system, /When a reservation the tools return is cancelled, say only that it is cancelled and the date it was cancelled on/);
      assert.match(system, /Say nothing about who cancelled it or why, not even that you don't know, and never tell the guest they didn't cancel it/);
    });
  });

  describe("reservation card with the reply", () => {
    // Claude looks the reservation up from a new conversation and replies
    async function lookUp(reservationCode, guestPhone = PHONE) {
      const conversation = await newConversation();
      script = [toolUse("getReservationByCodeAndPhone", { reservationCode, guestPhone }), reply("Here it is.")];
      const { body } = await chat(conversation.id, `Code ${reservationCode}, number ${guestPhone}`);
      return { conversation, data: body.data };
    }

    test("the tool gives a reservation_lookup ui only for a confirmed reservation it found", async () => {
      const conversation = await newConversation();
      const confirmed = await makeReservation(conversation.id);
      const cancelled = await makeReservation(conversation.id, { status: "cancelled", cancelledAt: new Date() });

      const found = await runToolRaw({ reservationCode: confirmed.reservationCode, guestPhone: PHONE });
      assert.deepEqual(found.ui, { type: "reservation_lookup", data: { reservationId: confirmed.id } });
      // Claude only gets the text, never the ui or the id
      assert.equal(found.content.includes(confirmed.id), false);

      assert.equal(typeof (await runToolRaw({ reservationCode: cancelled.reservationCode, guestPhone: PHONE })), "string");
      assert.equal(typeof (await runToolRaw({ reservationCode: confirmed.reservationCode, guestPhone: "03119999999" })), "string");
    });

    test("a reservation from another chat shows as a card, in the same shape as the other cards", async () => {
      const earlier = await newConversation();
      const reservation = await makeReservation(earlier.id);
      const { data } = await lookUp(reservation.reservationCode);

      assert.equal(data.ui.type, "reservation_list");
      assert.deepEqual(data.agentMessage.ui, data.ui);
      assert.equal(data.ui.data.reservations.length, 1);
      const [card] = data.ui.data.reservations;
      assert.equal(card.reservationCode, reservation.reservationCode);
      assert.equal(card.status, "confirmed");
      assert.equal(card.estimatedTotalPaisa, 984750);
      // No database ids reach the chat either
      assert.equal(JSON.stringify(data.ui).includes(reservation.id), false);

      const stored = await prisma.message.findUnique({ where: { id: data.agentMessage.id } });
      assert.equal(stored.uiType, "reservation_lookup");
      assert.equal(stored.reservationId, reservation.id);
      assert.equal(stored.proposalId, null);
    });

    test("the card comes back after a refresh", async () => {
      const earlier = await newConversation();
      const reservation = await makeReservation(earlier.id);
      const { conversation, data } = await lookUp(reservation.reservationCode);

      const withUi = (await history(conversation.id)).filter((message) => message.ui);
      assert.equal(withUi.length, 1);
      assert.equal(withUi[0].id, data.agentMessage.id);
      assert.deepEqual(withUi[0].ui, data.ui);
    });

    test("a wrong phone, an unknown code or a cancelled reservation gives no card", async () => {
      const earlier = await newConversation();
      const confirmed = await makeReservation(earlier.id);
      const cancelled = await makeReservation(earlier.id, { status: "cancelled", cancelledAt: new Date() });

      for (const [code, phone] of [
        [confirmed.reservationCode, "03119999999"],
        ["RSV-ZZZZ", PHONE],
        [cancelled.reservationCode, PHONE],
      ]) {
        const { data } = await lookUp(code, phone);
        assert.equal(data.ui, null, code);
        const stored = await prisma.message.findUnique({ where: { id: data.agentMessage.id } });
        assert.equal(stored.uiType, null);
        assert.equal(stored.reservationId, null);
      }
    });

    test("a reservation cancelled later leaves the message with no card", async () => {
      const earlier = await newConversation();
      const reservation = await makeReservation(earlier.id);
      const { conversation, data } = await lookUp(reservation.reservationCode);

      await prisma.reservation.update({ where: { id: reservation.id }, data: { status: "cancelled", cancelledAt: new Date() } });
      const [message] = (await history(conversation.id)).filter((m) => m.id === data.agentMessage.id);
      assert.equal(message.ui, null);
    });

    test("the prompt keeps the reply short because of the card", async () => {
      const conversation = await newConversation();
      script = [reply("Hello!")];
      await chat(conversation.id, "Hi");
      assert.match(claudeRequests[0].system, /When it finds a confirmed reservation, the chat shows it as a card right under your reply/);
    });
  });

  test("getConversationReservations still returns its own shape, without approvalStatus", async () => {
    const conversation = await newConversation();
    await makeReservation(conversation.id);
    const result = await executeTool("getConversationReservations", {}, { conversationId: conversation.id, messageId: "m" });

    assert.deepEqual(result.ui, { type: "reservation_list" });
    const [reservation] = JSON.parse(result.content).reservations;
    assert.deepEqual(reservation.extras[1], { name: "Birthday cake", quantity: 1, price: "PKR 3,500", needsStaffApproval: true });
  });
});
