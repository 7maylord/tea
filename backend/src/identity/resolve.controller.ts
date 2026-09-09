import { Body, Controller, Headers, Post } from '@nestjs/common';
import { SessionService } from './session.service';

@Controller('v1')
export class ResolveController {
  constructor(private readonly sessions: SessionService) {}

  @Post('resolve')
  resolve(
    @Headers('privy-id-token') token: string | undefined,
    @Body() body: unknown,
  ) {
    const input = body && typeof body === 'object' ? body : {};
    const kind = 'kind' in input ? input.kind : undefined;
    const value = 'value' in input ? input.value : undefined;
    return this.sessions.resolve(token, kind, value);
  }
}
