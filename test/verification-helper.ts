import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { EmailTransport } from '../src/email.service.js';

export class TestEmailTransport extends EmailTransport {
  messages = new Map<string, string>();
  override async send(id: string, body: string) {
    const message = JSON.parse(body) as { to: string[]; text: string };
    this.messages.set(message.to[0], message.text);
    return id;
  }
}
export async function verifiedGuest(
  app: NestExpressApplication,
  transport: TestEmailTransport,
  eventId: string,
  email: string,
) {
  const challenge = await request(app.getHttpServer())
    .post('/api/email-verification/send')
    .set('Origin', 'http://localhost:3000')
    .send({ email, eventId })
    .expect(201);
  const otp = transport.messages.get(email)?.match(/\b\d{6}\b/)?.[0];
  const proof = await request(app.getHttpServer())
    .post('/api/email-verification/verify')
    .set('Origin', 'http://localhost:3000')
    .send({ email, eventId, challengeId: challenge.body.challengeId, otp })
    .expect(201);
  return proof.body.verificationToken as string;
}
