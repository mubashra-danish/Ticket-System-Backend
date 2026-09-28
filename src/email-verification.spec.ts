import { AppService } from './app.service.js';
import { EmailVerificationService } from './email-verification.service.js';
import { EmailTransport } from './email.service.js';

describe('email verification', () => {
  let store: AppService, service: EmailVerificationService, eventId: string;
  let send: ReturnType<typeof vi.spyOn<EmailTransport, 'send'>>;
  const email = 'guest@example.com';
  beforeEach(() => {
    vi.stubEnv('DATABASE_PATH', ':memory:');
    vi.stubEnv('EMAIL_ENABLED', 'true');
    vi.stubEnv('SMTP_HOST', 'smtp.example.com');
    vi.stubEnv('SMTP_PORT', '587');
    vi.stubEnv('SMTP_SECURE', 'false');
    vi.stubEnv('SMTP_USER', 'test-only');
    vi.stubEnv('SMTP_PASS', 'test-only');
    vi.stubEnv('EMAIL_FROM', 'sender@example.com');
    store = new AppService();
    eventId = store.create({
      name: 'Meetup',
      location: 'Hall',
      startsAt: new Date(Date.now() + 86400000).toISOString(),
      capacity: 10,
    }).id;
    const transport = new EmailTransport();
    send = vi.spyOn(transport, 'send').mockResolvedValue('mock-message');
    service = new EmailVerificationService(transport, store);
  });
  afterEach(() => {
    store.onModuleDestroy();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  async function challenge() {
    const result = await service.send({ email, eventId });
    const message = JSON.parse(send.mock.calls.at(-1)![1]) as {
      text: string;
      to: string[];
    };
    expect(message.to).toEqual([email]);
    const otp = message.text.match(/\b\d{6}\b/)![0];
    expect(JSON.stringify(result)).not.toContain(otp);
    return { email, eventId, challengeId: result.challengeId, otp };
  }
  it('emails a code and binds the expiring proof to both email and event', async () => {
    const input = await challenge();
    const result = service.verify(input);
    expect(() =>
      service.assertVerified(eventId, {
        email: ' GUEST@example.com ',
        ...result,
      }),
    ).not.toThrow();
    expect(() =>
      service.assertVerified('other-event', { email, ...result }),
    ).toThrow('Verify your email');
    expect(() =>
      service.assertVerified(eventId, {
        email: 'other@example.com',
        ...result,
      }),
    ).toThrow('Verify your email');
    expect(() =>
      service.assertVerified(eventId, { email, verificationToken: 'forged' }),
    ).toThrow('Verify your email');
    expect(() => service.verify(input)).toThrow('Request a new');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600001);
    expect(() => service.assertVerified(eventId, { email, ...result })).toThrow(
      'Verify your email',
    );
  });
  it('expires unused codes', async () => {
    const input = await challenge();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600001);
    expect(() => service.verify(input)).toThrow('Request a new');
  });
  it('locks a challenge after five guesses, including malformed guesses', async () => {
    const input = await challenge();
    for (let n = 0; n < 5; n++)
      expect(() => service.verify({ ...input, otp: 'bad' })).toThrow(
        'Incorrect',
      );
    expect(() => service.verify(input)).toThrow('Too many');
  });
  it('enforces resend cooldown and invalidates the previous challenge', async () => {
    const input = await challenge();
    await expect(service.send({ email, eventId })).rejects.toThrow('wait 60');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60001);
    const replacement = await challenge();
    expect(() => service.verify(input)).toThrow('Request a new');
    expect(service.verify(replacement).verified).toBe(true);
  });
  it('serializes simultaneous sends', async () => {
    const results = await Promise.allSettled([
      service.send({ email, eventId }),
      service.send({ email, eventId }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('fails closed when delivery is disabled or the provider fails', async () => {
    vi.stubEnv('EMAIL_ENABLED', 'false');
    await expect(service.send({ email, eventId })).rejects.toThrow(
      'unavailable',
    );
    expect(send).not.toHaveBeenCalled();
    vi.stubEnv('EMAIL_ENABLED', 'true');
    send.mockRejectedValue(new Error('private provider details'));
    await expect(service.send({ email, eventId })).rejects.toThrow(
      'Could not send',
    );
    await expect(service.send({ email, eventId })).rejects.toThrow('wait 60');
    expect(() => service.assertVerified(eventId, { email })).toThrow(
      'Verify your email',
    );
  });
  it('rejects invalid input and limits email sends across service restarts', async () => {
    await expect(service.send({ email: 1, eventId })).rejects.toThrow(
      'valid email',
    );
    await expect(service.send({ email, eventId: 'missing' })).rejects.toThrow();
    for (let n = 0; n < 5; n++) {
      service = new EmailVerificationService(
        { send: async () => 'mock' },
        store,
      );
      await service.send({ email, eventId });
    }
    service = new EmailVerificationService({ send: async () => 'mock' }, store);
    await expect(service.send({ email, eventId })).rejects.toThrow(
      'Too many verification emails',
    );
  });
});
