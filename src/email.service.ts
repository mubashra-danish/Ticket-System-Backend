import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import QRCode from 'qrcode';
import { setTimeout as delay } from 'node:timers/promises';
import { AppService } from './app.service.js';
import type { MongoService } from './mongo.service.js';
import {
  RETRY_WINDOW,
  type EmailJob,
  type EmailPayload,
} from './email-outbox.js';
export function emailConfigured() {
  return (
    process.env.EMAIL_ENABLED === 'true' &&
    !!process.env.RESEND_API_KEY &&
    !!process.env.EMAIL_FROM
  );
}
export const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
export async function emailRequest(p: EmailPayload) {
  const timeZone = process.env.EMAIL_TIMEZONE || 'Asia/Kolkata';
  const when =
    new Intl.DateTimeFormat('en-IN', {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone,
    }).format(new Date(p.startsAt)) +
    ' (' +
    timeZone +
    ')';
  const title = p.ticketToken
    ? 'Your event ticket'
    : 'Your registration is confirmed';
  const instruction = p.ticketToken
    ? 'Your ticket QR is attached as ticket.png. Show it at entry and keep it private. Each ticket is valid for one admission.'
    : 'Save your registration reference and show it to the organizer if needed.';
  const amount = p.amount
    ? new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR',
      }).format(p.amount / 100)
    : 'Free';
  const text = [
    title,
    'Hi ' + p.name + ',',
    p.eventName,
    when,
    p.location,
    'Admission: ' + amount,
    'Reference: ' + p.registrationId,
    instruction,
  ].join('\n\n');
  const html = `<div style="background:#F7F6F2;padding:28px;font-family:Arial,sans-serif;color:#293B50"><div style="max-width:560px;margin:auto;background:#fffefb;border:1px solid #C8C6C6;border-radius:14px;overflow:hidden"><div style="background:#F0E5CF;padding:26px"><p style="color:#4B6587">Ticket System</p><h1 style="color:#4B6587;font-size:26px">${title}</h1></div><div style="padding:26px"><p>Hi ${escapeHtml(p.name)},</p><h2>${escapeHtml(p.eventName)}</h2><p>${escapeHtml(when)}</p><p>${escapeHtml(p.location)}</p><p>Admission: ${escapeHtml(amount)}</p><p>${instruction}</p><p style="background:#F0E5CF;padding:14px;word-break:break-all">Reference: ${escapeHtml(p.registrationId)}</p></div></div></div>`;
  const attachments = p.ticketToken
    ? [
        {
          filename: 'ticket.png',
          content: (
            await QRCode.toBuffer(p.ticketToken, {
              type: 'png',
              width: 600,
              margin: 4,
              errorCorrectionLevel: 'M',
            })
          ).toString('base64'),
          content_type: 'image/png',
        },
      ]
    : [];
  return JSON.stringify({
    from: process.env.EMAIL_FROM,
    to: [p.to],
    subject: (title + ' - ' + p.eventName).replace(/[\r\n]/g, ' '),
    html,
    text,
    ...(attachments.length ? { attachments } : {}),
  });
}
export class EmailSendError extends Error {
  constructor(
    message: string,
    public terminal = false,
  ) {
    super(message);
  }
}
@Injectable()
export class EmailTransport {
  async send(id: string, request: string) {
    let response: Response;
    try {
      response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
          'Content-Type': 'application/json',
          'Idempotency-Key': id,
        },
        body: request,
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new EmailSendError('Email provider timeout or network failure');
    }
    if (!response.ok)
      throw new EmailSendError(
        'Email provider returned HTTP ' + response.status,
        response.status >= 400 &&
          response.status < 500 &&
          ![408, 409, 429].includes(response.status),
      );
    const body = (await response.json()) as { id?: unknown };
    if (typeof body.id !== 'string')
      throw new EmailSendError('Email provider returned an invalid response');
    return body.id;
  }
}
@Injectable()
export class EmailService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running: Promise<void> | null = null;
  private readonly logger = new Logger(EmailService.name);
  constructor(
    @Inject(AppService) private readonly store: AppService | MongoService,
    @Inject(EmailTransport) private readonly transport: EmailTransport,
  ) {}
  onModuleInit() {
    if (!emailConfigured() || process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      void this.flush();
    }, 15000);
    this.timer.unref();
    void this.flush();
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
  flush() {
    if (this.running) return this.running;
    if (!emailConfigured()) return Promise.resolve();
    this.running = this.process()
      .catch(() => {
        this.logger.warn('Email queue is unavailable; it will be retried.');
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }
  private async process() {
    for (let n = 0; n < 10; n++) {
      if (n > 0 && process.env.NODE_ENV !== 'test') await delay(600);
      const job = await this.store.outbox.claim();
      if (!job) return;
      try {
        if (
          Date.now() - (job.firstAttempt ?? Date.now()) >= RETRY_WINDOW ||
          job.attempts > 12
        ) {
          await this.store.outbox.fail(
            job,
            'Retry window exhausted. Check provider logs before any manual resend.',
            true,
          );
          continue;
        }
        if (job.payload.ticketToken) {
          const booking = await this.store.bookings.get(
            job.payload.registrationId,
          );
          if (
            !booking ||
            booking.status !== 'PAID' ||
            booking.ticketToken !== job.payload.ticketToken
          ) {
            await this.store.outbox.cancel(job);
            continue;
          }
        }
        // Save the exact request before the first send: retries must match the provider's idempotency payload.
        const request = job.request || (await emailRequest(job.payload));
        if (!(await this.store.outbox.prepare(job, request))) continue;
        const providerId = await this.transport.send(job.id, request);
        await this.store.outbox.complete(job, providerId);
      } catch (error) {
        await this.failed(job, error);
      }
    }
  }
  private async failed(job: EmailJob, error: unknown) {
    const terminal = error instanceof EmailSendError && error.terminal;
    await this.store.outbox.fail(
      job,
      error instanceof EmailSendError
        ? error.message
        : 'Email preparation or acknowledgement failed',
      terminal,
    );
    this.logger.warn(
      'Email ' +
        job.id +
        ' failed; ' +
        (terminal ? 'admin review required.' : 'retry scheduled.'),
    );
  }
  async status() {
    return {
      configured: emailConfigured(),
      jobs: (await this.store.outbox.list()).map((j) => ({
        id: j.id,
        registrationId: j.payload.registrationId,
        eventName: j.payload.eventName,
        to: j.payload.to,
        status: j.status,
        attempts: j.attempts,
        providerId: j.providerId,
        lastError: j.lastError,
      })),
    };
  }
}
