import { randomBytes, scryptSync } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseEnv } from 'node:util';
const original = existsSync('.env') ? readFileSync('.env', 'utf8') : '';
const config = parseEnv(original);
if (config.ADMIN_PASSWORD_HASH)
  throw new Error(
    'An admin password is already configured. Setup will not overwrite it.',
  );
const rl = createInterface({ input: process.stdin, output: process.stdout });
try {
  const email = (config.ADMIN_EMAIL || (await rl.question('Admin email: ')))
    .trim()
    .toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new Error('Enter a valid email');
  const password = randomBytes(24).toString('base64url');
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  const values = {
    ADMIN_EMAIL: email,
    ADMIN_PASSWORD_HASH: salt + ':' + hash,
    APP_ORIGIN: 'http://localhost:3000',
    PORT: '8000',
    HOST: '127.0.0.1',
  };
  const additions = Object.entries(values)
    .filter(([key]) => !config[key])
    .map(([key, value]) => key + '=' + JSON.stringify(value))
    .join('\n');
  if (existsSync('.env')) {
    if (readFileSync('.env', 'utf8') !== original)
      throw new Error('.env changed during setup. Run setup again.');
    appendFileSync('.env', '\n' + additions + '\n');
  } else writeFileSync('.env', additions + '\n', { mode: 0o600, flag: 'wx' });
  console.log('Admin configured. Existing database settings were preserved.');
  console.log(
    'Save this generated password in your password manager:\n' +
      password +
      '\nIt is not stored in plaintext. Restart the backend after setup.',
  );
} finally {
  rl.close();
}
