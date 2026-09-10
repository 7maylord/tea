import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SessionController } from './identity/session.controller';
import { SessionService } from './identity/session.service';
import { HandleController } from './identity/handle.controller';
import { ResolveController } from './identity/resolve.controller';
import { FundsController } from './funds/funds.controller';
import { FundsService } from './funds/funds.service';

@Module({
  imports: [],
  controllers: [
    AppController,
    SessionController,
    HandleController,
    ResolveController,
    FundsController,
  ],
  providers: [AppService, SessionService, FundsService],
})
export class AppModule {}
