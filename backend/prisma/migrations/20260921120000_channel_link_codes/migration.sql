-- One-time codes that link a LINE/Telegram chat to a workspace.
-- Generated with `prisma migrate diff`; the GRANT and the RLS note at the bottom are hand-written.

-- CreateEnum
CREATE TYPE "ChannelType" AS ENUM ('LINE', 'TELEGRAM');

-- CreateTable
CREATE TABLE "channel_link_codes" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "channel" "ChannelType" NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_link_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "channel_link_codes_codeHash_key" ON "channel_link_codes"("codeHash");

-- CreateIndex
CREATE INDEX "channel_link_codes_workspaceId_channel_idx" ON "channel_link_codes"("workspaceId", "channel");

-- AddForeignKey
ALTER TABLE "channel_link_codes" ADD CONSTRAINT "channel_link_codes_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The app role (created by the enable_rls migration) may use the table.
-- Deliberately NO row-level security here: the bot webhook redeems a code
-- before it knows which workspace it belongs to, exactly like the
-- `workspaces` lookup by lineUserId/telegramChatId. Codes are stored hashed,
-- single-use and short-lived; see docs/decisions.md.
GRANT SELECT, INSERT, UPDATE, DELETE ON "channel_link_codes" TO receipts_app;
