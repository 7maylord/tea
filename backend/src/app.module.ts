import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SessionController } from './identity/session.controller';
import { SessionService } from './identity/session.service';
import { HandleController } from './identity/handle.controller';

@Module({
  imports: [],
  controllers: [AppController, SessionController, HandleController],
  providers: [AppService, SessionService],
})
export class AppModule {}
