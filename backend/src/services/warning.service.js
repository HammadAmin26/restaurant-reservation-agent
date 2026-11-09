const prisma = require("../lib/prisma");
const restaurantPolicies = require("../config/restaurant-policies");

// A conversation is blocked when it reaches this many warnings
const MAX_WARNINGS = restaurantPolicies.conversation.warningLimit;

// Record one warning for a guest message, and block the conversation on the last one.
// conversationId and messageId must come from the server, never from Claude or the guest.
async function recordWarning({ conversationId, messageId, category, reason }) {
  // SQLite only supports serializable transactions, and the adapter runs them one at a time
  return prisma.$transaction(async (tx) => {
    // Increment in the database, and only while the conversation is still active,
    // so two requests at the same time can't both count from the same number
    const { count } = await tx.conversation.updateMany({
      where: { id: conversationId, status: "active" },
      data: { warningCount: { increment: 1 } },
    });

    if (count === 0) {
      // Another request already blocked it, so don't add a warning past the limit
      const conversation = await tx.conversation.findUniqueOrThrow({
        where: { id: conversationId },
      });
      return {
        warningCount: conversation.warningCount,
        conversationStatus: conversation.status,
        blocked: conversation.status === "blocked",
      };
    }

    await tx.warning.create({
      data: { conversationId, messageId, reason: `${category}: ${reason}` },
    });

    let conversation = await tx.conversation.findUniqueOrThrow({
      where: { id: conversationId },
    });

    if (conversation.warningCount >= MAX_WARNINGS) {
      conversation = await tx.conversation.update({
        where: { id: conversationId },
        data: { status: "blocked" },
      });
    }

    return {
      warningCount: conversation.warningCount,
      conversationStatus: conversation.status,
      blocked: conversation.status === "blocked",
    };
  });
}

// The reply the guest sees after a warning. Written by the backend, not by Claude.
function getWarningMessage(category, { warningCount, blocked }) {
  if (blocked) {
    return `This conversation has been blocked because the maximum warning limit of ${MAX_WARNINGS} has been reached. No further messages can be processed in this conversation.`;
  }

  if (category === "abusive_or_manipulative") {
    return `That message goes against Hammad Foods' conversation policy. Please keep our conversation respectful and focused on Hammad Foods. This is warning ${warningCount} of ${MAX_WARNINGS}.`;
  }

  return `That request is outside Hammad Foods' restaurant and reservation services. Please keep our conversation focused on Hammad Foods. This is warning ${warningCount} of ${MAX_WARNINGS}.`;
}

module.exports = { recordWarning, getWarningMessage, MAX_WARNINGS };
