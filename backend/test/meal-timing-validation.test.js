// Run with: npm test
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { validateMealTiming, MEAL_TYPES } = require("../src/services/meal-timing-validation.service");

// November 2026: Monday the 9th and 16th; Tuesday the 10th to Sunday the 15th
const MONDAY = "2026-11-09";
const TUESDAY = "2026-11-10";
const OPEN_DAYS = ["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"];

const iso = (result) => [result.startTime.toISOString(), result.endTime.toISOString()];

describe("validateMealTiming", () => {
  test("Monday is closed for every meal type", () => {
    for (const date of [MONDAY, "2026-11-16"]) {
      for (const mealType of MEAL_TYPES) {
        const result = validateMealTiming({ date, mealType, time: "19:00" });
        assert.equal(result.valid, false);
        assert.equal(result.code, "RESTAURANT_CLOSED", `${date} ${mealType}`);
        assert.match(result.message, /closed on Mondays/);
      }
    }
  });

  test("Tuesday to Sunday are open for every meal type", () => {
    for (const date of OPEN_DAYS) {
      for (const mealType of MEAL_TYPES) {
        assert.equal(validateMealTiming({ date, mealType, time: "19:00" }).valid, true, `${date} ${mealType}`);
      }
    }
  });

  test("buffet lunch covers 12:00 to 15:30 Karachi time", () => {
    const result = validateMealTiming({ date: TUESDAY, mealType: "buffet_lunch" });
    assert.equal(result.valid, true);
    assert.equal(result.mealType, "buffet_lunch");
    assert.ok(result.startTime instanceof Date && result.endTime instanceof Date);
    // Karachi is UTC+5
    assert.deepEqual(iso(result), ["2026-11-10T07:00:00.000Z", "2026-11-10T10:30:00.000Z"]);
  });

  test("buffet dinner covers 19:00 to 23:00 Karachi time", () => {
    const result = validateMealTiming({ date: TUESDAY, mealType: "buffet_dinner" });
    assert.deepEqual(iso(result), ["2026-11-10T14:00:00.000Z", "2026-11-10T18:00:00.000Z"]);
  });

  test("buffets don't need a time, and ignore one if given", () => {
    const withTime = validateMealTiming({ date: TUESDAY, mealType: "buffet_dinner", time: "20:15" });
    assert.deepEqual(iso(withTime), ["2026-11-10T14:00:00.000Z", "2026-11-10T18:00:00.000Z"]);
  });

  test("rejects a missing or unsupported meal type", () => {
    for (const mealType of [undefined, null, "", "lunch", "BUFFET_LUNCH", "brunch", "a la carte", 1]) {
      const result = validateMealTiming({ date: TUESDAY, mealType, time: "19:00" });
      assert.equal(result.code, "INVALID_MEAL_TYPE", String(mealType));
    }
  });

  test("à la carte accepts every half-hour slot from 12:00 to 21:00", () => {
    const slots = [];
    for (let minutes = 12 * 60; minutes <= 21 * 60; minutes += 30) {
      slots.push(`${String(minutes / 60 | 0).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`);
    }
    assert.equal(slots.length, 19);
    for (const time of slots) {
      assert.equal(validateMealTiming({ date: TUESDAY, mealType: "a_la_carte", time }).valid, true, time);
    }
  });

  test("à la carte rejects starts that aren't on a half hour", () => {
    for (const time of ["12:15", "19:45", "20:01", "13:29"]) {
      assert.equal(validateMealTiming({ date: TUESDAY, mealType: "a_la_carte", time }).code, "INVALID_SLOT", time);
    }
  });

  test("à la carte lasts exactly two hours", () => {
    const result = validateMealTiming({ date: TUESDAY, mealType: "a_la_carte", time: "19:30" });
    assert.deepEqual(iso(result), ["2026-11-10T14:30:00.000Z", "2026-11-10T16:30:00.000Z"]);
    assert.equal(result.endTime - result.startTime, 2 * 60 * 60 * 1000);
  });

  test("à la carte can end exactly at 23:00", () => {
    const result = validateMealTiming({ date: TUESDAY, mealType: "a_la_carte", time: "21:00" });
    assert.equal(result.valid, true);
    assert.equal(result.endTime.toISOString(), "2026-11-10T18:00:00.000Z");
  });

  test("à la carte can't run past 23:00 or start before 12:00", () => {
    const late = validateMealTiming({ date: TUESDAY, mealType: "a_la_carte", time: "21:30" });
    assert.equal(late.code, "OUTSIDE_OPENING_HOURS");
    assert.match(late.message, /12:00 PM and 9:00 PM/);

    for (const time of ["00:00", "09:00", "11:30"]) {
      assert.equal(validateMealTiming({ date: TUESDAY, mealType: "a_la_carte", time }).code, "OUTSIDE_OPENING_HOURS", time);
    }
  });

  test("à la carte can't cross midnight", () => {
    for (const time of ["22:00", "22:30", "23:00", "23:30"]) {
      assert.equal(validateMealTiming({ date: TUESDAY, mealType: "a_la_carte", time }).code, "CROSSES_MIDNIGHT", time);
    }
  });

  test("rejects invalid dates", () => {
    for (const date of ["2026-02-30", "2026-13-01", "2027-02-29", "10-11-2026", "2026/11/10", "", null, undefined]) {
      assert.equal(validateMealTiming({ date, mealType: "buffet_lunch" }).code, "INVALID_DATE", String(date));
    }
  });

  test("rejects a missing or invalid à la carte time", () => {
    for (const time of [undefined, null, "", "7pm", "7:00", "24:00", "19:60", "19:00:00"]) {
      assert.equal(validateMealTiming({ date: TUESDAY, mealType: "a_la_carte", time }).code, "INVALID_TIME", String(time));
    }
  });

  test("every failure has a guest-friendly message", () => {
    const failures = [
      validateMealTiming({ date: "2026-02-30", mealType: "buffet_lunch" }),
      validateMealTiming({ date: TUESDAY, mealType: "brunch" }),
      validateMealTiming({ date: TUESDAY, mealType: "a_la_carte", time: "7pm" }),
      validateMealTiming({ date: MONDAY, mealType: "buffet_dinner" }),
      validateMealTiming({ date: TUESDAY, mealType: "a_la_carte", time: "12:15" }),
      validateMealTiming({ date: TUESDAY, mealType: "a_la_carte", time: "21:30" }),
    ];
    for (const result of failures) {
      assert.equal(result.valid, false);
      assert.ok(typeof result.message === "string" && result.message.length > 0, result.code);
    }
  });

  test("gives the same result whatever the server's timezone", () => {
    const servicePath = JSON.stringify(path.join(__dirname, "../src/services/meal-timing-validation.service"));
    const script = `
      const { validateMealTiming } = require(${servicePath});
      const results = [
        validateMealTiming({ date: "2026-11-10", mealType: "buffet_lunch" }),
        validateMealTiming({ date: "2026-11-10", mealType: "a_la_carte", time: "21:00" }),
        validateMealTiming({ date: "2026-11-09", mealType: "buffet_dinner" }),
      ];
      process.stdout.write(JSON.stringify(results));
    `;
    const outputs = new Set();
    // Kiritimati is UTC+14, so 9 November there is already a Tuesday
    for (const tz of ["UTC", "America/New_York", "Asia/Tokyo", "Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
      outputs.add(execFileSync(process.execPath, ["-e", script], { env: { ...process.env, TZ: tz }, encoding: "utf8" }));
    }
    assert.equal(outputs.size, 1);
    const [lunch, aLaCarte, monday] = JSON.parse([...outputs][0]);
    assert.deepEqual([lunch.startTime, lunch.endTime], ["2026-11-10T07:00:00.000Z", "2026-11-10T10:30:00.000Z"]);
    assert.equal(aLaCarte.endTime, "2026-11-10T18:00:00.000Z");
    assert.equal(monday.code, "RESTAURANT_CLOSED");
  });
});
