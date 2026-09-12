import { Controller, Get, Headers, Query } from '@nestjs/common';
import { PaymentsService } from './payments.service';

@Controller('v1/activity')
export class ActivityController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  list(
    @Headers('privy-id-token') token: string | undefined,
    @Query('cursor') cursor: string | undefined,
  ) {
    return this.payments.activity(token, cursor);
  }
}
