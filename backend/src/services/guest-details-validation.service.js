// Pakistani mobile numbers: 3 followed by 9 digits after the country code,
// written either as 03XXXXXXXXX or +923XXXXXXXXX. Landlines start with other
// digits (Karachi is 021...), so they don't match.
const LOCAL_MOBILE = /^03\d{9}$/;
const INTERNATIONAL_MOBILE = /^\+923\d{9}$/;

const invalid = (code, message) => ({ valid: false, code, message });

// A Pakistani mobile number in the +92 format, or null if it isn't one.
// Only surrounding whitespace is removed. Spaces or dashes inside the number,
// or any other mistake, make it invalid rather than being fixed silently.
function normalizeMobilePhone(value) {
  const phone = typeof value === "string" ? value.trim() : "";
  // 03001234567 -> +923001234567
  if (LOCAL_MOBILE.test(phone)) return `+92${phone.slice(1)}`;
  if (INTERNATIONAL_MOBILE.test(phone)) return phone;
  return null;
}

// Check the guest's name and phone number, and return them cleaned up:
// the name trimmed, and the phone number in the +92 format.
// Returns { valid: true, guestName, guestPhone } or { valid: false, code, message }.
function validateGuestDetails({ guestName, guestPhone } = {}) {
  // Any characters are allowed, so names like "Zoë O'Brien-Khan" or "حماد" are fine
  const name = typeof guestName === "string" ? guestName.trim() : "";
  if (name === "") {
    return invalid("INVALID_NAME", "Please provide the name for the reservation.");
  }

  const normalizedPhone = normalizeMobilePhone(guestPhone);
  if (!normalizedPhone) {
    return invalid("INVALID_PHONE", "Please provide a valid Pakistani mobile number.");
  }

  return { valid: true, guestName: name, guestPhone: normalizedPhone };
}

module.exports = { validateGuestDetails, normalizeMobilePhone };
