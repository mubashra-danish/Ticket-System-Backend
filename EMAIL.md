# Ticket email setup

New free registrations queue a confirmation; admin-approved paid bookings queue event details and an attached ticket QR (`ticket.png`). The template uses the site's cream and blue palette. Both MongoDB and SQLite queue the message inside the registration transaction. Existing registrations are not backfilled.

## Registration email verification

Email delivery must be configured before guests can register for free events or start paid bookings. The registration form sends a six-digit code through the SMTP transport configured below, then automatically continues after verification. Codes are never logged or returned by the API. Delivery failures are shown to the guest; there is no verification bypass when email is disabled.

Codes expire after 10 minutes, allow five guesses, and can be resent after 60 seconds. A persistent per-email limit allows five send attempts per hour, in addition to the existing request limits. A resend replaces the previous challenge. Successful verification returns a random token valid for 10 minutes, bound to that email and event. Both registration and order endpoints enforce this token. The token can be reused during that window to retry a failed checkout; existing duplicate-registration and booking protections still apply.

Challenges and token hashes are bounded, temporary in-memory state. Run one API instance, including when using MongoDB. Restarting it invalidates pending verifications; guests must request a new code. Multiple API instances require a shared challenge/proof store before deployment. Attendee form details and the verification token stay in page memory; refreshing before checkout requires starting verification again.

API sequence: `POST /api/email-verification/send` with `email` and `eventId`; `POST /api/email-verification/verify` with those fields plus `challengeId` and `otp`; then include the returned `verificationToken` with attendee details in `POST /api/events/:id/registrations` or `POST /api/events/:id/orders`.

## Activate delivery

1. Get the SMTP host, port, username, password (or app password), and allowed sender address from your email provider. This transport supports username/password authentication; OAuth-only accounts need an additional OAuth integration.
2. Copy the settings from `smtp.env.example` into the backend's ignored `.env` (never frontend environment variables) and replace the placeholders:

```dotenv
EMAIL_ENABLED=true
EMAIL_FROM="Ticket System <tickets@yourdomain.com>"
EMAIL_TIMEZONE=Asia/Kolkata
SMTP_HOST=smtp.yourprovider.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-username
SMTP_PASS=your-smtp-password
```

3. Restart the backend. Pending messages are processed at startup and every 15 seconds, including messages queued while delivery was disabled.
4. Make a registration using your own address. For paid tickets, submit a UPI reference and approve it from Admin > Tickets & payments after checking the receiving account. Check **Admin > Tickets & payments > Ticket emails** and your inbox/spam folder.

For port 587, use `SMTP_SECURE=false`; STARTTLS is required. For port 465, use `SMTP_SECURE=true` for TLS from connection start. Certificates are verified. Follow your provider's sender/domain authentication and sending limits, and allow outbound access to its SMTP port from your hosting server. See [Nodemailer's SMTP settings](https://nodemailer.com/smtp). An SMTP server and working credentials are required; changing the protocol does not create a mailbox or remove the provider's limits.

The old `RESEND_API_KEY` is no longer read and can be removed. Previously unattempted queued confirmations can use SMTP. Previously attempted messages with a saved old-provider request are marked `FAILED` for review, because the earlier provider may already have accepted them. Pending SMTP messages keep their original sender/content across retries, so ensure that sender is permitted by your new provider.

## Delivery behavior

- Queue records survive restarts. Multiple workers claim jobs with expiring leases.
- Confirmed temporary SMTP rejections and known connection failures before message submission retry with backoff, up to 12 attempts or 23 hours. Retries preserve message content and a stable Message-ID. SMTP provides no guaranteed deduplication; a stable Message-ID alone does not prevent duplicates.
- A lost connection during submission, uncertain delivery, failed database acknowledgement, or an expired worker lease after sending started requires admin review instead of automatic resending. SQLite and MongoDB persist the send-start marker before contacting SMTP. In the rare case of a crash just before the actual send, review may be needed even though nothing was sent.
- `SENT` means the SMTP server accepted the email; it does not prove inbox delivery. Inspect your provider's logs and bounce mailbox for delivery failures. Delivery-event webhooks are not implemented.
- Permanent configuration/provider errors become `FAILED`. Check the provider logs and correct configuration before arranging any manual resend; there is no automatic resend button.
- Refunded/invalidated tickets are cancelled before sending when possible. An email already in flight cannot be recalled, but the refunded QR fails check-in.
- Free confirmations contain a reference, not a paid admission QR. The emailed paid QR works at check-in; it does not restore the browser checkout session.
- Queue records contain recipient details and ticket tokens. Protect database backups and establish retention rules before launch.

Tests mock the SMTP transport; no real email is sent by the test suite. Live delivery requires your SMTP credentials and an allowed sender. Test one registration with an address you control after configuration, including the paid-ticket PNG attachment. Never enable SMTP debug logging in production because message content can include OTPs.
