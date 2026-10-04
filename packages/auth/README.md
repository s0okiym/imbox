# @imbox/auth

Browser identity and session authentication for Imbox. OIDC uses `openid-client` rather than handwritten JWT/OAuth validation. The application and identity pools have independent database roles.

## Integration

```ts
const identity = createIdentityService({
  db: applicationDatabase,
  identityDb: authenticationDatabase,
  publicOrigin: 'https://imbox.example',
  sessionSecret: configuredRandomSecret,
  environment: 'production',
  oidc: { issuer: configuredIssuer, clientId, clientSecret },
});
await registerAuthRoutes(fastify, {
  identity,
  capabilities: ['messaging.send'], // Advertise only implemented capabilities.
});
```

`authenticate` accepts the **value** of the `imbox_session` cookie, optional `authorization` header, selected `tenantId`, `origin`, `csrfToken` and request `method`. HTTP integration should always pass the actual method. `authenticationInput(request)` extracts these fields from Fastify. Do not supply body actor IDs as identity. Bearer authentication is currently rejected; machine credentials belong to a later module.

The result is `{principalId, tenantId, kind, authzRevision, sessionId}`. The tenant header selects a tenant; it grants no access. Every request verifies a live human session/global principal and queries active tenant membership plus tenant status under application-role RLS. `AuthError` (also exported as `IdentityError`) has canonical API `code`, `statusCode`, and an internal diagnostic `reason`. HTTP responses do not expose IdP responses or private identity details.

## Routes

| Route                     | Request                                           | Result                                                                                                                                              |
| ------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/auth/login`      | Optional `return_to`, a same-origin absolute path | IdP redirect plus short-lived HttpOnly login-binding cookie.                                                                                        |
| `GET /v1/auth/callback`   | IdP query parameters and binding cookie           | Validated login, new session cookie, saved same-origin redirect.                                                                                    |
| `POST /v1/auth/dev-login` | `{principal_id}` and exact `Origin`               | Restricted development session plus `{session_id,principal_id,csrf_token,expires_at}`.                                                              |
| `GET /v1/me`              | Session and `X-Imbox-Tenant-Id`                   | Principal, selected tenant, authorization revision, CSRF token, session expiry, current workspace memberships and explicitly supplied capabilities. |
| `POST /v1/auth/logout`    | Session, `Origin`, `X-CSRF-Token`                 | Revoke session and clear cookie; no tenant membership is required to log out.                                                                       |
| `GET /v1/sessions/:id`    | Session and tenant selection                      | Own session metadata only.                                                                                                                          |
| `DELETE /v1/sessions/:id` | Session, tenant selection, `Origin`, CSRF         | Revoke an owned session; other subjects return 404.                                                                                                 |

Cookies are HttpOnly, SameSite=Lax, host-only, and Secure on HTTPS. Production requires HTTPS. Auth responses use `Cache-Control: no-store`; the callback route disables request logging to keep authorization codes out of standard Fastify URL logs. Reverse proxies must likewise omit/redact authentication callback queries and Cookie/Authorization headers.

Unsafe session-authenticated requests require **both** the exact configured Origin and a token matching the session's CSRF digest. The authenticated same-origin `me` response supplies the CSRF token. No permissive CORS behavior is added by this package.

## Persistence and trust boundaries

- Session cookies are random 256-bit values. The database stores an HMAC digest, CSRF digest, expiry, revocation and revision; it never stores the browser token. Login rotates the presented previous session.
- OIDC code flow always uses S256 PKCE, state and nonce. Discovery checks the configured issuer; ID-token audience, time, nonce and signature are validated. Tokens remain server-side and are not retained after establishing the local identity.
- Migration `002-authentication` adds `oidc_login_attempts`. Its random cookie binding and state are hashed, its PKCE/nonce/redirect context is AES-256-GCM encrypted, and one atomic conditional UPDATE consumes it before token exchange. This works across API instances and rejects concurrent replay.
- Identities are keyed by **issuer + subject**. A first login creates a global human identity and grants no tenant membership. Existing email/name claims are never used to merge identities or grant organization access. Tenant enrollment remains an explicit membership operation.
- Expired login attempts are unusable. Operators should purge expired/consumed attempts according to the deployment's authentication retention policy; this package does not start hidden timers or delete session audit history.
- The identity role can access global principals, external identities, sessions and login attempts. The app role cannot read sessions/attempts. The identity role cannot read tenant business tables. Development grants are explicit; production provisioning must supply equivalent reviewed privileges.
- Changing the session secret invalidates existing sessions and pending OIDC attempts. Multi-key rotation is not currently implemented.

Authentication and the business command run in separate transactions/pools. A global principal/session revocation rejects **subsequent authentication checks**; an already authenticated in-flight command may finish. Resource/tenant revocation must be rechecked and locked by the business transaction (including the returned authorization revision). This module does not claim that cookie logout atomically aborts an external action or a command already in flight. Sensitive action admission requires the execution/policy fences described by the design.

Development login is disabled by default. It requires explicit development/test environment, `enableDevAuth: true`, a nonempty server-side UUID allowlist and an exact Origin. Production rejects enabling it even when the environment option is misconfigured while `NODE_ENV=production`. Loopback HTTP OIDC is allowed only with an explicit non-production test/development option; normal providers require HTTPS.

## Verification

The integration suite requires `TEST_DATABASE_URL`, `TEST_APP_DATABASE_URL`, and `TEST_IDENTITY_DATABASE_URL`. Missing infrastructure fails the suite instead of skipping it:

```sh
pnpm exec dotenv run -f .env -- vitest run packages/auth/test/auth.integration.test.ts --config vitest.integration.config.ts
```

Tests use PostgreSQL's real roles plus an actual HTTP authorization server issuing PKCE-bound codes and RSA-signed JWTs through a JWKS endpoint. They cover role isolation, opaque cookie flags/hash storage, tenant changes, CSRF/Origin rejection, rotation/expiry/logout/disable, own-session boundaries, development restrictions, HTTP callbacks, state/browser/URL/TTL validation, invalid nonce/audience/issuer/expiry/signature, and concurrent replay.

OIDC implementation references: [openid-client authorization code flow](https://github.com/panva/openid-client#authorization-code-flow) and [authorizationCodeGrant API](https://github.com/panva/openid-client/blob/main/docs/functions/authorizationCodeGrant.md).
