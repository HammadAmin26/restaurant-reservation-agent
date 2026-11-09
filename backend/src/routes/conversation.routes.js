const express = require("express");
const prisma = require("../lib/prisma");
const {
  generateResponse,
  toClaudeMessages,
  ClaudeServiceError,
} = require("../services/claude.service");
const { MESSAGE_UI_INCLUDE, toPublicMessage, toPublicMessages } = require("../services/message-ui.service");

const router = express.Router();

const ALLOWED_ROLES = ["guest", "agent"];

// How many recent messages Claude sees, so long chats don't send unlimited history
const CHAT_HISTORY_LIMIT = 30;

// ui events whose card shows a proposal, saved by linking the message to it
const PROPOSAL_UI_TYPES = ["reservation_proposal", "modification_proposal", "cancellation_proposal"];

// Create a new conversation
router.post("/", async (req, res) => {
  const conversation = await prisma.conversation.create({ data: {} });

  res.status(201).json({
    success: true,
    data: conversation,
  });
});

// Get one conversation with its messages, oldest first. A message that shows a
// component, such as a proposal card or reservation cards, has its ui built
// from the current data.
router.get("/:id", async (req, res) => {
  const conversation = await prisma.conversation.findUnique({
    where: { id: req.params.id },
    include: { messages: { orderBy: { createdAt: "asc" }, include: MESSAGE_UI_INCLUDE } },
  });

  if (!conversation) {
    return res.status(404).json({
      success: false,
      message: "Conversation not found",
    });
  }

  res.json({
    success: true,
    data: { ...conversation, messages: await toPublicMessages(conversation.messages) },
  });
});

// Add a message to an active conversation
router.post("/:id/messages", async (req, res) => {
  // req.body is undefined when the request has no JSON body
  const { role, content } = req.body ?? {};

  if (!ALLOWED_ROLES.includes(role)) {
    return res.status(400).json({
      success: false,
      message: 'role must be "guest" or "agent"',
    });
  }

  if (typeof content !== "string" || content.trim() === "") {
    return res.status(400).json({
      success: false,
      message: "content must be a non-empty string",
    });
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: req.params.id },
  });

  if (!conversation) {
    return res.status(404).json({
      success: false,
      message: "Conversation not found",
    });
  }

  if (conversation.status !== "active") {
    return res.status(409).json({
      success: false,
      message: "Conversation is not active",
    });
  }

  const message = await prisma.message.create({
    data: { conversationId: conversation.id, role, content },
  });

  res.status(201).json({
    success: true,
    data: toPublicMessage(message),
  });
});

// Save a guest message, ask Claude for a reply, and save the reply
router.post("/:id/chat", async (req, res) => {
  const { content } = req.body ?? {};

  if (typeof content !== "string" || content.trim() === "") {
    return res.status(400).json({
      success: false,
      message: "content must be a non-empty string",
    });
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: req.params.id },
  });

  if (!conversation) {
    return res.status(404).json({
      success: false,
      message: "Conversation not found",
    });
  }

  // Checked before anything is saved, so a blocked conversation gets no new messages
  if (conversation.status === "blocked") {
    return res.status(403).json({
      success: false,
      message: "This conversation has been blocked. No further messages can be processed.",
      data: { warningCount: conversation.warningCount, conversationStatus: conversation.status },
    });
  }

  if (conversation.status !== "active") {
    return res.status(409).json({
      success: false,
      message: "Conversation is not active",
    });
  }

  // Only content is read from the body, so any warning count or category sent by the client is ignored
  const guestMessage = await prisma.message.create({
    data: { conversationId: conversation.id, role: "guest", content },
  });

  // Take the newest messages, then put them back in oldest-first order
  const recentMessages = await prisma.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: "desc" },
    take: CHAT_HISTORY_LIMIT,
  });
  const history = toClaudeMessages(recentMessages.reverse());

  // Trusted IDs for the tools. Claude never sees or chooses these.
  const toolContext = { conversationId: conversation.id, messageId: guestMessage.id };

  let reply;
  try {
    reply = await generateResponse(history, toolContext);
  } catch (error) {
    // Unexpected bugs still go to the central error handler
    if (!(error instanceof ClaudeServiceError)) throw error;

    // The guest message stays saved, so send it back with the error
    return res.status(error.statusCode).json({
      success: false,
      message: error.message,
      data: { guestMessage: toPublicMessage(guestMessage) },
    });
  }

  // Claude's reply, or the backend's warning message if the guest was warned.
  // A reply that presents a proposal (new, a change or a cancellation) is linked to it, one that found a
  // reservation by code and phone is linked to that, and one that looked up
  // the conversation's reservations is marked, so its cards come back with the
  // message when the conversation is loaded again.
  const uiColumns =
    PROPOSAL_UI_TYPES.includes(reply.ui?.type)
      ? { uiType: reply.ui.type, proposalId: reply.ui.data.proposalId }
      : reply.ui?.type === "reservation_lookup"
        ? { uiType: reply.ui.type, reservationId: reply.ui.data.reservationId }
        : reply.ui?.type === "reservation_list"
          ? { uiType: reply.ui.type }
          : {};
  const [agentMessage] = await toPublicMessages([
    await prisma.message.create({
      data: { conversationId: conversation.id, role: "agent", content: reply.text, ...uiColumns },
      include: MESSAGE_UI_INCLUDE,
    }),
  ]);

  const { violation } = reply;

  res.status(201).json({
    success: true,
    data: {
      guestMessage: toPublicMessage(guestMessage),
      agentMessage,
      warningIssued: violation !== null,
      // Without a warning these haven't changed since the conversation was loaded
      warningCount: violation ? violation.warningCount : conversation.warningCount,
      conversationStatus: violation ? violation.conversationStatus : conversation.status,
      // The reply, plus a structured event the chat can show as a component,
      // such as a reservation proposal card. ui is built by the backend from
      // its own data, never from Claude's text, and is null otherwise. It is
      // the same as agentMessage.ui.
      message: { role: "assistant", content: agentMessage.content },
      ui: agentMessage.ui,
    },
  });
});

module.exports = router;
