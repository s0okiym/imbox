import { workspaceProvisioningSql } from './migrations/030-workspace-provisioning.js';
import { webPushSql } from './migrations/029-web-push.js';
import { recentSnapshotsSql } from './migrations/028-recent-snapshots.js';
import { notificationsSql } from './migrations/027-notifications.js';
import { runtimeToolIntentsSql } from './migrations/026-runtime-tool-intents.js';
import { artifactCollaborationSql } from './migrations/024-artifact-collaboration.js';
import { actionRecoverySql } from './migrations/020-action-recovery.js';
import { governanceRetentionSql } from './migrations/025-governance-retention.js';
import { runtimeKnowledgeSourcesSql } from './migrations/023-runtime-knowledge-sources.js';
import { governanceSql } from './migrations/022-governance.js';
import { knowledgeSql } from './migrations/018-knowledge.js';
import { runPromotionSql } from './migrations/021-run-promotion.js';
import { messageInteractionsSql } from './migrations/019-message-interactions.js';
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { Db } from './database.js';
import { foundationSql } from './migrations/001-foundation.js';
import { authenticationSql } from './migrations/002-authentication.js';
import { synchronizationSql } from './migrations/003-synchronization.js';
import { tasksSql } from './migrations/004-tasks.js';
import { taskFencesSql } from './migrations/005-task-fences.js';
import { runtimeSql } from './migrations/006-runtime.js';
import { runtimePrincipalFencesSql } from './migrations/007-runtime-principal-fences.js';
import { actionsSql } from './migrations/008-actions.js';
import { agentsSql } from './migrations/009-agents.js';
import { taskMaintenanceSql } from './migrations/017-task-maintenance.js';
import { messageResourcesSql } from './migrations/016-message-resources.js';
import { schedulesSql } from './migrations/015-schedules.js';
import { agentDeliverySql } from './migrations/014-agent-delivery.js';
import { resourcesSql } from './migrations/011-resources.js';
import { principalLockSql } from './migrations/012-principal-lock.js';
import { actionAuthoritySql } from './migrations/010-action-authority.js';

export const migrations = [
  { id: '001-foundation', sql: foundationSql },
  { id: '002-authentication', sql: authenticationSql },
  { id: '003-synchronization', sql: synchronizationSql },
  { id: '004-tasks', sql: tasksSql },
  { id: '005-task-fences', sql: taskFencesSql },
  { id: '006-runtime', sql: runtimeSql },
  { id: '007-runtime-principal-fences', sql: runtimePrincipalFencesSql },
  { id: '008-actions', sql: actionsSql },
  { id: '009-agents', sql: agentsSql },
  { id: '010-action-authority', sql: actionAuthoritySql },
  { id: '011-resources', sql: resourcesSql },
  { id: '012-principal-lock', sql: principalLockSql },
  { id: '014-agent-delivery', sql: agentDeliverySql },
  { id: '015-schedules', sql: schedulesSql },
  { id: '016-message-resources', sql: messageResourcesSql },
  { id: '017-task-maintenance', sql: taskMaintenanceSql },
  { id: '018-knowledge', sql: knowledgeSql },
  { id: '019-message-interactions', sql: messageInteractionsSql },
  { id: '020-action-recovery', sql: actionRecoverySql },
  { id: '021-run-promotion', sql: runPromotionSql },
  { id: '022-governance', sql: governanceSql },
  { id: '023-runtime-knowledge-sources', sql: runtimeKnowledgeSourcesSql },
  { id: '024-artifact-collaboration', sql: artifactCollaborationSql },
  { id: '025-governance-retention', sql: governanceRetentionSql },
  { id: '026-runtime-tool-intents', sql: runtimeToolIntentsSql },
  { id: '027-notifications', sql: notificationsSql },
  { id: '028-recent-snapshots', sql: recentSnapshotsSql },
  { id: '029-web-push', sql: webPushSql },
  { id: '030-workspace-provisioning', sql: workspaceProvisioningSql },
] as const;

/** Explicit command only. Atomic migration batch, immutable checksums, serialized owner DDL. */
export async function migrateToLatest(database: Db): Promise<string[]> {
  return database.transaction().execute(async (transaction) => {
    await sql`select pg_advisory_xact_lock(hashtextextended('imbox:schema:migrations', 0))`.execute(
      transaction,
    );
    await sql`create table if not exists imbox_migrations (
      id text primary key, checksum text not null, applied_at timestamptz not null default now()
    )`.execute(transaction);
    const applied = await sql<{
      id: string;
      checksum: string;
    }>`select id, checksum from imbox_migrations order by id`.execute(transaction);
    for (const recorded of applied.rows) {
      if (!migrations.some((migration) => migration.id === recorded.id))
        throw new Error(`Unknown migration ${recorded.id}; refusing downgrade`);
    }
    const completed: string[] = [];
    for (const migration of migrations) {
      const checksum = createHash('sha256').update(migration.sql).digest('hex');
      const previous = applied.rows.find((row) => row.id === migration.id);
      if (previous) {
        if (previous.checksum !== checksum)
          throw new Error(`Migration checksum mismatch: ${migration.id}`);
        continue;
      }
      await sql.raw(migration.sql).execute(transaction);
      await sql`insert into imbox_migrations (id, checksum) values (${migration.id}, ${checksum})`.execute(
        transaction,
      );
      completed.push(migration.id);
    }
    return completed;
  });
}

export const migrate = migrateToLatest;
