import { sql, withTenant, type Db } from '@imbox/db';
import {
  applyPolicyRecord,
  recordPolicy,
  MAINTENANCE_PRINCIPAL_ID,
  type AuthContext,
  type PolicyLedger,
  type PolicyFact,
} from '@imbox/application';
export interface RetentionPolicy {
  messageDays: number;
  resourceDays: number;
  runContentDays: number;
}
export function configuredRetentionPolicy(env: NodeJS.ProcessEnv): RetentionPolicy {
  const days = (name: string, otherwise: number) => {
    const n = Number(env[name] ?? otherwise);
    if (!Number.isSafeInteger(n) || n < 1 || n > 36500) throw new Error(`Invalid ${name}`);
    return n;
  };
  return {
    messageDays: days('RETENTION_MESSAGE_DAYS', 365),
    resourceDays: days('RETENTION_RESOURCE_DAYS', 365),
    runContentDays: days('RETENTION_RUN_CONTENT_DAYS', 7),
  };
}
/** Operator-configured retention runs as a service principal; no fabricated human authorization. */
export function createRetentionWorker(options: {
  db: Db;
  ledger: PolicyLedger;
  policy: RetentionPolicy;
}) {
  for (const value of Object.values(options.policy))
    if (!Number.isSafeInteger(value) || value < 1 || value > 36500)
      throw new Error('Invalid retention days');
  return async (tenantId: string, limit = 50) => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new Error('Invalid retention batch limit');
    const candidates = await withTenant(options.db, tenantId, async (tx) => {
      await sql`set local statement_timeout='10s'`.execute(tx);
      return (
        await sql<{ id: string; kind: PolicyFact['kind']; version: string }>`
        select id,'deletion.message' as kind,version from (select id,version from messages where deleted_at is null and created_at<=clock_timestamp()-${options.policy.messageDays}*interval '1 day' order by created_at,id limit ${limit}) m
        union all select id,'deletion.resource',version from (select id,version from resources where deleted_at is null and created_at<=clock_timestamp()-${options.policy.resourceDays}*interval '1 day' order by created_at,id limit ${limit}) r
        union all select id,'deletion.run',version from (select id,version from agent_runs where status in ('completed','failed','cancelled','expired') and content_redacted_at is null and updated_at<=clock_timestamp()-${options.policy.runContentDays}*interval '1 day' order by updated_at,id limit ${limit}) runs`.execute(
          tx,
        )
      ).rows;
    });
    let deleted = 0;
    for (const candidate of candidates)
      deleted += await withTenant(options.db, tenantId, async (tx) => {
        // A maintenance-specific lock serializes scanner retries. Authoritative rows are rechecked below.
        await sql`select pg_advisory_xact_lock(hashtextextended(${`retention:${candidate.id}`},0))`.execute(
          tx,
        );
        let current: { version: string; conversation_id: string | null } | undefined;
        if (candidate.kind === 'deletion.message')
          current = (
            await sql<{
              version: string;
              conversation_id: string;
            }>`select version,conversation_id from messages where id=${candidate.id} and deleted_at is null and version=${candidate.version} and created_at<=clock_timestamp()-${options.policy.messageDays}*interval '1 day' for update`.execute(
              tx,
            )
          ).rows[0];
        else if (candidate.kind === 'deletion.resource')
          current = (
            await sql<{
              version: string;
              conversation_id: string | null;
            }>`select version,conversation_id from resources where id=${candidate.id} and deleted_at is null and version=${candidate.version} and created_at<=clock_timestamp()-${options.policy.resourceDays}*interval '1 day' for update`.execute(
              tx,
            )
          ).rows[0];
        else
          current = (
            await sql<{
              version: string;
              conversation_id: null;
            }>`select version,null::uuid as conversation_id from agent_runs where id=${candidate.id} and status in ('completed','failed','cancelled','expired') and content_redacted_at is null and version=${candidate.version} and updated_at<=clock_timestamp()-${options.policy.runContentDays}*interval '1 day' for update`.execute(
              tx,
            )
          ).rows[0];
        if (!current) return 0;
        await sql`insert into tenant_principals(tenant_id,principal_id,role) values(${tenantId},${MAINTENANCE_PRINCIPAL_ID},'member') on conflict(tenant_id,principal_id) do nothing`.execute(
          tx,
        );
        const auth: AuthContext = {
          tenantId,
          principalId: MAINTENANCE_PRINCIPAL_ID,
          kind: 'service',
          authzRevision: '1',
        };
        const record = await recordPolicy(tx, auth, options.ledger, {
          kind: candidate.kind,
          target_id: candidate.id,
          target_version: current.version,
        });
        await applyPolicyRecord(tx, record!);

        return 1;
      });
    await withTenant(options.db, tenantId, async (tx) => {
      await sql`delete from governance_exports where id in(select id from governance_exports where expires_at<=clock_timestamp() order by expires_at,id limit ${limit})`.execute(
        tx,
      );
    });
    return { deleted };
  };
}
