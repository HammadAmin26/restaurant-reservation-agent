// How the reservation lookup tools describe a reservation to Claude
const { DateTime } = require("luxon");
const restaurantPolicies = require("../config/restaurant-policies");
const { formatPkr } = require("../lib/money");

const karachi = (date) => DateTime.fromJSDate(date, { zone: restaurantPolicies.timezone }).setLocale("en-GB");

// One reservation for Claude: Karachi dates and PKR text, so it never reads a
// UTC time or paisa. reservation is in the toReservationDetails shape; only the
// fields below are copied, so database ids, the conversation and the guest's
// name and phone never reach Claude.
// withApprovalStatus adds each extra's approvalStatus ("not_required",
// "pending", "approved" or "rejected").
function reservationForClaude(reservation, { withApprovalStatus = false } = {}) {
  const start = karachi(reservation.startTime);
  const end = karachi(reservation.endTime);
  return {
    reservationCode: reservation.reservationCode,
    status: reservation.status,
    date: start.toFormat("cccc d LLLL yyyy"),
    time: `${start.toFormat("HH:mm")}–${end.toFormat("HH:mm")} (Karachi time)`,
    mealType: reservation.mealType,
    adults: reservation.adults,
    children: reservation.children,
    tables: reservation.tables.map((table) => ({ tableNumber: table.tableNumber, section: table.section })),
    extras: reservation.extras.map((extra) => ({
      name: extra.name,
      quantity: extra.quantity,
      price: formatPkr(extra.lineTotalPaisa),
      needsStaffApproval: extra.approvalStatus === "pending",
      ...(withApprovalStatus && { approvalStatus: extra.approvalStatus }),
    })),
    estimatedTotal: formatPkr(reservation.estimatedTotalPaisa),
    specialRequest: reservation.specialRequest,
    ...(reservation.cancelledAt && { cancelledOn: karachi(reservation.cancelledAt).toFormat("cccc d LLLL yyyy") }),
  };
}

module.exports = { reservationForClaude };
