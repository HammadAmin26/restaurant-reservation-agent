// Run with: npm test
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { validateExtras } = require("../src/services/extras-validation.service");

// A fixed clock: Tuesday 10 November 2026, 12:00 in Karachi (07:00 UTC)
const NOW = new Date("2026-11-10T07:00:00Z");
const HOUR_MS = 60 * 60 * 1000;
const hoursFromNow = (hours) => new Date(NOW.getTime() + hours * HOUR_MS);
// A reservation a week away, so every notice period is met
const NEXT_WEEK = hoursFromNow(7 * 24);

const check = (extras, options = {}) =>
  validateExtras({ extras, reservationStartTime: NEXT_WEEK, now: NOW, ...options });
const extra = (extraKey, quantity = 1) => ({ extraKey, quantity });

const EXPECTED = {
  birthday_cake: { name: "Birthday cake", unitPricePaisa: 300000, noticeHours: 24, approvalStatus: "not_required" },
  candles: { name: "Candles", unitPricePaisa: 30000, noticeHours: 2, approvalStatus: "not_required" },
  high_chair: { name: "High chair", unitPricePaisa: 0, noticeHours: 2, approvalStatus: "pending" },
  balloons: { name: "Balloons", unitPricePaisa: 150000, noticeHours: 24, approvalStatus: "pending" },
  birthday_decorations: { name: "Birthday decorations", unitPricePaisa: 400000, noticeHours: 48, approvalStatus: "pending" },
};

