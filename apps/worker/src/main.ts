import { runNotificationLoop } from './notification-loop.js';
import { runMaintenanceLoop } from './maintenance-loop.js';
import { config } from 'dotenv';
config({ path: new URL('../../../.env', import.meta.url), quiet: true });
import { createDatabase, sql } from '@imbox/db';
import {
  createOutboxProcessor,
  configuredPolicyLedger,
  replayPolicyLedger,
} from '@imbox/application';
import { runResourceLoop } from './resource-loop.js';
import { runModelLoop } from './model-loop.js';

const databaseUrl = process.env.DATABASE_URL;
const tenants = [
  ...new Set(
    (process.env.WORKER_TENANT_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  ),
];
if (
  !databaseUrl ||
  !tenants.length ||
  tenants.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
) {
  throw new Error(
    'DATABASE_URL and an explicit comma-separated WORKER_TENANT_IDS UUID allowlist are required',
  );
}
const intervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 250);
if (!Number.isSafeInteger(intervalMs) || intervalMs < 10 || intervalMs > 60_000)
  throw new Error('Invalid WORKER_POLL_INTERVAL_MS');
const db = createDatabase(databaseUrl, { applicationName: 'imbox-outbox-worker' });
const policyLedger = await configuredPolicyLedger(process.env);
if (policyLedger) for (const tenant of tenants) await replayPolicyLedger(db, policyLedger, tenant);
const processor = createOutboxProcessor({ db });
let stopping = false;
const modelStop = new AbortController();
let modelLoop: Promise<void> | undefined;
let resourceLoop: Promise<void> | undefined;
let maintenanceLoop: Promise<void> | undefined;
let notificationLoop: Promise<void> | undefined;
let wake: (() => void) | undefined;
const stop = () => {
  stopping = true;
  modelStop.abort();
  wake?.();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

try {
  const role = await sql<{
    unsafe: boolean;
  }>`select rolsuper or rolbypassrls as unsafe from pg_roles where rolname = current_user`.execute(
    db,
  );
  const owner = await sql<{
    owns: boolean;
  }>`select exists(select 1 from pg_class where relname='outbox' and relnamespace=current_schema()::regnamespace and pg_has_role(current_user, relowner, 'USAGE')) as owns`.execute(
    db,
  );
  if (role.rows[0]?.unsafe || owner.rows[0]?.owns)
    throw new Error('Worker must use a non-owner role without superuser/BYPASSRLS');
  modelLoop = runModelLoop(db, tenants, modelStop.signal).catch(() => {
    process.stderr.write('{"level":"error","event":"model_loop_failed"}\n');
    process.exitCode = 1;
    stop();
  });
  resourceLoop = runResourceLoop(db, tenants, modelStop.signal).catch(() => {
    process.stderr.write('{"level":"error","event":"resource_loop_failed"}\n');
    process.exitCode = 1;
    stop();
  });
  maintenanceLoop = runMaintenanceLoop(db, tenants, modelStop.signal).catch(() => {
    process.stderr.write('{"level":"error","event":"maintenance_loop_failed"}\n');
    process.exitCode = 1;
    stop();
  });
  notificationLoop = runNotificationLoop(db, tenants, modelStop.signal).catch(() => {
    process.stderr.write('{"level":"error","event":"notification_loop_failed"}\n');
    process.exitCode = 1;
    stop();
  });
  process.stdout.write('{"event":"worker_ready"}\n');
  let cleanupAt = 0;
  while (!stopping) {
    let claimed = 0;
    for (const tenantId of tenants) {
      if (stopping) break;
      const stats = await processor.processBatch(tenantId);
      claimed += stats.claimed;
      if (stats.failed)
        process.stderr.write(
          `${JSON.stringify({ level: 'error', event: 'outbox_batch_failed', tenant_id: tenantId, ...stats })}\n`,
        );
      if (Date.now() >= cleanupAt) await processor.purgeExpiredSnapshots(tenantId);
    }
    if (Date.now() >= cleanupAt) cleanupAt = Date.now() + 60_000;
    if (!claimed && !stopping)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wake = undefined;
          resolve();
        }, intervalMs);
        wake = () => {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        };
      });
  }
} finally {
  modelStop.abort();
  await Promise.all([modelLoop, resourceLoop, maintenanceLoop, notificationLoop]);
  await db.destroy();
}
