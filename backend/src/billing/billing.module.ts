import { Module } from '@nestjs/common';

// Stub — wire up Stripe or Omise here when ready to charge. Suggested shape:
// a BillingService with createCheckoutSession(workspaceId, planId) and a
// webhook controller (billing.webhook.controller.ts) that listens for
// payment events and flips a Workspace.plan / subscriptionStatus field
// (add those columns to the Workspace model in schema.prisma first).
@Module({})
export class BillingModule {}
