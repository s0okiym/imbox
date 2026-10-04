import { notificationTableNames } from './migrations/027-notifications.js';
import { runtimeToolIntentTableNames } from './migrations/026-runtime-tool-intents.js';
import { artifactCollaborationTableNames } from './migrations/024-artifact-collaboration.js';
import { actionRecoveryTableNames } from './migrations/020-action-recovery.js';
import { governanceTableNames } from './migrations/022-governance.js';
import { knowledgeTableNames } from './migrations/018-knowledge.js';
import { runPromotionTableNames } from './migrations/021-run-promotion.js';
import { sql } from 'kysely';
import pg from 'pg';
import { authenticationTableNames } from './migrations/002-authentication.js';
import { synchronizationTableNames } from './migrations/003-synchronization.js';
import { taskTableNames } from './migrations/004-tasks.js';
import { runtimeTableNames } from './migrations/006-runtime.js';
import { actionTableNames } from './migrations/008-actions.js';
import { taskMaintenanceTableNames } from './migrations/017-task-maintenance.js';
import { messageResourceTableNames } from './migrations/016-message-resources.js';
import { scheduleTableNames } from './migrations/015-schedules.js';
import { agentDeliveryTableNames } from './migrations/014-agent-delivery.js';
import { resourceTableNames } from './migrations/011-resources.js';
import { agentTableNames } from './migrations/009-agents.js';
import type { Db } from './database.js';
import { identityTableNames, tenantTableNames } from './migrations/001-foundation.js';

/** Explicit development/test bootstrap. Never call from an app process or production migration. */
export async function bootstrapDevelopmentRole(
  ownerDatabase: Db,
  options: {
    environment: 'development' | 'test';
    role: string;
    password: string;
    kind?: 'application' | 'identity';
  },
): Promise<void> {
  return ownerDatabase.transaction().execute(async (database) => {
    await sql`select pg_advisory_xact_lock(hashtextextended('imbox:development-role-bootstrap', 0))`.execute(
      database,
    );
    if (
      !['development', 'test'].includes(options.environment) ||
      process.env.NODE_ENV === 'production'
    ) {
      throw new Error('Development role bootstrap is forbidden in production');
    }
    if (!/^imbox_[a-z0-9_]+$/.test(options.role))
      throw new Error('Development role must have safe imbox_ prefix');
    if (options.password.length < 12)
      throw new Error('Development password must contain at least 12 characters');
    // Identifiers and literals are independently quoted; role DDL does not accept bind parameters.
    const quotedRole = `"${options.role}"`;
    const quotedPassword = pg.escapeLiteral(options.password);
    const exists = await sql<{
      exists: boolean;
    }>`select exists(select 1 from pg_roles where rolname = ${options.role})`.execute(database);
    if (exists.rows[0]?.exists) {
      const role = await sql<{
        rolsuper: boolean;
        rolbypassrls: boolean;
      }>`select rolsuper, rolbypassrls from pg_roles where rolname = ${options.role}`.execute(
        database,
      );
      if (role.rows[0]?.rolsuper || role.rows[0]?.rolbypassrls)
        throw new Error('Existing role has unsafe privileges');
    } else {
      await sql
        .raw(
          `CREATE ROLE ${quotedRole} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${quotedPassword}`,
        )
        .execute(database);
    }
    const schema = await sql<{ schema: string }>`select current_schema() as schema`.execute(
      database,
    );
    const schemaName = schema.rows[0]?.schema;
    if (!schemaName || !/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(schemaName))
      throw new Error('Unsupported development schema');
    await sql.raw(`GRANT USAGE ON SCHEMA "${schemaName}" TO ${quotedRole}`).execute(database);
    const ownership = await sql<{ unsafe: boolean }>`
    select exists(select 1 from pg_class where relnamespace = current_schema()::regnamespace
      and pg_has_role(${options.role}, relowner, 'USAGE')) as unsafe
  `.execute(database);
    if (ownership.rows[0]?.unsafe)
      throw new Error('Development runtime role must not own or inherit ownership of tables');
    // Remove earlier default grants, including identity tables, before granting the exact boundary.
    await sql
      .raw(`REVOKE ALL ON ALL TABLES IN SCHEMA "${schemaName}" FROM ${quotedRole}`)
      .execute(database);
    const names =
      options.kind === 'identity'
        ? [...identityTableNames, ...authenticationTableNames]
        : [
            ...tenantTableNames,
            ...synchronizationTableNames,
            ...taskTableNames,
            ...runtimeTableNames,
            ...actionTableNames,
            ...actionRecoveryTableNames,
            ...runtimeToolIntentTableNames,
            ...notificationTableNames,
            ...agentTableNames,
            ...resourceTableNames,
            ...agentDeliveryTableNames,
            ...scheduleTableNames,
            ...messageResourceTableNames,
            ...taskMaintenanceTableNames,
            ...runPromotionTableNames,
            ...knowledgeTableNames,
            ...governanceTableNames,
            ...artifactCollaborationTableNames,
          ];
    for (const table of names) {
      await sql
        .raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${schemaName}"."${table}" TO ${quotedRole}`)
        .execute(database);
    }
    if (options.kind !== 'identity')
      await sql
        .raw(`GRANT EXECUTE ON FUNCTION public.imbox_lock_principal(uuid) TO ${quotedRole}`)
        .execute(database);
    // Global public identity display is readable, but credentials and identity mapping remain separate.
    if (options.kind !== 'identity')
      await sql
        .raw(`GRANT SELECT ON "${schemaName}".principals TO ${quotedRole}`)
        .execute(database);
  });
}
