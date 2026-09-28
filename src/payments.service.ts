import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  AppService,
  digest,
  email,
  field,
  aadhaarNumber,
} from './app.service.js';
import type { MongoService } from './mongo.service.js';
import type { Booking } from './bookings.js';
import { emailConfigured } from './email.service.js';
import { paymentInstructions, paymentReference } from './manual-payments.js';

@Injectable()
export class PaymentsService {
  constructor(
    @Inject(AppService) private readonly store: AppService | MongoService,
  ) {}
  private get bookings() {
    return this.store.bookings;
  }
  private token(body: Record<string, unknown>) {
    const token = field(body, 'token', 64);
    if (!/^[a-f0-9]{64}$/.test(token))
      throw new BadRequestException('Invalid booking access token');
    return token;
  }
  private async owned(body: Record<string, unknown>) {
    const hash = digest(this.token(body));
    const b = await this.bookings.get(hash.slice(0, 36));
    if (!b || b.accessHash !== hash)
      throw new NotFoundException('Booking not found');
    return b;
  }
  private async view(b: Booking) {
    return {
      id: b.id,
      eventId: b.eventId,
      eventName: b.eventName,
      amount: b.amount,
      currency: b.currency,
      status:
        b.status === 'PENDING' && b.expiresAt <= Date.now()
          ? 'EXPIRED'
          : b.status,
      expiresAt: b.expiresAt,
      paymentInstructions: b.manualPayment || null,
      submittedReference: b.submittedReference || null,
      ticket:
        b.status === 'PAID'
          ? { id: b.id, qr: b.ticketToken, checkedInAt: b.checkedInAt }
          : null,
      message: b.reviewReason,
      emailStatus: emailConfigured()
        ? (await this.store.outbox.get('registration-' + b.id))?.status ||
          'NOT_QUEUED'
        : 'NOT_CONFIGURED',
    };
  }
  async create(eventId: string, body: Record<string, unknown>) {
    const instructions = paymentInstructions();
    if (!instructions)
      throw new ServiceUnavailableException(
        'Payment details are not available yet. Please contact the organizer before sending money.',
      );
    const accessHash = digest(this.token(body)),
      event = await this.store.event(eventId);
    const name = field(body, 'name', 120),
      address = email(body),
      aadhaar = aadhaarNumber(body),
      phone = field(body, 'phone', 24);
    if (!/^[+\d ()-]{7,24}$/.test(phone))
      throw new BadRequestException('Invalid phone number');
    const now = Date.now();
    const { booking } = await this.bookings.reserve({
      id: accessHash.slice(0, 36),
      accessHash,
      eventId,
      eventName: event.name,
      name,
      email: address,
      phone,
      aadhaar,
      amount: event.amount,
      currency: 'INR',
      status: 'PENDING',
      createdAt: now,
      expiresAt: Math.min(now + 30 * 60 * 1000, Date.parse(event.startsAt)),
      lastChecked: 0,
      orderId: null,
      paymentId: null,
      ticketToken: null,
      checkedInAt: null,
      reviewReason: null,
      manualPayment: instructions,
    });
    return this.view(booking);
  }
  async status(body: Record<string, unknown>) {
    return this.view(await this.owned(body));
  }
  async submit(body: Record<string, unknown>) {
    const b = await this.owned(body);
    return this.view(
      await this.bookings.submit(b.id, paymentReference(body.reference)),
    );
  }
  async approve(id: string, body: Record<string, unknown>, actor: string) {
    const b = await this.bookings.get(id);
    if (!b) throw new NotFoundException('Booking not found');
    const reference = paymentReference(body.reference);
    if (body.receivedInBank !== true || body.amount !== b.amount)
      throw new BadRequestException(
        'Verify the exact amount credited in your bank account before approving.',
      );
    const decision = {
      actor,
      at: Date.now(),
      reference,
      note: field(body, 'note', 500),
    };
    try {
      return await this.view(
        await this.bookings.approve(
          id,
          decision,
          randomBytes(32).toString('hex'),
        ),
      );
    } catch (e) {
      if ((e as { code?: number }).code === 11000)
        throw new ConflictException(
          'This bank reference has already been used for another booking.',
        );
      throw e;
    }
  }
  async reject(id: string, body: Record<string, unknown>, actor: string) {
    return this.view(
      await this.bookings.reject(id, {
        actor,
        at: Date.now(),
        reference: '',
        note: field(body, 'reason', 500),
      }),
    );
  }
  async review() {
    return (await this.bookings.review()).map((b) => ({
      id: b.id,
      name: b.name,
      eventName: b.eventName,
      email: b.email,
      phone: b.phone,
      amount: b.amount,
      status: b.status,
      submittedReference: b.submittedReference,
      submittedAt: b.submittedAt,
      paymentInstructions: b.manualPayment,
      reason: b.reviewReason,
      paymentId: b.paymentId,
      decision: b.decision,
    }));
  }
  async checkin(body: Record<string, unknown>) {
    const b = await this.bookings.checkin(field(body, 'ticket', 64));
    return {
      id: b.id,
      name: b.name,
      eventName: b.eventName,
      checkedInAt: b.checkedInAt,
    };
  }
}
