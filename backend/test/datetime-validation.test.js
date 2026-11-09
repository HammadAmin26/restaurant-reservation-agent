// Run with: npm test
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { validateReservationDateTime } = require("../src/services/datetime-validation.service");

// A fixed clock: Tuesday 10 November 2026, 12:00 in Karachi (07:00 UTC)
const NOW = new Date("2026-11-10T07:00:00Z");
const check = (date, time, now = NOW) => validateReservationDateTime({ date, time }, now);

describe("validateReservationDateTime", () => {
  test("converts Karachi local time to the correct UTC instant", () => {
    // Karachi is UTC+5 all year, so 19:00 local is 14:00 UTC
    const result = check("2026-11-12", "19:00");
    assert.equal(result.valid, true);
    assert.ok(result.startTime instanceof Date);
    assert.equal(result.startTime.toISOString(), "2026-11-12T14:00:00.000Z");
  });

  test("handles times that fall on the previous day in UTC", () => {
    // 01:30 on the 12th in Karachi is 20:30 on the 11th in UTC
    assert.equal(check("2026-11-12", "01:30").startTime.toISOString(), "2026-11-11T20:30:00.000Z");
  });

  test("rejects dates that don't exist", () => {
    for (const date of ["2026-02-30", "2026-11-31", "2026-13-01", "2026-00-10", "2027-02-29"]) {
      assert.equal(check(date, "19:00").code, "INVALID_DATE", date);
    }
  });

  test("rejects dates in the wrong format", () => {
    for (const date of ["12-11-2026", "2026/11/12", "2026-1-5", "tomorrow", "", null, undefined, 20261112]) {
      assert.equal(check(date, "19:00").code, "INVALID_DATE", String(date));
    }
  });

  test("rejects invalid times", () => {
    for (const time of ["24:00", "19:60", "7:00", "7pm", "19:00:00", "19.00", "", null]) {
      assert.equal(check("2026-11-12", time).code, "INVALID_TIME", String(time));
    }
  });

  test("rejects past dates and times", () => {
    assert.equal(check("2026-11-09", "19:00").code, "DATE_IN_PAST");
    // Earlier the same day
    assert.equal(check("2026-11-10", "11:59").code, "DATE_IN_PAST");
    // Exactly now is not in the future
    assert.equal(check("2026-11-10", "12:00").code, "DATE_IN_PAST");
    // One minute from now is fine
    assert.equal(check("2026-11-10", "12:01").valid, true);
  });

  test("accepts exactly 30 days ahead", () => {
    const result = check("2026-12-10", "12:00");
    assert.equal(result.valid, true);
    assert.equal(result.startTime.toISOString(), "2026-12-10T07:00:00.000Z");
  });

  test("rejects more than 30 days ahead", () => {
    assert.equal(check("2026-12-10", "12:01").code, "TOO_FAR_AHEAD");
    assert.equal(check("2026-12-11", "12:00").code, "TOO_FAR_AHEAD");
  });

  test("returns a message for every failure", () => {
    const result = check("2026-02-30", "19:00");
    assert.equal(result.valid, false);
    assert.equal(typeof result.message, "string");
    assert.ok(result.message.length > 0);
  });

  test("rejects an invalid clock", () => {
    assert.throws(() => validateReservationDateTime({ date: "2026-11-12", time: "19:00" }, "now"), TypeError);
    assert.throws(() => validateReservationDateTime({ date: "2026-11-12", time: "19:00" }, new Date("x")), TypeError);
  });

  test("gives the same result whatever the server's timezone", () => {
    // Run the conversion in separate Node processes with different TZ settings
    const script = `
      const { validateReservationDateTime } = require(${JSON.stringify(path.join(__dirname, "../src/services/datetime-validation.service"))});
      const r = validateReservationDateTime({ date: "2026-11-12", time: "19:00" }, new Date("2026-11-10T07:00:00Z"));
      process.stdout.write(r.startTime.toISOString() + " " + new Date().getTimezoneOffset());
    `;
    const offsets = new Set();
    for (const tz of ["UTC", "America/New_York", "Asia/Tokyo", "Pacific/Kiritimati", "Asia/Karachi"]) {
      const [iso, offset] = execFileSync(process.execPath, ["-e", script], {
        env: { ...process.env, TZ: tz },
        encoding: "utf8",
      }).split(" ");
      assert.equal(iso, "2026-11-12T14:00:00.000Z", tz);
      offsets.add(offset);
    }
    // Shows the processes really ran in different timezones
    assert.ok(offsets.size >= 4);
  });
});
