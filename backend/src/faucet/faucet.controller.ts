import { Body, Controller, Headers, Post } from '@nestjs/common';
import { FaucetService } from './faucet.service';

@Controller('v1/faucet')
export class FaucetController {
  constructor(private readonly faucet: FaucetService) {}

  @Post('claim')
  claim(
    @Headers('privy-id-token') token: string | undefined,
    @Body() body: unknown,
  ) {
    return this.faucet.claim(token, body);
  }

  @Post('gas')
  gas(@Headers('privy-id-token') token: string | undefined) {
    return this.faucet.gas(token);
  }
}
