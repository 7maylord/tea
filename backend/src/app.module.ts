import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SessionController } from './identity/session.controller';
import { SessionService } from './identity/session.service';
import { HandleController } from './identity/handle.controller';
import { ResolveController } from './identity/resolve.controller';

@Module({
  imports: [],
  controllers: [
    AppController,
    SessionController,
    HandleController,
    ResolveController,
  ],
  providers: [AppService, SessionService],
})
export class AppModule {}
