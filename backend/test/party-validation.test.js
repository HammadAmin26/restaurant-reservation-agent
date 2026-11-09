// Run with: npm test
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { validateParty } = require("../src/services/party-validation.service");

describe("validateParty", () => {
  test("accepts an adults-only party", () => {
    assert.deepEqual(validateParty({ adults: 4, children: 0 }), {
      valid: true,
      adults: 4,
      children: 0,
      total: 4,
      requiresFamilySection: false,
    });
  });

  test("accepts a party with children", () => {
    assert.deepEqual(validateParty({ adults: 2, children: 3 }), {
      valid: true,
      adults: 2,
      children: 3,
      total: 5,
      requiresFamilySection: true,
    });
  });

  test("accepts a children-only party, since at least one adult or child is enough", () => {
    const result = validateParty({ adults: 0, children: 2 });
    assert.equal(result.valid, true);
    assert.equal(result.total, 2);
    assert.equal(result.requiresFamilySection, true);
  });

  test("accepts exactly 15 people", () => {
    for (const [adults, children] of [[15, 0], [0, 15], [10, 5]]) {
      const result = validateParty({ adults, children });
      assert.equal(result.valid, true, `${adults} + ${children}`);
      assert.equal(result.total, 15);
    }
  });

  test("rejects 16 or more people", () => {
    for (const [adults, children] of [[16, 0], [0, 16], [10, 6], [15, 1], [50, 50]]) {
      const result = validateParty({ adults, children });
      assert.equal(result.code, "PARTY_TOO_LARGE", `${adults} + ${children}`);
      assert.match(result.message, /up to 15 guests/);
    }
  });

  test("rejects zero adults and zero children", () => {
    assert.equal(validateParty({ adults: 0, children: 0 }).code, "PARTY_EMPTY");
  });

  test("rejects negative values", () => {
    assert.equal(validateParty({ adults: -1, children: 2 }).code, "INVALID_ADULTS");
    assert.equal(validateParty({ adults: 2, children: -1 }).code, "INVALID_CHILDREN");
    // A negative count can't be used to cancel out a large one
    assert.equal(validateParty({ adults: 20, children: -6 }).code, "INVALID_CHILDREN");
  });

  test("rejects decimal values", () => {
    assert.equal(validateParty({ adults: 2.5, children: 0 }).code, "INVALID_ADULTS");
    assert.equal(validateParty({ adults: 2, children: 0.5 }).code, "INVALID_CHILDREN");
  });

  test("rejects missing values", () => {
    assert.equal(validateParty({ children: 2 }).code, "INVALID_ADULTS");
    assert.equal(validateParty({ adults: 2 }).code, "INVALID_CHILDREN");
    assert.equal(validateParty({}).code, "INVALID_ADULTS");
    assert.equal(validateParty().code, "INVALID_ADULTS");
  });

  test("rejects strings, null, NaN, Infinity and other non-numbers", () => {
    const bad = ["2", "", "two", null, NaN, Infinity, -Infinity, true, [2], { n: 2 }, 2n];
    for (const value of bad) {
      assert.equal(validateParty({ adults: value, children: 0 }).code, "INVALID_ADULTS", String(value));
      assert.equal(validateParty({ adults: 2, children: value }).code, "INVALID_CHILDREN", String(value));
    }
  });

  test("requiresFamilySection is true exactly when there are children", () => {
    assert.equal(validateParty({ adults: 3, children: 0 }).requiresFamilySection, false);
    assert.equal(validateParty({ adults: 3, children: 1 }).requiresFamilySection, true);
    assert.equal(validateParty({ adults: 0, children: 1 }).requiresFamilySection, true);
  });

  test("every guest counts towards the total, including small children", () => {
    // The function can't tell a baby from an older child: each child is a seat
    assert.equal(validateParty({ adults: 2, children: 4 }).total, 6);
    assert.equal(validateParty({ adults: 1, children: 0 }).total, 1);
    // 13 adults + 3 children is 16 seats, so it's over the limit
    assert.equal(validateParty({ adults: 13, children: 3 }).code, "PARTY_TOO_LARGE");
  });

  test("every failure has a guest-friendly message", () => {
    const failures = [
      validateParty({ adults: "x", children: 0 }),
      validateParty({ adults: 1, children: null }),
      validateParty({ adults: 0, children: 0 }),
      validateParty({ adults: 16, children: 0 }),
    ];
    for (const result of failures) {
      assert.equal(result.valid, false);
      assert.deepEqual(Object.keys(result).sort(), ["code", "message", "valid"]);
      assert.ok(result.message.length > 0, result.code);
    }
  });
});
