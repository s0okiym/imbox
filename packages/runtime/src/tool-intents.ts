import {
  appendEvent,
  authorizeTenant,
  type AuthContext,
  type RuntimeSourcePort,
} from '@imbox/application';
import type { ContractTypes as C } from '@imbox/contracts';
import { sql, type TenantTransaction as Tx } from '@imbox/db';
import { RUNTIME_LIMITS } from './limits.js';
import { activeChain, ancestry, fail, hash, liveActors, runRow, verifyContext } from './shared.js';
import type { ContextItem, LeaseClaim, RunRow } from './types.js';

/** Explicit publication sources only; other context types cannot become tool disclosure. */
export function runToolReferences(taskId: string, items: ContextItem[]): C['ActionResourceRef'][] {
  if (items.filter((item) => item.source_type === 'artifact_version').length > 1)
    fail('DISCLOSURE_DENIED', 403);
  return items.map((item) => {
    if (item.source_type === 'task' && item.source_id === taskId)
      return { type: 'task', id: item.source_id, version: item.source_version };
    if (item.source_type === 'artifact_version' && item.source_sha256)
      return {
        type: 'artifact_version',
        id: item.source_id,
        version: item.source_version,
        sha256: item.source_sha256,
      };
    return fail('DISCLOSURE_DENIED', 403);
  });
}

