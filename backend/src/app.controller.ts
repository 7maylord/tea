import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { IndexerService } from './indexer/indexer.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly indexer: IndexerService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('health/live')
  getHealth(): { status: string } {
    return { status: 'ok' };
  }

  @Get('health/indexer')
  getIndexer() {
    return this.indexer.status();
  }
}
