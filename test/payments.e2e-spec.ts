import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { randomBytes, scryptSync } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { AppService } from '../src/app.service.js';
import { configure } from '../src/configure.js';
import { EmailTransport } from '../src/email.service.js';
import { TestEmailTransport, verifiedGuest } from './verification-helper.js';

describe('manual payment HTTP boundary', () => {
  let app: NestExpressApplication, store: AppService;
  let transport: TestEmailTransport;
  const origin = 'http://localhost:3000';
  beforeEach(async () => {
    vi.stubEnv('EMAIL_ENABLED', 'true');
    vi.stubEnv('SMTP_HOST', 'smtp.example.com');
    vi.stubEnv('SMTP_PORT', '587');
    vi.stubEnv('SMTP_SECURE', 'false');
    vi.stubEnv('SMTP_USER', 'test-only');
    vi.stubEnv('SMTP_PASS', 'test-only');
    vi.stubEnv('EMAIL_FROM', 'test@example.com');
    transport = new TestEmailTransport();
    for (const key of ['MONGODB_URI', 'MONGO_URL', 'MONGO_URI'])
      vi.stubEnv(key, '');
    vi.stubEnv('DATABASE_PATH', ':memory:');
    vi.stubEnv('APP_ORIGIN', origin);
    vi.stubEnv('PAYMENT_UPI_ID', 'organizer@bank');
    vi.stubEnv('PAYMENT_PAYEE_NAME', 'Organizer');
    vi.stubEnv('ADMIN_EMAIL', 'admin@example.com');
    vi.stubEnv(
      'ADMIN_PASSWORD_HASH',
      'salt:' + scryptSync('test-password', 'salt', 64).toString('hex'),
    );
    const module = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EmailTransport)
      .useValue(transport)
      .compile();
    app = module.createNestApplication<NestExpressApplication>();
    configure(app);
    await app.init();
    store = app.get(AppService);
  });
  afterEach(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });
  it('protects approval and rejection from guests and cross-origin requests; only admin approval issues a ticket', async () => {
    const e = store.create({
      name: 'Concert',
      location: 'Hall',
      startsAt: new Date(Date.now() + 86400000).toISOString(),
      capacity: 1,
      amount: 50000,
    });
    const token = randomBytes(32).toString('hex');
    const verificationToken = await verifiedGuest(
      app,
      transport,
      e.id,
      'guest@example.com',
    );
    const created = await request(app.getHttpServer())
      .post('/api/events/' + e.id + '/orders')
      .set('Origin', origin)
      .send({
        verificationToken,
        token,
        name: 'Guest',
        email: 'guest@example.com',
        phone: '9876543210',
        aadhaar: '123456789012',
      })
      .expect(201);
    const id = created.body.id;
    await request(app.getHttpServer())
      .post('/api/payments/submit')
      .set('Origin', origin)
      .send({ token, reference: '123456789012' })
      .expect(200);
    const body = {
      reference: '123456789012',
      amount: 50000,
      receivedInBank: true,
      note: 'Checked bank statement and payer',
    };
    for (const action of ['approve', 'reject']) {
      await request(app.getHttpServer())
        .post('/api/payments/' + id + '/' + action)
        .set('Origin', origin)
        .send(body)
        .expect(401);
      await request(app.getHttpServer())
        .post('/api/payments/' + id + '/' + action)
        .send(body)
        .expect(403);
    }
    expect(store.event(e.id).registered).toBe(0);
    const admin = request.agent(app.getHttpServer());
    await admin
      .post('/api/auth/login')
      .set('Origin', origin)
      .send({ email: 'admin@example.com', password: 'test-password' })
      .expect(201);
    await admin
      .post('/api/payments/' + id + '/approve')
      .set('Origin', 'https://attacker.example')
      .send(body)
      .expect(403);
    const approved = await admin
      .post('/api/payments/' + id + '/approve')
      .set('Origin', origin)
      .send(body)
      .expect(200);
    expect(approved.body.status).toBe('PAID');
    expect(approved.body.ticket.qr).toHaveLength(64);
    await admin
      .post('/api/payments/' + id + '/approve')
      .set('Origin', origin)
      .send(body)
      .expect(200);
    expect(await store.outbox.list()).toHaveLength(1);
    const status = await request(app.getHttpServer())
      .post('/api/payments/status')
      .set('Origin', origin)
      .send({ token })
      .expect(200);
    expect(status.body.accessHash).toBeUndefined();
    expect(status.body.decision).toBeUndefined();
    expect(store.event(e.id).registered).toBe(1);
    expect(store.registrations()[0]).toMatchObject({ aadhaar: '123456789012' });
    expect(status.body.aadhaar).toBeUndefined();
  });
  it('protects review, check-in and removed provider endpoints', async () => {
    await request(app.getHttpServer()).get('/api/payments/review').expect(401);
    await request(app.getHttpServer())
      .post('/api/tickets/check-in')
      .set('Origin', origin)
      .send({ ticket: 'a'.repeat(64) })
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/payments/verify')
      .set('Origin', origin)
      .send({})
      .expect(404);
    await request(app.getHttpServer())
      .post('/api/payments/razorpay/webhook')
      .set('Origin', origin)
      .send({})
      .expect(404);
  });
});
