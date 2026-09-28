import nodemailer from 'nodemailer';
import { EmailTransport, smtpSettings, smtpFailure } from './smtp.js';
import { emailConfigured } from './email.service.js';

describe('SMTP email transport', () => {
  beforeEach(() => {
    vi.stubEnv('EMAIL_ENABLED', 'true');
    vi.stubEnv('EMAIL_FROM', 'Tickets <tickets@example.com>');
    vi.stubEnv('SMTP_HOST', 'smtp.example.com');
    vi.stubEnv('SMTP_PORT', '587');
    vi.stubEnv('SMTP_SECURE', 'false');
    vi.stubEnv('SMTP_USER', 'test-user');
    vi.stubEnv('SMTP_PASS', 'test-password');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  const request = JSON.stringify({
    from: 'Tickets <tickets@example.com>',
    to: ['guest@example.com'],
    subject: 'Code',
    text: '123456',
    attachments: [
      {
        filename: 'ticket.png',
        content: 'aGVsbG8=',
        content_type: 'image/png',
      },
    ],
  });
  function mockedTransport() {
    const transport = nodemailer.createTransport({ host: 'localhost' });
    const send = vi
      .spyOn(transport, 'sendMail')
      .mockResolvedValue({
        accepted: ['guest@example.com'],
        rejected: [],
        messageId: 'message-id',
        envelope: { from: 'tickets@example.com', to: ['guest@example.com'] },
        response: '250 Accepted',
      });
    const close = vi.spyOn(transport, 'close');
    const create = vi
      .spyOn(nodemailer, 'createTransport')
      .mockReturnValue(transport);
    return { send, close, create };
  }
  it('sends OTPs and legacy queued QR attachments over required STARTTLS with a stable Message-ID', async () => {
    const { send, close, create } = mockedTransport();
    const transport = new EmailTransport();
    expect(await transport.send('same-job', request)).toBe('message-id');
    await transport.send('same-job', request);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 587,
        secure: false,
        requireTLS: true,
        auth: { user: 'test-user', pass: 'test-password' },
        disableFileAccess: true,
        disableUrlAccess: true,
      }),
    );
    expect(send.mock.calls[0][0]).toMatchObject({
      text: '123456',
      attachments: [
        { content: 'aGVsbG8=', encoding: 'base64', contentType: 'image/png' },
      ],
    });
    expect(send.mock.calls[0][0].messageId).toBe(
      send.mock.calls[1][0].messageId,
    );
    expect(close).toHaveBeenCalledTimes(2);
  });
  it('supports implicit TLS on 465', async () => {
    vi.stubEnv('SMTP_PORT', '465');
    vi.stubEnv('SMTP_SECURE', 'true');
    const { create } = mockedTransport();
    await new EmailTransport().send('otp', request);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ port: 465, secure: true, requireTLS: false }),
    );
  });
  it.each([
    ['SMTP_HOST', ''],
    ['SMTP_PASS', ''],
    ['SMTP_PORT', 'abc'],
    ['SMTP_PORT', '65536'],
    ['SMTP_SECURE', 'invalid'],
    ['SMTP_SECURE', 'true'],
  ])('rejects incomplete or invalid %s settings', (key, value) => {
    vi.stubEnv(key, value);
    expect(emailConfigured()).toBe(false);
    expect(smtpSettings()).toBeNull();
  });
  it('does not contact SMTP when email is disabled', async () => {
    vi.stubEnv('EMAIL_ENABLED', 'false');
    const { send } = mockedTransport();
    await expect(new EmailTransport().send('otp', request)).rejects.toThrow(
      'not configured',
    );
    expect(send).not.toHaveBeenCalled();
  });
  it('only retries known-safe errors and hides raw provider messages', () => {
    for (const error of [
      { responseCode: 451, command: 'DATA' },
      { code: 'EDNS' },
      { code: 'ETIMEDOUT', command: 'CONN' },
    ])
      expect(smtpFailure(error).terminal).toBe(false);
    for (const error of [
      { code: 'EAUTH' },
      { responseCode: 550 },
      { code: 'ETIMEDOUT', command: 'DATA' },
      { code: 'ECONNECTION' },
      new Error('password: secret'),
    ]) {
      expect(smtpFailure(error).terminal).toBe(true);
      expect(smtpFailure(error).message).not.toContain('secret');
    }
  });
  it('closes the transport and reports rejection without claiming delivery', async () => {
    const { send, close } = mockedTransport();
    send.mockRejectedValue({
      code: 'EAUTH',
      responseCode: 535,
      message: 'private provider details',
    });
    await expect(
      new EmailTransport().send('otp', request),
    ).rejects.toMatchObject({ terminal: true });
    expect(close).toHaveBeenCalledOnce();
  });
});
