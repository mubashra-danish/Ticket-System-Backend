import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import nodemailer from 'nodemailer';

export function smtpSettings() {
  const host = process.env.SMTP_HOST?.trim();
  const port = Number(process.env.SMTP_PORT || '587');
  const flag = process.env.SMTP_SECURE ?? (port === 465 ? 'true' : 'false');
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.EMAIL_FROM?.trim();
  if (
    !host ||
    /[\s/]/.test(host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !['true', 'false'].includes(flag) ||
    (port === 465 && flag !== 'true') ||
    (port === 587 && flag !== 'false') ||
    !user ||
    !pass ||
    !from ||
    /[\r\n]/.test(from) ||
    !from.includes('@')
  )
    return null;
  return { host, port, secure: flag === 'true', auth: { user, pass } };
}
export class EmailSendError extends Error {
  constructor(
    message: string,
    public terminal = false,
  ) {
    super(message);
  }
}
export function smtpFailure(error: unknown): EmailSendError {
  if (error instanceof EmailSendError) return error;
  const e = error as {
    code?: string;
    responseCode?: number;
    command?: string;
  } | null;
  const response = e?.responseCode;
  if (response && response >= 400 && response < 500 && e?.command !== 'QUIT')
    return new EmailSendError(
      'SMTP temporarily rejected the message: ' + response,
    );
  if (response && response >= 500 && response < 600)
    return new EmailSendError(
      'SMTP rejected the message: ' +
        response +
        '. Check sender, recipient and account settings.',
      true,
    );
  if (
    ['EAUTH', 'ENOAUTH', 'ETLS', 'ECONFIG', 'EENVELOPE', 'EMESSAGE'].includes(
      e?.code || '',
    )
  )
    return new EmailSendError(
      'SMTP configuration, authentication or message error. Check email settings.',
      true,
    );
  if (
    e?.code === 'EDNS' ||
    ([
      'CONN',
      'EHLO',
      'HELO',
      'STARTTLS',
      'AUTH PLAIN',
      'AUTH LOGIN',
      'MAIL FROM',
      'RCPT TO',
    ].includes(e?.command || '') &&
      ['ETIMEDOUT', 'ECONNECTION', 'ESOCKET'].includes(e?.code || ''))
  )
    return new EmailSendError(
      'SMTP connection failed before message delivery. A retry is scheduled.',
    );
  return new EmailSendError(
    'SMTP delivery outcome is unknown. Check provider logs before any manual resend.',
    true,
  );
}
type EmailRequest = {
  from: string;
  to: string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: {
    filename: string;
    content: string;
    content_type?: string;
    contentType?: string;
  }[];
};
@Injectable()
export class EmailTransport {
  async send(id: string, request: string) {
    const settings = smtpSettings();
    if (!settings || process.env.EMAIL_ENABLED !== 'true')
      throw new EmailSendError('SMTP is not configured.', true);
    const message = JSON.parse(request) as EmailRequest;
    if (!Array.isArray(message.to) || message.to.length !== 1)
      throw new EmailSendError('Expected one email recipient.', true);
    const transport = nodemailer.createTransport({
      ...settings,
      requireTLS: !settings.secure,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 15000,
      dnsTimeout: 15000,
      disableFileAccess: true,
      disableUrlAccess: true,
      logger: false,
      debug: false,
    });
    try {
      const domain =
        message.from.match(/@([a-zA-Z0-9.-]+)/)?.[1] || 'ticket-system.local';
      const result = await transport.sendMail({
        from: message.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        messageId: `<${createHash('sha256').update(id).digest('hex')}@${domain}>`,
        attachments: message.attachments?.map((a) => ({
          filename: a.filename,
          content: a.content,
          encoding: 'base64',
          contentType: a.contentType || a.content_type,
        })),
      });
      if (!result.accepted?.length || result.rejected?.length)
        throw new EmailSendError(
          'SMTP did not accept the recipient. Check provider logs.',
          true,
        );
      return result.messageId;
    } catch (error) {
      throw smtpFailure(error);
    } finally {
      transport.close();
    }
  }
}
