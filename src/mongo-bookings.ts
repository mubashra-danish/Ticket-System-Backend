import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Db, MongoClient, ClientSession } from 'mongodb';
import type { EventRow } from './app.service.js';
import type { MongoEmailOutbox } from './mongo-email-outbox.js';
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
export class MongoBookings implements BookingStore {
  constructor(
    private readonly client: MongoClient,
    private readonly db: Db,
    private readonly outbox: MongoEmailOutbox,
  ) {}
  private get rows() {
    return this.db.collection<Booking>('bookings');
  }
  async init() {
    await this.rows.createIndex({ id: 1 }, { unique: true });
    for (const key of ['orderId', 'paymentId', 'ticketToken'])
      await this.rows.createIndex(
        { [key]: 1 },
        {
          unique: true,
          partialFilterExpression: { [key]: { $type: 'string' } },
        },
      );
    await this.rows.createIndex({ eventId: 1, status: 1, expiresAt: 1 });
    await this.rows.createIndex({ status: 1, lastChecked: 1 });
  }
  private async transaction<T>(fn: (session: ClientSession) => Promise<T>) {
    const session = this.client.startSession();
    try {
      return await session.withTransaction(() => fn(session), {
        writeConcern: { w: 'majority' },
      });
    } finally {
      await session.endSession();
    }
  }
  private async lock(eventId: string, session: ClientSession) {
    const event = await this.db
      .collection<EventRow & { paymentVersion?: number }>('events')
      .findOneAndUpdate(
        { id: eventId },
        { $inc: { paymentVersion: 1 } },
        { session, returnDocument: 'after' },
      );
    if (!event) throw new NotFoundException('Event not found');
    return event;
  }
  private held(eventId: string, except: string, session: ClientSession) {
    return this.rows.countDocuments(
      {
        eventId,
        id: { $ne: except },
        status: { $in: ['PENDING', 'AWAITING_APPROVAL'] },
        expiresAt: { $gt: Date.now() },
      },
      { session },
    );
  }
  async reserve(input: Booking) {
    return this.transaction(async (session) => {
      const event = await this.lock(input.eventId, session);
      const existing = await this.rows.findOne({ id: input.id }, { session });
      const registration = await this.db
        .collection('registrations')
        .findOne({ eventId: input.eventId, email: input.email }, { session });
      const pending = await this.rows.findOne(
        {
          eventId: input.eventId,
          email: input.email,
          $or: [
            {
              status: { $in: ['PAID', 'PAYMENT_REVIEW', 'AWAITING_APPROVAL'] },
            },
            { status: 'PENDING', expiresAt: { $gt: Date.now() } },
          ],
        },
        { session },
      );
      reservation(
        event,
        input,
        existing,
        !!registration || !!pending,
        await this.held(input.eventId, input.id, session),
      );
      if (!existing) await this.rows.insertOne({ ...input }, { session });
      return { booking: existing || input, created: !existing };
    });
  }
  async get(id: string) {
    return this.rows.findOne({ id }, { projection: { _id: 0 } });
  }
  async approve(id: string, decision: Decision, ticketToken: string) {
    return this.transaction(async (session) => {
      const b = await this.rows.findOne({ id }, { session });
      if (!b) throw new NotFoundException();
      const event = await this.lock(b.eventId, session);
      approveClaim(b, decision);
      const paymentId = 'upi:' + decision.reference;
      if (b.status === 'PAID' || b.status === 'PAYMENT_REVIEW') {
        return b;
      }
      const duplicate = !!(await this.db
        .collection('registrations')
        .findOne({ eventId: b.eventId, email: b.email }, { session }));
      if (
        await this.rows.findOne(
          { paymentId: paymentId, id: { $ne: id } },
          { session },
        )
      )
        throw new ConflictException(
          'This bank reference has already been used for another booking.',
        );
      b.paymentId = paymentId;
      if (
        canIssue(event, await this.held(b.eventId, b.id, session), duplicate)
      ) {
        b.status = 'PAID';
        b.reviewReason = null;
        b.ticketToken = ticketToken;
        await this.outbox.enqueue(emailJob(event, b, ticketToken), session);
        await this.db.collection('registrations').insertOne(
          {
            id: b.id,
            eventId: b.eventId,
            eventName: b.eventName,
            name: b.name,
            email: b.email,
            phone: b.phone,
            createdAt: new Date().toISOString(),
          },
          { session },
        );
        await this.db
          .collection<EventRow>('events')
          .updateOne(
            { id: b.eventId },
            { $inc: { registered: 1 } },
            { session },
          );
      } else {
        b.status = 'PAYMENT_REVIEW';
        b.reviewReason =
          'The payment was verified, but a seat is no longer available. Please contact the organizer to arrange a refund. Do not pay again.';
      }
      await this.rows.updateOne(
        { id },
        {
          $set: {
            status: b.status,
            paymentId: b.paymentId,
            ticketToken: b.ticketToken,
            reviewReason: b.reviewReason,
            ...(b.decision ? { decision: b.decision } : {}),
          },
        },
        { session },
      );
      return b;
    });
  }
  private async updateClaim(id: string, change: (b: Booking) => void) {
    return this.transaction(async (session) => {
      const b = await this.rows.findOne({ id }, { session });
      if (!b) throw new NotFoundException();
      await this.lock(b.eventId, session);
      change(b);
      await this.rows.updateOne(
        { id },
        {
          $set: {
            status: b.status,
            submittedReference: b.submittedReference,
            submittedAt: b.submittedAt,
            reviewReason: b.reviewReason,
            ...(b.decision ? { decision: b.decision } : {}),
          },
        },
        { session },
      );
      return b;
    });
  }
  submit(id: string, reference: string) {
    return this.updateClaim(id, (b) => submitClaim(b, reference));
  }
  reject(id: string, decision: Decision) {
    return this.updateClaim(id, (b) => rejectClaim(b, decision));
  }
  async review() {
    return this.rows
      .find(
        { status: { $in: ['PAYMENT_REVIEW', 'AWAITING_APPROVAL'] } },
        { projection: { _id: 0 } },
      )
      .sort({ createdAt: -1 })
      .limit(1000)
      .toArray();
  }
  async checkin(token: string) {
    const b = await this.rows.findOneAndUpdate(
      { ticketToken: token, status: 'PAID', checkedInAt: null },
      { $set: { checkedInAt: Date.now() } },
      { returnDocument: 'after' },
    );
    if (b) return b;
    if (await this.rows.findOne({ ticketToken: token }))
      throw new ConflictException('Ticket has already been checked in');
    throw new NotFoundException('Ticket not found');
  }
}
