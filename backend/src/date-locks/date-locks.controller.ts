import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { DateLocksService } from './date-locks.service';

@Controller('v1/date-locks')
export class DateLocksController {
  constructor(private readonly dateLocks: DateLocksService) {}

  @Post()
  create(
    @Headers('privy-id-token') token: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    return this.dateLocks.create(token, key, body);
  }

  @Get(':id')
  get(
    @Headers('privy-id-token') token: string | undefined,
    @Param('id') id: string,
  ) {
    return this.dateLocks.get(token, id);
  }

  @Post(':id/submission')
  register(
    @Headers('privy-id-token') token: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.dateLocks.register(token, id, key, body);
  }

  @Post(':id/withdraw')
  withdraw(
    @Headers('privy-id-token') token: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Param('id') id: string,
  ) {
    return this.dateLocks.withdraw(token, key, id);
  }

  @Get(':id/actions/:actionId')
  getAction(
    @Headers('privy-id-token') token: string | undefined,
    @Param('id') id: string,
    @Param('actionId') actionId: string,
  ) {
    return this.dateLocks.getAction(token, id, actionId);
  }

  @Post(':id/actions/:actionId/submission')
  registerAction(
    @Headers('privy-id-token') token: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Param('id') id: string,
    @Param('actionId') actionId: string,
    @Body() body: unknown,
  ) {
    return this.dateLocks.registerAction(token, id, actionId, key, body);
  }
}
