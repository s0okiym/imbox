import { createHash, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, migrateToLatest, sql, withTenant } from '@imbox/db';
import { bootstrapDevelopmentRole } from '@imbox/db/testing';
import { createIdentityService, registerAuthRoutes, type IdentityService } from '../src/index.js';
import { startOidcProvider, type TokenFault } from './oidc-provider.js';

const adminUrl = process.env.TEST_DATABASE_URL;
const applicationUrl = process.env.TEST_APP_DATABASE_URL;
const identityUrl = process.env.TEST_IDENTITY_DATABASE_URL;
if (!adminUrl || !applicationUrl || !identityUrl)
  throw new Error(
    'Auth integration requires TEST_DATABASE_URL, TEST_APP_DATABASE_URL and TEST_IDENTITY_DATABASE_URL; real role boundaries cannot be skipped.',
  );
const owner = createDatabase(adminUrl);
const appDb = createDatabase(applicationUrl);
const identityDb = createDatabase(identityUrl);
const tenant = randomUUID();
const foreignTenant = randomUUID();
const alice = randomUUID();
const bob = randomUUID();
const foreignPrincipal = randomUUID();
const publicOrigin = 'https://imbox.test';
const sessionSecret = 'test-only-session-secret-with-64-random-ish-bytes-never-production';
let service: IdentityService;
let provider: Awaited<ReturnType<typeof startOidcProvider>>;
const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });

beforeAll(async () => {
  await migrateToLatest(owner);
  for (const [kind, url] of [
    ['application', applicationUrl],
    ['identity', identityUrl],
  ] as const) {
    const credentials = new URL(url);
    await bootstrapDevelopmentRole(owner, {
      environment: 'test',
      kind,
      role: credentials.username,
      password: credentials.password,
    });
  }
  await identityDb
    .insertInto('principals')
    .values([
      { id: alice, kind: 'human', display_name: 'Alice' },
      { id: bob, kind: 'human', display_name: 'Bob' },
      { id: foreignPrincipal, kind: 'human', display_name: 'Foreign principal' },
    ])
    .execute();
  await withTenant(owner, tenant, async (transaction) => {
    await transaction.insertInto('tenants').values({ id: tenant, name: 'Auth tenant' }).execute();
    await transaction
      .insertInto('tenant_principals')
      .values([
        { tenant_id: tenant, principal_id: alice },
        { tenant_id: tenant, principal_id: bob },
      ])
      .execute();
    const workspace = randomUUID();
    await transaction
      .insertInto('workspaces')
      .values({ tenant_id: tenant, id: workspace, name: 'Auth workspace' })
      .execute();
    await transaction
      .insertInto('memberships')
      .values({ tenant_id: tenant, workspace_id: workspace, principal_id: alice, role: 'member' })
      .execute();
  });
  await withTenant(owner, foreignTenant, async (transaction) => {
    await transaction
      .insertInto('tenants')
      .values({ id: foreignTenant, name: 'Other tenant' })
      .execute();
    await transaction
      .insertInto('tenant_principals')
      .values({ tenant_id: foreignTenant, principal_id: foreignPrincipal })
      .execute();
  });
  provider = await startOidcProvider();
  await identityDb
    .insertInto('external_identities')
    .values({
      id: randomUUID(),
      principal_id: alice,
      issuer: provider.issuer,
      subject: 'oidc-alice',
    })
    .execute();
  service = createIdentityService({
    db: appDb,
    identityDb,
    publicOrigin,
    sessionSecret,
    environment: 'test',
    enableDevAuth: true,
    devPrincipalIds: [alice, bob],
    oidc: {
      issuer: provider.issuer,
      clientId: 'imbox-test',
      clientSecret: 'test-client-secret',
      allowInsecureLocalHttp: true,
    },
  });
  await registerAuthRoutes(app, { identity: service, capabilities: ['messaging.send'] });
  await app.ready();
}, 30_000);

afterAll(async () => {
  await app.close();
  await provider?.close();
  await Promise.all([owner.destroy(), appDb.destroy(), identityDb.destroy()]);
});
const login = (principalId = alice) => service.devLogin({ principalId, origin: publicOrigin });

