// Gives a test file its own throwaway SQLite database, never dev.db.
// Call this before anything loads src/lib/prisma.js: the Prisma client reads
// DATABASE_URL when it's created, and dotenv doesn't override a variable that's set.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

const migrationsDir = path.join(__dirname, "../../prisma/migrations");

// Returns a function that deletes the database afterwards
function useTestDatabase() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hammad-foods-test-"));
  const dbPath = path.join(tempDir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;

  // Build the schema by running the project's migrations in order
  const setupDb = new Database(dbPath);
  for (const name of fs.readdirSync(migrationsDir).sort()) {
    const sqlFile = path.join(migrationsDir, name, "migration.sql");
    if (fs.existsSync(sqlFile)) setupDb.exec(fs.readFileSync(sqlFile, "utf8"));
  }
  setupDb.close();

  return () => fs.rmSync(tempDir, { recursive: true, force: true });
}

module.exports = { useTestDatabase };
