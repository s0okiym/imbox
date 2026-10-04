/* global fetch, AbortSignal */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, open } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parse } from 'dotenv';

// Local development launcher. Never provisions or exposes a production service.
const root = resolve(import.meta.dirname, '..');
process.chdir(root);
process.umask(0o077);
const mode = process.argv[2] ?? 'start';
if (!['setup', 'start', 'status'].includes(mode)) throw new Error('Use setup, start, or status');
const children = [];
let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.race([
    Promise.all(
      children.map((child) =>
        child.exitCode !== null || child.signalCode !== null
          ? Promise.resolve()
          : new Promise((done) => child.once('exit', done)),
      ),
    ),
    delay(10_000, undefined, { ref: false }),
  ]);
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  process.exitCode = code;
}
process.once('SIGINT', () => {
  void stop(130);
});
process.once('SIGTERM', () => {
  void stop(143);
});
async function run(args) {
  if (stopping) throw new Error('Setup interrupted');
  const child = spawn('pnpm', args, { cwd: root, stdio: 'inherit' });
  children.push(child);
  await new Promise((done, reject) => {
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? done() : reject(new Error(`Setup step failed: ${args[0]}`)),
    );
  });
}
try {
  if (mode === 'setup') {
    const template = await readFile('.env.example', 'utf8');
    const content = template
      .replace(/^SESSION_SECRET=.*$/m, `SESSION_SECRET=${randomBytes(48).toString('base64url')}`)
      .replace(
        /^POLICY_LEDGER_SIGNING_KEY=.*$/m,
        `POLICY_LEDGER_SIGNING_KEY=${randomBytes(48).toString('base64url')}`,
      )
      .replace(
        /^POLICY_LEDGER_DIRECTORY=.*$/m,
        `POLICY_LEDGER_DIRECTORY=${root}/.artifacts/pilot-policy-ledger`,
      )
      .replace(/^ENABLE_DEV_AUTH=false$/m, 'ENABLE_DEV_AUTH=true');
    try {
      await writeFile('.env', content, { flag: 'wx', mode: 0o600 });
      console.log('Created private local .env with random session and ledger keys.');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      console.log('Existing .env preserved.');
    }
  }
  const env = { ...parse(await readFile('.env')), ...process.env };
  if (env.APP_ENV !== 'development' || env.NODE_ENV === 'production')
    throw new Error('Pilot commands require APP_ENV=development and non-production NODE_ENV');
  const origin = new URL(env.PUBLIC_ORIGIN);
  const webPort = Number(origin.port || 80);
  const apiPort = Number(env.API_PORT);
  if (
    origin.protocol !== 'http:' ||
    !['localhost', '127.0.0.1'].includes(origin.hostname) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    env.API_HOST !== '127.0.0.1' ||
    !Number.isInteger(apiPort) ||
    apiPort < 1024 ||
    apiPort > 65535 ||
    webPort < 1024 ||
    webPort === apiPort
  )
    throw new Error(
      'Pilot requires a loopback HTTP PUBLIC_ORIGIN, API_HOST=127.0.0.1 and distinct unprivileged ports',
    );
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  const webOrigin = `http://127.0.0.1:${webPort}`;
  if (
    !env.SESSION_SECRET ||
    env.SESSION_SECRET.startsWith('replace-with-') ||
    env.SESSION_SECRET.length < 32
  )
    throw new Error('Configure a random SESSION_SECRET of at least 32 characters in .env');
  if (!env.WORKER_TENANT_IDS?.trim())
    throw new Error(
      'Configure WORKER_TENANT_IDS in .env; the local seed tenant is 10000000-0000-4000-8000-000000000001',
    );
  if (mode === 'setup') {
    for (const args of [['infra:up'], ['build'], ['db:setup'], ['db:seed']]) await run(args);
    console.log(
      'Local foundation ready. Run pnpm pilot. Optional model, files and tools: docs/operations/README.md',
    );
  } else if (mode === 'status') {
    for (const [name, url] of [
      ['API', `${apiOrigin}/readyz`],
      ['Web', `${webOrigin}/`],
    ]) {
      const ready = await fetch(url, { signal: AbortSignal.timeout(3000) })
        .then((r) => r.ok)
        .catch(() => false);
      console.log(`${name}: ${ready ? 'reachable' : 'unavailable'}`);
      if (!ready) process.exitCode = 1;
    }
    console.log('Worker process lifetime is supervised by the foreground pnpm pilot command.');
  } else {
    for (const port of [apiPort, webPort]) {
      await new Promise((done, reject) => {
        const server = createServer();
        server.once('error', () =>
          reject(new Error(`Port ${port} is occupied; no existing process was stopped`)),
        );
        server.listen(port, '127.0.0.1', () => server.close(done));
      });
    }
    await mkdir('.artifacts/pilot', { recursive: true, mode: 0o700 });
    const definitions = [
      ['api', 'apps/api/dist/main.js', []],
      ['worker', 'apps/worker/dist/main.js', []],
      [
        'web',
        'apps/web/node_modules/vite/bin/vite.js',
        ['apps/web', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'],
      ],
    ];
    if (env.ENABLE_DEMO_TOOL === 'true')
      definitions.push(['tool-runner', 'apps/tool-runner/dist/main.js', []]);
    for (const [name, entry, args] of definitions) {
      if (stopping) break;
      await readFile(entry);
      const log = await open(`.artifacts/pilot/${name}.log`, 'a', 0o600);
      const child = spawn(process.execPath, [entry, ...args], {
        cwd: root,
        env: {
          ...env,
          VITE_ENABLE_DEV_LOGIN: env.ENABLE_DEV_AUTH === 'true' ? 'true' : 'false',
          IMBOX_API_PROXY_TARGET: apiOrigin,
        },
        stdio: ['ignore', log.fd, log.fd],
      });
      children.push(child);
      child.once('error', () => {
        console.error(`${name} could not start`);
        void stop(1);
      });
      child.once('exit', () => {
        if (!stopping) {
          console.error(
            `${name} exited; stopping the pilot. Inspect private .artifacts/pilot logs.`,
          );
          void stop(1);
        }
      });
      await log.close();
    }
    let ready = false;
    for (let attempt = 0; attempt < 60 && !stopping; attempt++) {
      ready = (
        await Promise.all(
          [`${apiOrigin}/readyz`, `${webOrigin}/`].map((url) =>
            fetch(url, { signal: AbortSignal.timeout(1000) })
              .then((r) => r.ok)
              .catch(() => false),
          ),
        )
      ).every(Boolean);
      if (ready) break;
      await delay(500);
    }
    if (!ready) {
      await stop(1);
      throw new Error('Pilot readiness failed; inspect private .artifacts/pilot logs');
    }
    if (!stopping)
      console.log(
        `Imbox ready: ${origin.origin} — Ctrl+C stops application processes; data services are retained.`,
      );
  }
} catch (error) {
  console.error(
    error.code === 'ENOENT'
      ? 'Missing .env or build output. Run pnpm pilot:setup first.'
      : error.message,
  );
  await stop(1);
}