describe('Opaque browser sessions with real database roles', () => {
  it('identity and application roles cannot access each other’s private data', async () => {
    await expect(appDb.selectFrom('sessions').selectAll().execute()).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      appDb.selectFrom('oidc_login_attempts').selectAll().execute(),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      withTenant(identityDb, tenant, (transaction) =>
        transaction.selectFrom('tenant_principals').selectAll().execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const roles = await sql<{
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>`select rolsuper,rolbypassrls from pg_roles where rolname=current_user`.execute(identityDb);
    expect(roles.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
  it('persists only token digests, uses an opaque secure cookie, and returns authorized me data', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      headers: { origin: publicOrigin },
      payload: { principal_id: alice },
    });
    expect(response.statusCode).toBe(200);
    const cookie = response.cookies.find((item) => item.name === 'imbox_session')!;
    expect(cookie.value).toMatch(/^[a-zA-Z0-9_-]{43}$/);
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.secure).toBe(true);
    expect(cookie.sameSite).toBe('Lax');
    const stored = await identityDb
      .selectFrom('sessions')
      .selectAll()
      .where('id', '=', response.json().session_id)
      .executeTakeFirstOrThrow();
    expect(stored.token_hash).not.toContain(cookie.value);
    expect(stored.csrf_token_hash).not.toBe(response.json().csrf_token);
    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { 'x-imbox-tenant-id': tenant },
      cookies: { imbox_session: cookie.value },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      principal: { id: alice, kind: 'human' },
      tenant_id: tenant,
      authz_revision: '1',
      csrf_token: response.json().csrf_token,
      capabilities: ['messaging.send'],
    });
    expect(me.json().workspaces).toHaveLength(1);
    expect(me.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(me.json())).not.toContain(stored.token_hash);
  });
  it('requires both the exact origin and matching CSRF token for unsafe methods', async () => {
    const session = await login();
    const base = { cookie: session.token, tenantId: tenant, method: 'POST' };
    await expect(
      service.authenticate({ ...base, csrfToken: session.csrfToken }),
    ).rejects.toMatchObject({ reason: 'ORIGIN_REJECTED' });
    await expect(
      service.authenticate({ ...base, origin: 'https://evil.test', csrfToken: session.csrfToken }),
    ).rejects.toMatchObject({ reason: 'ORIGIN_REJECTED' });
    await expect(service.authenticate({ ...base, origin: publicOrigin })).rejects.toMatchObject({
      reason: 'CSRF_REJECTED',
    });
    await expect(
      service.authenticate({ ...base, origin: publicOrigin, csrfToken: 'wrong' }),
    ).rejects.toMatchObject({ reason: 'CSRF_REJECTED' });
    expect(
      await service.authenticate({ ...base, origin: publicOrigin, csrfToken: session.csrfToken }),
    ).toMatchObject({ principalId: alice, tenantId: tenant });
    await expect(
      service.authenticate({
        ...base,
        authorization: 'Bearer arbitrary',
        origin: publicOrigin,
        csrfToken: session.csrfToken,
      }),
    ).rejects.toMatchObject({ reason: 'AUTH_METHOD_UNSUPPORTED' });
  });
  it('rejects unjoined tenants, revoked membership and suspended tenants on every request', async () => {
    const session = await login();
    await expect(
      service.authenticate({ cookie: session.token, tenantId: foreignTenant }),
    ).rejects.toMatchObject({ reason: 'TENANT_ACCESS_DENIED' });
    await expect(
      service.authenticate({ cookie: session.token, tenantId: randomUUID() }),
    ).rejects.toMatchObject({ reason: 'TENANT_ACCESS_DENIED' });
    await withTenant(owner, tenant, (transaction) =>
      transaction
        .updateTable('tenant_principals')
        .set({ status: 'disabled', authz_revision: '2' })
        .where('principal_id', '=', alice)
        .execute(),
    );
    await expect(
      service.authenticate({ cookie: session.token, tenantId: tenant }),
    ).rejects.toMatchObject({ reason: 'TENANT_ACCESS_DENIED' });
    await withTenant(owner, tenant, (transaction) =>
      transaction
        .updateTable('tenant_principals')
        .set({ status: 'active', authz_revision: '3' })
        .where('principal_id', '=', alice)
        .execute(),
    );
    expect(
      (await service.authenticate({ cookie: session.token, tenantId: tenant })).authzRevision,
    ).toBe('3');
    await withTenant(owner, tenant, (transaction) =>
      transaction
        .updateTable('tenants')
        .set({ status: 'suspended' })
        .where('id', '=', tenant)
        .execute(),
    );
    await expect(
      service.authenticate({ cookie: session.token, tenantId: tenant }),
    ).rejects.toMatchObject({ reason: 'TENANT_ACCESS_DENIED' });
    await withTenant(owner, tenant, (transaction) =>
      transaction
        .updateTable('tenants')
        .set({ status: 'active' })
        .where('id', '=', tenant)
        .execute(),
    );
  });
  it('rotates sessions on login and enforces expiry, logout and global principal disable', async () => {
    const old = await login();
    const rotated = await service.devLogin({
      principalId: alice,
      origin: publicOrigin,
      previousCookie: old.token,
    });
    expect(rotated.token).not.toBe(old.token);
    await expect(
      service.authenticate({ cookie: old.token, tenantId: tenant }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await identityDb
      .updateTable('sessions')
      .set({ expires_at: sql`clock_timestamp() - interval '1 second'` })
      .where('id', '=', rotated.sessionId)
      .execute();
    await expect(
      service.authenticate({ cookie: rotated.token, tenantId: tenant }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const current = await login();
    await identityDb
      .updateTable('principals')
      .set({ status: 'disabled' })
      .where('id', '=', alice)
      .execute();
    await expect(
      service.authenticate({ cookie: current.token, tenantId: tenant }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await identityDb
      .updateTable('principals')
      .set({ status: 'active' })
      .where('id', '=', alice)
      .execute();
    const logout = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { origin: publicOrigin, 'x-csrf-token': current.csrfToken },
      cookies: { imbox_session: current.token },
    });
    expect(logout.statusCode).toBe(204);
    await expect(
      service.authenticate({ cookie: current.token, tenantId: tenant }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
  it('allows only own session inspection/revocation and does not expose hashes', async () => {
    const a = await login();
    const b = await login(bob);
    const auth = await service.authenticate({ cookie: a.token, tenantId: tenant });
    await expect(service.getSession(auth, b.sessionId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(service.revokeSession(auth, b.sessionId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await service.getSession(auth, a.sessionId)).not.toHaveProperty('token_hash');
    await service.revokeSession(auth, a.sessionId);
    await expect(service.authenticate({ cookie: a.token, tenantId: tenant })).rejects.toMatchObject(
      { code: 'UNAUTHENTICATED' },
    );
  });
  it('development login is closed by default, denies nonallowlisted identities and is forbidden in production', async () => {
    const closed = createIdentityService({
      db: appDb,
      identityDb,
      publicOrigin,
      sessionSecret,
      environment: 'test',
    });
    await expect(
      closed.devLogin({ principalId: alice, origin: publicOrigin }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      service.devLogin({ principalId: foreignPrincipal, origin: publicOrigin }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(() =>
      createIdentityService({
        db: appDb,
        identityDb,
        publicOrigin,
        sessionSecret,
        environment: 'production',
        enableDevAuth: true,
        devPrincipalIds: [alice],
      }),
    ).toThrow('forbidden in production');
    expect(() =>
      createIdentityService({
        db: appDb,
        identityDb,
        publicOrigin: 'http://example.test',
        sessionSecret,
        environment: 'production',
      }),
    ).toThrow('HTTPS');
  });
});

describe('OIDC authorization code flow over real HTTP', () => {
  it('sets a bound login cookie and rotates to a session through the actual callback route', async () => {
    const start = await app.inject({ method: 'GET', url: '/v1/auth/login?return_to=%2Fwork' });
    expect(start.statusCode).toBe(302);
    const browserCookie = start.cookies.find((item) => item.name === 'imbox_oidc')!;
    expect(browserCookie.path).toBe('/v1/auth/callback');
    expect(browserCookie.httpOnly).toBe(true);
    const callback = await provider.callback(start.headers.location!);
    const finish = await app.inject({
      method: 'GET',
      url: callback.pathname + callback.search,
      cookies: { imbox_oidc: browserCookie.value },
    });
    expect(finish.statusCode).toBe(302);
    expect(finish.headers.location).toBe('/work');
    expect(finish.cookies.find((item) => item.name === 'imbox_session')?.httpOnly).toBe(true);
    expect(finish.cookies.find((item) => item.name === 'imbox_oidc')?.value).toBe('');
    const sessionCookie = finish.cookies.find((item) => item.name === 'imbox_session')!.value;
    const account = await app.inject({
      method: 'GET',
      url: '/v1/account',
      cookies: { imbox_session: sessionCookie },
    });
    expect(account.statusCode).toBe(200);
    expect(account.json()).toMatchObject({ principal: { kind: 'human', status: 'active' } });
    expect('issuer' in account.json()).toBe(false);
    expect('subject' in account.json()).toBe(false);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/me',
          cookies: { imbox_session: sessionCookie },
        })
      ).statusCode,
    ).toBe(403);

    const replay = await app.inject({
      method: 'GET',
      url: callback.pathname + callback.search,
      cookies: { imbox_oidc: browserCookie.value },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().code).toBe('UNAUTHENTICATED');
    expect(replay.cookies.find((item) => item.name === 'imbox_oidc')?.value).toBe('');
  });
  it('validates PKCE/state/nonce and JWT signature, maps issuer+subject, and consumes attempt exactly once', async () => {
    const started = await service.startLogin('/work?tab=mine');
    const authorize = new URL(started.redirectUrl);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('state')).toBeTruthy();
    expect(authorize.searchParams.get('nonce')).toBeTruthy();
    const stored = await identityDb
      .selectFrom('oidc_login_attempts')
      .selectAll()
      .where('cookie_hash', '=', createHash('sha256').update(started.cookieToken).digest('hex'))
      .executeTakeFirstOrThrow();
    expect(stored.context_encrypted).not.toContain(authorize.searchParams.get('nonce'));
    const callback = await provider.callback(started.redirectUrl);
    const result = await service.finishLogin({ url: callback, cookieToken: started.cookieToken });
    expect(result.principalId).toBe(alice);
    expect(result.returnTo).toBe('/work?tab=mine');
    expect(
      (await service.authenticate({ cookie: result.token, tenantId: tenant })).principalId,
    ).toBe(alice);
    const tokenCalls = provider.tokenCalls;
    await expect(
      service.finishLogin({ url: callback, cookieToken: started.cookieToken }),
    ).rejects.toMatchObject({ reason: 'LOGIN_FAILED' });
    expect(provider.tokenCalls).toBe(tokenCalls);
  });
  it('rejects incorrect state, wrong browser binding, wrong callback URL and expired attempts before token exchange', async () => {
    const started = await service.startLogin();
    const callback = await provider.callback(started.redirectUrl);
    const wrongState = new URL(callback);
    wrongState.searchParams.set('state', 'attacker-state');
    const tokenCalls = provider.tokenCalls;
    await expect(
      service.finishLogin({ url: wrongState, cookieToken: started.cookieToken }),
    ).rejects.toMatchObject({ reason: 'LOGIN_FAILED' });
    await expect(
      service.finishLogin({ url: callback, cookieToken: 'a'.repeat(43) }),
    ).rejects.toMatchObject({ reason: 'LOGIN_FAILED' });
    const wrongHost = new URL(callback);
    wrongHost.host = 'evil.test';
    await expect(
      service.finishLogin({ url: wrongHost, cookieToken: started.cookieToken }),
    ).rejects.toMatchObject({ reason: 'LOGIN_FAILED' });
    await identityDb
      .updateTable('oidc_login_attempts')
      .set({ expires_at: sql`clock_timestamp() - interval '1 second'` })
      .where('cookie_hash', '=', createHash('sha256').update(started.cookieToken).digest('hex'))
      .execute();
    await expect(
      service.finishLogin({ url: callback, cookieToken: started.cookieToken }),
    ).rejects.toMatchObject({ reason: 'LOGIN_FAILED' });
    expect(provider.tokenCalls).toBe(tokenCalls);
  });
  it.each(['nonce', 'audience', 'issuer', 'expired', 'signature'] satisfies TokenFault[])(
    'rejects invalid token %s',
    async (fault) => {
      const started = await service.startLogin();
      provider.failNext(fault);
      const callback = await provider.callback(started.redirectUrl);
      await expect(
        service.finishLogin({ url: callback, cookieToken: started.cookieToken }),
      ).rejects.toMatchObject({ reason: 'LOGIN_FAILED' });
    },
  );
  it('rejects open redirects and concurrent callback replay', async () => {
    await expect(service.startLogin('//evil.test')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(service.startLogin('/\\evil.test')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const started = await service.startLogin();
    const callback = await provider.callback(started.redirectUrl);
    const results = await Promise.allSettled([
      service.finishLogin({ url: callback, cookieToken: started.cookieToken }),
      service.finishLogin({ url: callback, cookieToken: started.cookieToken }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });
});
