// Run with: npm test
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { calculateEstimatedTotal } = require("../src/services/pricing.service");

const total = (input) => calculateEstimatedTotal(input).estimatedTotalPaisa;

describe("calculateEstimatedTotal", () => {
  test("buffet lunch adults pay 249900 paisa each", () => {
    assert.deepEqual(calculateEstimatedTotal({ mealType: "buffet_lunch", adults: 2, children: 0 }), {
      valid: true,
      mealPaisa: 499800,
      extrasPaisa: 0,
      estimatedTotalPaisa: 499800,
    });
  });

  test("buffet dinner adults pay 349900 paisa each", () => {
    assert.equal(total({ mealType: "buffet_dinner", adults: 3, children: 0 }), 1049700);
  });

  test("children aged 3 to 11 pay half, including half-rupee amounts", () => {
    // Lunch child PKR 1,249.50; dinner child PKR 1,749.50
    assert.equal(total({ mealType: "buffet_lunch", adults: 1, children: 1 }), 374850);
    assert.equal(total({ mealType: "buffet_dinner", adults: 2, children: 1 }), 874750);
    assert.equal(total({ mealType: "buffet_dinner", adults: 0, children: 3 }), 524850);
  });

  test("children under 3 are free", () => {
    // 2 adults + 3 children, 1 of them under 3: 2 x 349900 + 2 x 174950
    assert.equal(total({ mealType: "buffet_dinner", adults: 2, children: 3, childrenUnder3: 1 }), 1049700);
    assert.equal(total({ mealType: "buffet_lunch", adults: 1, children: 2, childrenUnder3: 2 }), 249900);
  });

  test("without childrenUnder3, every child pays the 3 to 11 price", () => {
    assert.equal(total({ mealType: "buffet_lunch", adults: 0, children: 2 }), 249900);
  });

  test("à la carte has no per-person charge, so only extras count", () => {
    assert.deepEqual(calculateEstimatedTotal({ mealType: "a_la_carte", adults: 4, children: 2, extrasTotalPaisa: 330000 }), {
      valid: true,
      mealPaisa: 0,
      extrasPaisa: 330000,
      estimatedTotalPaisa: 330000,
    });
  });

  test("adds extras to buffet prices", () => {
    assert.equal(total({ mealType: "buffet_dinner", adults: 2, children: 0, extrasTotalPaisa: 350000 }), 1049800);
  });

  test("every amount is a whole number of paisa", () => {
    for (let adults = 0; adults <= 15; adults++) {
      for (let children = 0; adults + children <= 15; children++) {
        for (const mealType of ["buffet_lunch", "buffet_dinner", "a_la_carte"]) {
          assert.ok(Number.isInteger(total({ mealType, adults, children })));
        }
      }
    }
  });

  test("rejects invalid input", () => {
    assert.equal(calculateEstimatedTotal({ mealType: "brunch", adults: 1, children: 0 }).code, "INVALID_MEAL_TYPE");
    assert.equal(calculateEstimatedTotal({ mealType: "buffet_lunch", adults: 1.5, children: 0 }).code, "INVALID_PARTY");
    assert.equal(calculateEstimatedTotal({ mealType: "buffet_lunch", adults: 1, children: -1 }).code, "INVALID_PARTY");
    for (const childrenUnder3 of [-1, 1.5, "1", null, 3]) {
      assert.equal(
        calculateEstimatedTotal({ mealType: "buffet_lunch", adults: 1, children: 2, childrenUnder3 }).code,
        "INVALID_CHILDREN_UNDER_3",
        String(childrenUnder3),
      );
    }
    for (const extrasTotalPaisa of [-1, 1.5, "100", null]) {
      assert.equal(
        calculateEstimatedTotal({ mealType: "a_la_carte", adults: 1, children: 0, extrasTotalPaisa }).code,
        "INVALID_EXTRAS_TOTAL",
      );
    }
  });
});
