import { setTimeout as delay } from 'node:timers/promises';
import {
  createNotificationDispatcher,
  createNotificationService,
  pushConfiguration,
} from '@imbox/notifications';
import { createDatabase, assertRuntimeRole, sql, type Db } from '@imbox/db';
/** Give every tenant one bounded batch per round, yielding without an idle delay while full. */
export async function runNotificationDispatchLoop(options: {
  tenants: readonly string[];
  signal: AbortSignal;
  dispatch: (tenant: string) => Promise<{ batch_full: boolean }>;
  cleanup?: (tenant: string) => Promise<unknown>;
  failed: (tenant: string) => void;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}) {
  const wait =
    options.wait ?? ((milliseconds, signal) => delay(milliseconds, undefined, { signal }));
  let cleanupAt = 0;
  while (!options.signal.aborted) {
    const clean = Date.now() >= cleanupAt;
    let full = false;
    let failed = false;
    for (const tenant of options.tenants) {
      if (options.signal.aborted) break;
      try {
        const result = await options.dispatch(tenant);
        full = result.batch_full || full;
        if (clean && !options.signal.aborted) await options.cleanup?.(tenant);
      } catch {
        failed = true;
        options.failed(tenant);
      }
    }
    if (clean) cleanupAt = Date.now() + 60_000;
    if (options.signal.aborted) break;
    try {
      await wait(full && !failed ? 0 : 250, options.signal);
    } catch (error) {
      if (!options.signal.aborted) throw error;
    }
  }
}

/** Notification work has an independent loop and cannot hold up chat projection dispatch. */
export async function runNotificationLoop(db: Db, tenants: readonly string[], signal: AbortSignal) {
  const dispatch = createNotificationDispatcher({ db }),
    secret = process.env['SESSION_SECRET'];
  if (!secret) throw new Error('SESSION_SECRET required for notification cursors');
  const identityUrl = process.env['IDENTITY_DATABASE_URL'];
  const identityDb = identityUrl
    ? createDatabase(identityUrl, { max: 2, applicationName: 'imbox-notification-identity' })
    : undefined;
  try {
    if (identityDb) await assertRuntimeRole(identityDb);
    const service = identityDb
      ? createNotificationService({
          db,
          push: pushConfiguration(),
          cursorSecret: secret,
          sessionActive: async (principalId, sessionId) =>
            (
              await sql<{
                live: boolean;
              }>`select exists(select 1 from sessions s join principals p on p.id=s.principal_id where s.id=${sessionId} and s.principal_id=${principalId} and s.revoked_at is null and s.expires_at>clock_timestamp() and p.status='active') as live`.execute(
                identityDb,
              )
            ).rows[0]!.live,
        })
      : undefined;
    // Transport requests run outside the dispatcher loop; slow providers cannot stall inbox fanout.
    const pushLoop = (async () => {
      while (!signal.aborted && service) {
        for (const tenant of tenants) {
          if (signal.aborted) break;
          try {
            await service.pushBatch(tenant, 10);
          } catch {
            process.stderr.write('{"level":"error","event":"notification_push_failed"}\n');
          }
        }
        try {
          await delay(1000, undefined, { signal });
        } catch {
          break;
        }
      }
    })();
    await runNotificationDispatchLoop({
      tenants,
      signal,
      dispatch: (tenant) => dispatch(tenant, { limit: 50, fanoutLimit: 100 }),
      ...(service ? { cleanup: (tenant: string) => service.cleanupDevices(tenant, 50) } : {}),
      failed: (tenant) =>
        process.stderr.write(
          JSON.stringify({
            level: 'error',
            event: 'notification_batch_failed',
            tenant_id: tenant,
          }) + '\n',
        ),
    });
    await pushLoop;
  } finally {
    await identityDb?.destroy();
  }
}
