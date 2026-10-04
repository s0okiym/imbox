# @imbox/db

PostgreSQL 18 is the authority. This package provides typed Kysely access, explicit owner-run migrations, tenant transactions, and transaction-held sequence allocation. It deliberately contains no HTTP routes, resource ACL decisions, or model/tool calls.

## Roles and startup

- `imbox_owner`: migration role; used only by migration/setup commands and fixtures.
- `imbox_app`: non-owner, non-superuser, no `BYPASSRLS`; tenant tables CRUD and public principal metadata SELECT.
- `imbox_identity`: separate authentication pool; global `principals`, `external_identities`, `sessions` access. No tenant-table access is granted by this package.

`createDatabase(url)` never changes schema or role privileges. Production provisioning must grant the same reviewed table permissions to its managed roles separately. Application startup must not run migrations or use owner credentials.

Development/test setup is explicit:

```sh
pnpm exec dotenv run -f .env -- pnpm --filter @imbox/db setup:dev
pnpm exec dotenv run -f .env -- pnpm --filter @imbox/db setup:test
```

Development expects `MIGRATION_DATABASE_URL`, `DATABASE_URL`, and `IDENTITY_DATABASE_URL`. Test setup expects `TEST_DATABASE_URL`, `TEST_APP_DATABASE_URL`, and `TEST_IDENTITY_DATABASE_URL`. Setup is rejected when `NODE_ENV=production`. It revokes earlier table grants from the selected runtime role, then grants the exact role boundary; do not use it for production administration.

Owner-only migration command:

```sh
pnpm exec dotenv run -f .env -- pnpm --filter @imbox/db migrate
```

`migrateToLatest(db)` serializes migrations with a transaction advisory lock and checks immutable migration checksums. The current migration batch is atomic. Concurrent index creation and large backfills must be implemented as explicit separately reviewed migration steps when needed; no automatic rollback/downgrade is supplied.

## Tenant transaction contract

```ts
const database = createDatabase(applicationDatabaseUrl);
await withTenant(database, auth.tenantId, async (tx) => {
  const seq = await allocateMessageSequence(tx, conversationId);
  // Verify current resource ACL and append business state, event and outbox
  // in this same transaction. Sequence is a decimal string.
});
```

`withTenant` validates UUID syntax and uses `set_config(..., true)` on the transaction's single connection. The tenant must originate in trusted authentication context. PostgreSQL RLS cannot prevent a caller with arbitrary SQL privileges from setting its own GUC; application resource authorization is still required. Missing tenant context returns no tenant rows and rejects inserts.

`allocateStreamSequence` and `allocateMessageSequence` increment a row while holding its lock until commit. They must be in the same transaction as delivery/message persistence. Rollback releases the reservation; later transactions cannot commit a larger value before the smaller committed value becomes visible. PostgreSQL `bigint` values remain strings in JavaScript, including values above `Number.MAX_SAFE_INTEGER`.

`lockDependencyGraph` precedes sorted `lockTaskRoots` when changing task dependencies. Application services retain responsibility for cycle checks and the remaining documented lock order. The database additionally enforces immutable task ancestry and parent/root consistency.

Tenant tables have enabled **and forced** RLS. Composite foreign keys include tenant identity; message reply/thread foreign keys additionally include conversation identity. Projection scope references are polymorphic and require scope checks by the calling application. Global authentication data is separated by role instead of a tenant GUC.

## Real integration verification

Run from the repository root after starting PostgreSQL:

```sh
pnpm exec dotenv run -f .env -- vitest run packages/db/test/postgres.integration.test.ts --config vitest.integration.config.ts
```

The suite requires both test URLs and fails immediately if absent. It migrates explicitly, prepares the restricted app role and randomized two-tenant fixtures, then verifies:

1. Idempotent migrations; forced RLS on every tenant table; application is not owner/superuser/BYPASSRLS.
2. Missing tenant context fails closed; application cannot read session credentials.
3. Tenant context does not leak through a reused single-connection pool after commit or rollback.
4. RLS and composite foreign keys reject known foreign-tenant UUIDs.
5. A stalled first stream transaction blocks a second allocation; readers see only committed contiguous deliveries.
6. Rollback returns message sequence reservations; bigint precision survives above 2^53.
7. Business data, event and outbox roll back together.
8. Task roots match parents and ancestry cannot be moved after insertion.

The concurrency test observes an actual PostgreSQL lock wait before releasing its transaction barrier. It does not infer ordering from a fixed sleep or an ORM mock. Fixtures are additive with random UUIDs; this suite must only target a dedicated test database.
