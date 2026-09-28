import { Body, Controller, Inject, Post } from '@nestjs/common';
import { EmailVerificationService } from './email-verification.service.js';

@Controller('api/email-verification')
export class EmailVerificationController {
  constructor(
    @Inject(EmailVerificationService)
    private readonly verification: EmailVerificationService,
  ) {}
  @Post('send') send(@Body() body: Record<string, unknown>) {
    return this.verification.send(body);
  }
  @Post('verify') verify(@Body() body: Record<string, unknown>) {
    return this.verification.verify(body);
  }
}
