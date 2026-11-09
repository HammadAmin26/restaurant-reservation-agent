-- Hand-written instead of Prisma's generated SQL, which dropped and re-added
-- the columns and would have lost their values.
-- Renames the PKR price columns to paisa and converts existing values (PKR x 100).
-- RENAME COLUMN keeps each column's type, constraints, and data.

ALTER TABLE "Reservation" RENAME COLUMN "totalPricePkr" TO "totalPricePaisa";
UPDATE "Reservation" SET "totalPricePaisa" = "totalPricePaisa" * 100 WHERE "totalPricePaisa" IS NOT NULL;

ALTER TABLE "ReservationExtra" RENAME COLUMN "unitPricePkr" TO "unitPricePaisa";
UPDATE "ReservationExtra" SET "unitPricePaisa" = "unitPricePaisa" * 100;