describe("validateExtras", () => {
  test("accepts each of the five extras with its price and approval status", () => {
    for (const [extraKey, expected] of Object.entries(EXPECTED)) {
      const result = check([extra(extraKey)]);
      assert.equal(result.valid, true, extraKey);
      assert.deepEqual(result.extras, [
        {
          extraKey,
          name: expected.name,
          quantity: 1,
          unitPricePaisa: expected.unitPricePaisa,
          lineTotalPaisa: expected.unitPricePaisa,
          approvalStatus: expected.approvalStatus,
        },
      ]);
      assert.equal(result.totalExtrasPaisa, expected.unitPricePaisa);
      assert.equal(result.outsideCake, null);
    }
  });

  test("calculates line totals and the overall total for several extras", () => {
    const result = check([
      extra("birthday_cake", 2),
      extra("candles", 3),
      extra("high_chair", 2),
      extra("balloons", 4),
      extra("birthday_decorations", 1),
    ]);
    assert.equal(result.valid, true);
    assert.deepEqual(
      result.extras.map((e) => [e.extraKey, e.quantity, e.lineTotalPaisa]),
      [
        ["birthday_cake", 2, 600000],
        ["candles", 3, 90000],
        ["high_chair", 2, 0],
        ["balloons", 4, 600000],
        ["birthday_decorations", 1, 400000],
      ],
    );
    // PKR 6,000 + 900 + 0 + 6,000 + 4,000 = PKR 16,900
    assert.equal(result.totalExtrasPaisa, 1690000);
  });

  test("all money values are integer paisa", () => {
    const result = check(Object.keys(EXPECTED).map((key) => extra(key, 3)), { outsideCake: true });
    for (const e of result.extras) {
      assert.ok(Number.isInteger(e.unitPricePaisa) && Number.isInteger(e.lineTotalPaisa));
    }
    assert.ok(Number.isInteger(result.totalExtrasPaisa));
  });

  test("an empty list is valid and costs nothing", () => {
    assert.deepEqual(check([]), { valid: true, extras: [], outsideCake: null, totalExtrasPaisa: 0 });
  });

  test("rejects unknown extra keys", () => {
    for (const extraKey of ["fireworks", "Birthday cake", "BIRTHDAY_CAKE", "toString", "__proto__", "", 1, null, undefined]) {
      const result = check([extra(extraKey)]);
      assert.equal(result.code, "INVALID_EXTRA", String(extraKey));
      assert.match(result.message, /isn't available/);
    }
  });

  test("rejects the same extra listed twice", () => {
    const result = check([extra("candles", 1), extra("balloons"), extra("candles", 2)]);
    assert.equal(result.code, "INVALID_EXTRA");
    assert.match(result.message, /more than once/);
  });

  test("rejects invalid quantities", () => {
    for (const quantity of [0, -1, 1.5, "1", "two", null, NaN, Infinity, true, [1]]) {
      const result = check([extra("candles", quantity)]);
      assert.equal(result.code, "INVALID_EXTRA", String(quantity));
      assert.match(result.message, /quantity/);
    }
    // Missing quantity
    assert.equal(check([{ extraKey: "candles" }]).code, "INVALID_EXTRA");
  });

  test("rejects malformed lists and items", () => {
    for (const extras of [undefined, null, "candles", { extraKey: "candles", quantity: 1 }, 5]) {
      assert.equal(check(extras).code, "INVALID_EXTRA", String(extras));
    }
    for (const item of [null, "candles", 1, ["candles", 1], {}, { quantity: 1 }]) {
      assert.equal(check([item]).code, "INVALID_EXTRA", JSON.stringify(item));
    }
    // Extra fields, such as a price chosen by the guest, aren't allowed
    assert.equal(check([{ extraKey: "candles", quantity: 1, unitPricePaisa: 0 }]).code, "INVALID_EXTRA");
  });

  test("one bad item fails the whole list instead of being skipped", () => {
    const result = check([extra("birthday_cake"), extra("fireworks"), extra("candles")]);
    assert.equal(result.valid, false);
    assert.equal(result.extras, undefined);
  });

  test("rejects an invalid reservation start time", () => {
    for (const reservationStartTime of [undefined, null, "2026-11-17T14:00:00Z", 1763388000000, new Date("x")]) {
      assert.equal(check([], { reservationStartTime }).code, "INVALID_RESERVATION_TIME", String(reservationStartTime));
    }
  });

  test("throws for an invalid clock, which would be a bug in the caller", () => {
    assert.throws(() => check([], { now: "now" }), TypeError);
  });

  test("accepts each extra with exactly enough notice", () => {
    for (const [extraKey, { noticeHours }] of Object.entries(EXPECTED)) {
      const result = check([extra(extraKey)], { reservationStartTime: hoursFromNow(noticeHours) });
      assert.equal(result.valid, true, `${extraKey} at ${noticeHours}h`);
    }
  });

  test("rejects each extra with one minute too little notice", () => {
    for (const [extraKey, { name, noticeHours }] of Object.entries(EXPECTED)) {
      const reservationStartTime = new Date(hoursFromNow(noticeHours).getTime() - 60 * 1000);
      const result = check([extra(extraKey)], { reservationStartTime });
      assert.deepEqual(result, {
        valid: false,
        code: "INSUFFICIENT_NOTICE",
        message: `${name} needs at least ${noticeHours} hours' notice before the reservation.`,
      });
    }
  });

  test("notice is checked per extra", () => {
    // 3 hours away: candles and a high chair are fine, a birthday cake is not
    const reservationStartTime = hoursFromNow(3);
    assert.equal(check([extra("candles"), extra("high_chair")], { reservationStartTime }).valid, true);
    assert.equal(check([extra("candles"), extra("birthday_cake")], { reservationStartTime }).code, "INSUFFICIENT_NOTICE");
  });

  test("pending approval doesn't make the extras invalid", () => {
    const result = check([extra("balloons"), extra("birthday_decorations"), extra("high_chair")]);
    assert.equal(result.valid, true);
    assert.ok(result.extras.every((e) => e.approvalStatus === "pending"));
  });

  test("an outside cake adds a PKR 500 fee and needs approval", () => {
    const result = check([], { outsideCake: true });
    assert.deepEqual(result, {
      valid: true,
      extras: [],
      outsideCake: { name: "Outside cake service fee", serviceFeePaisa: 50000, approvalStatus: "pending" },
      totalExtrasPaisa: 50000,
    });
  });

  test("an outside cake is separate from our birthday cake", () => {
    const result = check([extra("candles", 2)], { outsideCake: true });
    assert.deepEqual(result.extras.map((e) => e.extraKey), ["candles"]);
    assert.equal(result.outsideCake.serviceFeePaisa, 50000);
    // 2 candles (PKR 600) + outside cake fee (PKR 500)
    assert.equal(result.totalExtrasPaisa, 110000);
  });

  test("an outside cake needs 24 hours' notice", () => {
    assert.equal(check([], { outsideCake: true, reservationStartTime: hoursFromNow(24) }).valid, true);
    const late = check([], { outsideCake: true, reservationStartTime: new Date(hoursFromNow(24).getTime() - 60 * 1000) });
    assert.equal(late.code, "INSUFFICIENT_NOTICE");
    assert.match(late.message, /24 hours/);
  });

  test("outsideCake false or missing means no outside cake", () => {
    assert.equal(check([], { outsideCake: false }).outsideCake, null);
    assert.equal(check([]).outsideCake, null);
    assert.equal(check([], { outsideCake: false }).totalExtrasPaisa, 0);
  });

  test("rejects outsideCake values that aren't true or false", () => {
    for (const outsideCake of ["true", "yes", 1, 0, null, {}, []]) {
      assert.equal(check([], { outsideCake }).code, "INVALID_OUTSIDE_CAKE", JSON.stringify(outsideCake));
    }
  });

  test("never touches the database", () => {
    // The service doesn't load the Prisma client, so it can't create a Reservation,
    // Proposal or ReservationExtra
    const prismaPath = path.join(__dirname, "../src/lib/prisma.js");
    assert.equal(require.cache[prismaPath], undefined);
  });
});
