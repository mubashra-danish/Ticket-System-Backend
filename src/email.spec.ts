import { AppService } from './app.service.js';
import {
  EmailService,
  EmailTransport,
  EmailSendError,
  emailRequest,
} from './email.service.js';
import { RETRY_WINDOW } from './email-outbox.js';

describe('durable ticket email delivery', () => {
  let store: AppService, worker: EmailService, transport: EmailTransport;
  let send: import('vitest').MockInstance<EmailTransport['send']>;
  const guest = {
    name: 'Guest <script>',
    email: 'guest@example.com',
    phone: '+91 9876543210',
    aadhaar: '123456789012',
  };
  beforeEach(() => {
    vi.stubEnv('DATABASE_PATH', ':memory:');
    vi.stubEnv('EMAIL_ENABLED', 'true');
    vi.stubEnv('SMTP_HOST', 'smtp.example.com');
    vi.stubEnv('SMTP_PORT', '587');
    vi.stubEnv('SMTP_SECURE', 'false');
    vi.stubEnv('SMTP_USER', 'test-only');
    vi.stubEnv('SMTP_PASS', 'test-only');
    vi.stubEnv('EMAIL_FROM', 'Tickets <tickets@example.com>');
    store = new AppService();
    transport = new EmailTransport();
    send = vi.spyOn(transport, 'send').mockResolvedValue('email_123');
    worker = new EmailService(store, transport);
  });
  afterEach(async () => {
    await worker.onModuleDestroy();
    store.onModuleDestroy();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  function register() {
    const event = store.create({
      name: 'Meetup',
      location: 'Studio',
      startsAt: new Date(Date.now() + 86400000).toISOString(),
      capacity: 2,
    });
    return { event, registration: store.register(event.id, guest) };
  }
  it('queues once atomically and sends escaped confirmation without a paid QR', async () => {
    const { event } = register();
    expect(() => store.register(event.id, guest)).toThrow();
    await Promise.all([
      worker.flush(),
      new EmailService(store, transport).flush(),
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    const body = JSON.parse(send.mock.calls[0][1]);
    expect(body.html).toContain('Guest &lt;script&gt;');
    expect(body.attachments).toBeUndefined();
    expect((await store.outbox.list())[0].status).toBe('SENT');
    expect(JSON.stringify(await worker.status())).not.toContain('ticketToken');
  });
  it('rolls back registration if queuing fails', () => {
    vi.spyOn(store.outbox, 'enqueue').mockImplementation(() => {
      throw new Error('disk failure');
    });
    expect(register).toThrow();
    expect(store.events()[0].registered).toBe(0);
  });
  it('keeps email pending when disabled', async () => {
    register();
    vi.stubEnv('EMAIL_ENABLED', 'false');
    await worker.flush();
    expect(send).not.toHaveBeenCalled();
    expect((await store.outbox.list())[0].status).toBe('PENDING');
  });
  it('retries a confirmed temporary rejection with the identical body and message identifier', async () => {
    register();
    send.mockRejectedValueOnce(new EmailSendError('SMTP 451'));
    await worker.flush();
    const first = send.mock.calls[0];
    const job = (await store.outbox.list())[0];
    vi.spyOn(Date, 'now').mockReturnValue(job.nextAttempt + 1);
    vi.stubEnv('EMAIL_FROM', 'Changed <changed@example.com>');
    await worker.flush();
    expect(send.mock.calls[1]).toEqual(first);
    expect((await store.outbox.list())[0].status).toBe('SENT');
  });
  it('recovers expired leases and fences stale workers', async () => {
    register();
    const first = (await store.outbox.claim())!;
    expect(await store.outbox.claim()).toBeNull();
    vi.spyOn(Date, 'now').mockReturnValue(first.leaseUntil + 1);
    const second = (await store.outbox.claim())!;
    expect(await store.outbox.prepare(first, 'stale')).toBe(false);
    await store.outbox.complete(first, 'stale');
    expect((await store.outbox.get(first.id))!.status).toBe('SENDING');
    await store.outbox.complete(second, 'current');
    expect((await store.outbox.get(first.id))!.providerId).toBe('current');
  });
  it('stops retries after the configured retry window', async () => {
    register();
    const claimed = (await store.outbox.claim())!;
    vi.spyOn(Date, 'now').mockReturnValue(
      claimed.firstAttempt! + RETRY_WINDOW + 1,
    );
    await worker.flush();
    expect(send).not.toHaveBeenCalled();
    expect((await store.outbox.list())[0].status).toBe('FAILED');
  });
  it('flags permanent failures for admin review', async () => {
    register();
    send.mockRejectedValue(new EmailSendError('SMTP 535', true));
    await worker.flush();
    await worker.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect((await store.outbox.list())[0].status).toBe('FAILED');
  });
  it('renders a paid QR attachment and cancels invalidated ticket jobs', async () => {
    register();
    const job = (await store.outbox.list())[0];
    job.id = 'paid-test';
    job.payload.ticketToken = 'a'.repeat(64);
    const body = JSON.parse(await emailRequest(job.payload));
    expect(
      Buffer.from(body.attachments[0].content, 'base64')
        .subarray(1, 4)
        .toString(),
    ).toBe('PNG');
    store.outbox.enqueue(job);
    await worker.flush();
    expect((await store.outbox.get('paid-test'))!.status).toBe('CANCELLED');
  });
  it('does not resend after a worker disappears during an SMTP attempt', async () => {
    register();
    const first = (await store.outbox.claim())!;
    await store.outbox.prepare(first, await emailRequest(first.payload));
    expect(await store.outbox.beginSend(first)).toBe(true);
    vi.spyOn(Date, 'now').mockReturnValue(first.leaseUntil + 1);
    await worker.flush();
    expect(send).not.toHaveBeenCalled();
    expect(await store.outbox.get(first.id)).toMatchObject({
      status: 'FAILED',
      lastError: expect.stringContaining('unknown'),
    });
    expect(await store.outbox.beginSend(first)).toBe(false);
  });
  it('does not resend if SMTP accepted the message but database acknowledgement failed', async () => {
    register();
    vi.spyOn(store.outbox, 'complete').mockRejectedValue(
      new Error('database unavailable'),
    );
    await worker.flush();
    await worker.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect((await store.outbox.list())[0].status).toBe('FAILED');
  });
  it('stops an uncertain delivery from the previous transport during migration', async () => {
    register();
    const first = (await store.outbox.claim())!;
    const legacy = JSON.parse(await emailRequest(first.payload));
    delete legacy.transport;
    await store.outbox.prepare(first, JSON.stringify(legacy));
    await store.outbox.fail(first, 'Previous provider timeout', false);
    vi.spyOn(Date, 'now').mockReturnValue(first.leaseUntil + 1);
    await worker.flush();
    expect(send).not.toHaveBeenCalled();
    expect((await store.outbox.list())[0].status).toBe('FAILED');
  });
});
