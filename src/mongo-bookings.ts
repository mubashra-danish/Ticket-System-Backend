import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Db, MongoClient, ClientSession } from 'mongodb';
import type { EventRow } from './app.service.js';
import type { MongoEmailOutbox } from './mongo-email-outbox.js';
import { emailJob } from './email-outbox.js';
import {
  reservation,
  canIssue,
  type Booking,
  type BookingStore,
  type Payment,
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
        status: 'PENDING',
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
            { status: { $in: ['PAID', 'PAYMENT_REVIEW'] } },
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
  async byOrder(orderId: string) {
    return this.rows.findOne({ orderId }, { projection: { _id: 0 } });
  }
  async attach(id: string, orderId: string) {
    const result = await this.rows.updateOne(
      { id, $or: [{ orderId: null }, { orderId }] },
      { $set: { orderId } },
    );
    if (!result.matchedCount)
      throw new ConflictException('Order already assigned');
  }
  async finish(id: string, p: Payment, ticketToken: string) {
    return this.transaction(async (session) => {
      const b = await this.rows.findOne({ id }, { session });
      if (!b) throw new NotFoundException();
      const event = await this.lock(b.eventId, session);
      if (b.status !== 'PENDING') {
        if (b.paymentId !== p.id)
          throw new ConflictException('Payment already assigned');
        return b;
      }
      const duplicate = !!(await this.db
        .collection('registrations')
        .findOne({ eventId: b.eventId, email: b.email }, { session }));
      b.paymentId = p.id;
      if (
        canIssue(event, await this.held(b.eventId, b.id, session), duplicate)
      ) {
        b.status = 'PAID';
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
          'Payment captured after availability changed. Organizer must arrange a refund.';
      }
      await this.rows.updateOne(
        { id },
        {
          $set: {
            status: b.status,
            paymentId: b.paymentId,
            ticketToken: b.ticketToken,
            reviewReason: b.reviewReason,
          },
        },
        { session },
      );
      return b;
    });
  }
  async pending() {
    return this.rows
      .find({ status: 'PENDING', orderId: { $type: 'string' } })
      .sort({ lastChecked: 1 })
      .limit(25)
      .toArray();
  }
  async checked(id: string) {
    await this.rows.updateOne({ id }, { $set: { lastChecked: Date.now() } });
  }
  async review() {
    return this.rows
      .find({ status: 'PAYMENT_REVIEW' }, { projection: { _id: 0 } })
      .sort({ createdAt: -1 })
      .limit(1000)
      .toArray();
  }
  async refund(id: string, paymentId: string) {
    return this.transaction(async (session) => {
      const b = await this.rows.findOne({ id }, { session });
      if (!b) throw new NotFoundException();
      await this.lock(b.eventId, session);
      if (b.paymentId && b.paymentId !== paymentId)
        throw new ConflictException('Payment already assigned');
      if (b.status === 'PAID') {
        await this.db
          .collection('registrations')
          .deleteOne({ id: b.id }, { session });
        await this.db
          .collection<EventRow>('events')
          .updateOne(
            { id: b.eventId },
            { $inc: { registered: -1 } },
            { session },
          );
      }
      b.status = 'REFUNDED';
      b.paymentId = paymentId;
      b.reviewReason =
        'Payment fully refunded. This ticket is no longer valid.';
      await this.rows.updateOne(
        { id },
        { $set: { status: b.status, paymentId, reviewReason: b.reviewReason } },
        { session },
      );
      return b;
    });
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
