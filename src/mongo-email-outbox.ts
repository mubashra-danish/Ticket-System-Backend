import { randomUUID } from 'node:crypto';
import type { Db, ClientSession } from 'mongodb';
import { retryAt, type EmailJob, type EmailOutbox } from './email-outbox.js';
export class MongoEmailOutbox implements EmailOutbox {
  async get(id: string) {
    return this.rows.findOne({ id }, { projection: { _id: 0 } });
  }
  constructor(private readonly db: Db) {}
  private get rows() {
    return this.db.collection<EmailJob>('email_outbox');
  }
  async init() {
    await this.rows.createIndex({ id: 1 }, { unique: true });
    await this.rows.createIndex({ status: 1, nextAttempt: 1, leaseUntil: 1 });
  }
  async enqueue(job: EmailJob, session: ClientSession) {
    await this.rows.updateOne(
      { id: job.id },
      { $setOnInsert: job },
      { session, upsert: true },
    );
  }
  async claim() {
    const now = Date.now();
    return this.rows.findOneAndUpdate(
      {
        $or: [
          { status: 'PENDING', nextAttempt: { $lte: now } },
          { status: 'SENDING', leaseUntil: { $lte: now } },
        ],
      },
      [
        {
          $set: {
            status: 'SENDING',
            attempts: { $add: ['$attempts', 1] },
            firstAttempt: { $ifNull: ['$firstAttempt', now] },
            leaseUntil: now + 120000,
            leaseToken: randomUUID(),
          },
        },
      ],
      { sort: { nextAttempt: 1 }, returnDocument: 'after' },
    );
  }
  private owned(job: EmailJob) {
    return {
      id: job.id,
      status: 'SENDING' as const,
      leaseToken: job.leaseToken,
    };
  }
  async prepare(job: EmailJob, request: string) {
    return (
      (await this.rows.updateOne(this.owned(job), { $set: { request } }))
        .matchedCount === 1
    );
  }
  async complete(job: EmailJob, providerId: string) {
    await this.rows.updateOne(this.owned(job), {
      $set: {
        status: 'SENT',
        providerId,
        lastError: null,
        leaseUntil: 0,
        leaseToken: null,
        request: null,
      },
    });
  }
  async fail(job: EmailJob, error: string, terminal: boolean) {
    await this.rows.updateOne(this.owned(job), {
      $set: {
        status: terminal ? 'FAILED' : 'PENDING',
        lastError: error,
        nextAttempt: retryAt(job.attempts),
        leaseUntil: 0,
        leaseToken: null,
      },
    });
  }
  async cancel(job: EmailJob) {
    await this.rows.updateOne(this.owned(job), {
      $set: {
        status: 'CANCELLED',
        request: null,
        leaseUntil: 0,
        leaseToken: null,
      },
    });
  }
  async list() {
    return this.rows
      .find({}, { projection: { _id: 0 } })
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();
  }
}
