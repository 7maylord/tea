import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { SplitsService } from './splits.service';

@Controller('v1/splits')
export class SplitsController {
  constructor(private readonly splits: SplitsService) {}

  @Post()
  create(
    @Headers('privy-id-token') token: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    return this.splits.create(token, key, body);
  }

  @Get()
  list(@Headers('privy-id-token') token: string | undefined) {
    return this.splits.list(token);
  }

  @Post(':splitId/obligations/:obligationId/payment')
  payment(
    @Headers('privy-id-token') token: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Param('splitId') splitId: string,
    @Param('obligationId') obligationId: string,
  ) {
    return this.splits.preparePayment(token, splitId, obligationId, key);
  }
}
