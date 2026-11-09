// Seeds the restaurant's table inventory. Safe to run more than once:
// each table is matched by its tableNumber, so nothing is duplicated or deleted.
const prisma = require("../src/lib/prisma");
const tables = require("../src/config/restaurant-tables");

async function main() {
  for (const { tableNumber, section, capacity } of tables) {
    // Creates the table, or brings an existing one back to these values
    await prisma.restaurantTable.upsert({
      where: { tableNumber },
      create: { tableNumber, section, capacity },
      update: { section, capacity },
    });
  }

  console.log(`Seeded ${tables.length} restaurant tables`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
