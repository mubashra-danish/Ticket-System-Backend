import {
  Injectable,
  ServiceUnavailableException,
  BadRequestException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Booking, Payment } from './bookings.js';
export function paymentsConfigured() {
  return !!(
    process.env.RAZORPAY_KEY_ID &&
    process.env.RAZORPAY_KEY_SECRET &&
    process.env.RAZORPAY_WEBHOOK_SECRET
  );
}
export function signatureValid(
  value: Buffer | string,
  signature: unknown,
  secret: string,
) {
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature))
    return false;
  return timingSafeEqual(
    createHmac('sha256', secret).update(value).digest(),
    Buffer.from(signature, 'hex'),
  );
}
export type RazorOrder = {
  id: string;
  amount: number;
  currency: string;
  receipt: string;
};
@Injectable()
export class RazorpayService {
  async request<T>(path: string, body?: unknown): Promise<T> {
    if (!paymentsConfigured())
      throw new ServiceUnavailableException(
        'Online payments are not configured. Please contact the organizer.',
      );
    try {
      const response = await fetch('https://api.razorpay.com/v1' + path, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization:
            'Basic ' +
            Buffer.from(
              process.env.RAZORPAY_KEY_ID +
                ':' +
                process.env.RAZORPAY_KEY_SECRET,
            ).toString('base64'),
          'Content-Type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error('Provider request rejected');
      return (await response.json()) as T;
    } catch {
      throw new ServiceUnavailableException(
        'Payment provider is unavailable. Check booking status before trying again.',
      );
    }
  }
  async create(b: Booking) {
    return this.request<RazorOrder>('/orders', {
      amount: b.amount,
      currency: b.currency,
      receipt: b.id,
      partial_payment: false,
      notes: { bookingId: b.id },
    });
  }
  async payment(id: string) {
    if (!/^pay_[a-zA-Z0-9]+$/.test(id))
      throw new BadRequestException('Invalid payment ID');
    return this.request<Payment>('/payments/' + id);
  }
  async order(id: string) {
    if (!/^order_[a-zA-Z0-9]+$/.test(id))
      throw new BadRequestException('Invalid order ID');
    return this.request<RazorOrder>('/orders/' + id);
  }
  async orderPayments(id: string) {
    if (!/^order_[a-zA-Z0-9]+$/.test(id))
      throw new BadRequestException('Invalid order ID');
    return this.request<{ items: Payment[] }>('/orders/' + id + '/payments');
  }
}
