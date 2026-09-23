import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { scryptSync } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { AppService } from '../src/app.service.js';
import { configure } from '../src/configure.js';
describe('ticket API security and workflow', () => {
  let app: NestExpressApplication;
  const origin = 'http://localhost:3000';
  const password = 'test-password-unique-for-tests';
  const details = {
    name: 'Community meetup',
    location: 'Studio',
    startsAt: new Date(Date.now() + 86400000).toISOString(),
    capacity: 1,
  };
  const guest = {
    name: 'Guest',
    email: 'guest@example.com',
    phone: '+91 9876543210',
  };
  beforeEach(async () => {
    process.env.DATABASE_PATH = ':memory:';
    process.env.ADMIN_EMAIL = 'admin@example.com';
    const salt = 'a'.repeat(32);
    process.env.ADMIN_PASSWORD_HASH =
      salt + ':' + scryptSync(password, salt, 64).toString('hex');
    process.env.APP_ORIGIN = origin;
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication<NestExpressApplication>({
      rawBody: true,
    });
    configure(app);
    await app.init();
  });
  afterEach(async () => {
    await app.close();
  });
  async function login() {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Origin', origin)
      .send({ email: 'admin@example.com', password })
      .expect(201);
    expect(res.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(res.headers['set-cookie'][0]).toContain('SameSite=Strict');
    return res.headers['set-cookie'][0].split(';')[0];
  }
  it('protects admin operations and attendee data', async () => {
    await request(app.getHttpServer()).get('/api/emails/status').expect(401);
    await request(app.getHttpServer()).get('/api/registrations').expect(401);
    await request(app.getHttpServer())
      .post('/api/events')
      .set('Origin', origin)
      .send(details)
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Cookie', 'ticket_session=forged')
      .expect(401);
  });
  it('creates an event, registers from a separate browser, and revokes logout', async () => {
    const cookie = await login();
    const event = await request(app.getHttpServer())
      .post('/api/events')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send(details)
      .expect(201);
    await request(app.getHttpServer())
      .get('/api/events/' + event.body.id)
      .expect(200);
    const registration = await request(app.getHttpServer())
      .post('/api/events/' + event.body.id + '/registrations')
      .set('Origin', origin)
      .send(guest)
      .expect(201);
    expect(registration.body.id).toBeTruthy();
    const emails = await request(app.getHttpServer())
      .get('/api/emails/status')
      .set('Cookie', cookie)
      .expect(200);
    expect(emails.body.jobs).toHaveLength(1);
    expect(emails.body.jobs[0].to).toBe(guest.email);
    expect(emails.body.jobs[0].payload).toBeUndefined();
    await request(app.getHttpServer())
      .post('/api/events/' + event.body.id + '/registrations')
      .set('Origin', origin)
      .send(guest)
      .expect(409);
    await request(app.getHttpServer())
      .post('/api/events/' + event.body.id + '/registrations')
      .set('Origin', origin)
      .send({ ...guest, email: 'another@example.com' })
      .expect(409);
    const people = await request(app.getHttpServer())
      .get('/api/registrations')
      .set('Cookie', cookie)
      .expect(200);
    expect(people.body).toHaveLength(1);
    const publicData = await request(app.getHttpServer())
      .get('/api/events')
      .expect(200);
    expect(JSON.stringify(publicData.body)).not.toContain(guest.email);
    await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({})
      .expect(201);
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Cookie', cookie)
      .expect(401);
  });
  it('rejects missing or hostile origins and non-JSON writes', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({})
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Origin', 'https://evil.example')
      .send({})
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Origin', origin)
      .type('form')
      .send('email=x')
      .expect(403);
  });
  it('rejects wrong passwords and rate limits login attempts', async () => {
    for (let i = 0; i < 10; i++)
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .set('Origin', origin)
        .send({ email: 'admin@example.com', password: 'wrong-password' })
        .expect(401);
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Origin', origin)
      .send({ email: 'admin@example.com', password })
      .expect(429);
  });
  it('rejects expired sessions, oversized bodies and unknown events', async () => {
    const service = app.get(AppService);
    expect(service.authenticated('unknown')).toBe(false);
    const cookie = await login();
    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.now() + 9 * 60 * 60 * 1000);
    try {
      await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Cookie', cookie)
        .expect(401);
    } finally {
      clock.mockRestore();
    }
    await request(app.getHttpServer()).get('/api/events/missing').expect(404);
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Origin', origin)
      .send({ email: 'a'.repeat(20000) })
      .expect(413);
  });
});
