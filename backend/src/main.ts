import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import type { NextFunction, Request, Response } from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: process.env.APP_ORIGIN
      ? [process.env.APP_ORIGIN]
      : ['http://127.0.0.1:3000', 'http://localhost:3000'],
  });
  app.use(
    '/v1',
    (_request: Request, response: Response, next: NextFunction) => {
      response.setHeader('Cache-Control', 'no-store');
      next();
    },
  );
  await app.listen(process.env.PORT ?? 3001);
}
void bootstrap();
