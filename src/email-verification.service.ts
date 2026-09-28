import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { AppService } from './app.service.js';
import type { MongoService } from './mongo.service.js';
import { emailConfigured, EmailTransport } from './email.service.js';

const TTL = 10 * 60 * 1000;
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
type Challenge = {
  id: string;
  eventId: string;
  otpHash: string;
  expiresAt: number;
  attempts: number;
  sentAt: number;
  ready: boolean;
};
type Proof = { email: string; eventId: string; expiresAt: number };

@Injectable()
export class EmailVerificationService {
  private readonly challenges = new Map<string, Challenge>();
  private readonly proofs = new Map<string, Proof>();
  constructor(
    @Inject(EmailTransport) private readonly transport: EmailTransport,
    @Inject(AppService) private readonly store: AppService | MongoService,
  ) {}
  private email(value: unknown) {
    if (
      typeof value !== 'string' ||
      value.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
    )
      throw new BadRequestException('Enter a valid email address.');
    return value.trim().toLowerCase();
  }
  private cleanup() {
    const now = Date.now();
    for (const [key, value] of this.challenges)
      if (value.expiresAt <= now) this.challenges.delete(key);
    for (const [key, value] of this.proofs)
      if (value.expiresAt <= now) this.proofs.delete(key);
  }
  async send(body: Record<string, unknown>) {
    const email = this.email(body.email);
    if (typeof body.eventId !== 'string' || body.eventId.length > 120)
      throw new BadRequestException('Event is required.');
    const event = await this.store.event(body.eventId);
    if (Date.parse(event.startsAt) <= Date.now())
      throw new BadRequestException('Registration has closed.');
    if (!emailConfigured())
      throw new ServiceUnavailableException(
        'Email verification is unavailable. Please contact the organizer.',
      );
    this.cleanup();
    const existing = this.challenges.get(email);
    if (existing && Date.now() - existing.sentAt < 60000)
      throw new HttpException(
        'Please wait 60 seconds before requesting another code.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    if (this.challenges.size >= 5000 || this.proofs.size >= 5000)
      throw new ServiceUnavailableException('Please try again later.');
    if (
      !(await this.store.limit(
        'email-verification:' + hash(email),
        5,
        60 * 60 * 1000,
      ))
    )
      throw new HttpException(
        'Too many verification emails. Try again in an hour.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    // Recheck after the asynchronous rate-limit operation to serialize concurrent sends.
    const current = this.challenges.get(email);
    if (current && Date.now() - current.sentAt < 60000)
      throw new HttpException(
        'Please wait 60 seconds before requesting another code.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    const code = randomInt(100000, 1000000).toString();
    const id = randomBytes(32).toString('hex');
    const challenge: Challenge = {
      id,
      eventId: body.eventId,
      otpHash: hash(id + code),
      expiresAt: Date.now() + TTL,
      attempts: 0,
      sentAt: Date.now(),
      ready: false,
    };
    this.challenges.set(email, challenge);
    try {
      await this.transport.send(
        'verification-' + id,
        JSON.stringify({
          from: process.env.EMAIL_FROM,
          to: [email],
          subject: 'Your Ticket System verification code',
          text: `Your verification code is ${code}. It expires in 10 minutes. Do not share this code. If you did not request it, ignore this email.`,
        }),
      );
      challenge.ready = true;
    } catch {
      // Keep the cooldown even when delivery fails; never claim that a code was sent.
      throw new ServiceUnavailableException(
        'Could not send your verification email. Please try again in 60 seconds.',
      );
    }
    return { challengeId: id, expiresIn: TTL / 1000, resendAfter: 60 };
  }
  verify(body: Record<string, unknown>) {
    const email = this.email(body.email);
    this.cleanup();
    const record = this.challenges.get(email);
    if (
      !record ||
      !record.ready ||
      record.id !== body.challengeId ||
      record.eventId !== body.eventId
    )
      throw new BadRequestException('Request a new verification code.');
    if (record.attempts >= 5)
      throw new HttpException(
        'Too many incorrect attempts. Request a new code.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    record.attempts++;
    if (
      typeof body.otp !== 'string' ||
      !/^\d{6}$/.test(body.otp) ||
      hash(record.id + body.otp) !== record.otpHash
    )
      throw new BadRequestException('Incorrect verification code.');
    const verificationToken = randomBytes(32).toString('hex');
    this.proofs.set(hash(verificationToken), {
      email,
      eventId: record.eventId,
      expiresAt: Date.now() + TTL,
    });
    record.ready = false;
    return { verified: true, verificationToken, expiresIn: TTL / 1000 };
  }
  assertVerified(eventId: string, body: Record<string, unknown>) {
    this.cleanup();
    const email = this.email(body.email);
    const proof =
      typeof body.verificationToken === 'string'
        ? this.proofs.get(hash(body.verificationToken))
        : undefined;
    if (!proof || proof.email !== email || proof.eventId !== eventId)
      throw new ForbiddenException('Verify your email before registering.');
  }
}
