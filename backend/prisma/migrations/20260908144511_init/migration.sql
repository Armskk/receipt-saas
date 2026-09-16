-- CreateEnum
CREATE TYPE "WorkspaceRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "ReceiptSource" AS ENUM ('WEB', 'LINE', 'TELEGRAM');

-- CreateEnum
CREATE TYPE "ReceiptStatus" AS ENUM ('PENDING', 'PROCESSING', 'PARSED', 'CONFIRMED', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lineUserId" TEXT,
    "telegramChatId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_members" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "WorkspaceRole" NOT NULL DEFAULT 'MEMBER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipts" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "source" "ReceiptSource" NOT NULL,
    "sourceRef" TEXT,
    "imageKey" TEXT NOT NULL,
    "merchantName" TEXT,
    "purchaseDate" TIMESTAMP(3),
    "currency" TEXT NOT NULL DEFAULT 'THB',
    "subtotal" DECIMAL(12,2),
    "discountTotal" DECIMAL(12,2),
    "total" DECIMAL(12,2),
    "status" "ReceiptStatus" NOT NULL DEFAULT 'PENDING',
    "rawAgentResponse" JSONB,
    "failureReason" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_items" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "categoryId" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(10,3),
    "unitPrice" DECIMAL(12,2),
    "amount" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_logs" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "receiptId" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "imageCount" INTEGER NOT NULL DEFAULT 1,
    "estimatedCostUsd" DECIMAL(10,4),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_lineUserId_key" ON "workspaces"("lineUserId");

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_telegramChatId_key" ON "workspaces"("telegramChatId");

-- CreateIndex
CREATE INDEX "workspace_members_userId_idx" ON "workspace_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_members_workspaceId_userId_key" ON "workspace_members"("workspaceId", "userId");

-- CreateIndex
CREATE INDEX "categories_workspaceId_idx" ON "categories"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "categories_workspaceId_name_key" ON "categories"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "receipts_workspaceId_createdAt_idx" ON "receipts"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "receipts_workspaceId_status_idx" ON "receipts"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "receipt_items_receiptId_idx" ON "receipt_items"("receiptId");

-- CreateIndex
CREATE INDEX "usage_logs_workspaceId_createdAt_idx" ON "usage_logs"("workspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_items" ADD CONSTRAINT "receipt_items_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_items" ADD CONSTRAINT "receipt_items_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
