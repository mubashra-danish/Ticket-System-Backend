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
@Controller('api')
export class PaymentsController {
  constructor(
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(AppService) private readonly store: AppService | MongoService,
  ) {}
  @Post('events/:id/orders') create(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.payments.create(id, body);
  }
  @Post('payments/status') @HttpCode(200) status(
    @Body() body: Record<string, unknown>,
  ) {
    return this.payments.status(body);
  }
  @Post('payments/verify') @HttpCode(200) verify(
    @Body() body: Record<string, unknown>,
  ) {
    return this.payments.verify(body);
  }
  @Post('payments/refresh') @HttpCode(200) refresh(
    @Body() body: Record<string, unknown>,
  ) {
    return this.payments.refresh(body);
  }
  @Post('payments/razorpay/webhook') @HttpCode(200) webhook(
    @Req() req: Request & { rawBody?: Buffer },
  ) {
    return this.payments.webhook(
      req.rawBody,
      req.headers['x-razorpay-signature'],
    );
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
