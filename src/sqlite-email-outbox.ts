import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { retryAt, type EmailJob, type EmailOutbox } from './email-outbox.js';
export class SqliteEmailOutbox implements EmailOutbox {
  async get(id: string) {
    return this.read(
      this.db.prepare('SELECT * FROM email_outbox WHERE id=?').get(id),
    );
  }
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS email_outbox(id TEXT PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL,createdAt INTEGER NOT NULL,nextAttempt INTEGER NOT NULL,attempts INTEGER NOT NULL,firstAttempt INTEGER,leaseUntil INTEGER NOT NULL,leaseToken TEXT,request TEXT,providerId TEXT,lastError TEXT);
 CREATE INDEX IF NOT EXISTS email_outbox_due ON email_outbox(status,nextAttempt,leaseUntil);`);
    const columns = db.prepare('PRAGMA table_info(email_outbox)').all() as {
      name: string;
    }[];
    if (!columns.some((c) => c.name === 'smtpStartedAt'))
      db.exec('ALTER TABLE email_outbox ADD COLUMN smtpStartedAt INTEGER');
  }
  // Called synchronously inside the registration/payment transaction.
  enqueue(job: EmailJob) {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO email_outbox (id,payload,status,createdAt,nextAttempt,attempts,firstAttempt,leaseUntil,leaseToken,request,providerId,lastError) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        job.id,
        JSON.stringify(job.payload),
        job.status,
        job.createdAt,
        job.nextAttempt,
        0,
        null,
        0,
        null,
        null,
        null,
        null,
      );
  }
  private read(row: unknown): EmailJob | null {
    if (!row) return null;
    const job = row as Omit<EmailJob, 'payload'> & { payload: string };
    return { ...job, payload: JSON.parse(job.payload) as EmailJob['payload'] };
  }
  async claim() {
    const now = Date.now(),
      lease = randomUUID();
    return this.read(
      this.db
        .prepare(
          "UPDATE email_outbox SET status='SENDING',attempts=attempts+1,firstAttempt=COALESCE(firstAttempt,?),leaseUntil=?,leaseToken=? WHERE id=(SELECT id FROM email_outbox WHERE (status='PENDING' AND nextAttempt<=?) OR (status='SENDING' AND leaseUntil<=?) ORDER BY nextAttempt LIMIT 1) RETURNING *",
        )
        .get(now, now + 120000, lease, now, now),
    );
  }
  async prepare(job: EmailJob, request: string) {
    return (
      this.db
        .prepare(
          "UPDATE email_outbox SET request=? WHERE id=? AND status='SENDING' AND leaseToken=?",
        )
        .run(request, job.id, job.leaseToken).changes === 1
    );
  }
  async complete(job: EmailJob, providerId: string) {
    this.db
      .prepare(
        "UPDATE email_outbox SET status='SENT',providerId=?,lastError=NULL,leaseUntil=0,leaseToken=NULL,request=NULL,smtpStartedAt=NULL WHERE id=? AND status='SENDING' AND leaseToken=?",
      )
      .run(providerId, job.id, job.leaseToken);
  }
  async fail(job: EmailJob, error: string, terminal: boolean) {
    this.db
      .prepare(
        "UPDATE email_outbox SET status=?,lastError=?,nextAttempt=?,leaseUntil=0,leaseToken=NULL,smtpStartedAt=NULL WHERE id=? AND status='SENDING' AND leaseToken=?",
      )
      .run(
        terminal ? 'FAILED' : 'PENDING',
        error,
        retryAt(job.attempts),
        job.id,
        job.leaseToken,
      );
  }
  async cancel(job: EmailJob) {
    this.db
      .prepare(
        "UPDATE email_outbox SET status='CANCELLED',request=NULL,leaseUntil=0,leaseToken=NULL WHERE id=? AND status='SENDING' AND leaseToken=?",
      )
      .run(job.id, job.leaseToken);
  }
  async beginSend(job: EmailJob) {
    return (
      this.db
        .prepare(
          "UPDATE email_outbox SET smtpStartedAt=? WHERE id=? AND status='SENDING' AND leaseToken=? AND leaseUntil>? AND smtpStartedAt IS NULL",
        )
        .run(Date.now(), job.id, job.leaseToken, Date.now()).changes === 1
    );
  }
  async list() {
    return this.db
      .prepare('SELECT * FROM email_outbox ORDER BY createdAt DESC LIMIT 100')
      .all()
      .map((row) => this.read(row)!);
  }
}
