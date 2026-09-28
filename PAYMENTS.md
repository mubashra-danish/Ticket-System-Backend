# Direct UPI payments and admin approval

Razorpay is no longer used. Customers transfer money directly to the organizer's UPI account. This application does not charge a payment gateway fee or automatically verify bank credits. Any account/provider charges remain subject to your banking arrangement.

## Configure

Set these backend `.env` values to your real receiving account, then restart the backend:

```dotenv
PAYMENT_UPI_ID=your-business@yourbank
PAYMENT_PAYEE_NAME="Your business name"
```

There is deliberately no default receiving account. Paid event creation and new paid bookings are disabled until these values are valid. Free registrations still work. Check the UPI ID and recipient name with a small transfer before publishing. Never put a PIN, OTP or bank password in these settings. Existing bookings keep the recipient details displayed when they were created.

## Customer flow

1. Enter attendee details and verify the email address with the emailed code. The server then fixes the event price and creates a private booking with a 30-minute seat hold (or until the event starts). Email verification requires the configuration in [EMAIL.md](EMAIL.md).
2. Scan the UPI QR or open the UPI app, check the recipient, and transfer the exact amount once.
3. Enter the 12-digit UPI transaction reference (UTR/RRN). This is an unverified claim. No registration, ticket or confirmation email is issued yet.
4. The customer sees a friendly awaiting-verification message. They can refresh status in the same browser tab. The page polls briefly and also has a manual status button.
5. After approval, the ticket and printable admission QR appear. A durable confirmation email is queued in the same database transaction. Configure delivery using [EMAIL.md](EMAIL.md). If email is unavailable, the customer can print/save the ticket from this page.

The private status token is stored in sessionStorage. It is not put into URLs or QR codes. Losing the browser session removes online status access; the customer should retain their booking reference and contact the organizer, or use their emailed ticket after approval. The booking reference alone cannot access a ticket.

## Organizer verification

Open **Admin > Tickets & payments**. Independently open the receiving bank's transaction history and verify:

- The credit actually reached the receiving account (not merely pending in the payer's app).
- The 12-digit reference and exact amount match.
- The recipient, payer identity and transaction date correspond to this booking. Contact the customer when the payer differs; do not accept someone else's transaction as theirs.

Enter the bank reference and credited amount, record the payer/date in the verification note, check the bank-verification box, and approve. Notes and the admin identity/time are persisted with the decision. A verified reference is unique across all bookings, enforced by the database. Duplicate approvals issue only one ticket and one queued email. Unverified references are not globally reserved, so a false claim cannot squat on a legitimate reference.

Reject an unverifiable claim with a clear reason. The customer sees that reason; rejection releases the seat and cannot later be approved. Corrected claims require a new booking. Rejection does not refund a transfer. If money arrived, arrange the refund directly, inform the customer and retain the bank record.

Screenshots, SMS, a submitted reference and the customer's payment-success screen are not sufficient evidence. Manual review reduces risk but is not fraud-proof. The application has no bank access and cannot prove receipt automatically. Review promptly and protect admin access.

The reference field uses the 12-digit RRN described in [NPCI's UPI account-statement specification](https://www.npci.org.in/PDF/npci/upi/circular/2018/UPI%20-%20Circular%20No.43.pdf). Customers should use that bank reference rather than an app's internal transaction ID.

## Availability, refunds and old bookings

Pending and awaiting-approval bookings count against capacity only during their initial seat hold. Late payment references can still be reported. Approval checks current event availability atomically; it cannot oversell, override an existing registration, or issue after the event starts. If money is verified but a seat is unavailable, the booking stays in the review queue with no ticket or confirmation email. The organizer must arrange a refund outside the application and keep records. There is no automatic refund or refund-completion workflow.

Historical payment records and already-issued tickets are retained. Old gateway bookings cannot be approved as manual UPI payments. The gateway callback/webhook/reconciliation routes have been removed: reconcile any outstanding gateway transfers and refunds in the former provider dashboard before switching an active deployment. Previously refunded tickets stay invalid; new external refunds are not automatically detected.

Admission QR codes are random and accepted once, only for confirmed tickets. A copied valid QR could be used first by someone else, so ask guests to keep it private and check attendee identity when appropriate.

## Storage and verification

Both SQLite and MongoDB persist claims, decisions, confirmed payment references and tickets. Approval, seat assignment and email queuing share a transaction. MongoDB requires Atlas or a replica set for transactions. Test your deployed MongoDB configuration and email delivery before accepting real transfers.

Automated checks:

- Backend: `npm.cmd run build`, `npm.cmd test`, `npm.cmd run test:e2e`, `npm.cmd run lint`.
- Frontend: `npm.cmd run build`, `npm.cmd run lint`, `npm.cmd run test:e2e`.

Tests use isolated SQLite and simulated manual approval, not real bank transfers. They cover guest/admin boundaries, origin checks, duplicate claims/approvals/references, reservation expiry, no overselling, rejection, rollback when email queuing fails, and one-time admission. The browser test exercises the customer-to-admin-to-ticket flow.
