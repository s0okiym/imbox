import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Database } from './schema.js';

export type Db = Kysely<Database>;
export type TenantTransaction = Transaction<Database>;
export type DatabaseObservation = {
  kind: 'query' | 'acquire';
  durationMs: number;
  failed: boolean;
  waiting: number;
  idle: number;
  total: number;
  fingerprint?: string;
  operation?: string;
  relation?: string;
};
export type DatabaseOptions = {
  max?: number;
  applicationName?: string;
  statementTimeoutMs?: number;
  observe?: (event: DatabaseObservation) => void | Promise<void>;
};
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The caller chooses a role-specific connection URL. No connection here runs migrations. */
export function createDatabase(url: string, options: DatabaseOptions = {}): Db {
  const pool = new pg.Pool({
    connectionString: url,
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'imbox',
    statement_timeout: options.statementTimeoutMs ?? 15_000,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
  const dialect = new PostgresDialect({ pool });
  if (!options.observe) return new Kysely<Database>({ dialect });
  const notify = (event: Omit<DatabaseObservation, 'waiting' | 'idle' | 'total'>) => {
    try {
      const result = options.observe?.({
        ...event,
        waiting: pool.waitingCount,
        idle: pool.idleCount,
        total: pool.totalCount,
      });
      if (result !== undefined) void Promise.resolve(result).catch(() => {});
    } catch {
      /* Diagnostics must not alter transaction success or expose callback errors. */
    }
  };
  // Only fixed schema identifiers can enter metrics; never emit SQL, values or errors.
  const relations = new Set([
    'tenants',
    'tenant_principals',
    'principals',
    'memberships',
    'conversations',
    'conversation_members',
    'messages',
    'message_revisions',
    'message_resources',
    'resources',
    'reactions',
    'domain_events',
    'outbox',
    'projection_streams',
    'projection_items',
    'projection_events',
    'projection_checkpoints',
    'command_receipts',
    'read_cursors',
    'notification_event_queue',
    'notifications',
    'notification_preferences',
    'notification_devices',
    'sessions',
    'sync_snapshot_sessions',
    'sync_snapshot_items',
  ]);
  return new Kysely<Database>({
    dialect: {
      createAdapter: () => dialect.createAdapter(),
      createIntrospector: (database) => dialect.createIntrospector(database),
      createQueryCompiler: () => dialect.createQueryCompiler(),
      createDriver: () => {
        const driver = dialect.createDriver();
        const acquire = driver.acquireConnection.bind(driver);
        driver.acquireConnection = async () => {
          const start = performance.now();
          let failed = true;
          try {
            const connection = await acquire();
            failed = false;
            return connection;
          } finally {
            notify({ kind: 'acquire', durationMs: performance.now() - start, failed });
          }
        };
        return driver;
      },
    },
    log: (event) => {
      const statement = event.query.sql;
      const verb = /^\s*([a-z]+)/i.exec(statement)?.[1]?.toLowerCase();
      const relation = /\b(?:from|into|update)\s+"?([a-z_][a-z0-9_]*)"?/i.exec(statement)?.[1];
      notify({
        kind: 'query',
        durationMs: event.queryDurationMillis,
        failed: event.level === 'error',
        fingerprint: createHash('sha256').update(statement).digest('hex'),
        operation:
          verb &&
          ['select', 'insert', 'update', 'delete', 'begin', 'commit', 'rollback'].includes(verb)
            ? verb
            : 'other',
        ...(relation && relations.has(relation) ? { relation } : {}),
      });
    },
  });
}

/** AuthContext must supply tenantId. Transaction-local GUC is reset on commit AND rollback. */
export async function withTenant<T>(
  database: Db,
  tenantId: string,
  fn: (transaction: TenantTransaction) => Promise<T>,
  options: { isolationLevel?: 'read committed' | 'repeatable read' | 'serializable' } = {},
): Promise<T> {
  if (!uuidPattern.test(tenantId)) throw new Error('Invalid tenant UUID');
  return database
    .transaction()
    .setIsolationLevel(options.isolationLevel ?? 'read committed')
    .execute(async (transaction) => {
      await sql`select set_config('imbox.tenant_id', ${tenantId}, true)`.execute(transaction);
      return fn(transaction);
    });
}

/** UPDATE holds the stream row lock until commit. Never use a database sequence for this. */
export async function allocateStreamSequence(
  transaction: TenantTransaction,
  streamId: string,
): Promise<string> {
  const row = await transaction
    .updateTable('projection_streams')
    .set({ head_seq: sql`head_seq + 1`, updated_at: sql`clock_timestamp()` })
    .where('id', '=', streamId)
    .where('tenant_id', '=', sql<string>`current_setting('imbox.tenant_id')::uuid`)
    .returning('head_seq')
    .executeTakeFirstOrThrow();
  return row.head_seq;
}

export async function allocateMessageSequence(
  transaction: TenantTransaction,
  conversationId: string,
): Promise<string> {
  const row = await transaction
    .updateTable('conversations')
    .set({ message_head_seq: sql`message_head_seq + 1`, updated_at: sql`clock_timestamp()` })
    .where('id', '=', conversationId)
    .where('tenant_id', '=', sql<string>`current_setting('imbox.tenant_id')::uuid`)
    .returning('message_head_seq')
    .executeTakeFirstOrThrow();
  return row.message_head_seq;
}

/** Stable transaction locks: caller must pass roots in sorted order for cross-root operations. */
export async function lockTaskRoots(
  transaction: TenantTransaction,
  tenantId: string,
  rootTaskIds: readonly string[],
): Promise<void> {
  for (const rootId of [...new Set(rootTaskIds)].sort()) {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:root:${rootId}`}, 0))`.execute(
      transaction,
    );
  }
}

export async function lockDependencyGraph(
  transaction: TenantTransaction,
  tenantId: string,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:dependency_graph`}, 0))`.execute(
    transaction,
  );
}

/** Fail startup when runtime credentials can bypass reviewed tenant/authentication boundaries. */
export async function assertRuntimeRole(database: Db): Promise<void> {
  const result = await sql<{ unsafe: boolean }>`select
    (select rolsuper or rolbypassrls from pg_roles where rolname = current_user)
    or exists(select 1 from pg_class where relnamespace = current_schema()::regnamespace
      and relkind in ('r','p') and pg_has_role(current_user, relowner, 'USAGE')) as unsafe`.execute(
    database,
  );
  if (result.rows[0]?.unsafe !== false)
    throw new Error(
      'Runtime database role must not be superuser, BYPASSRLS, table owner or inherit ownership',
    );
}
