import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Booking } from './bookings.js';

export type PaymentInstructions = { upiId: string; payeeName: string };
export type Decision = {
  actor: string;
  at: number;
  reference: string;
  note: string;
};
export function paymentInstructions(): PaymentInstructions | null {
  const upiId = process.env.PAYMENT_UPI_ID?.trim();
  const payeeName = process.env.PAYMENT_PAYEE_NAME?.trim();
  return upiId &&
    /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}$/.test(upiId) &&
    payeeName &&
    payeeName.length <= 120
    ? { upiId, payeeName }
    : null;
}
export function paymentReference(value: unknown) {
  if (typeof value !== 'string' || !/^\d{12}$/.test(value.trim()))
    throw new BadRequestException(
      'Enter the 12-digit UPI transaction reference (UTR/RRN) from your payment app.',
    );
  return value.trim();
}
export function submitClaim(b: Booking, reference: string) {
  if (!b.manualPayment)
    throw new ConflictException(
      'Contact the organizer about this older payment.',
    );
  if (b.submittedReference === reference && b.status !== 'REJECTED') return;
  if (b.status !== 'PENDING')
    throw new ConflictException(
      'Payment details have already been submitted. Contact the organizer for corrections.',
    );
  b.submittedReference = reference;
  b.submittedAt = Date.now();
  b.status = 'AWAITING_APPROVAL';
  b.reviewReason =
    'Thank you! Your payment details have been sent to the organizer. Your ticket will be confirmed after the payment is verified. Please do not pay again.';
}
export function rejectClaim(b: Booking, decision: Decision) {
  if (b.status === 'REJECTED') return;
  if (!b.manualPayment || b.status !== 'AWAITING_APPROVAL')
    throw new ConflictException(
      'Only a payment awaiting approval can be rejected.',
    );
  b.status = 'REJECTED';
  b.decision = decision;
  b.reviewReason = decision.note;
}
export function approveClaim(b: Booking, decision: Decision) {
  if (
    !b.manualPayment ||
    !b.submittedReference ||
    b.submittedReference !== decision.reference
  )
    throw new ConflictException(
      'The bank reference must match the submitted UPI reference.',
    );
  if (
    (b.status === 'PAID' || b.status === 'PAYMENT_REVIEW') &&
    b.paymentId === 'upi:' + decision.reference
  )
    return;
  if (b.status !== 'AWAITING_APPROVAL')
    throw new ConflictException('This booking is not awaiting approval.');
  b.decision = decision;
}
