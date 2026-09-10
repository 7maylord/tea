import { Controller, Get, Headers, Post } from '@nestjs/common';
import { FundsService } from './funds.service';

@Controller('v1')
export class FundsController {
  constructor(private readonly funds: FundsService) {}

  @Get('balance')
  balance(@Headers('privy-id-token') token: string | undefined) {
    return this.funds.balance(token);
  }

  @Post('local/faucet')
  faucet(@Headers('privy-id-token') token: string | undefined) {
    return this.funds.localFaucet(token);
  }
}
