import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configure } from './configure.js';
if (
  !process.env.ADMIN_EMAIL ||
  !/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(process.env.ADMIN_PASSWORD_HASH || '')
)
  throw new Error('Run npm run setup to configure the admin account first');
const app = await NestFactory.create<NestExpressApplication>(AppModule, {
  rawBody: true,
});
configure(app);
await app.listen(
  Number(process.env.PORT || 8000),
  process.env.HOST || '127.0.0.1',
);
