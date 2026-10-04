import { setTimeout as delay } from 'node:timers/promises';
import type { Db } from '@imbox/db';
import { configuredResourceStore, createResourceCleanup } from '@imbox/resources';
/** Object-store latency/failure must not hold the messaging projection loop. */
export async function runResourceLoop(db: Db, tenants: readonly string[], signal: AbortSignal) {
  const store = configuredResourceStore(process.env);
  if (!store) return;
  const cleanup = createResourceCleanup({ db, store });
  try {
    while (!signal.aborted) {
      for (const tenant of tenants) {
        if (signal.aborted) break;
        try {
          const result = await cleanup(tenant);
          if (result.claimed)
            process.stdout.write(
              `${JSON.stringify({ event: 'resource_cleanup', tenant_id: tenant, ...result })}\n`,
            );
        } catch {
          process.stderr.write(
            `${JSON.stringify({ level: 'error', event: 'resource_cleanup_failed', tenant_id: tenant })}\n`,
          );
        }
      }
      try {
        await delay(30000, undefined, { signal });
      } catch {
        break;
      }
    }
  } finally {
    store.destroy();
  }
}
