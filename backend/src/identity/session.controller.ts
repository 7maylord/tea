import { Body, Controller, Headers, Post } from '@nestjs/common';
import { SessionService } from './session.service';

@Controller('v1/session')
export class SessionController {
  constructor(private readonly sessions: SessionService) {}

  @Post('sync')
  sync(
    @Headers('privy-id-token') token: string | undefined,
    @Body() body: unknown,
  ) {
    return this.sessions.sync(token, body, false);
  }
}
