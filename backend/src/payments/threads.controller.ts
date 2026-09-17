import { Controller, Get, Headers, Param, Query } from '@nestjs/common';
import { PaymentsService } from './payments.service';

@Controller('v1/threads')
export class ThreadsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  list(
    @Headers('privy-id-token') token: string | undefined,
    @Query('cursor') cursor: string | undefined,
  ) {
    return this.payments.threads(token, cursor);
  }

  @Get(':id')
  detail(
    @Headers('privy-id-token') token: string | undefined,
    @Param('id') id: string,
    @Query('cursor') cursor: string | undefined,
  ) {
    return this.payments.threadDetail(token, id, cursor);
  }
}
