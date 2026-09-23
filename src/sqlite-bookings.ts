import { ConflictException, NotFoundException } from '@nestjs/common';
import type { DatabaseSync } from 'node:sqlite';
import type { EventRow } from './app.service.js';
import type { SqliteEmailOutbox } from './sqlite-email-outbox.js';
import { emailJob } from './email-outbox.js';
import {
  reservation,
  canIssue,
  type Booking,
  type BookingStore,
  type Payment,
} from './bookings.js';
export class SqliteBookings implements BookingStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly outbox: SqliteEmailOutbox,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS bookings(id TEXT PRIMARY KEY,eventId TEXT NOT NULL,email TEXT NOT NULL,orderId TEXT UNIQUE,paymentId TEXT UNIQUE,ticketToken TEXT UNIQUE,status TEXT NOT NULL,expiresAt INTEGER NOT NULL,lastChecked INTEGER NOT NULL,data TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS bookings_event ON bookings(eventId,status,expiresAt);`);
  }
  private read(row: unknown): Booking | null {
    return row ? (JSON.parse((row as { data: string }).data) as Booking) : null;
  }
  private save(b: Booking) {
    this.db
      .prepare(
        'INSERT INTO bookings VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET orderId=excluded.orderId,paymentId=excluded.paymentId,ticketToken=excluded.ticketToken,status=excluded.status,lastChecked=excluded.lastChecked,data=excluded.data',
      )
      .run(
        b.id,
        b.eventId,
        b.email,
        b.orderId,
        b.paymentId,
        b.ticketToken,
        b.status,
        b.expiresAt,
        b.lastChecked,
        JSON.stringify(b),
      );
  }
  private event(id: string): EventRow | null {
    return (
      (this.db
        .prepare(
          'SELECT e.*, (SELECT COUNT(*) FROM registrations r WHERE r.eventId=e.id) AS registered FROM events e WHERE id=?',
        )
        .get(id) as EventRow) || null
    );
  }
  private held(eventId: string, except: string) {
    return (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM bookings WHERE eventId=? AND id!=? AND status='PENDING' AND expiresAt>?",
        )
        .get(eventId, except, Date.now()) as { n: number }
    ).n;
  }
  async reserve(input: Booking) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.read(
        this.db.prepare('SELECT data FROM bookings WHERE id=?').get(input.id),
      );
      const duplicate = !!this.db
        .prepare(
          "SELECT 1 FROM registrations WHERE eventId=? AND email=? UNION ALL SELECT 1 FROM bookings WHERE eventId=? AND email=? AND (status IN ('PAID','PAYMENT_REVIEW') OR (status='PENDING' AND expiresAt>?))",
        )
        .get(
          input.eventId,
          input.email,
          input.eventId,
          input.email,
          Date.now(),
        );
      reservation(
        this.event(input.eventId),
        input,
        existing,
        duplicate,
        this.held(input.eventId, input.id),
      );
      if (!existing) this.save(input);
      this.db.exec('COMMIT');
      return { booking: existing || input, created: !existing };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  async get(id: string) {
    return this.read(
      this.db.prepare('SELECT data FROM bookings WHERE id=?').get(id),
    );
  }
  async byOrder(orderId: string) {
    return this.read(
      this.db.prepare('SELECT data FROM bookings WHERE orderId=?').get(orderId),
    );
  }
  async attach(id: string, orderId: string) {
    // No await inside SQLite transactions.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const b = this.read(
        this.db.prepare('SELECT data FROM bookings WHERE id=?').get(id),
      );
      if (!b) throw new NotFoundException();
      if (b.orderId && b.orderId !== orderId)
        throw new ConflictException('Order already assigned');
      b.orderId = orderId;
      this.save(b);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  async finish(id: string, p: Payment, ticketToken: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const b = this.read(
        this.db.prepare('SELECT data FROM bookings WHERE id=?').get(id),
      );
      if (!b) throw new NotFoundException();
      if (b.status !== 'PENDING') {
        if (b.paymentId !== p.id)
          throw new ConflictException('Payment already assigned');
        this.db.exec('COMMIT');
        return b;
      }
      const event = this.event(b.eventId);
      if (!event) throw new NotFoundException();
      const duplicate = !!this.db
        .prepare('SELECT 1 FROM registrations WHERE eventId=? AND email=?')
        .get(b.eventId, b.email);
      b.paymentId = p.id;
      if (canIssue(event, this.held(b.eventId, b.id), duplicate)) {
        b.status = 'PAID';
        b.ticketToken = ticketToken;
        this.outbox.enqueue(emailJob(event, b, ticketToken));
        this.db
          .prepare('INSERT INTO registrations VALUES (?,?,?,?,?,?)')
          .run(
            b.id,
            b.eventId,
            b.name,
            b.email,
            b.phone,
            new Date().toISOString(),
          );
      } else {
        b.status = 'PAYMENT_REVIEW';
        b.reviewReason =
          'Payment captured after availability changed. Organizer must arrange a refund.';
      }
      this.save(b);
      this.db.exec('COMMIT');
      return b;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  async pending() {
    return this.db
      .prepare(
        "SELECT data FROM bookings WHERE status='PENDING' AND orderId IS NOT NULL ORDER BY lastChecked LIMIT 25",
      )
      .all()
      .map((r) => this.read(r)!);
  }
  async checked(id: string) {
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE bookings SET lastChecked=?,data=json_set(data,'$.lastChecked',?) WHERE id=?",
      )
      .run(now, now, id);
  }
  async review() {
    return this.db
      .prepare(
        "SELECT data FROM bookings WHERE status='PAYMENT_REVIEW' ORDER BY lastChecked DESC LIMIT 1000",
      )
      .all()
      .map((r) => this.read(r)!);
  }
  async refund(id: string, paymentId: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const b = this.read(
        this.db.prepare('SELECT data FROM bookings WHERE id=?').get(id),
      );
      if (!b) throw new NotFoundException();
      if (b.paymentId && b.paymentId !== paymentId)
        throw new ConflictException('Payment already assigned');
      if (b.status === 'PAID')
        this.db.prepare('DELETE FROM registrations WHERE id=?').run(b.id);
      b.status = 'REFUNDED';
      b.paymentId = paymentId;
      b.reviewReason =
        'Payment fully refunded. This ticket is no longer valid.';
      this.save(b);
      this.db.exec('COMMIT');
      return b;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  async checkin(token: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const b = this.read(
        this.db
          .prepare(
            "SELECT data FROM bookings WHERE ticketToken=? AND status='PAID'",
          )
          .get(token),
      );
      if (!b) throw new NotFoundException('Ticket not found');
      if (b.checkedInAt)
        throw new ConflictException('Ticket has already been checked in');
      b.checkedInAt = Date.now();
      this.save(b);
      this.db.exec('COMMIT');
      return b;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}
