import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AppService } from './app.service.js';
import type { MongoService } from './mongo.service.js';
import { sessionToken } from './app.controller.js';
import { PaymentsService } from './payments.service.js';
import { EmailVerificationService } from './email-verification.service.js';
@Controller('api')
export class PaymentsController {
  constructor(
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(AppService) private readonly store: AppService | MongoService,
    @Inject(EmailVerificationService)
    private readonly verification: EmailVerificationService,
  ) {}
  @Post('events/:id/orders') create(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    this.verification.assertVerified(id, body);
    return this.payments.create(id, body);
  }
  @Post('payments/status') @HttpCode(200) status(
    @Body() body: Record<string, unknown>,
  ) {
    return this.payments.status(body);
  }
  @Post('payments/submit') @HttpCode(200) submit(
    @Body() body: Record<string, unknown>,
  ) {
    return this.payments.submit(body);
  }
  @Post('payments/refresh') @HttpCode(200) refresh(
    @Body() body: Record<string, unknown>,
  ) {
    return this.payments.status(body);
  }
  @Post('payments/:id/approve') @HttpCode(200) async approve(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    await this.admin(req);
    return this.payments.approve(id, body, process.env.ADMIN_EMAIL || 'admin');
  }
  @Post('payments/:id/reject') @HttpCode(200) async reject(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    await this.admin(req);
    return this.payments.reject(id, body, process.env.ADMIN_EMAIL || 'admin');
  }
  @Get('payments/review') async review(@Req() req: Request) {
    await this.admin(req);
    return this.payments.review();
  }
  @Post('tickets/check-in') async checkin(
    @Req() req: Request,
    @Body() body: Record<string, unknown>,
  ) {
    await this.admin(req);
    return this.payments.checkin(body);
  }
  private async admin(req: Request) {
    if (!(await this.store.authenticated(sessionToken(req))))
      throw new UnauthorizedException('Please sign in');
  }
}