/** The caller holds the Action safety fence before entering this gate. No network operations. */
export async function lockRunToolAuthority(
  tx: Tx,
  claim: LeaseClaim,
  sources?: RuntimeSourcePort,
  machine?: AuthContext,
  replayHash?: string,
) {
  const initial = await runRow(tx, claim.runId);
  if (initial.tenant_id !== claim.tenantId || !initial.tool_grant_id || !initial.task_id)
    fail('FORBIDDEN', 403);
  if (machine) {
    await authorizeTenant(tx, machine);
    if (
      machine.tenantId !== claim.tenantId ||
      !machine.machine ||
      machine.machine.installationId !== initial.agent_id ||
      initial.execution_location !== 'external' ||
      claim.holder !== `external:${machine.machine.installationId}:${machine.machine.credentialId}`
    )
      fail('FORBIDDEN', 403);
    if (
      !(
        await sql`select 1 from agent_access_tokens where id=${machine.machine.tokenId} and scopes @> '["runs.tools"]'::jsonb for share`.execute(
          tx,
        )
      ).rows.length
    )
      fail('FORBIDDEN', 403);
  } else if (initial.execution_location !== 'hosted') fail('FORBIDDEN', 403);
  const actors = await liveActors(tx, initial);
  const chain = await ancestry(tx, initial.task_id);
  activeChain(chain, initial.ancestor_fences);
  const run = await runRow(tx, initial.id, true);
  const replay =
    replayHash &&
    (
      await sql`select 1 from run_tool_intents where run_id=${run.id} and request_hash=${replayHash} and lease_holder=${claim.holder} and lease_generation=${claim.generation}`.execute(
        tx,
      )
    ).rows.length === 1;
  if (!replay) await assertRunToolLease(tx, run, claim);
  const items = await verifyContext(tx, run, actors.creator, actors.agent, sources);
  runToolReferences(run.task_id!, items);
  return { run, actors, chain, items };
}
export async function assertRunToolLease(tx: Tx, run: RunRow, claim: LeaseClaim) {
  const valid = (
    await sql<{
      valid: boolean;
    }>`select lease_holder=${claim.holder} and lease_generation=${claim.generation} and lease_expires_at>clock_timestamp() and created_at+${RUNTIME_LIMITS.lifetimeSeconds}*interval '1 second'>clock_timestamp() and status='running' and not pause_requested and not cancellation_requested as valid from agent_runs where id=${run.id}`.execute(
      tx,
    )
  ).rows[0]?.valid;
  if (!valid || claim.runId !== run.id || claim.tenantId !== run.tenant_id)
    fail('VERSION_CONFLICT', 409, 'Run execution lease is no longer current');
  if (run.budget_blocked) fail('BUDGET_EXCEEDED', 409);
  if (
    (
      await sql`select 1 from runtime_reservations where run_id=${run.id} and status in ('held','unknown')`.execute(
        tx,
      )
    ).rows.length
  )
    fail('CHARGE_STATUS_UNKNOWN', 409);
}
export async function bindRunToolGrant(
  tx: Tx,
  auth: AuthContext,
  run: RunRow,
  items: ContextItem[],
  grantId: string,
  executorId: string,
) {
  if (auth.kind !== 'human' || !run.task_id) fail('DISCLOSURE_DENIED', 403);
  const row = (
    await sql<{
      task_id: string;
      executor_principal_id: string;
      revision: string;
      resource_versions: unknown;
      currency: string;
      limit_microunits: string;
      valid: boolean;
    }>`select *,status='active' and expires_at>clock_timestamp() and allow_execute and allow_disclosure as valid from capability_grants where id=${grantId} for share`.execute(
      tx,
    )
  ).rows[0];
  const refs = runToolReferences(run.task_id!, items);
  if (
    !row ||
    !row.valid ||
    row.task_id !== run.task_id ||
    row.executor_principal_id !== executorId ||
    row.currency !== run.budget_currency ||
    BigInt(row.limit_microunits) > BigInt(run.budget_limit_microunits) ||
    hash(row.resource_versions) !== hash(refs)
  )
    fail(
      'FORBIDDEN',
      403,
      'The explicit Run grant does not match the disclosed fixed context and budget',
    );
  await sql`update agent_runs set tool_grant_id=${grantId},tool_grant_revision=${row.revision} where id=${run.id}`.execute(
    tx,
  );
}
export async function runToolState(tx: Tx, runId: string) {
  return (
    (
      await sql<{
        action_id: string;
        status: string;
        fingerprint: string;
        version: string;
        tool_id: string;
        target_id: string;
      }>`select a.id as action_id,a.status,a.fingerprint,a.version,a.tool_id,a.target_id from run_tool_intents i join actions a on a.tenant_id=i.tenant_id and a.id=i.action_id where i.run_id=${runId}`.execute(
        tx,
      )
    ).rows[0] ?? null
  );
}
/** Caller holds root and Run locks; unknown never becomes a new tool invocation. */
export async function assertRunToolProgress(
  tx: Tx,
  runId: string,
  operation: 'claim' | 'resume' | 'complete' | 'model',
) {
  const intent = await runToolState(tx, runId);
  if (!intent) return;
  if (['unknown', 'executing'].includes(intent.status)) fail('ACTION_OUTCOME_UNKNOWN', 409);
  if (intent.status === 'awaiting_approval' || intent.status === 'proposed')
    fail('APPROVAL_REQUIRED', 409);
  if (
    ['complete', 'model'].includes(operation) &&
    !['succeeded', 'failed', 'cancelled'].includes(intent.status)
  )
    fail('VERSION_CONFLICT', 409, 'The bound Action must finish before further model output');
}
export async function cancelPendingRunTool(tx: Tx, auth: AuthContext, runId: string) {
  const intent = await runToolState(tx, runId);
  if (!intent) return;
  const result = (
    await sql<{
      id: string;
      task_id: string;
      version: string;
    }>`update actions set status='cancelled',version=version+1 where id=${intent.action_id} and status in ('proposed','awaiting_approval','ready') returning id,task_id,version`.execute(
      tx,
    )
  ).rows[0];
  if (!result) return;
  await sql`update action_approvals set status='revoked' where action_id=${result.id} and status in ('pending','approved')`.execute(
    tx,
  );
  await appendEvent(tx, auth, {
    aggregateType: 'action',
    aggregateId: result.id,
    version: result.version,
    type: 'action.cancelled',
    payload: { task_id: result.task_id, run_id: runId },
    target: `task:${result.task_id}`,
  });
}
