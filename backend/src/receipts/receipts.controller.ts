import { Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WorkspaceGuard } from '../workspaces/workspace.guard';
import { ReceiptsService } from './receipts.service';

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

@Controller('workspaces/:workspaceId/receipts')
@UseGuards(JwtAuthGuard, WorkspaceGuard)
export class ReceiptsController {
  constructor(private readonly receiptsService: ReceiptsService) {}

  @Get()
  list(@Param('workspaceId') workspaceId: string) {
    return this.receiptsService.listForWorkspace(workspaceId);
  }

  // Declared before the ':receiptId' routes so "summary" isn't taken as an id.
  @Get('summary/months')
  months(@Param('workspaceId') workspaceId: string) {
    return this.receiptsService.availableMonths(workspaceId);
  }

  @Get('summary')
  summary(
    @Param('workspaceId') workspaceId: string,
    @Query('month') month?: string,
  ) {
    return this.receiptsService.monthlySummary(
      workspaceId,
      month || currentMonth(),
    );
  }

  @Get(':receiptId')
  get(@Param('workspaceId') workspaceId: string, @Param('receiptId') receiptId: string) {
    return this.receiptsService.get(workspaceId, receiptId);
  }

  @Patch(':receiptId/confirm')
  confirm(@Param('workspaceId') workspaceId: string, @Param('receiptId') receiptId: string) {
    return this.receiptsService.confirm(workspaceId, receiptId);
  }
}
