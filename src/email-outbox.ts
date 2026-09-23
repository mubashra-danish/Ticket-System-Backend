import type { EventRow } from './app.service.js';
export type EmailPayload = {
  registrationId: string;
  eventId: string;
  eventName: string;
  startsAt: string;
  location: string;
  name: string;
  to: string;
  ticketToken: string | null;
  amount: number;
};
export type EmailJob = {
  id: string;
  payload: EmailPayload;
  status: 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'CANCELLED';
  createdAt: number;
  nextAttempt: number;
  attempts: number;
  firstAttempt: number | null;
  leaseUntil: number;
  leaseToken: string | null;
  request: string | null;
  providerId: string | null;
  lastError: string | null;
};
export interface EmailOutbox {
  get(id: string): Promise<EmailJob | null>;
  claim(): Promise<EmailJob | null>;
  prepare(job: EmailJob, request: string): Promise<boolean>;
  complete(job: EmailJob, providerId: string): Promise<void>;
  fail(job: EmailJob, error: string, terminal: boolean): Promise<void>;
  cancel(job: EmailJob): Promise<void>;
  list(): Promise<EmailJob[]>;
}
export function emailJob(
  event: EventRow,
  registration: { id: string; name: string; email: string },
  ticketToken: string | null = null,
): EmailJob {
  const now = Date.now();
  return {
    id: 'registration-' + registration.id,
    payload: {
      registrationId: registration.id,
      eventId: event.id,
      eventName: event.name,
      startsAt: event.startsAt,
      location: event.location,
      name: registration.name,
      to: registration.email,
      ticketToken,
      amount: event.amount,
    },
    status: 'PENDING',
    createdAt: now,
    nextAttempt: now,
    attempts: 0,
    firstAttempt: null,
    leaseUntil: 0,
    leaseToken: null,
    request: null,
    providerId: null,
    lastError: null,
  };
}
export const RETRY_WINDOW = 23 * 60 * 60 * 1000;
export const retryAt = (attempts: number) =>
  Date.now() + Math.min(3600000, 60000 * 2 ** Math.min(attempts, 6));
