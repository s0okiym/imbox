import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db, type TenantTransaction as Tx } from '@imbox/db';
import { appendEvent, type AuthContext } from './common.js';
import { MAINTENANCE_PRINCIPAL_ID } from './task-maintenance.js';
import type { PolicyFact, PolicyLedger, PolicyRecord } from './policy-ledger.js';

async function serviceActor(tx: Tx): Promise<AuthContext> {
  const tenant = (
    await sql<{ id: string }>`select current_setting('imbox.tenant_id') as id`.execute(tx)
  ).rows[0]!.id;
  await sql`insert into tenant_principals(tenant_id,principal_id,role) values(${tenant},${MAINTENANCE_PRINCIPAL_ID},'member') on conflict(tenant_id,principal_id) do nothing`.execute(
    tx,
  );
  return {
    tenantId: tenant,
    principalId: MAINTENANCE_PRINCIPAL_ID,
    kind: 'service',
    authzRevision: '1',
  };
}
async function policyEvent(
  tx: Tx,
  aggregateType: string,
  id: string,
  version: string,
  target: string,
  payload: Record<string, unknown> = {},
) {
  if (
    (
      await sql`select id from domain_events where aggregate_type=${aggregateType} and aggregate_id=${id} and aggregate_version=${version}`.execute(
        tx,
      )
    ).rows.length
  )
    return;
  await appendEvent(tx, await serviceActor(tx), {
    aggregateType,
    aggregateId: id,
    version,
    type: `${aggregateType}.policy_replayed`,
    payload,
    target,
  });
}
/** Erase cached and derived bodies as well as denying future reads of the original source. */
export async function purgeDerivedContent(tx: Tx, kind: PolicyFact['kind'], id: string) {
  if (!kind.startsWith('deletion.')) return;
  const type = kind.slice('deletion.'.length);
  const artifactIds =
    type === 'resource'
      ? (
          await sql<{
            id: string;
          }>`select id from artifact_versions where resource_id=${id}`.execute(tx)
        ).rows.map((r) => r.id)
      : [];
  const memories = (
    await sql<{
      id: string;
    }>`select distinct mi.id from memory_items mi left join memory_sources ms on ms.tenant_id=mi.tenant_id and ms.memory_id=mi.id where
      (${type}='memory' and mi.id=${id}) or (${type}='message' and ms.source_message_id=${id}) or ms.source_artifact_version_id=any(${artifactIds}::uuid[])`.execute(
      tx,
    )
  ).rows.map((r) => r.id);
  if (memories.length) {
    const changed = (
      await sql<{
        id: string;
        version: string;
      }>`update memory_items set status='restricted',version=version+1,updated_at=clock_timestamp() where id=any(${memories}::uuid[]) and status not in ('deleted','restricted') returning id,version`.execute(
        tx,
      )
    ).rows;
    for (const row of changed)
      await policyEvent(tx, 'memory', row.id, row.version, `memory:${row.id}`);
    await sql`update memory_revisions set body='',redacted_at=clock_timestamp() where memory_id=any(${memories}::uuid[])`.execute(
      tx,
    );
  }
  const manifests = (
    await sql<{ manifest_id: string }>`select distinct manifest_id from context_items where
      (source_type=${type} and source_id=${id}) or (source_type='memory' and source_id=any(${memories}::uuid[])) or
      (source_type='artifact_version' and source_id=any(${artifactIds}::uuid[]))`.execute(tx)
  ).rows.map((r) => r.manifest_id);
  if (manifests.length) {
    await sql`update context_items set payload='{}'::jsonb where manifest_id=any(${manifests}::uuid[])`.execute(
      tx,
    );
    const changed = (
      await sql<{
        id: string;
        version: string;
      }>`update agent_runs set output=null,summary='',version=version+1,updated_at=clock_timestamp() where context_manifest_id=any(${manifests}::uuid[]) returning id,version`.execute(
        tx,
      )
    ).rows;
    for (const row of changed)
      await policyEvent(tx, 'agent_run', row.id, row.version, `run:${row.id}`);
    await sql`update run_checkpoints set payload='{}'::jsonb where run_id in(select id from agent_runs where context_manifest_id=any(${manifests}::uuid[]))`.execute(
      tx,
    );
  }
  if (type === 'resource') {
    await sql`delete from resource_text_documents where resource_id=${id}`.execute(tx);
    await sql`update artifact_comments set body='',deleted_at=coalesce(deleted_at,clock_timestamp()),version=version+1 where version_id=any(${artifactIds}::uuid[]) and deleted_at is null`.execute(
      tx,
    );
    await sql`update artifact_shares set status='revoked',revoked_at=coalesce(revoked_at,clock_timestamp()),version=version+1 where version_id=any(${artifactIds}::uuid[]) and status='active'`.execute(
      tx,
    );
  }
  if (type === 'message') {
    const tombstone = sql`'{"body":"","deleted":true,"attachment_ids":[],"reactions":[]}'::jsonb`;
    await sql`update projections set dto=jsonb_set(jsonb_set(dto,'{summary}','""'::jsonb),'{message}',((dto->'message')-'quote'-'reply_to_id'-'reply_to_version'-'thread_root_id')||${tombstone}),retracted=true,updated_at=clock_timestamp() where entity_type='message' and entity_id=${id}`.execute(
      tx,
    );
    await sql`update projection_deliveries set dto=jsonb_set(jsonb_set(dto,'{payload,summary}','""'::jsonb),'{payload,message}',((dto->'payload'->'message')-'quote'-'reply_to_id'-'reply_to_version'-'thread_root_id')||${tombstone}),retracted=true where projection_id in(select id from projections where entity_type='message' and entity_id=${id})`.execute(
      tx,
    );
    await sql`update sync_snapshot_items set payload=jsonb_set(jsonb_set(payload,'{summary}','""'::jsonb),'{message}',((payload->'message')-'quote'-'reply_to_id'-'reply_to_version'-'thread_root_id')||${tombstone}),retracted=true where entity_type='message' and entity_id=${id}`.execute(
      tx,
    );
    // Quotes are hydrated per read; discard any legacy embedded body too.
    await sql`update projections set dto=dto#-'{message,quote}' where dto->'message'->'quote'->>'source_id'=${id}`.execute(
      tx,
    );
    await sql`update projection_deliveries set dto=dto#-'{payload,message,quote}' where dto->'payload'->'message'->'quote'->>'source_id'=${id}`.execute(
      tx,
    );
    await sql`update sync_snapshot_items set payload=payload#-'{message,quote}' where payload->'message'->'quote'->>'source_id'=${id}`.execute(
      tx,
    );
  }
}
async function bumpConversation(tx: Tx, id: string) {
  const row = (
    await sql<{
      version: string;
    }>`update conversations set authz_generation=authz_generation+1,version=version+1,updated_at=clock_timestamp() where id=${id} returning version`.execute(
      tx,
    )
  ).rows[0];
  await sql`update projection_streams set authz_generation=authz_generation+1,retention_generation=retention_generation+1,updated_at=clock_timestamp() where id=${id}`.execute(
    tx,
  );
  if (row) await policyEvent(tx, 'conversation', id, row.version, `conversation:${id}`);
}
export async function applyPolicyRecord(tx: Tx, record: PolicyRecord) {
  const id = record.target_id;
  switch (record.kind) {
    case 'deletion.message': {
      const rows = (
        await sql<{
          conversation_id: string;
          version: string;
        }>`update messages set body='',deleted_at=coalesce(deleted_at,clock_timestamp()),version=version+1,updated_at=clock_timestamp() where id=${id} returning conversation_id,version`.execute(
          tx,
        )
      ).rows;
      await sql`delete from message_revisions where message_id=${id}`.execute(tx);
      await sql`delete from reactions where message_id=${id}`.execute(tx);
      if (rows[0]) {
        await bumpConversation(tx, rows[0].conversation_id);
        await policyEvent(
          tx,
          'message',
          id,
          rows[0].version,
          `conversation:${rows[0].conversation_id}`,
          { conversation_id: rows[0].conversation_id },
        );
      }
      break;
    }
    case 'deletion.artifact_comment':
      await sql`update artifact_comments set body='',deleted_at=coalesce(deleted_at,clock_timestamp()),version=version+1 where id=${id}`.execute(
        tx,
      );
      break;
    case 'revocation.artifact_share':
      await sql`update artifact_shares set status='revoked',revoked_at=coalesce(revoked_at,clock_timestamp()),version=version+1 where id=${id} and status='active'`.execute(
        tx,
      );
      break;
    case 'deletion.run': {
      await sql`update context_items set payload='{}'::jsonb where manifest_id in(select context_manifest_id from agent_runs where id=${id})`.execute(
        tx,
      );
      await sql`update run_checkpoints set payload='{}'::jsonb where run_id=${id}`.execute(tx);
      const changed = (
        await sql<{
          version: string;
        }>`update agent_runs set output=null,summary='',content_redacted_at=clock_timestamp(),version=version+1 where id=${id} returning version`.execute(
          tx,
        )
      ).rows[0];
      if (changed) await policyEvent(tx, 'agent_run', id, changed.version, `run:${id}`);
      break;
    }
    case 'deletion.memory': {
      const changed = (
        await sql<{
          version: string;
        }>`update memory_items set status='deleted',deleted_at=coalesce(deleted_at,clock_timestamp()),version=version+1,updated_at=clock_timestamp() where id=${id} returning version`.execute(
          tx,
        )
      ).rows[0];
      if (changed) await policyEvent(tx, 'memory', id, changed.version, `memory:${id}`);
      break;
    }
    case 'deletion.resource': {
      const rows = (
        await sql<{
          object_key: string;
          version: string;
          conversation_id: string | null;
        }>`update resources set deleted_at=coalesce(deleted_at,clock_timestamp()),authz_generation=authz_generation+1,version=version+1 where id=${id} returning object_key,conversation_id,version`.execute(
          tx,
        )
      ).rows;
      if (rows[0]) {
        await sql`insert into resource_cleanup_jobs(tenant_id,id,resource_id,object_key) values(${record.tenant_id},${randomUUID()},${id},${rows[0].object_key}) on conflict(tenant_id,object_key) do update set status='pending',lease_generation=resource_cleanup_jobs.lease_generation+1,lease_expires_at=null,updated_at=clock_timestamp()`.execute(
          tx,
        );
        await policyEvent(tx, 'resource', id, rows[0].version, `resource:${id}`);
        if (rows[0].conversation_id) await bumpConversation(tx, rows[0].conversation_id);
      }
      break;
    }
    case 'revocation.conversation': {
      const result =
        await sql`update conversation_members set status='removed',version=version+1,left_at=clock_timestamp(),updated_at=clock_timestamp() where conversation_id=${id} and principal_id=${record.subject_id!} and version<=${record.target_version}::bigint and status='active'`.execute(
          tx,
        );
      if (result.numAffectedRows) await bumpConversation(tx, id);
      break;
    }
    case 'revocation.task': {
      const result =
        await sql`update task_participants set status='removed',version=version+1,updated_at=clock_timestamp() where task_id=${id} and principal_id=${record.subject_id!} and version<=${record.target_version}::bigint and status='active'`.execute(
          tx,
        );
      if (result.numAffectedRows) {
        const task = (
          await sql<{
            version: string;
          }>`update tasks set authz_generation=authz_generation+1,execution_epoch=execution_epoch+1,version=version+1,updated_at=clock_timestamp() where id=${id} returning version`.execute(
            tx,
          )
        ).rows[0];
        if (task) await policyEvent(tx, 'task', id, task.version, `task:${id}`);
      }
      break;
    }
    case 'revocation.tenant_member': {
      await sql`update tenant_principals set status='disabled',membership_policy_version=membership_policy_version+1,authz_revision=authz_revision+1,version=version+1,updated_at=clock_timestamp() where principal_id=${id} and membership_policy_version<=${record.target_version}::bigint and status='active'`.execute(
        tx,
      );
      break;
    }
    case 'revocation.workspace_member': {
      const changed =
        await sql`update memberships set status='disabled',version=version+1,updated_at=clock_timestamp() where workspace_id=${id} and principal_id=${record.subject_id!} and version<=${record.target_version}::bigint and status='active'`.execute(
          tx,
        );
      if (changed.numAffectedRows) {
        await sql`update tenant_principals set authz_revision=authz_revision+1,version=version+1,updated_at=clock_timestamp() where principal_id=${record.subject_id!}`.execute(
          tx,
        );
        const w = (
          await sql<{
            version: string;
          }>`update workspaces set version=version+1,updated_at=clock_timestamp() where id=${id} returning version`.execute(
            tx,
          )
        ).rows[0];
        if (w) await policyEvent(tx, 'workspace', id, w.version, `workspace:${id}`);
      }
      break;
    }
    case 'revocation.credential':
      await sql`update agent_credentials set status='revoked',revision=revision+1,revoked_at=clock_timestamp() where id=${id} and status='active'`.execute(
        tx,
      );
      await sql`update agent_access_tokens set revoked_at=clock_timestamp() where credential_id=${id} and revoked_at is null`.execute(
        tx,
      );
      break;
    case 'revocation.agent':
      await sql`update agent_installations set status='disabled',authz_revision=authz_revision+1,version=version+1,updated_at=clock_timestamp() where id=${id} and status='active'`.execute(
        tx,
      );
      await sql`update agent_access_tokens set revoked_at=clock_timestamp() where installation_id=${id} and revoked_at is null`.execute(
        tx,
      );
  }
  await purgeDerivedContent(tx, record.kind, id);
}
/** Run before opening API/listeners after restore. A receipt is in the same DB transaction
 * as the purge, so restoring a point before deletion necessarily loses that receipt too. */
export async function replayPolicyLedger(db: Db, ledger: PolicyLedger, onlyTenant?: string) {
  let applied = 0;
  for (const tenant of onlyTenant ? [onlyTenant] : await ledger.tenants()) {
    for (const record of await ledger.records(tenant)) {
      applied += await withTenant(db, tenant, async (tx) => {
        await sql`select pg_advisory_xact_lock(hashtextextended(${`policy:${record.id}`},0))`.execute(
          tx,
        );
        const exists = (await sql`select id from policy_receipts where id=${record.id}`.execute(tx))
          .rows.length;
        if (
          exists ||
          !(await sql`select id from tenants where id=${tenant}`.execute(tx)).rows.length
        )
          return 0;
        await applyPolicyRecord(tx, record);
        await sql`insert into policy_receipts(tenant_id,id,kind,target_id,actor_id,accepted_at) values(${tenant},${record.id},${record.kind},${record.target_id},${record.actor_id},${record.accepted_at}::timestamptz)`.execute(
          tx,
        );
        return 1;
      });
    }
  }
  return { applied };
}
