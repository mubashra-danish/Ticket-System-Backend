import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  rmdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';
const script = resolve('scripts/setup.mjs');
describe('admin setup with an existing environment file', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ticket-setup-'));
  });
  afterEach(() => {
    unlinkSync(join(directory, '.env'));
    rmdirSync(directory);
  });
  it('preserves MongoDB settings and adds admin credentials', () => {
    const original =
      'MONGODB_URI="mongodb://localhost:27017/test"\nPORT=8100\n';
    writeFileSync(join(directory, '.env'), original);
    const result = spawnSync(process.execPath, [script], {
      cwd: directory,
      input: 'admin@example.com\n',
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    const contents = readFileSync(join(directory, '.env'), 'utf8');
    expect(contents.startsWith(original)).toBe(true);
    const env = parseEnv(contents);
    expect(env.MONGODB_URI).toBe('mongodb://localhost:27017/test');
    expect(env.PORT).toBe('8100');
    expect(env.ADMIN_EMAIL).toBe('admin@example.com');
    expect(env.ADMIN_PASSWORD_HASH).toMatch(/^[a-f0-9]{32}:[a-f0-9]{128}$/);
  });
  it('never replaces an existing admin password', () => {
    const original =
      'ADMIN_EMAIL=admin@example.com\nADMIN_PASSWORD_HASH=existing\n';
    writeFileSync(join(directory, '.env'), original);
    const result = spawnSync(process.execPath, [script], {
      cwd: directory,
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(directory, '.env'), 'utf8')).toBe(original);
  });
});
