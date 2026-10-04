import {
  subscriptionCipher,
  validateSubscription,
  createPushTransport,
  type PushConfiguration,
  type PushSubscriptionInput,
  type PushTransport,
  type PushOutcome,
} from './push.js';
import { randomUUID } from 'node:crypto';
import {
  authorizeTenant,
  authorizeConversation,
  ApplicationError,
  CursorCodec,
  type AuthContext,
} from '@imbox/application';
import { sql, withTenant, type Db, type TenantTransaction as Tx } from '@imbox/db';
import { intentQuery, type Category } from './sources.js';
export interface NotificationPreferencesInput {
  categories: Record<Category, boolean>;
  dnd: { enabled: boolean; time_zone: string; start: string; end: string };
}
export interface NotificationSession extends AuthContext {
  sessionId: string;
}
interface Intent {
  id: string;
  source_kind: Category;
  source_id: string;
  source_version: string;
  live_source_version: string;
  version: string;
  read_version: string;
  category: Category;
  created_at: Date;
  updated_at: Date;
  silent: boolean;
  conversation_id: string | null;
  task_id: string | null;
}
interface Prefs {
  categories: Record<Category, boolean>;
  dnd_enabled: boolean;
  dnd_timezone: string;
  dnd_start: number;
  dnd_end: number;
  version: string;
}
interface Device {
  id: string;
  principal_id: string;
  session_id: string;
  enabled: boolean;
  version: string;
  subscription_ciphertext: string | null;
}
function fail(code: string, status: number): never {
  throw new ApplicationError(code, status);
}
const hint = '你有新的待查看事项';
const categories: Category[] = ['message', 'task', 'request', 'action', 'run'];
const pageLimit = (n = 50) => {
  if (!Number.isSafeInteger(n) || n < 1 || n > 100) fail('VALIDATION_FAILED', 400);
  return n;
};
const minute = (text: string) => {
  if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(text)) fail('VALIDATION_FAILED', 400);
  return Number(text.slice(0, 2)) * 60 + Number(text.slice(3));
};
const time = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export function validateTimeZone(zone: string) {
  try {
    if (!zone || zone.length > 100 || /^[+-]/.test(zone)) throw new Error();
    new Intl.DateTimeFormat('en', { timeZone: zone }).format();
  } catch {
    fail('VALIDATION_FAILED', 400);
  }
}
/** The time zone maps each instant directly to local wall time, including DST folds and gaps. */
export function quietAt(dnd: NotificationPreferencesInput['dnd'], instant: Date) {
  validateTimeZone(dnd.time_zone);
  const start = minute(dnd.start),
    end = minute(dnd.end);
  if (!dnd.enabled) return false;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: dnd.time_zone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const m =
    Number(parts.find((p) => p.type === 'hour')!.value) * 60 +
    Number(parts.find((p) => p.type === 'minute')!.value);
  return (
    start === end ||
    (start < end && m >= start && m < end) ||
    (start > end && (m >= start || m < end))
  );
}
const prefsDto = (p: Prefs) => ({
  version: p.version,
  categories: p.categories,
  dnd: {
    enabled: p.dnd_enabled,
    time_zone: p.dnd_timezone,
    start: time(p.dnd_start),
    end: time(p.dnd_end),
  },
});
const item = (r: Intent) => ({
  id: r.id,
  category: r.category,
  hint,
  version: r.version,
  unread: BigInt(r.read_version) < BigInt(r.version),
  silent: r.silent,
  created_at: r.created_at.toISOString(),
  updated_at: r.updated_at.toISOString(),
});
export function createNotificationService(options: {
  db: Db;
  cursorSecret: string;
  sessionActive?: (principalId: string, sessionId: string) => Promise<boolean>;
  push?: PushConfiguration | undefined;
  pushTransport?: PushTransport;
}) {
  const cursors = new CursorCodec(options.cursorSecret);
  const cipher = options.push ? subscriptionCipher(options.push) : undefined;
  const pushTransport = options.push
    ? (options.pushTransport ?? createPushTransport(options.push))
    : undefined;
  const binding = (tenant: string, d: Device) =>
    JSON.stringify([tenant, d.principal_id, d.session_id, d.id]);
  const transaction = <T>(auth: AuthContext, fn: (tx: Tx) => Promise<T>) =>
    withTenant(options.db, auth.tenantId, async (tx) => {
      await authorizeTenant(tx, auth);
      if (auth.kind !== 'human' || auth.machine) fail('FORBIDDEN', 403);
      await sql`set local statement_timeout='5s'`.execute(tx);
      return fn(tx);
    });
  async function prefs(tx: Tx, auth: AuthContext, write = false) {
    await sql`insert into notification_preferences(tenant_id,principal_id) values(${auth.tenantId},${auth.principalId}) on conflict do nothing`.execute(
      tx,
    );
    return (
      await sql<Prefs>`select * from notification_preferences where principal_id=${auth.principalId} ${write ? sql`for update` : sql`for share`}`.execute(
        tx,
      )
    ).rows[0]!;
  }
  async function current(tx: Tx, auth: AuthContext, id: string) {
    const r = (await sql<Intent>`${intentQuery(auth.principalId)} and n.id=${id}`.execute(tx))
      .rows[0];
    if (!r) fail('NOT_FOUND', 404);
    return r;
  }
  async function device(tenantId: string, id: string) {
    return withTenant(
      options.db,
      tenantId,
      async (tx) =>
        (await sql<Device>`select * from notification_devices where id=${id}`.execute(tx)).rows[0],
    );
  }
  async function deviceAuth(tenantId: string, id: string) {
    const d = await device(tenantId, id);
    if (!d || !d.enabled) return null;
    const active = options.sessionActive
      ? await options.sessionActive(d.principal_id, d.session_id)
      : false;
    if (!active) {
      await withTenant(options.db, tenantId, (tx) =>
        sql`update notification_devices set enabled=false,subscription_ciphertext=null,endpoint_fingerprint=null,version=version+1,updated_at=clock_timestamp() where id=${id} and enabled`.execute(
          tx,
        ),
      );
      return null;
    }
    const member = await withTenant(
      options.db,
      tenantId,
      async (tx) =>
        (
          await sql<{
            authz_revision: string;
          }>`select authz_revision from tenant_principals where principal_id=${d.principal_id} and status='active'`.execute(
            tx,
          )
        ).rows[0],
    );
    return member
      ? {
          principalId: d.principal_id,
          tenantId,
          kind: 'human' as const,
          authzRevision: member.authz_revision,
        }
      : null;
  }
  async function deliverable(tx: Tx, auth: AuthContext, p: Prefs, notificationId?: string) {
    const now = (await sql<{ now: Date }>`select clock_timestamp() now`.execute(tx)).rows[0]!.now;
    if (quietAt(prefsDto(p).dnd, now)) return null;
    return (
      (
        await sql<Intent>`${intentQuery(auth.principalId)} and n.read_version<n.version and not coalesce(mu.muted,false) and ${JSON.stringify(p.categories)}::jsonb->>n.category='true' ${notificationId ? sql`and n.id=${notificationId}` : sql``} order by n.updated_at,n.id limit 1`.execute(
          tx,
        )
      ).rows[0] ?? null
    );
  }
  const service = {
    async pushKey(auth: AuthContext) {
      return transaction(auth, async () => ({
        enabled: !!options.push,
        public_key: options.push?.publicKey ?? null,
      }));
    },
    async subscribe(auth: NotificationSession, input: PushSubscriptionInput) {
      if (!options.push || !cipher) fail('FEATURE_UNAVAILABLE', 503);
      try {
        validateSubscription(input, options.push);
      } catch {
        fail('VALIDATION_FAILED', 400);
      }
      if (
        !auth.sessionId ||
        !options.sessionActive ||
        !(await options.sessionActive(auth.principalId, auth.sessionId))
      )
        fail('UNAUTHENTICATED', 401);
      return transaction(auth, async (tx) => {
        // Serialize the same endpoint, including account replacement within this tenant.
        const fingerprint = cipher.fingerprint(input.endpoint);
        await sql`select pg_advisory_xact_lock(hashtextextended(${auth.tenantId + fingerprint},0))`.execute(
          tx,
        );
        await sql`update notification_devices set enabled=false,subscription_ciphertext=null,endpoint_fingerprint=null,version=version+1 where endpoint_fingerprint=${fingerprint} and (principal_id<>${auth.principalId} or session_id<>${auth.sessionId})`.execute(
          tx,
        );
        const d = (
          await sql<Device>`insert into notification_devices(tenant_id,id,principal_id,session_id,enabled) values(${auth.tenantId},${randomUUID()},${auth.principalId},${auth.sessionId},true) on conflict(tenant_id,principal_id,session_id) do update set enabled=true,version=notification_devices.version+1,updated_at=clock_timestamp() returning *`.execute(
            tx,
          )
        ).rows[0]!;
        await sql`update notification_devices set subscription_ciphertext=${cipher.seal(input, binding(auth.tenantId, d))},endpoint_fingerprint=${fingerprint} where id=${d.id}`.execute(
          tx,
        );
        return { id: d.id, enabled: true, version: d.version };
      });
    },
    /** Bounded independent delivery loop. Generic payloads may be redelivered after a crash. */
    async pushBatch(tenantId: string, limit = 20): Promise<{ checked: number; sent: number }> {
      pageLimit(limit);
      if (!pushTransport || !cipher) return { checked: 0, sent: 0 };
      const devices = await withTenant(options.db, tenantId, async (tx) => {
        const rows = (
          await sql<Device>`select * from notification_devices where enabled and subscription_ciphertext is not null order by push_checked_at,id limit ${limit} for update skip locked`.execute(
            tx,
          )
        ).rows;
        for (const row of rows)
          await sql`update notification_devices set push_checked_at=clock_timestamp() where id=${row.id}`.execute(
            tx,
          );
        return rows;
      });
      let sent = 0;
      for (const d of devices) {
        const delivery = await service.prepareDelivery(tenantId, d.id);
        if (!delivery) continue;
        let outcome: PushOutcome = 'discard';
        try {
          const current = await device(tenantId, d.id);
          if (current?.version === delivery.device_version && current.subscription_ciphertext) {
            const subscription = cipher.open(
              current.subscription_ciphertext,
              binding(tenantId, current),
            );
            outcome = await pushTransport(
              subscription,
              JSON.stringify(delivery.payload),
              delivery.payload.locator.replaceAll('-', ''),
              () =>
                service.revalidateDelivery(tenantId, delivery.delivery_id, delivery.lease_token),
            );
          }
        } catch {
          outcome = 'discard';
        }
        await service
          .settleDelivery(tenantId, delivery.delivery_id, delivery.lease_token, outcome)
          .catch((failure: unknown) => {
            if (!(failure instanceof ApplicationError && failure.code === 'LEASE_LOST'))
              throw failure;
          });
        sent += Number(outcome === 'sent');
      }
      return { checked: devices.length, sent };
    },
    async list(auth: AuthContext, query: { cursor?: string; limit?: number } = {}) {
      return transaction(auth, async (tx) => {
        const n = pageLimit(query.limit);
        const binding = JSON.stringify([
          auth.tenantId,
          auth.principalId,
          auth.authzRevision,
          'notification-inbox:v1',
        ]);
        const after = query.cursor ? cursors.decode(query.cursor, binding) : null;
        if (after && !/^[a-f0-9-]{36}$/.test(after)) fail('RESYNC_REQUIRED', 409);
        const rows = (
          await sql<Intent>`${intentQuery(auth.principalId)} ${after ? sql`and n.id>${after}::uuid` : sql``} order by n.id limit ${n + 1}`.execute(
            tx,
          )
        ).rows;
        return {
          items: rows.slice(0, n).map(item),
          ...(rows.length > n ? { next_cursor: cursors.encode(binding, rows[n - 1]!.id) } : {}),
        };
      });
    },
    async unread(auth: AuthContext) {
      return transaction(auth, async (tx) => {
        const rows = (
          await sql<{
            count: string;
          }>`select count(*)::text count from (${intentQuery(auth.principalId)} and n.read_version<n.version) visible_unread`.execute(
            tx,
          )
        ).rows;
        return { unread_count: Number(rows[0]!.count) };
      });
    },
    async open(auth: AuthContext, id: string) {
      return transaction(auth, async (tx) => {
        const row = await current(tx, auth, id);
        return {
          notification_id: row.id,
          version: row.version,
          target: { type: row.source_kind, id: row.source_id, version: row.live_source_version },
          conversation_id: row.conversation_id,
          task_id: row.task_id,
        };
      });
    },
    async markRead(auth: AuthContext, id: string, version: string) {
      return transaction(auth, async (tx) => {
        const row = await current(tx, auth, id);
        if (row.version !== version) fail('VERSION_CONFLICT', 409);
        const result =
          await sql`update notification_intents set read_version=version where id=${id} and recipient_id=${auth.principalId} and version=${version}`.execute(
            tx,
          );
        if (result.numAffectedRows !== 1n) fail('VERSION_CONFLICT', 409);
        return { id, version, read: true as const };
      });
    },
    async getPreferences(auth: AuthContext) {
      return transaction(auth, async (tx) => prefsDto(await prefs(tx, auth)));
    },
    async setPreferences(auth: AuthContext, input: NotificationPreferencesInput, version: string) {
      if (
        Object.keys(input.categories).length !== categories.length ||
        categories.some((c) => typeof input.categories[c] !== 'boolean')
      )
        fail('VALIDATION_FAILED', 400);
      validateTimeZone(input.dnd.time_zone);
      const start = minute(input.dnd.start),
        end = minute(input.dnd.end);
      return transaction(auth, async (tx) => {
        await prefs(tx, auth, true);
        const row = (
          await sql<Prefs>`update notification_preferences set categories=${JSON.stringify(input.categories)}::jsonb,dnd_enabled=${input.dnd.enabled},dnd_timezone=${input.dnd.time_zone},dnd_start=${start},dnd_end=${end},version=version+1,updated_at=clock_timestamp() where principal_id=${auth.principalId} and version=${version} returning *`.execute(
            tx,
          )
        ).rows[0];
        if (!row) fail('VERSION_CONFLICT', 409);
        return prefsDto(row);
      });
    },
    async mute(auth: AuthContext, conversationId: string, muted: boolean) {
      return transaction(auth, async (tx) => {
        await authorizeConversation(tx, auth, conversationId);
        await sql`insert into notification_mutes(tenant_id,principal_id,conversation_id,muted) values(${auth.tenantId},${auth.principalId},${conversationId},${muted}) on conflict(tenant_id,principal_id,conversation_id) do update set muted=excluded.muted`.execute(
          tx,
        );
        return { conversation_id: conversationId, muted };
      });
    },
    async setDevice(auth: NotificationSession, enabled: boolean) {
      if (
        !auth.sessionId ||
        !options.sessionActive ||
        !(await options.sessionActive(auth.principalId, auth.sessionId))
      )
        fail('UNAUTHENTICATED', 401);
      return transaction(auth, async (tx) => {
        const d = (
          await sql<Device>`insert into notification_devices(tenant_id,id,principal_id,session_id,enabled) values(${auth.tenantId},${randomUUID()},${auth.principalId},${auth.sessionId},${enabled}) on conflict(tenant_id,principal_id,session_id) do update set enabled=excluded.enabled,subscription_ciphertext=case when excluded.enabled then notification_devices.subscription_ciphertext else null end,endpoint_fingerprint=case when excluded.enabled then notification_devices.endpoint_fingerprint else null end,version=notification_devices.version+case when notification_devices.enabled<>excluded.enabled then 1 else 0 end,updated_at=clock_timestamp() returning *`.execute(
            tx,
          )
        ).rows[0]!;
        return { id: d.id, enabled: d.enabled, version: d.version };
      });
    },
    async devices(auth: AuthContext) {
      return transaction(auth, async (tx) => ({
        items: (
          await sql<Device>`select * from notification_devices where principal_id=${auth.principalId} order by id limit 100`.execute(
            tx,
          )
        ).rows.map((d) => ({ id: d.id, enabled: d.enabled, version: d.version })),
      }));
    },
    async disableDevice(auth: AuthContext, id: string) {
      return transaction(auth, async (tx) => {
        const d = (
          await sql<Device>`update notification_devices set enabled=false,subscription_ciphertext=null,endpoint_fingerprint=null,version=version+case when enabled then 1 else 0 end,updated_at=clock_timestamp() where id=${id} and principal_id=${auth.principalId} returning *`.execute(
            tx,
          )
        ).rows[0];
        if (!d) fail('NOT_FOUND', 404);
        return { id: d.id, enabled: d.enabled, version: d.version };
      });
    },
    /** Internal transport adapter only. No public endpoint can claim a delivery or assert it was sent. */
    async prepareDelivery(tenantId: string, deviceId: string) {
      const auth = await deviceAuth(tenantId, deviceId);
      if (!auth) return null;
      return transaction(auth, async (tx) => {
        const p = await prefs(tx, auth);
        const d = (
          await sql<Device>`select * from notification_devices where id=${deviceId} and enabled for update`.execute(
            tx,
          )
        ).rows[0];
        if (!d) return null;
        const now = (await sql<{ now: Date }>`select clock_timestamp() now`.execute(tx)).rows[0]!
          .now;
        if (quietAt(prefsDto(p).dnd, now)) return null;
        const row = (
          await sql<Intent>`${intentQuery(auth.principalId)} and n.read_version<n.version and not coalesce(mu.muted,false) and ${JSON.stringify(p.categories)}::jsonb->>n.category='true' and not exists(select 1 from notification_deliveries nd where nd.device_id=${deviceId} and nd.notification_id=n.id and nd.notification_version=n.version and (nd.attempts>=5 or nd.status in('delivered','invalid') or nd.available_at>clock_timestamp() or nd.status='leased' and nd.lease_expires_at>clock_timestamp())) order by n.updated_at,n.id limit 1`.execute(
            tx,
          )
        ).rows[0];
        if (!row) return null;
        const token = randomUUID();
        const delivery = (
          await sql<{
            id: string;
            lease_expires_at: Date;
          }>`insert into notification_deliveries(tenant_id,id,device_id,notification_id,notification_version,status,lease_token,lease_expires_at,attempts,device_version) values(${tenantId},${randomUUID()},${deviceId},${row.id},${row.version},'leased',${token},clock_timestamp()+interval '30 seconds',1,${d.version}) on conflict(tenant_id,device_id,notification_id,notification_version) do update set status='leased',lease_token=excluded.lease_token,lease_expires_at=excluded.lease_expires_at,attempts=notification_deliveries.attempts+1,device_version=excluded.device_version returning id,lease_expires_at`.execute(
            tx,
          )
        ).rows[0]!;
        return {
          delivery_id: delivery.id,
          device_id: deviceId,
          device_version: d.version,
          lease_token: token,
          lease_expires_at: delivery.lease_expires_at.toISOString(),
          payload: { title: 'Imbox', body: hint, locator: row.id, version: row.version },
        };
      });
    },
    async revalidateDelivery(tenantId: string, deliveryId: string, token: string) {
      const row = await withTenant(
        options.db,
        tenantId,
        async (tx) =>
          (
            await sql<{
              device_id: string;
              notification_id: string;
              notification_version: string;
              device_version: string;
            }>`select device_id,notification_id,notification_version,device_version from notification_deliveries where id=${deliveryId} and status='leased' and lease_token=${token} and lease_expires_at>clock_timestamp()`.execute(
              tx,
            )
          ).rows[0],
      );
      if (!row) return false;
      const auth = await deviceAuth(tenantId, row.device_id);
      if (!auth) return false;
      return transaction(auth, async (tx) => {
        const p = await prefs(tx, auth);
        const n = await deliverable(tx, auth, p, row.notification_id);
        const enabled = (
          await sql<{
            enabled: boolean;
          }>`select enabled from notification_devices where id=${row.device_id} and version=${row.device_version} and exists(select 1 from notification_deliveries where id=${deliveryId} and status='leased' and lease_token=${token} and lease_expires_at>clock_timestamp())`.execute(
            tx,
          )
        ).rows[0]?.enabled;
        return !!enabled && n?.version === row.notification_version;
      });
    },
    async settleDelivery(tenantId: string, id: string, token: string, outcome: PushOutcome) {
      return withTenant(options.db, tenantId, async (tx) => {
        const row = (
          await sql<{
            device_id: string;
            device_version: string;
          }>`update notification_deliveries set status=case when ${outcome}='retry' and attempts>=5 then 'invalid' else ${outcome === 'sent' ? 'delivered' : outcome === 'retry' ? 'pending' : 'invalid'} end,delivered_at=case when ${outcome}='sent' then clock_timestamp() else null end,available_at=clock_timestamp()+make_interval(secs=>least(900,30*power(2,attempts-1))::integer),lease_token=null,lease_expires_at=null where id=${id} and status='leased' and lease_token=${token} and lease_expires_at>clock_timestamp() returning device_id,device_version`.execute(
            tx,
          )
        ).rows[0];
        if (!row) fail('LEASE_LOST', 409);
        if (outcome === 'subscription_invalid')
          await sql`update notification_devices set enabled=false,subscription_ciphertext=null,endpoint_fingerprint=null,version=version+1,updated_at=clock_timestamp() where id=${row.device_id} and version=${row.device_version}`.execute(
            tx,
          );
        return { recorded: true };
      });
    },
    async cleanupDevices(tenantId: string, limit = 50) {
      pageLimit(limit);
      const devices = await withTenant(
        options.db,
        tenantId,
        async (tx) =>
          (
            await sql<Device>`select * from notification_devices where enabled order by updated_at,id limit ${limit}`.execute(
              tx,
            )
          ).rows,
      );
      let disabled = 0;
      for (const d of devices) {
        const live = options.sessionActive
          ? await options.sessionActive(d.principal_id, d.session_id)
          : false;
        await withTenant(options.db, tenantId, (tx) =>
          sql`update notification_devices set enabled=${live},subscription_ciphertext=case when ${live} then subscription_ciphertext else null end,endpoint_fingerprint=case when ${live} then endpoint_fingerprint else null end,version=version+${live ? 0 : 1},updated_at=clock_timestamp() where id=${d.id} and enabled`.execute(
            tx,
          ),
        );
        disabled += Number(!live);
      }
      return { checked: devices.length, disabled };
    },
  };
  return service;
}
export type NotificationService = ReturnType<typeof createNotificationService>;
