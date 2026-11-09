const restaurantPolicies = require("../config/restaurant-policies");

const MAX_PARTY_SIZE = restaurantPolicies.reservations.maxOnlinePartySize;
const CHILD_AGE_UNDER = restaurantPolicies.children.childAgeUnder;

const invalid = (code, message) => ({ valid: false, code, message });

// A whole number, 0 or more. Rejects strings, null, NaN, Infinity and decimals.
const isGuestCount = (value) => Number.isInteger(value) && value >= 0;

// Check the number of adults and children in a party.
// Guests are already classified: children are under 12, adults are 12 and over.
// Every guest needs a seat, including children under 3.
// Returns { valid: true, adults, children, total, requiresFamilySection }
// or { valid: false, code, message }.
function validateParty({ adults, children } = {}) {
  if (!isGuestCount(adults)) {
    return invalid("INVALID_ADULTS", "Please tell us how many adults are coming, as a whole number (0 or more).");
  }

  if (!isGuestCount(children)) {
    return invalid(
      "INVALID_CHILDREN",
      `Please tell us how many children under ${CHILD_AGE_UNDER} are coming, as a whole number (0 or more).`,
    );
  }

  const total = adults + children;

  if (total === 0) {
    return invalid("PARTY_EMPTY", "A reservation needs at least one guest.");
  }

  if (total > MAX_PARTY_SIZE) {
    return invalid(
      "PARTY_TOO_LARGE",
      `Online reservations are for up to ${MAX_PARTY_SIZE} guests in total, including children. Your party has ${total}.`,
    );
  }

  return {
    valid: true,
    adults,
    children,
    total,
    // Parties with children must sit in the FAMILY section
    requiresFamilySection: children > 0,
  };
}

module.exports = { validateParty };
