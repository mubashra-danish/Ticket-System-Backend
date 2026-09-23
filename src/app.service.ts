import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  UnauthorizedException,
} from '@nestjs/common';
import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { SqliteBookings } from './sqlite-bookings.js';
import { SqliteEmailOutbox } from './sqlite-email-outbox.js';
import { emailJob } from './email-outbox.js';
import { paymentsConfigured } from './razorpay.service.js';
export function eventAmount(value: unknown) {
  const amount = value ?? 0;
  if (
    typeof amount !== 'number' ||
    !Number.isSafeInteger(amount) ||
    amount < 0 ||
    amount > 10000000 ||
    (amount > 0 && amount < 100)
  )
    throw new BadRequestException(
      'Price must be zero or between INR 1 and INR 100,000, in paise',
    );
  if (amount > 0 && !paymentsConfigured())
    throw new BadRequestException(
      'Configure the payment provider before publishing a paid event',
    );
  return amount;
}
const deriveKey = promisify(scrypt);
export const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export function field(body: Record<string, unknown>, key: string, max: number) {
  const value = body?.[key];
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    throw new BadRequestException('Invalid ' + key);
  return value.trim();
}
export function email(body: Record<string, unknown>) {
  const value = field(body, 'email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
    throw new BadRequestException('Invalid email');
  return value;
}
export type EventRow = {
  id: string;
  name: string;
  startsAt: string;
  location: string;
  capacity: number;
  amount: number;
  registered: number;
};
@Injectable()
export class AppService implements OnModuleDestroy {
  private readonly db: DatabaseSync;
  readonly bookings: SqliteBookings;
  readonly outbox: SqliteEmailOutbox;
  constructor() {
    const path = process.env.DATABASE_PATH || './data/tickets.sqlite';
    if (path !== ':memory:')
      mkdirSync(dirname(resolve(path)), { recursive: true });
    const { DatabaseSync } = createRequire(import.meta.url)(
      'node:sqlite',
    ) as typeof import('node:sqlite');
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, name TEXT NOT NULL, startsAt TEXT NOT NULL, location TEXT NOT NULL, capacity INTEGER NOT NULL CHECK(capacity>0), amount INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS registrations (id TEXT PRIMARY KEY, eventId TEXT NOT NULL REFERENCES events(id), name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, createdAt TEXT NOT NULL, UNIQUE(eventId,email));
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);`);
    this.outbox = new SqliteEmailOutbox(this.db);
    this.bookings = new SqliteBookings(this.db, this.outbox);
  }
  onModuleDestroy() {
    this.db.close();
  }
  limit(key: string, maximum: number, windowMs: number) {
    const now = Date.now();
    this.db.prepare('DELETE FROM limits WHERE expires <= ?').run(now);
    const row = this.db
      .prepare(
        'INSERT INTO limits(key,count,expires) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count',
      )
      .get(key, now + windowMs) as { count: number };
    return row.count <= maximum;
  }
  async login(body: Record<string, unknown>) {
    const address = email(body);
    const password = field(body, 'password', 256);
    const [salt, expectedHex] = (process.env.ADMIN_PASSWORD_HASH || '').split(
      ':',
    );
    if (!salt || !expectedHex || !/^[a-f0-9]{128}$/.test(expectedHex))
      throw new UnauthorizedException('Admin account is not configured');
    const actual = (await deriveKey(password, salt, 64)) as Buffer;
    if (
      !timingSafeEqual(actual, Buffer.from(expectedHex, 'hex')) ||
      address !== process.env.ADMIN_EMAIL?.toLowerCase()
    )
      throw new UnauthorizedException('Invalid email or password');
    const token = randomBytes(32).toString('hex');
    this.db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
    this.db
      .prepare('INSERT INTO sessions VALUES (?,?)')
      .run(digest(token), Date.now() + 8 * 60 * 60 * 1000);
    return token;
  }
  authenticated(token: string) {
    return !!this.db
      .prepare('SELECT 1 FROM sessions WHERE token=? AND expires>?')
      .get(digest(token), Date.now());
  }
  logout(token: string) {
    this.db.prepare('DELETE FROM sessions WHERE token=?').run(digest(token));
  }
  events(): EventRow[] {
    return this.db
      .prepare(
        'SELECT e.*, (SELECT COUNT(*) FROM registrations r WHERE r.eventId=e.id) AS registered FROM events e ORDER BY startsAt',
      )
      .all() as EventRow[];
  }
  event(id: string): EventRow {
    const event = this.db
      .prepare(
        'SELECT e.*, (SELECT COUNT(*) FROM registrations r WHERE r.eventId=e.id) AS registered FROM events e WHERE id=?',
      )
      .get(id) as EventRow | undefined;
    if (!event) throw new NotFoundException('Event not found');
    return event;
  }
  create(body: Record<string, unknown>) {
    const name = field(body, 'name', 120),
      location = field(body, 'location', 240);
    const startsAt = field(body, 'startsAt', 40);
    if (
      !Number.isFinite(Date.parse(startsAt)) ||
      Date.parse(startsAt) <= Date.now()
    )
      throw new BadRequestException('Choose a future event date');
    const capacity = body.capacity;
    if (
      typeof capacity !== 'number' ||
      !Number.isInteger(capacity) ||
      capacity < 1 ||
      capacity > 100000
    )
      throw new BadRequestException('Capacity must be between 1 and 100,000');
    const amount = eventAmount(body.amount);
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO events VALUES (?,?,?,?,?,?)')
      .run(
        id,
        name,
        new Date(startsAt).toISOString(),
        location,
        capacity,
        amount,
      );
    return this.event(id);
  }
  register(eventId: string, body: Record<string, unknown>) {
    const name = field(body, 'name', 120),
      address = email(body),
      phone = field(body, 'phone', 24);
    if (!/^[+\d ()-]{7,24}$/.test(phone))
      throw new BadRequestException('Invalid phone number');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const event = this.event(eventId);
      if (Date.parse(event.startsAt) <= Date.now())
        throw new ConflictException('Registration has closed');
      if (event.amount !== 0)
        throw new ConflictException('Paid registration is not available');
      if (
        this.db
          .prepare('SELECT 1 FROM registrations WHERE eventId=? AND email=?')
          .get(eventId, address)
      )
        throw new ConflictException('This email is already registered');
      if (event.registered >= event.capacity)
        throw new ConflictException('This event is full');
      const id = randomUUID();
      this.db
        .prepare('INSERT INTO registrations VALUES (?,?,?,?,?,?)')
        .run(id, eventId, name, address, phone, new Date().toISOString());
      this.outbox.enqueue(emailJob(event, { id, name, email: address }));
      this.db.exec('COMMIT');
      return { id, eventName: event.name };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  registrations() {
    return this.db
      .prepare(
        'SELECT r.*, e.name AS eventName FROM registrations r JOIN events e ON e.id=r.eventId ORDER BY r.createdAt DESC LIMIT 1000',
      )
      .all();
  }
}
