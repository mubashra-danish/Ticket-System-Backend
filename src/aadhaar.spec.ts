import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AppService } from './app.service.js';
import { PaymentsService } from './payments.service.js';

describe('Aadhaar registration storage', () => {
  let store: AppService;
  const guest = {
    name: 'Test Guest',
    email: 'guest@example.com',
    phone: '9876543210',
    aadhaar: '123456789012',
  };
  const details = {
    name: 'Meetup',
    location: 'Hall',
    startsAt: new Date(Date.now() + 86400000).toISOString(),
    capacity: 10,
  };
  beforeEach(() => {
    vi.stubEnv('DATABASE_PATH', ':memory:');
    vi.stubEnv('PAYMENT_UPI_ID', 'test@bank');
    vi.stubEnv('PAYMENT_PAYEE_NAME', 'Test Organizer');
    store = new AppService();
  });
  afterEach(() => {
    store.onModuleDestroy();
    vi.unstubAllEnvs();
  });
  it.each([
    undefined,
    null,
    123456789012,
    '',
    '12345678901',
    '1234567890123',
    '12345678901a',
  ])(
    'rejects invalid Aadhaar %s before creating free or paid records',
    async (aadhaar) => {
      const free = store.create(details);
      const paid = store.create({ ...details, amount: 50000 });
      expect(() => store.register(free.id, { ...guest, aadhaar })).toThrow(
        'Aadhaar',
      );
      await expect(
        new PaymentsService(store).create(paid.id, {
          ...guest,
          aadhaar,
          token: randomBytes(32).toString('hex'),
        }),
      ).rejects.toThrow('Aadhaar');
      expect(store.registrations()).toHaveLength(0);
    },
  );
  it('retains the number through registration without copying it into confirmation emails', async () => {
    const result = store.register(store.create(details).id, guest);
    expect(store.registrations()[0]).toMatchObject({ aadhaar: guest.aadhaar });
    expect(result).not.toHaveProperty('aadhaar');
    expect(JSON.stringify(await store.outbox.list())).not.toContain(
      guest.aadhaar,
    );
  });
  it('rejects changing the number when retrying a paid booking', async () => {
    const event = store.create({ ...details, amount: 50000 });
    const payments = new PaymentsService(store);
    const body = { ...guest, token: randomBytes(32).toString('hex') };
    const result = await payments.create(event.id, body);
    expect(await store.bookings.get(result.id)).toMatchObject({
      aadhaar: guest.aadhaar,
    });
    await expect(
      payments.create(event.id, { ...body, aadhaar: '234567890123' }),
    ).rejects.toThrow('another registration');
  });
  it('migrates an older SQLite database without losing rows and persists new numbers after restart', () => {
    const folder = mkdtempSync(join(tmpdir(), 'ticket-aadhaar-'));
    const target = resolve(folder);
    if (
      dirname(target) !== resolve(tmpdir()) ||
      !basename(target).startsWith('ticket-aadhaar-')
    )
      throw new Error('Unexpected test cleanup path');
    const path = join(folder, 'tickets.sqlite');
    const { DatabaseSync } = createRequire(import.meta.url)(
      'node:sqlite',
    ) as typeof import('node:sqlite');
    const db = new DatabaseSync(path);
    db.exec(
      'CREATE TABLE events (id TEXT PRIMARY KEY, name TEXT NOT NULL, startsAt TEXT NOT NULL, location TEXT NOT NULL, capacity INTEGER NOT NULL, amount INTEGER NOT NULL DEFAULT 0); CREATE TABLE registrations (id TEXT PRIMARY KEY, eventId TEXT NOT NULL REFERENCES events(id), name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, createdAt TEXT NOT NULL, UNIQUE(eventId,email));',
    );
    db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?)').run(
      'old-event',
      details.name,
      details.startsAt,
      details.location,
      10,
      0,
    );
    db.prepare('INSERT INTO registrations VALUES (?,?,?,?,?,?)').run(
      'old-row',
      'old-event',
      'Old Guest',
      'old@example.com',
      guest.phone,
      new Date().toISOString(),
    );
    db.close();
    vi.stubEnv('DATABASE_PATH', path);
    let migrated: AppService | undefined;
    try {
      migrated = new AppService();
      expect(migrated.registrations()[0]).toMatchObject({
        id: 'old-row',
        aadhaar: null,
      });
      migrated.register('old-event', guest);
      migrated.onModuleDestroy();
      migrated = undefined;
      migrated = new AppService();
      expect(migrated.registrations()).toHaveLength(2);
      expect(migrated.registrations()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            email: guest.email,
            aadhaar: guest.aadhaar,
          }),
        ]),
      );
    } finally {
      migrated?.onModuleDestroy();
      rmSync(target, { recursive: true, force: true });
    }
  });
});
