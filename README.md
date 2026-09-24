# Ticket System API

NestJS API with SQLite persistence. Use Node.js 24.15+ (the Nest CLI's dependencies require this minimum). SQLite uses Node's built-in module.

## Local setup
```powershell
npm.cmd install
npm.cmd run setup
npm.cmd run start:dev
```
Setup asks for an admin email, generates a strong password, prints it once, and writes only its scrypt hash to the ignored .env file. Save the password in a password manager. No default password is shipped. Existing .env files are never overwritten. API listens on 127.0.0.1:8000. Run the frontend separately on localhost:3000.

Database tables are created automatically at data/tickets.sqlite. Keep the database and .env private. Do not commit either. On Windows, configure filesystem ACLs for the service account; POSIX file modes do not enforce Windows permissions.

## Validation
```powershell
npm.cmd run build
npm.cmd test
npm.cmd run test:e2e
npm.cmd run lint
```

## API
- GET /api/health
- POST /api/auth/login (email, password), GET /api/auth/me, POST /api/auth/logout
- GET /api/events, GET /api/events/:id
- POST /api/events (admin): name, startsAt (ISO timestamp), location, capacity, amount (integer paise; zero for free events)
- POST /api/events/:id/registrations: name, email, phone
- GET /api/registrations (admin, most recent 1,000)

Writes require application/json and an Origin exactly matching APP_ORIGIN. Browser requests go through the frontend's same-origin proxy. No permissive CORS is enabled.

## Security and deployment
Sessions are random opaque tokens, hashed in the database, expire after eight hours, and are revoked on logout. Cookies are HttpOnly, SameSite=Strict, and Secure in production. Passwords use scrypt. SQL uses bound parameters; registration capacity and uniqueness are checked inside a write transaction. The API validates input and requires a configured receiving UPI account for paid events.

For production set NODE_ENV=production, APP_ORIGIN=https://your-domain.example, a private DATABASE_PATH on a persistent disk, and the admin environment values. Build then run npm run start:prod. Terminate TLS at your trusted proxy and keep the API private. The default HOST is loopback; containers may need HOST=0.0.0.0 on a private network.

Rate limiting uses the actual connection address, ignoring untrusted forwarded headers. With the Next.js proxy, callers share the proxy address and therefore share a conservative limit (10 login attempts and 60 other writes per 15 minutes). Before public launch, add trusted ingress per-client limits and tune these application limits; never blindly trust X-Forwarded-For. Limits persist in SQLite. Deploy a single API instance with local persistent storage; horizontal scaling needs a shared database and limiter.

Next steps: production hosting/domain/TLS, tested database backups and restores, admin recovery/rotation and MFA, privacy/retention policy, email provider configuration, and load testing. Rotating the configured password does not revoke existing sessions automatically: delete session rows when rotating credentials. This is a development foundation, not an independent security certification.

## MongoDB setup
Save your MongoDB URI in **Ticket-System-Backend/.env** (not .env.example and not the frontend environment):

```
MONGODB_URI="mongodb+srv://YOUR_CONNECTION_STRING"
MONGODB_DATABASE=ticket_system
```

MONGO_URL and MONGO_URI are accepted aliases. A configured MongoDB URI selects MongoDB for all events, registrations, sessions and rate limits; it never silently falls back on a connection failure. Without a URI, local SQLite remains available. MongoDB must be an Atlas cluster, replica set, or sharded cluster because registration uses a transaction to reserve a seat and save the attendee together. See https://www.mongodb.com/docs/drivers/node/v6.x/crud/transactions/.

Run `npm.cmd run setup` after saving the file. It preserves existing MongoDB and other settings, prompts for your admin email if absent, and adds a generated password hash. It refuses to overwrite an existing password hash. Save the displayed password and restart `npm.cmd run start:dev` so the process reloads .env. A MongoDB URL is a database credential, not the admin login.

For MongoDB deployments, back up the MongoDB database instead of the SQLite file. Existing SQLite records are not migrated automatically. Configure database user permissions and Atlas network access for the API host. Connection errors are deliberately generic to avoid leaking URI credentials. MongoDB session and rate-limit collections have TTL indexes; session expiry is also checked on every authenticated request. The rate limiter uses fixed windows and counts atomically in MongoDB.

## Direct UPI payments
Direct UPI payments, admin verification, ticket issuance and single-use admin check-in are implemented. Read [PAYMENTS.md](PAYMENTS.md) for receiving-account setup, verification, refund handling and limitations. Razorpay integration has been removed.

## Ticket email

Automatic confirmations and paid-ticket QR emails are implemented with a durable Resend queue. See [EMAIL.md](EMAIL.md) to configure a verified sender. GET /api/emails/status is admin-only.
