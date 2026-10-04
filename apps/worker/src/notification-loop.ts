import { setTimeout as delay } from 'node:timers/promises';
import {
  createNotificationDispatcher,
  createNotificationService,
  pushConfiguration,
} from '@imbox/notifications';
import { createDatabase, assertRuntimeRole, sql, type Db } from '@imbox/db';
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
    let cleanupAt = 0;
    while (!signal.aborted) {
      const clean = Date.now() >= cleanupAt;
      for (const tenant of tenants) {
        if (signal.aborted) break;
        try {
          await dispatch(tenant, { limit: 50, fanoutLimit: 100 });
          if (clean && service) await service.cleanupDevices(tenant, 50);
        } catch {
          process.stderr.write(
            JSON.stringify({
              level: 'error',
              event: 'notification_batch_failed',
              tenant_id: tenant,
            }) + '\n',
          );
        }
      }
      if (clean) cleanupAt = Date.now() + 60000;
      try {
        await delay(250, undefined, { signal });
      } catch {
        break;
      }
    }
    await pushLoop;
  } finally {
    await identityDb?.destroy();
  }
}
