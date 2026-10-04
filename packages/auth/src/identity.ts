import { randomUUID } from 'node:crypto';
import * as oidc from 'openid-client';
import { sql, withTenant, type Db } from '@imbox/db';
import { AuthError } from './errors.js';
import { createSecrets, digest, opaqueToken, secureEqual } from './crypto.js';

export interface AuthContext {
  principalId: string;
  tenantId: string;
  kind: 'human' | 'agent' | 'service';
  authzRevision: string;
  sessionId: string;
}
export interface AuthenticationInput {
  cookie?: string | undefined;
  authorization?: string | undefined;
  tenantId: string;
  origin?: string | undefined;
  csrfToken?: string | undefined;
  method?: string | undefined;
}
export interface IdentityOptions {
  db: Db;
  identityDb: Db;
  publicOrigin: string;
  sessionSecret: string;
  environment?: 'production' | 'development' | 'test';
  sessionTtlSeconds?: number;
  enableDevAuth?: boolean;
  devPrincipalIds?: readonly string[];
  oidc?: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    allowInsecureLocalHttp?: boolean;
  };
}
export interface IssuedSession {
  sessionId: string;
  principalId: string;
  token: string;
  csrfToken: string;
  expiresAt: Date;
}
interface AttemptContext {
  codeVerifier: string;
  nonce: string;
  returnTo: string;
}
const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tokenPattern = /^[a-zA-Z0-9_-]{43}$/;

