import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { StreamsService } from './streams.service';

@Controller('v1/streams')
export class StreamsController {
  constructor(private readonly streams: StreamsService) {}

  @Post()
  create(
    @Headers('privy-id-token') token: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    return this.streams.create(token, key, body);
  }

  @Get(':id')
  get(
    @Headers('privy-id-token') token: string | undefined,
    @Param('id') id: string,
  ) {
    return this.streams.get(token, id);
  }

  @Post(':id/submission')
  register(
    @Headers('privy-id-token') token: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.streams.register(token, id, key, body);
  }

  @Post(':id/withdraw')
  withdraw(
    @Headers('privy-id-token') token: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Param('id') id: string,
  ) {
    return this.streams.action(token, key, id, 'withdraw');
  }

  @Post(':id/cancel')
  cancel(
    @Headers('privy-id-token') token: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Param('id') id: string,
  ) {
    return this.streams.action(token, key, id, 'cancel');
  }

  @Get(':id/actions/:actionId')
  getAction(
    @Headers('privy-id-token') token: string | undefined,
    @Param('id') id: string,
    @Param('actionId') actionId: string,
  ) {
    return this.streams.getAction(token, id, actionId);
  }

  @Post(':id/actions/:actionId/submission')
  registerAction(
    @Headers('privy-id-token') token: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Param('id') id: string,
    @Param('actionId') actionId: string,
    @Body() body: unknown,
  ) {
    return this.streams.registerAction(token, id, actionId, key, body);
  }
}
