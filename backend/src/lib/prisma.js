// Load DATABASE_URL from the .env file into process.env
require("dotenv").config();

const { PrismaBetterSqlite3 } = require("@prisma/adapter-better-sqlite3");
const { PrismaClient } = require("../generated/prisma");

// Prisma 7 connects to the database through a driver adapter
const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL });

// Share one client across the whole app
const prisma = new PrismaClient({ adapter });

module.exports = prisma;
