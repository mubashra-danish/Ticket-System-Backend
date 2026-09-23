import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createHmac, randomBytes } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { AppService } from '../src/app.service.js';
import { RazorpayService } from '../src/razorpay.service.js';
import { configure } from '../src/configure.js';
describe('payment HTTP boundary', () => {
  let app: NestExpressApplication, store: AppService;
  beforeEach(async () => {
    vi.stubEnv('DATABASE_PATH', ':memory:');
    vi.stubEnv('MONGODB_URI', '');
    vi.stubEnv('MONGO_URL', '');
    vi.stubEnv('MONGO_URI', '');
    vi.stubEnv('APP_ORIGIN', 'http://localhost:3000');
    vi.stubEnv('RAZORPAY_KEY_ID', 'rzp_test_example');
    vi.stubEnv('RAZORPAY_KEY_SECRET', 'test-secret');
    vi.stubEnv('RAZORPAY_WEBHOOK_SECRET', 'webhook-secret');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RazorpayService)
      .useValue({
        create: async (b: { id: string; amount: number }) => ({
          id: 'order_http',
          receipt: b.id,
          amount: b.amount,
          currency: 'INR',
        }),
        payment: async () => ({
          id: 'pay_http',
          order_id: 'order_http',
          status: 'captured',
          amount: 50000,
          currency: 'INR',
        }),
      })
      .compile();
    app = module.createNestApplication<NestExpressApplication>({
      rawBody: true,
    });
    configure(app);
    await app.init();
    store = app.get(AppService);
  });
  afterEach(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });
  it('accepts a signed server webhook without Origin, issues one ticket, and rejects body tampering', async () => {
    const event = store.create({
      name: 'Concert',
      location: 'Hall',
      startsAt: new Date(Date.now() + 86400000).toISOString(),
      capacity: 1,
      amount: 50000,
    });
    const token = randomBytes(32).toString('hex');
    await request(app.getHttpServer())
      .post('/api/events/' + event.id + '/orders')
      .set('Origin', 'http://localhost:3000')
      .send({
        token,
        name: 'Guest',
        email: 'guest@example.com',
        phone: '9876543210',
      })
      .expect(201);
    const raw =
      '{ "event": "payment.captured", "payload": { "payment": { "entity": { "id":"pay_http", "order_id":"order_http" } } } }';
    const signature = createHmac('sha256', 'webhook-secret')
      .update(raw)
      .digest('hex');
    for (let i = 0; i < 2; i++)
      await request(app.getHttpServer())
        .post('/api/payments/razorpay/webhook')
        .type('json')
        .set('x-razorpay-signature', signature)
        .send(raw)
        .expect(200);
    await request(app.getHttpServer())
      .post('/api/payments/razorpay/webhook')
      .type('json')
      .set('x-razorpay-signature', signature)
      .send(raw + ' ')
      .expect(401);
    expect(store.event(event.id).registered).toBe(1);
    const response = await request(app.getHttpServer())
      .post('/api/payments/status')
      .set('Origin', 'http://localhost:3000')
      .send({ token })
      .expect(200);
    expect(response.body.status).toBe('PAID');
    expect(response.body.ticket.qr).toHaveLength(64);
    expect(response.body.accessHash).toBeUndefined();
  });
  it('keeps browser origin checks and admin-only actions protected', async () => {
    await request(app.getHttpServer())
      .post('/api/payments/status')
      .send({ token: 'a'.repeat(64) })
      .expect(403);
    await request(app.getHttpServer()).get('/api/payments/review').expect(401);
    await request(app.getHttpServer())
      .post('/api/tickets/check-in')
      .set('Origin', 'http://localhost:3000')
      .send({ ticket: 'a'.repeat(64) })
      .expect(401);
  });
});
