/*
  Warnings:

  - You are about to drop the column `reservationDate` on the `Reservation` table. All the data in the column will be lost.
  - You are about to drop the column `serviceType` on the `Reservation` table. All the data in the column will be lost.
  - You are about to drop the column `specialRequests` on the `Reservation` table. All the data in the column will be lost.
  - You are about to drop the column `totalPricePaisa` on the `Reservation` table. All the data in the column will be lost.
  - Made the column `expiresAt` on table `Proposal` required. This step will fail if there are existing NULL values in that column.
  - Added the required column `endTime` to the `Reservation` table without a default value. This is not possible if the table is not empty.
  - Added the required column `mealType` to the `Reservation` table without a default value. This is not possible if the table is not empty.
  - Added the required column `reservationCode` to the `Reservation` table without a default value. This is not possible if the table is not empty.
  - Added the required column `startTime` to the `Reservation` table without a default value. This is not possible if the table is not empty.
  - Added the required column `extraKey` to the `ReservationExtra` table without a default value. This is not possible if the table is not empty.
  - Added the required column `lineTotalPaisa` to the `ReservationExtra` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Proposal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "reservationId" TEXT,
    "actionType" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Proposal_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Proposal_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Proposal" ("actionType", "conversationId", "createdAt", "expiresAt", "id", "payload", "reservationId", "status", "updatedAt") SELECT "actionType", "conversationId", "createdAt", "expiresAt", "id", "payload", "reservationId", "status", "updatedAt" FROM "Proposal";
DROP TABLE "Proposal";
ALTER TABLE "new_Proposal" RENAME TO "Proposal";
CREATE INDEX "Proposal_conversationId_status_idx" ON "Proposal"("conversationId", "status");
CREATE INDEX "Proposal_reservationId_idx" ON "Proposal"("reservationId");
CREATE TABLE "new_Reservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "reservationCode" TEXT NOT NULL,
    "guestName" TEXT NOT NULL,
    "guestPhone" TEXT NOT NULL,
    "startTime" DATETIME NOT NULL,
    "endTime" DATETIME NOT NULL,
    "mealType" TEXT NOT NULL,
    "adults" INTEGER NOT NULL,
    "children" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'confirmed',
    "estimatedTotalPaisa" INTEGER NOT NULL DEFAULT 0,
    "specialRequest" TEXT,
    "cancelledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Reservation_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
-- Edited by hand: renamed columns keep their values. reservationCode and endTime have
-- no old value, so on a non-empty table this fails (and rolls back) instead of losing data.
INSERT INTO "new_Reservation" ("adults", "cancelledAt", "children", "conversationId", "createdAt", "guestName", "guestPhone", "id", "status", "updatedAt", "startTime", "mealType", "estimatedTotalPaisa", "specialRequest") SELECT "adults", "cancelledAt", "children", "conversationId", "createdAt", "guestName", "guestPhone", "id", "status", "updatedAt", "reservationDate", "serviceType", COALESCE("totalPricePaisa", 0), "specialRequests" FROM "Reservation";
DROP TABLE "Reservation";
ALTER TABLE "new_Reservation" RENAME TO "Reservation";
CREATE UNIQUE INDEX "Reservation_reservationCode_key" ON "Reservation"("reservationCode");
CREATE INDEX "Reservation_conversationId_idx" ON "Reservation"("conversationId");
CREATE INDEX "Reservation_startTime_status_idx" ON "Reservation"("startTime", "status");
CREATE TABLE "new_ReservationExtra" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reservationId" TEXT NOT NULL,
    "extraKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPricePaisa" INTEGER NOT NULL,
    "lineTotalPaisa" INTEGER NOT NULL,
    "approvalStatus" TEXT NOT NULL DEFAULT 'not_required',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReservationExtra_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
-- Edited by hand: lineTotalPaisa is calculated from the old rows. extraKey has no old
-- value, so on a non-empty table this fails (and rolls back) instead of losing data.
INSERT INTO "new_ReservationExtra" ("createdAt", "id", "name", "quantity", "reservationId", "unitPricePaisa", "lineTotalPaisa") SELECT "createdAt", "id", "name", "quantity", "reservationId", "unitPricePaisa", "unitPricePaisa" * "quantity" FROM "ReservationExtra";
DROP TABLE "ReservationExtra";
ALTER TABLE "new_ReservationExtra" RENAME TO "ReservationExtra";
CREATE INDEX "ReservationExtra_reservationId_idx" ON "ReservationExtra"("reservationId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
