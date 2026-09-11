import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { PaymentsService } from './payments.service';

@Controller('v1/payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post()
  create(
    @Headers('privy-id-token') token: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    return this.payments.create(token, key, body);
  }

  @Get(':id')
  get(
    @Headers('privy-id-token') token: string | undefined,
    @Param('id') id: string,
  ) {
    return this.payments.get(token, id);
  }

  @Post(':id/submission')
  register(
    @Headers('privy-id-token') token: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.payments.register(token, id, key, body);
  }
}
