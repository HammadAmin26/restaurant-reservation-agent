const { BUFFET_SESSIONS, MEAL_TYPES } = require("./meal-timing-validation.service");

const invalid = (code, message) => ({ valid: false, code, message });

// Work out a reservation's estimated total, in integer paisa.
// Buffets: adults pay the session's adult price; children aged 3 to 11 pay its
// child price (50% of the adult price, set in the policies); children under 3 are free.
// À la carte has no fixed per-person charge, so only extras count.
// children is every child under 12; childrenUnder3 is how many of them are under 3.
// extrasTotalPaisa is the total from validateExtras, including any outside cake fee.
// Returns { valid: true, mealPaisa, extrasPaisa, estimatedTotalPaisa }
// or { valid: false, code, message }.
function calculateEstimatedTotal({ mealType, adults, children, childrenUnder3 = 0, extrasTotalPaisa = 0 } = {}) {
  if (!MEAL_TYPES.includes(mealType)) {
    return invalid("INVALID_MEAL_TYPE", "Please choose buffet lunch, buffet dinner, or à la carte.");
  }
  if (!Number.isInteger(adults) || adults < 0 || !Number.isInteger(children) || children < 0) {
    return invalid("INVALID_PARTY", "The number of guests isn't valid.");
  }
  if (!Number.isInteger(childrenUnder3) || childrenUnder3 < 0 || childrenUnder3 > children) {
    return invalid(
      "INVALID_CHILDREN_UNDER_3",
      "The number of children under 3 must be a whole number, no more than the number of children.",
    );
  }
  if (!Number.isInteger(extrasTotalPaisa) || extrasTotalPaisa < 0) {
    return invalid("INVALID_EXTRAS_TOTAL", "The extras total isn't valid.");
  }

  const session = BUFFET_SESSIONS[mealType];
  // Children under 3 eat free, so they add nothing
  const mealPaisa = session
    ? adults * session.adultPricePaisa + (children - childrenUnder3) * session.childPricePaisa
    : 0;

  return {
    valid: true,
    mealPaisa,
    extrasPaisa: extrasTotalPaisa,
    estimatedTotalPaisa: mealPaisa + extrasTotalPaisa,
  };
}

module.exports = { calculateEstimatedTotal };
