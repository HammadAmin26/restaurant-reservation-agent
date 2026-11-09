const restaurantPolicies = require("../config/restaurant-policies");

const { items: EXTRA_POLICIES, outsideCake: OUTSIDE_CAKE_POLICY } = restaurantPolicies.extras;
const EXTRAS_BY_KEY = new Map(EXTRA_POLICIES.map((extra) => [extra.key, extra]));

// An outside cake needs the same notice as one of our own birthday cakes
const OUTSIDE_CAKE_NOTICE_HOURS = EXTRAS_BY_KEY.get("birthday_cake").noticeHours;

const HOUR_MS = 60 * 60 * 1000;

const invalid = (code, message) => ({ valid: false, code, message });

// Staff must confirm extras that need approval or depend on availability (the high chair).
// A pending extra doesn't stop the reservation from being confirmed.
const approvalStatusFor = (policy) =>
  policy.requiresStaffApproval || policy.subjectToAvailability ? "pending" : "not_required";

const hasEnoughNotice = (reservationStartTime, now, noticeHours) =>
  reservationStartTime.getTime() - now.getTime() >= noticeHours * HOUR_MS;

const noticeFailure = (name, noticeHours) =>
  invalid(
    "INSUFFICIENT_NOTICE",
    `${name} needs at least ${noticeHours} hours' notice before the reservation.`,
  );

// Check the extras requested for a reservation and work out their cost.
// extras is an array of { extraKey, quantity }; pass [] for none.
// outsideCake is true if the guest is bringing their own cake.
// reservationStartTime is the reservation's start; now is the current instant
// (pass a fixed Date in tests).
// Returns { valid: true, extras, outsideCake, totalExtrasPaisa } with money in
// integer paisa, or { valid: false, code, message }.
function validateExtras({ extras, outsideCake, reservationStartTime, now = new Date() } = {}) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }

  if (!(reservationStartTime instanceof Date) || Number.isNaN(reservationStartTime.getTime())) {
    return invalid("INVALID_RESERVATION_TIME", "The reservation time isn't valid.");
  }

  if (!Array.isArray(extras)) {
    return invalid("INVALID_EXTRA", "Extras must be a list.");
  }

  if (outsideCake !== undefined && typeof outsideCake !== "boolean") {
    return invalid("INVALID_OUTSIDE_CAKE", "Please say yes or no to bringing your own cake.");
  }

  const seenKeys = new Set();
  const validatedExtras = [];

  for (const item of extras) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return invalid("INVALID_EXTRA", "Each extra must have an extra and a quantity.");
    }

    const unexpected = Object.keys(item).filter((key) => key !== "extraKey" && key !== "quantity");
    if (unexpected.length > 0) {
      return invalid("INVALID_EXTRA", "Each extra must have only an extra and a quantity.");
    }

    const { extraKey, quantity } = item;
    const policy = typeof extraKey === "string" ? EXTRAS_BY_KEY.get(extraKey) : undefined;
    if (!policy) {
      const available = EXTRA_POLICIES.map((extra) => extra.name.toLowerCase()).join(", ");
      return invalid("INVALID_EXTRA", `That extra isn't available. We offer: ${available}.`);
    }

    if (seenKeys.has(extraKey)) {
      return invalid("INVALID_EXTRA", `${policy.name} is listed more than once. Please list it once with a quantity.`);
    }
    seenKeys.add(extraKey);

    if (!Number.isInteger(quantity) || quantity < 1) {
      return invalid("INVALID_EXTRA", `The quantity for ${policy.name.toLowerCase()} must be a whole number, 1 or more.`);
    }

    if (!hasEnoughNotice(reservationStartTime, now, policy.noticeHours)) {
      return noticeFailure(policy.name, policy.noticeHours);
    }

    validatedExtras.push({
      extraKey,
      name: policy.name,
      quantity,
      unitPricePaisa: policy.pricePaisa,
      lineTotalPaisa: policy.pricePaisa * quantity,
      approvalStatus: approvalStatusFor(policy),
    });
  }

  let validatedOutsideCake = null;
  if (outsideCake === true) {
    if (!hasEnoughNotice(reservationStartTime, now, OUTSIDE_CAKE_NOTICE_HOURS)) {
      return noticeFailure("Bringing your own cake", OUTSIDE_CAKE_NOTICE_HOURS);
    }

    // A service fee for a cake the guest brings, not one of our birthday cakes
    validatedOutsideCake = {
      name: "Outside cake service fee",
      serviceFeePaisa: OUTSIDE_CAKE_POLICY.serviceFeePaisa,
      approvalStatus: OUTSIDE_CAKE_POLICY.requiresStaffApproval ? "pending" : "not_required",
    };
  }

  const totalExtrasPaisa =
    validatedExtras.reduce((sum, extra) => sum + extra.lineTotalPaisa, 0) +
    (validatedOutsideCake ? validatedOutsideCake.serviceFeePaisa : 0);

  return {
    valid: true,
    extras: validatedExtras,
    outsideCake: validatedOutsideCake,
    totalExtrasPaisa,
  };
}

module.exports = { validateExtras };
