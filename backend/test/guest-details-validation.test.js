// Run with: npm test
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { validateGuestDetails } = require("../src/services/guest-details-validation.service");

const VALID_PHONE = "03001234567";
const VALID_NAME = "Hammad Amin";

const nameCode = (guestName) => validateGuestDetails({ guestName, guestPhone: VALID_PHONE }).code;
const phoneResult = (guestPhone) => validateGuestDetails({ guestName: VALID_NAME, guestPhone });

describe("validateGuestDetails", () => {
  test("accepts a local-format mobile number and converts it to +92", () => {
    assert.deepEqual(validateGuestDetails({ guestName: VALID_NAME, guestPhone: "03001234567" }), {
      valid: true,
      guestName: "Hammad Amin",
      guestPhone: "+923001234567",
    });
  });

  test("accepts a +92-format mobile number unchanged", () => {
    assert.deepEqual(validateGuestDetails({ guestName: VALID_NAME, guestPhone: "+923001234567" }), {
      valid: true,
      guestName: "Hammad Amin",
      guestPhone: "+923001234567",
    });
  });

  test("both formats of the same number give the same result", () => {
    for (const [local, international] of [
      ["03211234567", "+923211234567"],
      ["03451234567", "+923451234567"],
      ["03129876543", "+923129876543"],
    ]) {
      assert.equal(phoneResult(local).guestPhone, international);
      assert.equal(phoneResult(international).guestPhone, international);
    }
  });

  test("accepts names with spaces, hyphens, apostrophes and non-English characters", () => {
    for (const name of [
      "Hammad Amin",
      "Mary-Jane Smith",
      "O'Brien",
      "Zoë Ångström",
      "José Núñez",
      "حماد امین",
      "محمد",
      "李小龙",
      "A",
      "Dr. Ayesha Khan",
    ]) {
      const result = validateGuestDetails({ guestName: name, guestPhone: VALID_PHONE });
      assert.equal(result.valid, true, name);
      assert.equal(result.guestName, name);
    }
  });

  test("trims whitespace around valid inputs", () => {
    const result = validateGuestDetails({ guestName: "  Hammad Amin \n", guestPhone: " \t03001234567  " });
    assert.deepEqual(result, { valid: true, guestName: "Hammad Amin", guestPhone: "+923001234567" });
    assert.equal(phoneResult("  +923001234567 ").guestPhone, "+923001234567");
  });

  test("keeps the spaces inside a name", () => {
    assert.equal(validateGuestDetails({ guestName: "  Syed  Ali  ", guestPhone: VALID_PHONE }).guestName, "Syed  Ali");
  });

  test("rejects empty and whitespace-only names", () => {
    for (const name of ["", " ", "   ", "\t\n", " "]) {
      assert.equal(nameCode(name), "INVALID_NAME", JSON.stringify(name));
    }
  });

  test("rejects missing and non-string names", () => {
    for (const name of [undefined, null, 0, 123, true, ["Hammad"], { name: "Hammad" }]) {
      assert.equal(nameCode(name), "INVALID_NAME", String(name));
    }
    assert.equal(validateGuestDetails({ guestPhone: VALID_PHONE }).code, "INVALID_NAME");
  });

  test("rejects missing and non-string phone numbers", () => {
    for (const phone of [undefined, null, "", "   ", 3001234567, 923001234567, true, ["03001234567"]]) {
      assert.equal(phoneResult(phone).code, "INVALID_PHONE", String(phone));
    }
    assert.equal(validateGuestDetails({ guestName: VALID_NAME }).code, "INVALID_PHONE");
  });

  test("rejects a missing argument", () => {
    assert.equal(validateGuestDetails().code, "INVALID_NAME");
  });

  test("rejects phone numbers of the wrong length", () => {
    for (const phone of [
      "0300123456", // 10 digits
      "030012345678", // 12 digits
      "+92300123456", // 9 digits after +92
      "+9230012345678", // 11 digits after +92
      "03",
      "+92",
    ]) {
      assert.equal(phoneResult(phone).code, "INVALID_PHONE", phone);
    }
  });

  test("rejects numbers without the mobile prefix", () => {
    for (const phone of [
      "3001234567", // missing the leading 0
      "00923001234567", // 00 instead of +
      "923001234567", // missing +
      "+9203001234567", // both +92 and the leading 0
      "04001234567", // doesn't start with 03
      "+924001234567",
    ]) {
      assert.equal(phoneResult(phone).code, "INVALID_PHONE", phone);
    }
  });

  test("rejects landline numbers", () => {
    for (const phone of [
      "02134567890", // Karachi
      "04235678901", // Lahore
      "0512345678", // Islamabad
      "+922134567890",
      "+92421234567",
    ]) {
      assert.equal(phoneResult(phone).code, "INVALID_PHONE", phone);
    }
  });

  test("rejects other countries' numbers", () => {
    for (const phone of [
      "+13001234567", // US/Canada
      "+447911123456", // UK
      "+919876543210", // India
      "+971501234567", // UAE
      "+9613001234567",
    ]) {
      assert.equal(phoneResult(phone).code, "INVALID_PHONE", phone);
    }
  });

  test("never repairs malformed numbers", () => {
    for (const phone of [
      "0300-1234567",
      "0300 1234567",
      "+92 300 1234567",
      "+92-300-1234567",
      "(0300) 1234567",
      "0300.123.4567",
      "03001234567x",
      "o3001234567", // letter o instead of zero
      "٠٣٠٠١٢٣٤٥٦٧", // Arabic-Indic digits
      "0３001234567", // full-width digit
      "03001234567\n03001234567",
    ]) {
      const result = phoneResult(phone);
      assert.equal(result.valid, false, phone);
      assert.equal(result.code, "INVALID_PHONE", phone);
      assert.equal(result.guestPhone, undefined, phone);
    }
  });

  test("failures have the documented shape and messages", () => {
    const name = validateGuestDetails({ guestName: " ", guestPhone: VALID_PHONE });
    assert.deepEqual(Object.keys(name).sort(), ["code", "message", "valid"]);
    assert.ok(name.message.length > 0);

    assert.deepEqual(phoneResult("12345"), {
      valid: false,
      code: "INVALID_PHONE",
      message: "Please provide a valid Pakistani mobile number.",
    });
  });

  test("checks the name before the phone number", () => {
    assert.equal(validateGuestDetails({ guestName: "", guestPhone: "bad" }).code, "INVALID_NAME");
  });
});
