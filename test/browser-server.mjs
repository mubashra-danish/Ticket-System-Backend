// Dedicated browser-test server. This mock is never loaded by src/main.ts.
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { AppModule } from '../dist/app.module.js';
import { configure } from '../dist/configure.js';
if (process.env.NODE_ENV !== 'test' || process.env.DATABASE_PATH !== ':memory:')
  throw new Error(
    'Browser test server requires an isolated in-memory test database',
  );
const module = await Test.createTestingModule({
  imports: [AppModule],
}).compile();
const app = module.createNestApplication({ rawBody: true });
configure(app);
await app.listen(Number(process.env.PORT), '127.0.0.1');
