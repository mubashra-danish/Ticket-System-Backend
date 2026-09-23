import { ConflictException, NotFoundException } from '@nestjs/common';
import type { EventRow } from './app.service.js';
export type Booking = {
  id: string;
  accessHash: string;
  eventId: string;
  eventName: string;
  name: string;
  email: string;
  phone: string;
  amount: number;
  currency: 'INR';
  status: 'PENDING' | 'PAID' | 'PAYMENT_REVIEW' | 'REFUNDED';
  createdAt: number;
  expiresAt: number;
  lastChecked: number;
  orderId: string | null;
  paymentId: string | null;
  ticketToken: string | null;
  checkedInAt: number | null;
  reviewReason: string | null;
};
export type Payment = {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: string;
  amount_refunded?: number;
};
export interface BookingStore {
  reserve(input: Booking): Promise<{ booking: Booking; created: boolean }>;
  get(id: string): Promise<Booking | null>;
  byOrder(orderId: string): Promise<Booking | null>;
  attach(id: string, orderId: string): Promise<void>;
  finish(id: string, payment: Payment, ticketToken: string): Promise<Booking>;
  pending(): Promise<Booking[]>;
  checked(id: string): Promise<void>;
  review(): Promise<Booking[]>;
  refund(id: string, paymentId: string): Promise<Booking>;
  checkin(token: string): Promise<Booking>;
}
export function reservation(
  event: EventRow | null,
  input: Booking,
  existing: Booking | null,
  duplicate: boolean,
  held: number,
) {
  if (existing) {
    if (
      existing.accessHash !== input.accessHash ||
      existing.eventId !== input.eventId ||
      existing.email !== input.email ||
      existing.name !== input.name ||
      existing.phone !== input.phone
    )
      throw new ConflictException(
        'This checkout belongs to another registration. Start a new booking.',
      );
    return;
  }
  if (!event) throw new NotFoundException('Event not found');
  if (Date.parse(event.startsAt) <= Date.now())
    throw new ConflictException('Registration has closed');
  if (event.amount <= 0 || event.amount !== input.amount)
    throw new ConflictException('Event price changed. Reload and try again.');
  if (duplicate)
    throw new ConflictException(
      'This email already has a registration or an active checkout',
    );
  if (event.registered + held >= event.capacity)
    throw new ConflictException(
      'All places are booked or temporarily reserved. Please try again later.',
    );
}
export function canIssue(event: EventRow, held: number, duplicate: boolean) {
  // A late capture may reclaim a free seat, but never a seat held by another checkout.
  return (
    Date.parse(event.startsAt) > Date.now() &&
    !duplicate &&
    event.registered + held < event.capacity
  );
}
