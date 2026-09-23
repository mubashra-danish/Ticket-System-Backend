# Ticket email setup

New free registrations queue a confirmation; verified paid bookings queue event details and an attached ticket QR (`ticket.png`). The template uses the site's cream and blue palette. Both MongoDB and SQLite queue the message inside the registration transaction. Existing registrations are not backfilled.

## Activate delivery

1. Create a Resend account and verify a domain you control, adding the DNS records Resend provides.
2. Create a sending API key. Add these values to the backend's ignored `.env` (never frontend environment variables):

```dotenv
EMAIL_ENABLED=true
RESEND_API_KEY=re_replace_with_your_key
EMAIL_FROM="Ticket System <tickets@your-verified-domain.com>"
EMAIL_TIMEZONE=Asia/Kolkata
```

3. Restart the backend. Pending messages are processed at startup and every 15 seconds, including messages queued while delivery was disabled.
4. Make a registration using your own address. For paid tickets, complete a verified Razorpay test payment. Check **Admin > Tickets & payments > Ticket emails** and your inbox/spam folder.

Resend's free plan currently includes 3,000 emails/month with a 100/day limit: https://resend.com/pricing/ . Domain registration may cost money. Resend's testing sender cannot send unrestricted production mail; use a verified sender domain.

## Delivery behavior

- Queue records survive restarts. Multiple workers claim jobs with expiring leases.
- Transient failures retry with backoff. The exact request and stable idempotency key are reused; Resend deduplicates requests for 24 hours. Automatic retries stop after 23 hours from first attempt or 12 attempts, requiring review rather than risking a duplicate outside that window.
- `SENT` means Resend accepted the email; it does not prove inbox delivery. Inspect Resend's dashboard for bounces/delivery events. Delivery-event webhooks are not implemented.
- Permanent configuration/provider errors become `FAILED`. Check the provider logs and correct configuration before arranging any manual resend; there is no automatic resend button.
- Refunded/invalidated tickets are cancelled before sending when possible. An email already in flight cannot be recalled, but the refunded QR fails check-in.
- Free confirmations contain a reference, not a paid admission QR. The emailed paid QR works at check-in; it does not restore the browser checkout session.
- Queue records contain recipient details and ticket tokens. Protect database backups and establish retention rules before launch.

Tests mock the provider; no real email is sent by the test suite. Live delivery requires your API key and verified sender.