export function createIdentityService(options: IdentityOptions) {
  const environment = options.environment ?? 'production';
  const originUrl = new URL(options.publicOrigin);
  if (
    originUrl.origin !== options.publicOrigin ||
    originUrl.username ||
    originUrl.password ||
    !['http:', 'https:'].includes(originUrl.protocol)
  ) {
    throw new Error('publicOrigin must be an exact HTTP(S) origin without a path');
  }
  if (environment === 'production' && originUrl.protocol !== 'https:')
    throw new Error('Production requires HTTPS publicOrigin');
  if (
    options.enableDevAuth &&
    (environment === 'production' || process.env.NODE_ENV === 'production')
  )
    throw new Error('Development authentication is forbidden in production');
  const allowedDevPrincipals = new Set(options.devPrincipalIds ?? []);
  if ([...allowedDevPrincipals].some((id) => !uuid.test(id)))
    throw new Error('Invalid development principal ID');
  if (options.enableDevAuth && allowedDevPrincipals.size === 0)
    throw new Error('Development authentication requires an explicit principal allowlist');
  const secrets = createSecrets(options.sessionSecret);
  const sessionTtlSeconds = options.sessionTtlSeconds ?? 8 * 60 * 60;
  if (
    !Number.isSafeInteger(sessionTtlSeconds) ||
    sessionTtlSeconds < 60 ||
    sessionTtlSeconds > 30 * 86400
  )
    throw new Error('Session TTL must be 60 seconds to 30 days');
  const callbackUrl = `${options.publicOrigin}/v1/auth/callback`;
  let oidcConfiguration: Promise<oidc.Configuration> | undefined;

  function assertOrigin(origin: string | undefined): void {
    if (origin !== options.publicOrigin)
      throw new AuthError('ORIGIN_REJECTED', 403, 'Request origin is not allowed');
  }
  function checkUnsafeRequest(
    input: Pick<AuthenticationInput, 'origin' | 'csrfToken' | 'method'>,
    session: { csrf_token_hash: string },
  ): void {
    if (safeMethods.has((input.method ?? 'GET').toUpperCase())) return;
    assertOrigin(input.origin);
    if (!input.csrfToken || !secureEqual(digest(input.csrfToken), session.csrf_token_hash)) {
      throw new AuthError('CSRF_REJECTED', 403, 'CSRF token is missing or invalid');
    }
  }
  function safeReturnTo(path: string): string {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.length > 2000)
      throw new AuthError('INVALID_REQUEST', 400, 'Invalid return path');
    const target = new URL(path, options.publicOrigin);
    if (target.origin !== options.publicOrigin)
      throw new AuthError('INVALID_REQUEST', 400, 'Invalid return path');
    return `${target.pathname}${target.search}${target.hash}`;
  }
  async function oidcConfig(): Promise<oidc.Configuration> {
    if (!options.oidc) throw new AuthError('LOGIN_FAILED', 503, 'OIDC login is not configured');
    const settings = options.oidc;
    if (!oidcConfiguration) {
      const issuer = new URL(settings.issuer);
      if (issuer.username || issuer.password || issuer.search || issuer.hash)
        throw new Error('Invalid configured OIDC issuer');
      const insecureLocal =
        settings.allowInsecureLocalHttp === true &&
        environment !== 'production' &&
        process.env.NODE_ENV !== 'production' &&
        issuer.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(issuer.hostname);
      if (issuer.protocol !== 'https:' && !insecureLocal)
        throw new Error(
          'OIDC issuer requires HTTPS; only explicit non-production loopback HTTP is allowed',
        );
      oidcConfiguration = oidc
        .discovery(
          issuer,
          settings.clientId,
          settings.clientSecret,
          undefined,
          insecureLocal
            ? {
                execute: [oidc.allowInsecureRequests, oidc.enableNonRepudiationChecks],
                timeout: 10,
              }
            : { execute: [oidc.enableNonRepudiationChecks], timeout: 10 },
        )
        .catch((error: unknown) => {
          oidcConfiguration = undefined;
          throw error;
        });
    }
    return oidcConfiguration;
  }
  async function currentSession(cookie: string | undefined) {
    if (!cookie || !tokenPattern.test(cookie))
      throw new AuthError('UNAUTHENTICATED', 401, 'Valid session required');
    const session = await options.identityDb
      .selectFrom('sessions')
      .innerJoin('principals', 'principals.id', 'sessions.principal_id')
      .select([
        'sessions.id',
        'sessions.principal_id',
        'sessions.csrf_token_hash',
        'sessions.expires_at',
        'principals.kind',
        'principals.display_name',
      ])
      .where('sessions.token_hash', '=', secrets.sessionHash(cookie))
      .where('sessions.revoked_at', 'is', null)
      .where('sessions.expires_at', '>', sql<Date>`clock_timestamp()`)
      .where('principals.status', '=', 'active')
      .executeTakeFirst();
    if (!session || session.kind !== 'human')
      throw new AuthError('UNAUTHENTICATED', 401, 'Valid session required');
    return session;
  }
  async function issueSession(
    principalId: string,
    previousCookie?: string,
  ): Promise<IssuedSession> {
    const token = opaqueToken();
    const csrfToken = secrets.csrfToken(token);
    const sessionId = randomUUID();
    const expiresAt = await options.identityDb.transaction().execute(async (transaction) => {
      const principal = await transaction
        .selectFrom('principals')
        .select(['id', 'kind', 'status'])
        .where('id', '=', principalId)
        .forShare()
        .executeTakeFirst();
      if (!principal || principal.status !== 'active' || principal.kind !== 'human')
        throw new AuthError('LOGIN_FAILED', 401, 'Login could not be completed');
      if (previousCookie && tokenPattern.test(previousCookie)) {
        await transaction
          .updateTable('sessions')
          .set({
            revoked_at: sql`clock_timestamp()`,
            revision: sql`revision + 1`,
            updated_at: sql`clock_timestamp()`,
          })
          .where('token_hash', '=', secrets.sessionHash(previousCookie))
          .where('revoked_at', 'is', null)
          .execute();
      }
      const row = await transaction
        .insertInto('sessions')
        .values({
          id: sessionId,
          principal_id: principalId,
          token_hash: secrets.sessionHash(token),
          csrf_token_hash: digest(csrfToken),
          expires_at: sql<Date>`clock_timestamp() + ${sessionTtlSeconds} * interval '1 second'`,
        })
        .returning('expires_at')
        .executeTakeFirstOrThrow();
      return new Date(row.expires_at);
    });
    return { sessionId, principalId, token, csrfToken, expiresAt };
  }

  return {
    publicOrigin: options.publicOrigin,
    cookieSecure: originUrl.protocol === 'https:',
    sessionTtlSeconds,
    async authenticate(input: AuthenticationInput): Promise<AuthContext> {
      if (input.authorization !== undefined)
        throw new AuthError(
          'AUTH_METHOD_UNSUPPORTED',
          401,
          'Use the supported session authentication method',
        );
      const session = await currentSession(input.cookie);
      checkUnsafeRequest(input, session);
      if (!uuid.test(input.tenantId))
        throw new AuthError('TENANT_ACCESS_DENIED', 403, 'Tenant access denied');
      const membership = await withTenant(options.db, input.tenantId, (transaction) =>
        transaction
          .selectFrom('tenant_principals')
          .innerJoin('tenants', 'tenants.id', 'tenant_principals.tenant_id')
          .select(['tenant_principals.authz_revision'])
          .where('tenant_principals.tenant_id', '=', input.tenantId)
          .where('tenant_principals.principal_id', '=', session.principal_id)
          .where('tenant_principals.status', '=', 'active')
          .where('tenants.status', '=', 'active')
          .executeTakeFirst(),
      );
      if (!membership) throw new AuthError('TENANT_ACCESS_DENIED', 403, 'Tenant access denied');
      return {
        principalId: session.principal_id,
        tenantId: input.tenantId,
        kind: session.kind,
        authzRevision: membership.authz_revision,
        sessionId: session.id,
      };
    },
    async me(input: AuthenticationInput) {
      const auth = await this.authenticate(input);
      const session = await currentSession(input.cookie);
      const workspaces = await withTenant(options.db, auth.tenantId, (transaction) =>
        transaction
          .selectFrom('workspaces')
          .innerJoin('memberships', (join) =>
            join
              .onRef('memberships.tenant_id', '=', 'workspaces.tenant_id')
              .onRef('memberships.workspace_id', '=', 'workspaces.id'),
          )
          .select(['workspaces.id', 'workspaces.name', 'memberships.role'])
          .where('memberships.principal_id', '=', auth.principalId)
          .where('memberships.status', '=', 'active')
          .orderBy('workspaces.name')
          .limit(200)
          .execute(),
      );
      return {
        auth,
        displayName: session.display_name,
        csrfToken: secrets.csrfToken(input.cookie!),
        expiresAt: new Date(session.expires_at).toISOString(),
        workspaces,
      };
    },
    async devLogin(input: {
      principalId: string;
      origin?: string;
      previousCookie?: string;
    }): Promise<IssuedSession> {
      if (
        !options.enableDevAuth ||
        environment === 'production' ||
        process.env.NODE_ENV === 'production'
      )
        throw new AuthError('DEV_AUTH_DISABLED', 404, 'Login method is unavailable');
      assertOrigin(input.origin);
      if (!allowedDevPrincipals.has(input.principalId))
        throw new AuthError('LOGIN_FAILED', 401, 'Login could not be completed');
      return issueSession(input.principalId, input.previousCookie);
    },
    async logout(
      input: Pick<AuthenticationInput, 'cookie' | 'origin' | 'csrfToken'>,
    ): Promise<void> {
      const session = await currentSession(input.cookie);
      checkUnsafeRequest({ ...input, method: 'POST' }, session);
      await options.identityDb
        .updateTable('sessions')
        .set({
          revoked_at: sql`clock_timestamp()`,
          revision: sql`revision + 1`,
          updated_at: sql`clock_timestamp()`,
        })
        .where('id', '=', session.id)
        .where('revoked_at', 'is', null)
        .execute();
    },
    async getSession(auth: AuthContext, sessionId: string) {
      if (!uuid.test(sessionId)) throw new AuthError('NOT_FOUND', 404, 'Session not found');
      const session = await options.identityDb
        .selectFrom('sessions')
        .select(['id', 'created_at', 'expires_at', 'revoked_at', 'revision'])
        .where('id', '=', sessionId)
        .where('principal_id', '=', auth.principalId)
        .executeTakeFirst();
      if (!session) throw new AuthError('NOT_FOUND', 404, 'Session not found');
      return {
        id: session.id,
        created_at: session.created_at.toISOString(),
        expires_at: new Date(session.expires_at).toISOString(),
        revoked_at: session.revoked_at?.toISOString() ?? null,
        revision: session.revision,
      };
    },
    async revokeSession(auth: AuthContext, sessionId: string): Promise<void> {
      if (!uuid.test(sessionId)) throw new AuthError('NOT_FOUND', 404, 'Session not found');
      const result = await options.identityDb
        .updateTable('sessions')
        .set({
          revoked_at: sql`COALESCE(revoked_at, clock_timestamp())`,
          revision: sql`CASE WHEN revoked_at IS NULL THEN revision + 1 ELSE revision END`,
          updated_at: sql`clock_timestamp()`,
        })
        .where('id', '=', sessionId)
        .where('principal_id', '=', auth.principalId)
        .returning('id')
        .executeTakeFirst();
      if (!result) throw new AuthError('NOT_FOUND', 404, 'Session not found');
    },
    async startLogin(returnTo = '/'): Promise<{ redirectUrl: string; cookieToken: string }> {
      const safePath = safeReturnTo(returnTo);
      const config = await oidcConfig();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const codeVerifier = oidc.randomPKCECodeVerifier();
      const cookieToken = opaqueToken();
      const challenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
      const redirectUrl = oidc.buildAuthorizationUrl(config, {
        response_type: 'code',
        redirect_uri: callbackUrl,
        scope: 'openid profile',
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).href;
      await options.identityDb
        .insertInto('oidc_login_attempts')
        .values({
          id: randomUUID(),
          state_hash: digest(state),
          cookie_hash: digest(cookieToken),
          context_encrypted: secrets.encrypt({ codeVerifier, nonce, returnTo: safePath }),
          expires_at: sql<Date>`clock_timestamp() + interval '10 minutes'`,
        })
        .execute();
      return { redirectUrl, cookieToken };
    },
    async finishLogin(input: {
      url: URL;
      cookieToken?: string;
      previousCookie?: string;
    }): Promise<IssuedSession & { returnTo: string }> {
      if (
        input.url.origin !== options.publicOrigin ||
        input.url.pathname !== '/v1/auth/callback' ||
        input.url.hash
      )
        throw new AuthError('LOGIN_FAILED', 401, 'Login could not be completed');
      const states = input.url.searchParams.getAll('state');
      if (
        states.length !== 1 ||
        !states[0] ||
        !input.cookieToken ||
        !tokenPattern.test(input.cookieToken)
      )
        throw new AuthError('LOGIN_FAILED', 401, 'Login could not be completed');
      const attempt = await options.identityDb
        .updateTable('oidc_login_attempts')
        .set({ consumed_at: sql`clock_timestamp()` })
        .where('state_hash', '=', digest(states[0]))
        .where('cookie_hash', '=', digest(input.cookieToken))
        .where('consumed_at', 'is', null)
        .where('expires_at', '>', sql<Date>`clock_timestamp()`)
        .returning('context_encrypted')
        .executeTakeFirst();
      if (!attempt) throw new AuthError('LOGIN_FAILED', 401, 'Login could not be completed');
      try {
        const decoded = secrets.decrypt(attempt.context_encrypted) as Partial<AttemptContext>;
        if (
          typeof decoded.codeVerifier !== 'string' ||
          typeof decoded.nonce !== 'string' ||
          typeof decoded.returnTo !== 'string'
        )
          throw new Error('Invalid login context');
        const config = await oidcConfig();
        const tokens = await oidc.authorizationCodeGrant(config, input.url, {
          pkceCodeVerifier: decoded.codeVerifier,
          expectedState: states[0],
          expectedNonce: decoded.nonce,
          idTokenExpected: true,
        });
        const claims = tokens.claims();
        if (!claims || !claims.sub || claims.iss !== options.oidc!.issuer)
          throw new Error('Invalid identity claims');
        const principalId = await options.identityDb.transaction().execute(async (transaction) => {
          await sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([claims.iss, claims.sub])}, 0))`.execute(
            transaction,
          );
          const existing = await transaction
            .selectFrom('external_identities')
            .select('principal_id')
            .where('issuer', '=', claims.iss)
            .where('subject', '=', claims.sub)
            .executeTakeFirst();
          if (existing) return existing.principal_id;
          const id = randomUUID();
          const displayName =
            typeof claims.name === 'string' && claims.name.trim()
              ? Array.from(claims.name.trim()).slice(0, 120).join('')
              : 'User';
          await transaction
            .insertInto('principals')
            .values({ id, kind: 'human', display_name: displayName })
            .execute();
          await transaction
            .insertInto('external_identities')
            .values({ id: randomUUID(), principal_id: id, issuer: claims.iss, subject: claims.sub })
            .execute();
          return id;
        });
        const session = await issueSession(principalId, input.previousCookie);
        return { ...session, returnTo: safeReturnTo(decoded.returnTo) };
      } catch {
        // Do not include upstream token responses, codes, identity claims, or verifier in errors/logs.
        throw new AuthError('LOGIN_FAILED', 401, 'Login could not be completed');
      }
    },
  };
}
export type IdentityService = ReturnType<typeof createIdentityService>;
