import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppService } from './app.service.js';
import type { MongoService } from './mongo.service.js';
import { emailConfigured } from './email.service.js';
import { EmailVerificationService } from './email-verification.service.js';
export function sessionToken(req: Request) {
  return (
    (req.headers.cookie || '')
      .split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith('ticket_session='))
      ?.slice(15) || ''
  );
}
const cookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  path: '/',
});
@Controller('api')
export class AppController {
  constructor(
    @Inject(AppService) private readonly service: AppService | MongoService,
    @Inject(EmailVerificationService)
    private readonly verification: EmailVerificationService,
  ) {}
  private async admin(req: Request) {
    if (!(await this.service.authenticated(sessionToken(req))))
      throw new UnauthorizedException('Please sign in');
  }
  @Get('health') health() {
    return { status: 'ok' };
  }
  @Post('auth/login') async login(
    @Body() body: Record<string, unknown>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = await this.service.login(body);
    res.cookie('ticket_session', token, {
      ...cookieOptions(),
      maxAge: 8 * 60 * 60 * 1000,
    });
    return { ok: true };
  }
  @Get('auth/me') async me(@Req() req: Request) {
    await this.admin(req);
    return { email: process.env.ADMIN_EMAIL };
  }
  @Post('auth/logout') async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.service.logout(sessionToken(req));
    res.clearCookie('ticket_session', cookieOptions());
    return { ok: true };
  }
  @Get('events') events() {
    return this.service.events();
  }
  @Get('events/:id') event(@Param('id') id: string) {
    return this.service.event(id);
  }
  @Post('events') async create(
    @Req() req: Request,
    @Body() body: Record<string, unknown>,
  ) {
    await this.admin(req);
    return this.service.create(body);
  }
  @Post('events/:id/registrations') async register(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    this.verification.assertVerified(id, body);
    return {
      ...(await this.service.register(id, body)),
      emailStatus: emailConfigured() ? 'PENDING' : 'NOT_CONFIGURED',
    };
  }
  @Get('registrations') async registrations(@Req() req: Request) {
    await this.admin(req);
    return this.service.registrations();
  }
}
