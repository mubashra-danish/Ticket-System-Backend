import { createRequire } from 'node:module';
import { SqliteEmailOutbox } from './sqlite-email-outbox.js';

it('adds SMTP attempt tracking to an existing outbox without losing queued messages', async () => {
  const { DatabaseSync } = createRequire(import.meta.url)(
    'node:sqlite',
  ) as typeof import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      'CREATE TABLE email_outbox(id TEXT PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL,createdAt INTEGER NOT NULL,nextAttempt INTEGER NOT NULL,attempts INTEGER NOT NULL,firstAttempt INTEGER,leaseUntil INTEGER NOT NULL,leaseToken TEXT,request TEXT,providerId TEXT,lastError TEXT)',
    );
    const payload = {
      registrationId: 'old',
      eventId: 'event',
      eventName: 'Meetup',
      startsAt: '2030-01-01T00:00:00Z',
      location: 'Hall',
      name: 'Guest',
      to: 'guest@example.com',
      ticketToken: null,
      amount: 0,
    };
    db.prepare('INSERT INTO email_outbox VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
      'old',
      JSON.stringify(payload),
      'PENDING',
      0,
      0,
      0,
      null,
      0,
      null,
      null,
      null,
      null,
    );
    const outbox = new SqliteEmailOutbox(db);
    expect(await outbox.get('old')).toMatchObject({
      payload,
      status: 'PENDING',
      smtpStartedAt: null,
    });
    const job = (await outbox.claim())!;
    expect(await outbox.beginSend(job)).toBe(true);
    expect(await outbox.beginSend(job)).toBe(false);
    expect(
      (await new SqliteEmailOutbox(db).get('old'))!.smtpStartedAt,
    ).toBeGreaterThan(0);
    await outbox.fail(job, 'SMTP 451', false);
    expect(await outbox.get('old')).toMatchObject({
      status: 'PENDING',
      smtpStartedAt: null,
    });
  } finally {
    db.close();
  }
});
