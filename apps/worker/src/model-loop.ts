import { configuredActions } from '@imbox/actions';
import { createKnowledgeService, knowledgeRuntimeSourcePort } from '@imbox/knowledge';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Db } from '@imbox/db';
import { createRuntimeWorker } from '@imbox/runtime';
import { createModelDriver, createOllamaAdapter } from '@imbox/model-runtime';

/** Independent from projection processing: a slow model never holds the outbox loop. */
export async function runModelLoop(db: Db, tenants: readonly string[], signal: AbortSignal) {
  if (process.env.ENABLE_LOCAL_MODEL !== 'true') return;
  const origin = process.env.OLLAMA_ORIGIN;
  const model = process.env.OLLAMA_MODEL;
  const digest = process.env.OLLAMA_MODEL_DIGEST;
  if (!origin || !model || !digest)
    throw new Error('Explicit pinned Ollama configuration required');
  const secret = process.env['SESSION_SECRET'];
  if (!secret) throw new Error('SESSION_SECRET is required for model source access');
  const sources = knowledgeRuntimeSourcePort(createKnowledgeService({ db, cursorSecret: secret }));
  const worker = createRuntimeWorker({ db, workerId: `hosted-model:${randomUUID()}`, sources });
  const adapter = createOllamaAdapter({
    origin,
    model,
    digest,
    allowLoopbackHttp: process.env.OLLAMA_ALLOW_LOOPBACK_HTTP === 'true',
  });
  const actions = await configuredActions(db, process.env, sources);
  const driver = createModelDriver({
    worker,
    models: new Map([['local', adapter]]),
    ...(actions ? { actions } : {}),
  });
  while (!signal.aborted) {
    for (const tenantId of tenants) {
      if (signal.aborted) break;
      const runs = await worker.listRunnable(tenantId, 20);
      for (const runId of runs) {
        if (signal.aborted) break;
        const outcome = await driver.execute(tenantId, runId, signal);
        process.stdout.write(
          `${JSON.stringify({ event: 'model_run_processed', tenant_id: tenantId, run_id: runId, outcome })}\n`,
        );
      }
    }
    try {
      await delay(1000, undefined, { signal });
    } catch {
      break;
    }
  }
}
