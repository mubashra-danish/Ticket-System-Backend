import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  OnModuleDestroy,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AppService, digest, email, field } from './app.service.js';
import type { MongoService } from './mongo.service.js';
import type { Booking, Payment } from './bookings.js';
import { emailConfigured } from './email.service.js';
import {
  RazorpayService,
  paymentsConfigured,
  signatureValid,
} from './razorpay.service.js';
@Injectable()
export class PaymentsService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly logger = new Logger(PaymentsService.name);
  constructor(
    @Inject(AppService) private readonly store: AppService | MongoService,
    @Inject(RazorpayService) private readonly gateway: RazorpayService,
  ) {}
  onModuleInit() {
    if (paymentsConfigured() && process.env.NODE_ENV !== 'test') {
      this.timer = setInterval(() => {
        void this.reconcile();
      }, 60000);
      this.timer.unref();
    }
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
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
      orderId: b.orderId,
      keyId: process.env.RAZORPAY_KEY_ID,
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
    if (!paymentsConfigured())
      throw new ServiceUnavailableException(
        'Online payments are not configured. Please contact the organizer.',
      );
    const accessHash = digest(this.token(body)),
      event = await this.store.event(eventId);
    const name = field(body, 'name', 120),
      address = email(body),
      phone = field(body, 'phone', 24);
    if (!/^[+\d ()-]{7,24}$/.test(phone))
      throw new BadRequestException('Invalid phone number');
    const now = Date.now();
    const { booking: b, created } = await this.bookings.reserve({
      id: accessHash.slice(0, 36),
      accessHash,
      eventId,
      eventName: event.name,
      name,
      email: address,
      phone,
      amount: event.amount,
      currency: 'INR',
      status: 'PENDING',
      createdAt: now,
      expiresAt: Math.min(now + 15 * 60 * 1000, Date.parse(event.startsAt)),
      lastChecked: 0,
      orderId: null,
      paymentId: null,
      ticketToken: null,
      checkedInAt: null,
      reviewReason: null,
    });
    if (created) {
      // Never blindly retry order creation after a timeout: the provider may have created it.
      const order = await this.gateway.create(b);
      if (
        order.amount !== b.amount ||
        order.currency !== b.currency ||
        order.receipt !== b.id
      )
        throw new BadRequestException('Payment order mismatch');
      await this.bookings.attach(b.id, order.id);
      b.orderId = order.id;
    }
    return this.view(b);
  }
  async status(body: Record<string, unknown>) {
    return this.view(await this.owned(body));
  }
  private async capture(b: Booking, p: Payment) {
    if (
      p.order_id !== b.orderId ||
      p.amount !== b.amount ||
      p.currency !== b.currency
    )
      throw new BadRequestException('Payment does not match the booking');
    if ((p.amount_refunded || 0) >= b.amount)
      return this.bookings.refund(b.id, p.id);
    if (p.status !== 'captured' || (p.amount_refunded || 0) > 0) return b;
    return this.bookings.finish(b.id, p, randomBytes(32).toString('hex'));
  }
  async verify(body: Record<string, unknown>) {
    const b = await this.owned(body),
      paymentId = field(body, 'razorpay_payment_id', 100),
      orderId = field(body, 'razorpay_order_id', 100);
    if (
      !b.orderId ||
      orderId !== b.orderId ||
      !signatureValid(
        b.orderId + '|' + paymentId,
        body.razorpay_signature,
        process.env.RAZORPAY_KEY_SECRET || '',
      )
    )
      throw new UnauthorizedException('Invalid payment signature');
    return this.view(
      await this.capture(b, await this.gateway.payment(paymentId)),
    );
  }
  async refresh(body: Record<string, unknown>) {
    const b = await this.owned(body);
    if (b.status === 'REFUNDED' || !b.orderId) return this.view(b);
    if (Date.now() - b.lastChecked < 10000) return this.view(b);
    await this.bookings.checked(b.id);
    if (b.paymentId)
      return this.view(
        await this.capture(b, await this.gateway.payment(b.paymentId)),
      );
    const payments = await this.gateway.orderPayments(b.orderId);
    for (const p of payments.items)
      if (p.status === 'captured' || (p.amount_refunded || 0) >= b.amount)
        return this.view(await this.capture(b, p));
    return this.view(b);
  }
  async webhook(raw: Buffer | undefined, signature: unknown) {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret)
      throw new ServiceUnavailableException('Webhook is not configured');
    if (!raw || !signatureValid(raw, signature, secret))
      throw new UnauthorizedException('Invalid webhook signature');
    let payload: {
      event?: string;
      payload?: { payment?: { entity?: Payment } };
    };
    try {
      payload = JSON.parse(raw.toString('utf8')) as typeof payload;
    } catch {
      throw new BadRequestException('Invalid webhook payload');
    }
    if (!['payment.captured', 'refund.processed'].includes(payload.event || ''))
      return { ok: true };
    const incoming = payload.payload?.payment?.entity;
    if (!incoming?.id || !incoming.order_id)
      throw new BadRequestException('Missing payment');
    let b = await this.bookings.byOrder(incoming.order_id);
    if (!b) {
      // Recover a provider order created immediately before an application crash.
      const order = await this.gateway.order(incoming.order_id);
      b = await this.bookings.get(order.receipt);
      if (!b) return { ok: true };
      if (order.amount !== b.amount || order.currency !== b.currency)
        throw new BadRequestException('Order mismatch');
      await this.bookings.attach(b.id, order.id);
      b.orderId = order.id;
    }
    await this.capture(b, await this.gateway.payment(incoming.id));
    return { ok: true };
  }
  async reconcile() {
    if (this.running) return;
    this.running = true;
    try {
      for (const b of await this.bookings.pending()) {
        try {
          await this.bookings.checked(b.id);
          const payments = await this.gateway.orderPayments(b.orderId!);
          for (const p of payments.items)
            if (
              p.status === 'captured' ||
              (p.amount_refunded || 0) >= b.amount
            ) {
              await this.capture(b, p);
              break;
            }
        } catch {
          this.logger.warn(
            'Payment reconciliation failed for booking ' +
              b.id +
              '; it will be retried.',
          );
        }
      }
    } catch {
      this.logger.warn(
        'Could not load bookings for reconciliation; it will be retried.',
      );
    } finally {
      this.running = false;
    }
  }
  async review() {
    return (await this.bookings.review()).map((b) => ({
      id: b.id,
      eventName: b.eventName,
      email: b.email,
      amount: b.amount,
      paymentId: b.paymentId,
      orderId: b.orderId,
      reason: b.reviewReason,
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
