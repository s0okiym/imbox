export {
  assertRuntimeRole,
  createDatabase,
  withTenant,
  allocateStreamSequence,
  allocateMessageSequence,
  lockTaskRoots,
  lockDependencyGraph,
} from './database.js';
export type { Db, TenantTransaction, DatabaseOptions, DatabaseObservation } from './database.js';
export type {
  Database,
  Bigint,
  GeneratedBigint,
  Timestamp,
  NullableTimestamp,
  Json,
} from './schema.js';
export { migrateToLatest, migrate, migrations } from './migrate.js';
export { sql } from 'kysely';

export { lockPrincipal } from './principal.js';
