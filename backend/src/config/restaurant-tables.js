// Hammad Foods' table inventory. prisma/seed.js writes these to the database;
// the database is the source of truth once seeded.
const restaurantTables = [
  { tableNumber: "T1", section: "GENERAL", capacity: 2 },
  { tableNumber: "T2", section: "GENERAL", capacity: 2 },
  { tableNumber: "T3", section: "GENERAL", capacity: 4 },
  { tableNumber: "T4", section: "GENERAL", capacity: 4 },
  { tableNumber: "T5", section: "GENERAL", capacity: 4 },
  { tableNumber: "T6", section: "GENERAL", capacity: 6 },
  { tableNumber: "T7", section: "FAMILY", capacity: 4 },
  { tableNumber: "T8", section: "FAMILY", capacity: 4 },
  { tableNumber: "T9", section: "FAMILY", capacity: 6 },
  { tableNumber: "T10", section: "FAMILY", capacity: 8 },
];

module.exports = restaurantTables;
