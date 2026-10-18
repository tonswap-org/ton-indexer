import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

// Local integration only: an owned disposable PostgreSQL16 process, no production
// credentials, providers, VAPID subscriptions, release authority or broadcasts.
const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const bin = process.env.TONSWAP_POSTGRES_BIN_ROOT ?? '/opt/homebrew/opt/postgresql@16/bin';
const version = (await run(path.join(bin, 'postgres'), ['--version'])).stdout.trim();
if (!/PostgreSQL\) 16\./.test(version)) throw Error('Native integration requires PostgreSQL 16.');
const directory = await mkdtemp(path.join(tmpdir(), 'tonswap-platform-options-'));
const data = path.join(directory, 'data');
let postgres;
try {
  await run(path.join(bin, 'initdb'), ['-D', data, '-U', 'platform_test', '--auth-local=trust', '--auth-host=trust', '--no-locale', '-E', 'UTF8']);
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  postgres = spawn(path.join(bin, 'postgres'), ['-D', data, '-h', '127.0.0.1', '-p', String(port), '-k', '', '-c', 'fsync=on'], { stdio: 'ignore' });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (postgres.exitCode !== null) throw Error('Owned PostgreSQL process exited during startup.');
    try { await run(path.join(bin, 'pg_isready'), ['-h', '127.0.0.1', '-p', String(port), '-U', 'platform_test']); ready = true; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  if (!ready) throw Error('Owned PostgreSQL did not become ready.');
  await run(path.join(bin, 'createdb'), ['-h', '127.0.0.1', '-p', String(port), '-U', 'platform_test', 'tonswap_platform_test_options']);
  console.log(`Native option lifecycle integration: ${version}`);
  const result = await run(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', 'test/optionLifecycleWorker.test.ts'], {
    cwd: root, env: { ...process.env, PLATFORM_TEST_DATABASE_URL: `postgresql://platform_test@127.0.0.1:${port}/tonswap_platform_test_options` }, maxBuffer: 2_000_000,
  });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
} catch (error) {
  if (error.stdout) process.stdout.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {
  if (postgres && postgres.exitCode === null) {
    await run(path.join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop']);
    if (postgres.exitCode === null) await new Promise(resolve => postgres.once('exit', resolve));
  }
  await rm(directory, { recursive: true, force: true });
}
