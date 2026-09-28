// Dedicated browser-test server. This mock is never loaded by src/main.ts.
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { AppModule } from '../dist/app.module.js';
import { configure } from '../dist/configure.js';
import { EmailTransport } from '../dist/email.service.js';
if (process.env.NODE_ENV !== 'test' || process.env.DATABASE_PATH !== ':memory:')
  throw new Error(
    'Browser test server requires an isolated in-memory test database',
  );
process.env.EMAIL_ENABLED = 'true';
process.env.SMTP_HOST = 'smtp.example.com';
process.env.SMTP_PORT = '587';
process.env.SMTP_SECURE = 'false';
process.env.SMTP_USER = 'browser-test-only';
process.env.SMTP_PASS = 'browser-test-only';
process.env.EMAIL_FROM = 'test@example.com';
const mailbox = new Map();
const module = await Test.createTestingModule({
  imports: [AppModule],
})
  .overrideProvider(EmailTransport)
  .useValue({
    async send(id, body) {
      const message = JSON.parse(body);
      mailbox.set(message.to[0], message.text);
      return id;
    },
  })
  .compile();
const app = module.createNestApplication({ rawBody: true });
configure(app);
// This mailbox exists only in the isolated browser-test entrypoint.
app.getHttpAdapter().get('/test/mailbox', (req, res) => {
  res.json({ text: mailbox.get(req.query.email) || '' });
});
await app.listen(Number(process.env.PORT), '127.0.0.1');
