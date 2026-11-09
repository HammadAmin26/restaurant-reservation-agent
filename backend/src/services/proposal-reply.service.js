const { DateTime } = require("luxon");
const prisma = require("../lib/prisma");
const restaurantPolicies = require("../config/restaurant-policies");
const { toPublicMessage } = require("./message-ui.service");

// "Friday 13 November 2026 at 19:00", in Karachi time
const karachiTime = (date) =>
  DateTime.fromJSDate(date, { zone: restaurantPolicies.timezone })
    .setLocale("en-GB")
    .toFormat("cccc d LLLL yyyy 'at' HH:mm");

// The agent's reply after the guest pressed a button on a proposal card,
// written by the backend from what it actually did, never by Claude.
// It is saved in the conversation, so Claude sees it in the history next turn.
// actionType is the proposal's ("create", "modify" or "cancel"); reason is the
// service's message for a rejected proposal, which is safe to show.
function proposalReplyText({ outcome, actionType, reservation, reason }) {
  const nothingDone = actionType === "create" ? "nothing was booked" : "nothing was changed";
  if (outcome === "declined") {
    return `No problem, that proposal has been declined and ${nothingDone}. Would you like to try something different?`;
  }
  if (outcome === "expired") {
    return `Sorry, that proposal has expired, so ${nothingDone}. Would you like me to prepare a new one?`;
  }
  if (outcome === "rejected") {
    return `Sorry, I couldn't complete that proposal, so ${nothingDone}. ${reason} Would you like to try something different?`;
  }
  const code = reservation.reservationCode;
  if (actionType === "cancel") {
    return `Your reservation ${code} has been cancelled.`;
  }
  if (actionType === "modify") {
    return `Your reservation ${code} has been updated. We look forward to seeing you on ${karachiTime(reservation.startTime)}.`;
  }
  return `Your reservation is confirmed! Your reservation code is ${code}. We look forward to seeing you on ${karachiTime(reservation.startTime)}.`;
}

// Save that reply as an agent message and return it in the public shape.
// outcome is "accepted" (with the reservation), "declined", "expired", or
// "rejected" (with the reason).
// The message is linked to the proposal (with no uiType, so it shows no card),
// which marks it as the backend's own reply when it's sent to Claude.
// The guest's answer has already been saved, so a failure here is only
// logged and gives null: the reservation must not look like it failed.
async function saveProposalReply({ conversationId, proposalId, outcome, actionType, reservation, reason }) {
  try {
    const message = await prisma.message.create({
      data: {
        conversationId,
        role: "agent",
        content: proposalReplyText({ outcome, actionType, reservation, reason }),
        proposalId,
      },
    });
    return toPublicMessage(message);
  } catch (error) {
    console.error("Couldn't save the proposal reply message", error);
    return null;
  }
}

module.exports = { saveProposalReply, proposalReplyText };
