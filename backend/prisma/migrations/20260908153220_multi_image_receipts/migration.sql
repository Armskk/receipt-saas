/*
  Warnings:

  - You are about to drop the column `imageKey` on the `receipts` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "receipts" DROP COLUMN "imageKey",
ADD COLUMN     "imageKeys" TEXT[];
