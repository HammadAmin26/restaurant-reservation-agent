const prisma = require("../lib/prisma");
const restaurantPolicies = require("../config/restaurant-policies");
const { validateParty } = require("./party-validation.service");

// Parties with children must sit in this section
const FAMILY_SECTION = restaurantPolicies.children.requiredSectionForPartiesWithChildren;

// Sections are tried in this order, so adults-only parties use GENERAL first and
// FAMILY tables stay free for parties with children. Any other section comes last.
const SECTION_PREFERENCE = ["GENERAL", FAMILY_SECTION];

// Every subset of a section's tables is checked, so keep sections small enough for that
const MAX_TABLES_PER_SECTION = 20;

// Orders tables as T1, T2, ... T10 instead of T1, T10, T2
const byTableNumber = (a, b) =>
  a.tableNumber.localeCompare(b.tableNumber, "en", { numeric: true });

// Active tables that no confirmed reservation is using during [startTime, endTime).
// Read-only: a table returned here can still be taken by another request before it is
// booked, so creating a reservation must check availability again.
// excludeReservationId is a reservation being modified: its own tables count as free.
// db is the Prisma client, or a transaction client to read inside a transaction.
async function getAvailableTables({ startTime, endTime, children, excludeReservationId }, db = prisma) {
  if (!(startTime instanceof Date) || !(endTime instanceof Date) || !(startTime < endTime)) {
    throw new RangeError("startTime and endTime must be Dates, with startTime before endTime");
  }
  if (!Number.isInteger(children) || children < 0) {
    throw new RangeError("children must be a whole number, 0 or more");
  }
  if (excludeReservationId !== undefined && (typeof excludeReservationId !== "string" || excludeReservationId === "")) {
    throw new RangeError("excludeReservationId must be a non-empty string when given");
  }

  const tables = await db.restaurantTable.findMany({
    where: {
      isActive: true,
      ...(children > 0 && { section: FAMILY_SECTION }),
      // Two bookings overlap when each one starts before the other ends.
      // Cancelled reservations don't count.
      reservations: {
        none: {
          reservation: {
            status: "confirmed",
            startTime: { lt: endTime },
            endTime: { gt: startTime },
            ...(excludeReservationId && { id: { not: excludeReservationId } }),
          },
        },
      },
    },
  });

  return tables.sort(byTableNumber);
}

// Sort key for a section: its place in SECTION_PREFERENCE, other sections after
const sectionRank = (section) => {
  const index = SECTION_PREFERENCE.indexOf(section);
  return index === -1 ? SECTION_PREFERENCE.length : index;
};

// The best combination within one section: the fewest empty seats, then the
// fewest tables. Further ties keep the first one found, which follows table order.
// Returns null if the section can't seat the party.
function findBestInSection(sectionTables, partySize) {
  if (sectionTables.length > MAX_TABLES_PER_SECTION) {
    throw new RangeError(`A section can have at most ${MAX_TABLES_PER_SECTION} tables`);
  }

  let best = null;

  // Each bit of mask says whether that table is in the combination
  for (let mask = 1; mask < 1 << sectionTables.length; mask++) {
    const combination = sectionTables.filter((_, index) => mask & (1 << index));
    const capacity = combination.reduce((sum, table) => sum + table.capacity, 0);
    if (capacity < partySize) continue;

    const unusedSeats = capacity - partySize;
    if (
      !best ||
      unusedSeats < best.unusedSeats ||
      (unusedSeats === best.unusedSeats && combination.length < best.tables.length)
    ) {
      best = { tables: combination, unusedSeats };
    }
  }

  return best ? best.tables : null;
}

// Choose tables for the party, all from one section. Sections are tried in
// SECTION_PREFERENCE order, and the first one that can seat the whole party wins,
// even if a later section would leave fewer empty seats.
// Returns the chosen tables, or null if no section can seat the party.
function findBestTableCombination(tables, partySize) {
  if (!Number.isInteger(partySize) || partySize < 1) {
    throw new RangeError("partySize must be a whole number, 1 or more");
  }

  const sections = new Map();
  for (const table of [...tables].sort(byTableNumber)) {
    if (!sections.has(table.section)) sections.set(table.section, []);
    sections.get(table.section).push(table);
  }

  const orderedSections = [...sections.keys()].sort(
    (a, b) => sectionRank(a) - sectionRank(b) || a.localeCompare(b),
  );

  for (const section of orderedSections) {
    const combination = findBestInSection(sections.get(section), partySize);
    if (combination) return combination;
  }

  return null;
}

// Find the best free tables for a party, or null if none fit.
// Only identifies tables: it doesn't reserve them.
// The party must pass validateParty: at least one guest, adult or child.
// excludeReservationId is a reservation being modified: its own tables count as free.
// db is the Prisma client, or a transaction client to read inside a transaction.
async function findTablesForParty({ startTime, endTime, adults, children, excludeReservationId }, db = prisma) {
  const party = validateParty({ adults, children });
  if (!party.valid) {
    throw new RangeError(`Invalid party (${party.code}): ${party.message}`);
  }

  // Parties with children, including children-only parties, get FAMILY tables only
  const tables = await getAvailableTables(
    { startTime, endTime, children: party.children, excludeReservationId },
    db,
  );
  // Every guest needs a seat, including children
  return findBestTableCombination(tables, party.total);
}

module.exports = { getAvailableTables, findBestTableCombination, findTablesForParty };
