import {
  Controller,
  Get,
  Inject,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AppService } from './app.service.js';
import type { MongoService } from './mongo.service.js';
import { sessionToken } from './app.controller.js';
import { EmailService } from './email.service.js';
@Controller('api/emails')
export class EmailController {
  constructor(
    @Inject(AppService) private readonly store: AppService | MongoService,
    @Inject(EmailService) private readonly email: EmailService,
  ) {}
  @Get('status') async status(@Req() req: Request) {
    if (!(await this.store.authenticated(sessionToken(req))))
      throw new UnauthorizedException('Please sign in');
    return this.email.status();
  }
}
