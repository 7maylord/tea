import { Body, Controller, Headers, Post } from '@nestjs/common';
import { SessionService } from './session.service';

@Controller('v1/me')
export class HandleController {
  constructor(private readonly sessions: SessionService) {}

  @Post('handle')
  reserve(
    @Headers('privy-id-token') token: string | undefined,
    @Body() body: unknown,
  ) {
    const handle =
      body && typeof body === 'object' && 'handle' in body
        ? body.handle
        : undefined;
    return this.sessions.reserveHandle(token, handle);
  }
}
