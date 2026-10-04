import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type AddressInfo } from 'node:net';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { request, type APIRequestContext } from '@playwright/test';
import WebSocket from 'ws';
import { createIdentityService } from '@imbox/auth';
import { sql, withTenant } from '@imbox/db';
import { testDatabases, tenantFixture } from '../helpers/database.js';

const exec = promisify(execFile);
const project = `imbox-release-${randomUUID().slice(0, 8)}`;
const prefix = process.env.IMBOX_IMAGE_PREFIX ?? 'imbox';
const tag = process.env.IMBOX_IMAGE_TAG ?? 'local';
const image = (kind: string) => `${prefix}/${kind}:${tag}`;
const network = process.env.IMBOX_TEST_DOCKER_NETWORK ?? 'imbox_default';
const directory = resolve('.artifacts', project),
  volume = `${project}-policy`;
let databases: Awaited<ReturnType<typeof testDatabases>>;
let fixture: Awaited<ReturnType<typeof tenantFixture>>;
let client: APIRequestContext;
let origin: string;
let headers: Record<string, string>;
let composeEnv: NodeJS.ProcessEnv;
const composeArgs = [
  'compose',
  '--project-name',
  project,
  '--file',
  'infra/deployment/compose.yaml',
  '--file',
  join(directory, 'override.yaml'),
];
async function docker(args: string[], env: NodeJS.ProcessEnv = process.env) {
  try {
    return (
      await exec('docker', args, { env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
    ).stdout.trim();
  } catch {
    // Environment-file contents and authenticated request context must never enter assertion output.
    throw new Error(
      `Container operation failed (${args[0]}); inspect the isolated ${project} services locally`,
    );
  }
}
const compose = (...args: string[]) => docker([...composeArgs, ...args], composeEnv);
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) =>
    server.once('error', reject).listen(0, '127.0.0.1', resolve),
  );
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  return port;
}
async function rawEnv(path: string, values: Record<string, string>) {
  if (Object.values(values).some((v) => /[\r\n\0]/.test(v)))
    throw new Error('Invalid environment value');
  await writeFile(
    path,
    Object.entries(values)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n',
    { mode: 0o600 },
  );
}
function containerUrl(key: string) {
  const value = process.env[key];
  if (!value) throw new Error(`Missing ${key}`);
  const url = new URL(value);
  url.hostname = process.env.IMBOX_TEST_DATABASE_HOST ?? 'postgres';
  url.port = '5432';
  return url.toString();
}
async function ready() {
  for (let i = 0; i < 60; i++) {
    const result = await client.get('/readyz').catch(() => null);
    if (result?.status() === 200) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('TLS gateway did not become ready');
}
beforeAll(async () => {
  databases = await testDatabases();
  fixture = await tenantFixture(databases.owner);
  const httpsPort = await freePort(),
    httpPort = await freePort();
  origin = `https://localhost:${httpsPort}`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const secret = randomBytes(48).toString('base64url'),
    policyKey = randomBytes(48).toString('base64url');
  const common = {
    DATABASE_URL: containerUrl('TEST_APP_DATABASE_URL'),
    POLICY_LEDGER_SIGNING_KEY: policyKey,
    SESSION_SECRET: secret,
  };
  await rawEnv(join(directory, '.env.api'), {
    ...common,
    IDENTITY_DATABASE_URL: containerUrl('TEST_IDENTITY_DATABASE_URL'),
    PUBLIC_ORIGIN: origin,
    OIDC_ISSUER: 'https://issuer.invalid',
    OIDC_CLIENT_ID: 'deployment-fixture',
    OIDC_CLIENT_SECRET: randomBytes(32).toString('base64url'),
  });
  await rawEnv(join(directory, '.env.worker'), {
    ...common,
    WORKER_TENANT_IDS: fixture.tenantId,
    WORKER_POLL_INTERVAL_MS: '25',
  });
  await rawEnv(join(directory, '.env.migration'), {
    MIGRATION_DATABASE_URL: containerUrl('TEST_DATABASE_URL'),
  });
  await writeFile(
    join(directory, 'override.yaml'),
    `services:\n  api:\n    volumes: !override\n      - smoke_policy:/var/lib/imbox/policy-ledger\n  worker:\n    volumes: !override\n      - smoke_policy:/var/lib/imbox/policy-ledger\nnetworks:\n  default:\n    external: true\n    name: ${network}\nvolumes:\n  smoke_policy:\n    external: true\n    name: ${volume}\n`,
  );
  composeEnv = {
    ...process.env,
    IMBOX_API_IMAGE: image('api'),
    IMBOX_WORKER_IMAGE: image('worker'),
    IMBOX_WEB_IMAGE: image('web'),
    IMBOX_API_ENV_FILE: join(directory, '.env.api'),
    IMBOX_WORKER_ENV_FILE: join(directory, '.env.worker'),
    IMBOX_MIGRATION_ENV_FILE: join(directory, '.env.migration'),
    IMBOX_POLICY_DIR: directory,
    IMBOX_PUBLIC_HOST: 'localhost',
    IMBOX_HTTP_BIND: '127.0.0.1',
    IMBOX_HTTPS_BIND: '127.0.0.1',
    IMBOX_HTTP_PORT: String(httpPort),
    IMBOX_HTTPS_PORT: String(httpsPort),
  };
  await docker(['volume', 'create', volume]);
  await docker([
    'run',
    '--rm',
    '--read-only',
    '--user',
    '0',
    '--cap-drop',
    'ALL',
    '--cap-add',
    'CHOWN',
    '--mount',
    `type=volume,source=${volume},target=/state`,
    image('api'),
    '--input-type=module',
    '-e',
    "import{chmodSync,chownSync}from'node:fs';chmodSync('/state',0o700);chownSync('/state',1000,1000)",
  ]);
  await compose('config', '--quiet');
  await docker(
    [...composeArgs, '--file', 'infra/deployment/compose.tools.yaml', 'config', '--quiet'],
    {
      ...composeEnv,
      IMBOX_TOOL_IMAGE: image('tool-runner'),
      IMBOX_TOOL_ENV_FILE: join(directory, '.env.worker'),
      IMBOX_ACTION_DIR: directory,
    },
  );
  await compose('run', '--rm', 'migrate');
  await compose('up', '--detach', '--wait', '--wait-timeout', '60', 'api', 'worker', 'web');
  client = await request.newContext({ baseURL: origin, ignoreHTTPSErrors: true, timeout: 5000 });
  await ready();
  // Issue only a test-fixture session outside the production containers. Production dev login stays disabled.
  const identity = createIdentityService({
    db: databases.db,
    identityDb: databases.identityDb,
    publicOrigin: origin,
    sessionSecret: secret,
    environment: 'test',
    enableDevAuth: true,
    devPrincipalIds: [fixture.alice.principalId],
  });
  const session = await identity.devLogin({ principalId: fixture.alice.principalId, origin });
  headers = {
    origin,
    cookie: `imbox_session=${session.token}`,
    'x-csrf-token': session.csrfToken,
    'x-imbox-tenant-id': fixture.tenantId,
  };
});
afterAll(async () => {
  await client?.dispose();
  if (composeEnv) {
    const id = await compose('ps', '--all', '--quiet', 'worker').catch(() => '');
    if (id) {
      const logs = await exec('docker', ['logs', id], { maxBuffer: 1024 * 1024 }).catch(() => ({
        stdout: '',
        stderr: '',
      }));
      await writeFile('.artifacts/deployment-worker.log', logs.stdout + '\n' + logs.stderr, {
        mode: 0o600,
      });
    }
    await compose('down', '--volumes', '--remove-orphans');
  }
  await docker(['volume', 'rm', volume]).catch(() => {});
  await databases?.close();
  await rm(directory, { recursive: true, force: true });
});
it('runs the pinned production dependency tree as a non-root user on a read-only root filesystem', async () => {
  const result = JSON.parse(
    await docker([
      'run',
      '--rm',
      '--read-only',
      image('api'),
      '--input-type=module',
      '-e',
      "import{readFileSync,existsSync,readdirSync,writeFileSync}from'node:fs';import{createHash}from'node:crypto';await import('./apps/api/dist/app.js');let readonly=false;try{writeFileSync('/app/forbidden','x')}catch{readonly=true}console.log(JSON.stringify({uid:process.getuid(),node:process.version,readonly,lock:createHash('sha256').update(readFileSync('/app/pnpm-lock.yaml')).digest('hex'),source:existsSync('/app/apps/api/src'),env:existsSync('/app/.env'),development:readdirSync('/app/node_modules/.pnpm').some(n=>/^(typescript|vitest|tsx)@/.test(n))}))",
    ]),
  ) as {
    uid: number;
    node: string;
    readonly: boolean;
    lock: string;
    source: boolean;
    env: boolean;
    development: boolean;
  };
  expect(result).toEqual({
    uid: 1000,
    node: 'v24.21.0',
    readonly: true,
    lock: createHash('sha256')
      .update(await readFile('pnpm-lock.yaml'))
      .digest('hex'),
    source: false,
    env: false,
    development: false,
  });
  for (const service of ['api', 'worker', 'web']) {
    const id = await compose('ps', '--quiet', service);
    const config = JSON.parse(
      await docker(['inspect', '--format', '{{json .HostConfig}}', id]),
    ) as { ReadonlyRootfs: boolean; CapDrop: string[] };
    expect(config.ReadonlyRootfs).toBe(true);
    expect(config.CapDrop).toContain('ALL');
  }
});
it('serves the production SPA over TLS, preserves cache policy and keeps API and dev login outside the SPA fallback', async () => {
  const page = await client.get('/organization');
  expect(page.status()).toBe(200);
  expect(page.headers()['cache-control']).toContain('no-cache');
  const html = await page.text();
  expect(html.includes('<div id="root">')).toBe(true);
  const asset = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  expect(Boolean(asset)).toBe(true);
  expect((await client.get(asset!)).headers()['cache-control']).toContain('immutable');
  expect((await client.get('/sw.js')).headers()['cache-control']).toContain('no-cache');
  const unauthenticated = await client.get('/v1/me');
  expect(unauthenticated.status()).toBe(401);
  expect(unauthenticated.headers()['cache-control']).toContain('no-store');
  expect(
    (
      await client.post('/v1/auth/dev-login', {
        headers: { origin },
        data: { principal_id: fixture.alice.principalId },
      })
    ).status(),
  ).toBe(404);
  expect((await client.get('/v1/missing')).status()).toBe(404);
  expect((await client.get('/v1/me', { headers })).status()).toBe(200);
});
it('carries authenticated commands and WebSockets through TLS and lets the container worker commit the message projection', async () => {
  const input = {
    workspace_id: fixture.workspaceId,
    kind: 'group',
    title: 'Container deployment',
    member_ids: [fixture.bob.principalId],
    history_policy: 'all',
  };
  const missingCsrf = { ...headers, 'x-csrf-token': '', 'idempotency-key': randomUUID() };
  expect(
    (await client.post('/v1/conversations', { headers: missingCsrf, data: input })).status(),
  ).toBe(403);
  const created = await client.post('/v1/conversations', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: input,
  });
  expect(created.status()).toBe(201);
  const conversation = (await created.json()) as { id: string };
  const posted = await client.post(`/v1/conversations/${conversation.id}/messages`, {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: { client_message_id: randomUUID(), body: 'TLS container projection' },
  });
  expect(posted.status()).toBe(201);
  const message = (await posted.json()) as { id: string };
  await expect
    .poll(
      async () =>
        withTenant(
          databases.db,
          fixture.tenantId,
          async (tx) =>
            (await sql`select id from projections where entity_id=${message.id}`.execute(tx)).rows
              .length,
        ),
      { timeout: 10000 },
    )
    .toBeGreaterThan(0);
  const socket = new WebSocket(
    `${origin.replace('https:', 'wss:')}/v1/ws?tenant_id=${fixture.tenantId}`,
    { rejectUnauthorized: false, headers: { cookie: headers.cookie!, origin } },
  );
  try {
    const welcome = await new Promise<{ type: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WSS welcome timeout')), 5000);
      socket.once('error', () => {
        clearTimeout(timer);
        reject(new Error('WSS connection failed'));
      });
      socket.once('message', (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(data.toString()) as { type: string });
      });
      socket.once('open', () =>
        socket.send(
          JSON.stringify({ type: 'hello', protocol_version: 1, client_id: randomUUID() }),
        ),
      );
    });
    expect(welcome.type).toBe('welcome');
  } finally {
    socket.terminate();
  }
  await compose('restart', 'api');
  await ready();
  expect(
    (await client.get(`/v1/conversations/${conversation.id}/messages`, { headers })).status(),
  ).toBe(200);
  await mkdir('.artifacts', { recursive: true });
  const images: Record<string, string> = {};
  for (const name of ['api', 'worker', 'tool-runner', 'web'])
    images[name] = await docker(['image', 'inspect', '--format', '{{.Id}}', image(name)]);
  await writeFile(
    '.artifacts/deployment-evidence.json',
    JSON.stringify(
      {
        verified_at: new Date().toISOString(),
        images,
        checks: [
          'frozen-production-dependencies',
          'non-root',
          'read-only-root',
          'TLS-SPA-cache',
          'API-no-store',
          'production-dev-login-disabled',
          'cookie-CSRF',
          'worker-message-projection',
          'WSS-upgrade',
          'API-restart',
        ],
        scope:
          'Local Docker deployment using a fixture session and localhost CA; no production IdP, ACME domain or external provider acceptance claimed',
      },
      null,
      2,
    ) + '\n',
  );
});
