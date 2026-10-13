import { Controller, Get, Headers } from '@nestjs/common';
import { FundsService } from './funds.service';

@Controller('v1')
export class FundsController {
  constructor(private readonly funds: FundsService) {}

  @Get('balance')
  balance(@Headers('privy-id-token') token: string | undefined) {
    return this.funds.balance(token);
  }

  @Get('balances')
  balances(@Headers('privy-id-token') token: string | undefined) {
    return this.funds.balances(token);
  }
}
