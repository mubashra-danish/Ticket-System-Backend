import { ConflictException, NotFoundException } from '@nestjs/common';
import type { DatabaseSync } from 'node:sqlite';
import type { EventRow } from './app.service.js';
import type { SqliteEmailOutbox } from './sqlite-email-outbox.js';
import {
  approveClaim,
  submitClaim,
  rejectClaim,
  type Decision,
} from './manual-payments.js';
import { emailJob } from './email-outbox.js';
import {
  reservation,
  canIssue,
  type Booking,
  type BookingStore,
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
          "SELECT COUNT(*) AS n FROM bookings WHERE eventId=? AND id!=? AND status IN ('PENDING','AWAITING_APPROVAL') AND expiresAt>?",
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
          "SELECT 1 FROM registrations WHERE eventId=? AND email=? UNION ALL SELECT 1 FROM bookings WHERE eventId=? AND email=? AND (status IN ('PAID','PAYMENT_REVIEW','AWAITING_APPROVAL') OR (status='PENDING' AND expiresAt>?))",
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
  async approve(id: string, decision: Decision, ticketToken: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const b = this.read(
        this.db.prepare('SELECT data FROM bookings WHERE id=?').get(id),
      );
      if (!b) throw new NotFoundException();
      approveClaim(b, decision);
      const paymentId = 'upi:' + decision.reference;
      if (b.status === 'PAID' || b.status === 'PAYMENT_REVIEW') {
        this.db.exec('COMMIT');
        return b;
      }
      const event = this.event(b.eventId);
      if (!event) throw new NotFoundException();
      const duplicate = !!this.db
        .prepare('SELECT 1 FROM registrations WHERE eventId=? AND email=?')
        .get(b.eventId, b.email);
      if (
        this.db
          .prepare('SELECT 1 FROM bookings WHERE paymentId=? AND id!=?')
          .get(paymentId, id)
      )
        throw new ConflictException(
          'This bank reference has already been used for another booking.',
        );
      b.paymentId = paymentId;
      if (canIssue(event, this.held(b.eventId, b.id), duplicate)) {
        b.status = 'PAID';
        b.reviewReason = null;
        b.ticketToken = ticketToken;
        this.outbox.enqueue(emailJob(event, b, ticketToken));
        this.db
          .prepare(
            'INSERT INTO registrations (id,eventId,name,email,phone,createdAt,aadhaar) VALUES (?,?,?,?,?,?,?)',
          )
          .run(
            b.id,
            b.eventId,
            b.name,
            b.email,
            b.phone,
            new Date().toISOString(),
            b.aadhaar ?? null,
          );
      } else {
        b.status = 'PAYMENT_REVIEW';
        b.reviewReason =
          'The payment was verified, but a seat is no longer available. Please contact the organizer to arrange a refund. Do not pay again.';
      }
      this.save(b);
      this.db.exec('COMMIT');
      return b;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  private async updateClaim(id: string, change: (b: Booking) => void) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const b = this.read(
        this.db.prepare('SELECT data FROM bookings WHERE id=?').get(id),
      );
      if (!b) throw new NotFoundException();
      change(b);
      this.save(b);
      this.db.exec('COMMIT');
      return b;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  submit(id: string, reference: string) {
    return this.updateClaim(id, (b) => submitClaim(b, reference));
  }
  reject(id: string, decision: Decision) {
    return this.updateClaim(id, (b) => rejectClaim(b, decision));
  }
  async review() {
    return this.db
      .prepare(
        "SELECT data FROM bookings WHERE status IN ('PAYMENT_REVIEW','AWAITING_APPROVAL') ORDER BY lastChecked DESC LIMIT 1000",
      )
      .all()
      .map((r) => this.read(r)!);
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
