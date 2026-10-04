import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { assertRuntimeRole, createDatabase } from '@imbox/db';
import { createKnowledgeService, knowledgeRuntimeSourcePort } from '@imbox/knowledge';
import { configuredActions, createToolRunner } from '@imbox/actions';
config({ path: new URL('../../../.env', import.meta.url), quiet: true });
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
const db = createDatabase(required('DATABASE_URL'), { applicationName: 'imbox-tool-runner' });
await assertRuntimeRole(db);
const tenants = [
  ...new Set(
    required('TOOL_RUNNER_TENANT_IDS')
      .split(',')
      .map((id) => id.trim()),
  ),
];
for (const id of tenants)
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))
    throw new Error('Explicit tenant UUID allowlist required');
const actions = await configuredActions(
  db,
  process.env,
  knowledgeRuntimeSourcePort(
    createKnowledgeService({ db, cursorSecret: required('SESSION_SECRET') }),
  ),
);
if (!actions)
  throw new Error('Enable and configure the controlled connector before starting tool-runner');
const runner = createToolRunner({ actions, workerId: `tool-${randomUUID()}` });
const shutdown = new AbortController();
process.once('SIGINT', () => shutdown.abort());
process.once('SIGTERM', () => shutdown.abort());
try {
  while (!shutdown.signal.aborted) {
    for (const tenantId of tenants) {
      if (shutdown.signal.aborted) break;
      try {
        for (const id of await runner.scan(tenantId)) {
          if (shutdown.signal.aborted) break;
          try {
            await runner.runOnce(tenantId, id);
          } catch {
            process.stderr.write(
              JSON.stringify({
                level: 'warn',
                event: 'action_not_dispatched',
                tenant_id: tenantId,
                action_id: id,
              }) + '\n',
            );
          }
        }
      } catch {
        process.stderr.write(
          JSON.stringify({ level: 'error', event: 'action_batch_paused', tenant_id: tenantId }) +
            '\n',
        );
      }
    }
    try {
      await delay(1000, undefined, { signal: shutdown.signal });
    } catch {
      break;
    }
  }
} finally {
  await db.destroy();
}
