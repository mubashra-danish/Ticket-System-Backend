# Razorpay payments and tickets

## Configure locally
Add these values to Ticket-System-Backend/.env. Keep secrets on the backend only:

```env
RAZORPAY_KEY_ID=rzp_test_your_key_id
RAZORPAY_KEY_SECRET=your_test_key_secret
RAZORPAY_WEBHOOK_SECRET=a_separate_random_webhook_secret
```

Restart the backend after changing .env. Without all three values, paid event creation and checkout are disabled; free registration still works. Use test-mode credentials first. Do not paste secrets into source code or the frontend environment.

In Razorpay Dashboard, configure automatic payment capture and a webhook at:

```
https://YOUR_PUBLIC_DOMAIN/api/payments/razorpay/webhook
```

Subscribe to `payment.captured` and `refund.processed`. Use the same webhook secret as RAZORPAY_WEBHOOK_SECRET. The public website must forward /api to this backend. Localhost cannot receive external webhooks; use a trusted HTTPS development tunnel or a staging deployment. Test mode and live mode require their respective keys/webhook configuration.

## What happens
1. Admin creates an event with its price in rupees. The API stores an integer number of paise (500 rupees = 50000 paise). Zero remains free.
2. The attendee supplies details. The server checks its own event price and availability, then reserves a seat for 15 minutes (or until event start, whichever is earlier).
3. A durable booking exists before the server creates a Razorpay order. The order ID and public key are passed to Standard Checkout. Razorpay presents eligible UPI/card/payment options for the device and account.
4. The browser callback is HMAC-verified using the stored order ID. The server fetches the payment from Razorpay, verifies order, amount, currency, capture and refund state, then atomically issues one ticket and registration.
5. The raw-body-signed webhook invokes the same confirmation logic, even when the browser closes. Repeated callbacks/webhooks cannot create another registration or ticket.
6. The page polls local booking state for up to a minute and provides a manual Check payment status action. A background reconciliation loop checks up to 25 pending orders per minute, oldest-check first, including expired holds. It runs only while the API process is up and payment keys are configured.
7. The user can print/save the ticket QR. Admins can paste its contents or use a keyboard barcode reader at /admin/payments. Successful check-in is atomic and a second attempt fails. Camera scanning is not included. Ticket email delivery is available when configured; see [EMAIL.md](EMAIL.md).

The buyer's random access token is stored in sessionStorage to resume after refresh in the same browser tab. No attendee details or provider secrets are stored there. The token is a private capability, never included in URL parameters or the ticket QR. If the tab/session is lost, the checkout session cannot be restored by email; use the emailed QR (when configured) or save/print the issued ticket. Free registrations retain their original confirmation reference and do not get a paid-ticket QR.

## Failure and refund behavior
- Active reservations count against capacity. Expired holds stop counting without deleting the financial record.
- A failed/cancelled payment does not create a ticket. A buyer can retry the same provider order before the reservation expires.
- An expired reservation can accept a late captured payment only when a seat remains available and the email has no confirmed registration. Otherwise it becomes PAYMENT_REVIEW, appears in the admin review queue, and receives no ticket. The organizer must arrange its refund in Razorpay Dashboard; the application does not automatically send refunds.
- A verified full refund marks the booking REFUNDED, invalidates its ticket and removes its active registration. Refund processing is idempotent. A captured webhook replay cannot reactivate a refunded ticket. Partial refunds of an already issued ticket leave it valid; partial refunds before ticket issuance require manual investigation and do not issue a ticket.
- A provider timeout during order creation is ambiguous. The application does not blindly create another order. The reservation expires, and the buyer can start a new booking after checking payment status. Webhooks can recover an order whose response was lost using its server-created receipt.
- Only PENDING bookings are automatically reconciled. Refunds of already confirmed tickets depend on the signed refund webhook (or buyer-triggered status refresh). Monitor webhook delivery failures in Razorpay.

## Storage and security
Both SQLite and MongoDB persist bookings, ticket tokens and payment IDs. MongoDB requires a replica set/Atlas for transactions; per-event writes serialize competing reservations and confirmations. SQLite uses immediate write transactions. Unique provider order/payment indexes prevent accidental reassignment. Amounts come from the database, not the browser. A paid event cannot use the free-registration endpoint.

The webhook is the only browser-Origin exemption; it requires its own raw-body HMAC. Keep its exact URL above, configure HTTPS, and preserve the raw JSON body through proxies. API keys and webhook secrets are separate. Public ticket status requires the buyer capability; review and check-in require an admin session.

## Tests and launch checks
- npm.cmd run build
- npm.cmd test
- npm.cmd run test:e2e
- Frontend: npm.cmd run test:e2e

Automated payment tests simulate Razorpay API/Checkout responses and use isolated SQLite. They cover signatures, amount/currency/order mismatch, duplicate callbacks, seat competition, expired holds, missed captures, full refund invalidation, and one-time check-in. Browser tests cover free registration and a simulated paid checkout through ticket issuance and admin check-in. They do not make real payments or prove your Razorpay account/MongoDB deployment configuration.

Before accepting real money, run a complete Razorpay test-mode transaction and webhook delivery against your configured MongoDB staging database, including refund delivery, dropped-browser recovery, simultaneous final-seat bookings and database restart. Confirm capture settings, refund policy, account activation, backups, webhook monitoring and trusted-ingress rate limits. The current application still uses conservative shared proxy rate limits, so tune them for expected attendance. Switch to live credentials only after those checks.

Official references:
- https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/
- https://razorpay.com/docs/webhooks/validate-test/
- https://razorpay.com/docs/api/payments/fetch-payments-orders/
- https://razorpay.com/docs/webhooks/refunds/
