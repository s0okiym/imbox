import cookie from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuthError } from './errors.js';
import type { AuthenticationInput, IdentityService, IssuedSession } from './identity.js';

export const SESSION_COOKIE = 'imbox_session';
export const OIDC_COOKIE = 'imbox_oidc';
export function authenticationInput(request: FastifyRequest): AuthenticationInput {
  return {
    cookie: request.cookies[SESSION_COOKIE],
    authorization: request.headers.authorization,
    tenantId: singleHeader(request.headers['x-imbox-tenant-id']) ?? '',
    origin: singleHeader(request.headers.origin),
    csrfToken: singleHeader(request.headers['x-csrf-token']),
    method: request.method,
  };
}
function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  options: { identity: IdentityService; capabilities?: readonly string[] },
): Promise<void> {
  if (!app.hasDecorator('parseCookie')) await app.register(cookie);
  const identity = options.identity;
  function setSession(reply: FastifyReply, session: IssuedSession) {
    reply.setCookie(SESSION_COOKIE, session.token, {
      httpOnly: true,
      secure: identity.cookieSecure,
      sameSite: 'lax',
      path: '/',
      maxAge: identity.sessionTtlSeconds,
    });
  }
  function clearAttempt(reply: FastifyReply) {
    reply.clearCookie(OIDC_COOKIE, {
      path: '/v1/auth/callback',
      httpOnly: true,
      secure: identity.cookieSecure,
      sameSite: 'lax',
    });
  }
  const handled =
    (handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      reply
        .header('Cache-Control', 'no-store')
        .header('Pragma', 'no-cache')
        .header('Referrer-Policy', 'no-referrer');
      try {
        return await handler(request, reply);
      } catch (error) {
        if (error instanceof AuthError)
          return reply.code(error.statusCode).send({
            code: error.code,
            message: error.message,
            request_id: request.id,
            retryable: error.statusCode === 503,
          });
        throw error;
      }
    };
  app.get(
    '/v1/auth/login',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { return_to: { type: 'string', maxLength: 2000 } },
        },
      },
    },
    handled(async (request, reply) => {
      const input = request.query as { return_to?: string };
      const login = await identity.startLogin(input.return_to);
      reply.setCookie(OIDC_COOKIE, login.cookieToken, {
        path: '/v1/auth/callback',
        httpOnly: true,
        secure: identity.cookieSecure,
        sameSite: 'lax',
        maxAge: 600,
      });
      return reply.redirect(login.redirectUrl);
    }),
  );
  app.get(
    '/v1/auth/callback',
    { logLevel: 'silent' },
    handled(async (request, reply) => {
      clearAttempt(reply);
      const session = await identity.finishLogin({
        url: new URL(request.url, identity.publicOrigin),
        ...(request.cookies[OIDC_COOKIE] ? { cookieToken: request.cookies[OIDC_COOKIE] } : {}),
        ...(request.cookies[SESSION_COOKIE]
          ? { previousCookie: request.cookies[SESSION_COOKIE] }
          : {}),
      });
      setSession(reply, session);
      return reply.redirect(session.returnTo);
    }),
  );
  app.post(
    '/v1/auth/dev-login',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['principal_id'],
          properties: { principal_id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    handled(async (request, reply) => {
      const input = request.body as { principal_id: string };
      const session = await identity.devLogin({
        principalId: input.principal_id,
        ...(request.headers.origin ? { origin: request.headers.origin } : {}),
        ...(request.cookies[SESSION_COOKIE]
          ? { previousCookie: request.cookies[SESSION_COOKIE] }
          : {}),
      });
      setSession(reply, session);
      return {
        session_id: session.sessionId,
        principal_id: session.principalId,
        csrf_token: session.csrfToken,
        expires_at: session.expiresAt.toISOString(),
      };
    }),
  );
  app.post(
    '/v1/auth/logout',
    handled(async (request, reply) => {
      const input = authenticationInput(request);
      await identity.logout(input);
      reply.clearCookie(SESSION_COOKIE, {
        path: '/',
        httpOnly: true,
        secure: identity.cookieSecure,
        sameSite: 'lax',
      });
      return reply.code(204).send();
    }),
  );
  app.get(
    '/v1/account',
    handled(async (request) => identity.account(authenticationInput(request))),
  );
  app.get(
    '/v1/me',
    handled(async (request) => {
      const result = await identity.me(authenticationInput(request));
      return {
        principal: {
          id: result.auth.principalId,
          kind: result.auth.kind,
          display_name: result.displayName,
          status: 'active',
        },
        tenant_id: result.auth.tenantId,
        authz_revision: result.auth.authzRevision,
        csrf_token: result.csrfToken,
        session_id: result.auth.sessionId,
        session_expires_at: result.expiresAt,
        workspaces: result.workspaces,
        capabilities: [...(options.capabilities ?? [])],
      };
    }),
  );
  app.get(
    '/v1/sessions/:id',
    handled(async (request) => {
      const auth = await identity.authenticate(authenticationInput(request));
      return identity.getSession(auth, (request.params as { id: string }).id);
    }),
  );
  app.delete(
    '/v1/sessions/:id',
    handled(async (request, reply) => {
      const auth = await identity.authenticate(authenticationInput(request));
      const id = (request.params as { id: string }).id;
      await identity.revokeSession(auth, id);
      if (id === auth.sessionId)
        reply.clearCookie(SESSION_COOKIE, {
          path: '/',
          httpOnly: true,
          secure: identity.cookieSecure,
          sameSite: 'lax',
        });
      return reply.code(204).send();
    }),
  );
}
