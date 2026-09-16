import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SessionController } from './identity/session.controller';
import { SessionService } from './identity/session.service';
import { HandleController } from './identity/handle.controller';
import { ResolveController } from './identity/resolve.controller';
import { FundsController } from './funds/funds.controller';
import { FundsService } from './funds/funds.service';
import { PaymentsController } from './payments/payments.controller';
import { PaymentsService } from './payments/payments.service';
import { ActivityController } from './payments/activity.controller';
import { ClaimsController } from './claims/claims.controller';
import { ClaimsService } from './claims/claims.service';
import { StreamsController } from './streams/streams.controller';
import { StreamsService } from './streams/streams.service';

@Module({
  imports: [],
  controllers: [
    AppController,
    SessionController,
    HandleController,
    ResolveController,
    FundsController,
    PaymentsController,
    ActivityController,
    ClaimsController,
    StreamsController,
  ],
  providers: [
    AppService,
    SessionService,
    FundsService,
    PaymentsService,
    ClaimsService,
    StreamsService,
  ],
})
export class AppModule {}
