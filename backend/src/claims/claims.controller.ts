import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { ClaimsService } from './claims.service';

@Controller('v1/claims')
export class ClaimsController {
  constructor(private readonly claims: ClaimsService) {}

  @Post()
  create(
    @Headers('privy-id-token') token: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    return this.claims.create(token, key, body);
  }

  @Get(':id')
  get(
    @Headers('privy-id-token') token: string | undefined,
    @Param('id') id: string,
  ) {
    return this.claims.get(token, id);
  }

  @Post(':id/deposit')
  registerDeposit(
    @Headers('privy-id-token') token: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.claims.registerDeposit(token, id, key, body);
  }

  @Post('resolve-link')
  resolveLink(
    @Headers('privy-id-token') token: string | undefined,
    @Body() body: unknown,
  ) {
    return this.claims.resolveLink(token, body);
  }
}
