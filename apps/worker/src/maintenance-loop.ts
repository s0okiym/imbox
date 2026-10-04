import { configuredPolicyLedger } from '@imbox/application';
import { createRetentionWorker, configuredRetentionPolicy } from '@imbox/governance';
import { createRuntimeMaintenance } from '@imbox/runtime';
import { createKnowledgeService, knowledgeRuntimeSourcePort } from '@imbox/knowledge';
import { createKnowledgeReconciler } from '@imbox/knowledge';
import { setTimeout as delay } from 'node:timers/promises';
import type { Db } from '@imbox/db';
import { createTaskMaintenance } from '@imbox/application';
import { createSchedulingService } from '@imbox/scheduling';
/** Each durable batch is retryable. Failure in one tenant does not delay outbox delivery. */
export async function runMaintenanceLoop(db: Db, tenants: readonly string[], signal: AbortSignal) {
  const secret = process.env['SESSION_SECRET'];
  if (!secret) throw new Error('SESSION_SECRET is required for maintenance');
  const ledger = await configuredPolicyLedger(process.env);
  const retain = ledger
    ? createRetentionWorker({ db, ledger, policy: configuredRetentionPolicy(process.env) })
    : null;
  const expireRuns = createRuntimeMaintenance(db);
  let retentionAt = 0;
  const reconcileKnowledge = createKnowledgeReconciler(db);
  const maintenance = createTaskMaintenance(db, secret);
  const scheduling = createSchedulingService({
    db,
    cursorSecret: secret,
    sources: knowledgeRuntimeSourcePort(createKnowledgeService({ db, cursorSecret: secret })),
  });
  while (!signal.aborted) {
    const retentionDue = Date.now() >= retentionAt;
    for (const tenant of tenants) {
      if (signal.aborted) break;
      try {
        await maintenance.process(tenant);
        await expireRuns(tenant);
        await scheduling.collectDue(tenant);
        await scheduling.dispatchPending(tenant);
        await reconcileKnowledge(tenant);
        if (retain && retentionDue) await retain(tenant);
      } catch {
        process.stderr.write(
          `${JSON.stringify({ level: 'error', event: 'maintenance_batch_failed', tenant_id: tenant })}\n`,
        );
      }
    }
    if (retentionDue) retentionAt = Date.now() + 60_000;
    try {
      await delay(1000, undefined, { signal });
    } catch {
      break;
    }
  }
}
