import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { cpus, totalmem } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import WebSocket from 'ws';
import { createDatabase, migrateToLatest, sql, withTenant } from '@imbox/db';
import { bootstrapDevelopmentRole } from '@imbox/db/testing';
import {
  createMessagingService,
  createSyncService,
  createOutboxProcessor,
} from '@imbox/application';
import {
  createNotificationDispatcher,
  measureNotificationSourceLookup,
} from '@imbox/notifications';
import { createIdentityService } from '@imbox/auth';
import { createApp } from '../apps/api/src/app.js';
import { tenantFixture } from '../tests/helpers/database.js';
config({ quiet: true });
const integer = (name: string, defaultValue: number, max: number) => {
  const n = Number(process.env[name] ?? defaultValue);
  if (!Number.isSafeInteger(n) || n < 1 || n > max)
    throw new Error('Invalid capacity configuration');
  return n;
};
const connections = integer('CAPACITY_CONNECTIONS', 1000, 1000),
  history = integer('CAPACITY_HISTORY', 1000000, 1000000),
  seconds = integer('CAPACITY_SECONDS', 30, 300),
  rate = integer('CAPACITY_RATE', 50, 100);
const percentile = (values: number[], p: number) =>
  values.length
    ? Math.round([...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]! * 100) / 100
    : null;
export async function runCapacityProbe() {
  const urls = ['TEST_DATABASE_URL', 'TEST_APP_DATABASE_URL', 'TEST_IDENTITY_DATABASE_URL'].map(
    (name) => new URL(process.env[name] ?? ''),
  );
  if (
    urls.some((u) => !['127.0.0.1', 'localhost'].includes(u.hostname) || u.port !== '55432') ||
    urls[0]!.pathname !== '/imbox_test'
  )
    throw new Error('Capacity probe requires isolated local test cluster');
  const name = 'imbox_capacity_' + randomUUID().replaceAll('-', ''),
    management = createDatabase(urls[0]!.href, { max: 1 }),
    url = (index: number) => {
      const u = new URL(urls[index]!.href);
      u.pathname = '/' + name;
      return u.href;
    };
  const owner = createDatabase(url(0), { max: 2, statementTimeoutMs: 120000 }),
    db = createDatabase(url(1)),
    identityDb = createDatabase(url(2), { max: 5 }),
    workerDb = createDatabase(url(1), { max: 5 });
  const sockets: WebSocket[] = [];
  let app: ReturnType<typeof createApp> | undefined,
    stop = false,
    pump: Promise<void> | undefined,
    notificationPump: Promise<void> | undefined,
    sampler: Promise<void> | undefined;
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();
  const started = new Date().toISOString(),
    cpu = process.cpuUsage();
  let peakRss = process.memoryUsage().rss,
    maximumLockWaiters = 0,
    maximumPending = 0,
    maximumNotificationPending = 0,
    queueAgeMs = 0,
    workerFailures = 0;
  const errors: Record<string, number> = {},
    error = (name: string) => {
      errors[name] = (errors[name] ?? 0) + 1;
    };
  try {
    await sql.raw('create database "' + name + '"').execute(management);
    await migrateToLatest(owner);
    for (const [index, kind] of [
      [1, 'application'],
      [2, 'identity'],
    ] as const)
      await bootstrapDevelopmentRole(owner, {
        environment: 'test',
        role: urls[index]!.username,
        password: decodeURIComponent(urls[index]!.password),
        kind,
      });
    const f = await tenantFixture(owner),
      secret = 'capacity-isolated-local-secret-longer-than-thirty-two-characters',
      origin = 'http://capacity.imbox.test';
    const messaging = createMessagingService(db, secret),
      sync = createSyncService({ db, cursorSecret: secret }),
      processor = createOutboxProcessor({ db: workerDb });
    const historyChats: Awaited<ReturnType<typeof messaging.createConversation>>[] = [];
    process.stdout.write(JSON.stringify({ stage: 'seeding_history', messages: history }) + '\n');
    for (let i = 0; i < 10; i++) {
      const chat = await messaging.createConversation(
        f.alice,
        {
          workspace_id: f.workspaceId,
          kind: 'group',
          title: 'History ' + i,
          member_ids: [f.bob.principalId],
          history_policy: 'all',
        },
        randomUUID(),
      );
      historyChats.push(chat);
      const count = Math.floor(history / 10) + (i < history % 10 ? 1 : 0);
      if (count)
        await withTenant(owner, f.tenantId, async (tx) => {
          await sql`insert into messages(tenant_id,id,conversation_id,sender_principal_id,seq,body,client_message_id,deleted_at) select ${f.tenantId},gen_random_uuid(),${chat.id},${f.alice.principalId},n,case when n%100=0 then '' else '历史 History message '||n::text end,gen_random_uuid(),case when n%100=0 then clock_timestamp() else null end from generate_series(1,${count}) n`.execute(
            tx,
          );
          await sql`update conversations set message_head_seq=${count} where id=${chat.id}`.execute(
            tx,
          );
        });
    }
    await sql`analyze messages`.execute(owner);
    const historyReads: number[] = [];
    for (let i = 0; i < 30; i++) {
      const before = performance.now();
      await messaging.listMessages(f.bob, historyChats[i % 10]!.id, { limit: 100 });
      historyReads.push(performance.now() - before);
    }
    const firstHistory = await withTenant(db, f.tenantId, (tx) =>
      tx
        .selectFrom('messages')
        .select('id')
        .where('conversation_id', '=', historyChats[0]!.id)
        .where('deleted_at', 'is', null)
        .limit(1)
        .executeTakeFirstOrThrow(),
    );
    const notificationPlan = await measureNotificationSourceLookup(
      db,
      f.tenantId,
      'message',
      firstHistory.id,
    );
    // This fixture is explicit about 50 streams in one workspace and two distinct authenticated actors.
    const streams: Awaited<ReturnType<typeof messaging.createConversation>>[] = [];
    for (let i = 0; i < 50; i++)
      streams.push(
        await messaging.createConversation(
          f.alice,
          {
            workspace_id: f.workspaceId,
            kind: 'group',
            title: 'Live ' + i,
            member_ids: [f.bob.principalId],
            history_policy: 'all',
          },
          randomUUID(),
        ),
      );
    for (let i = 0; i < 20; i++) {
      const batch = await processor.processBatch(f.tenantId);
      if (!batch.claimed) break;
    }
    const identity = createIdentityService({
      db,
      identityDb,
      publicOrigin: origin,
      sessionSecret: secret,
      environment: 'test',
      enableDevAuth: true,
      devPrincipalIds: [...f.ids],
    });
    const sender = await identity.devLogin({ principalId: f.alice.principalId, origin }),
      recipient = await identity.devLogin({ principalId: f.bob.principalId, origin });
    const streamRecipients = new Map(
      streams.map((stream, index) => [
        stream.id,
        Math.floor(connections / 50) + (index < connections % 50 ? 1 : 0),
      ]),
    );
    let expectedDeliveries = 0;
    const committed = new Map<string, number>(),
      visible: number[] = [],
      seen = new Set<string>(),
      save: number[] = [];
    let duplicateDeliveries = 0,
      subscribed = 0,
      closedDuringLoad = 0;
    app = createApp({
      identity,
      sync,
      messaging: {
        ...messaging,
        async createMessage(...args: Parameters<typeof messaging.createMessage>) {
          const result = await messaging.createMessage(...args);
          if (!committed.has(result.id)) expectedDeliveries += streamRecipients.get(args[1]) ?? 0;
          committed.set(result.id, performance.now());
          return result;
        },
      },
      readiness: async () => {},
    });
    app.addHook('onError', async (_request, _reply, failure) => {
      const code = typeof failure.code === 'string' ? failure.code : failure.name;
      error('server_' + (/^[A-Za-z0-9_]{1,64}$/.test(code) ? code : 'unclassified'));
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    pump = (async () => {
      while (!stop) {
        const stats = await processor.processBatch(f.tenantId);
        workerFailures += stats.failed;
        if (!stats.claimed) await delay(10);
      }
    })();
    const dispatchNotifications = createNotificationDispatcher({ db: workerDb });
    notificationPump = (async () => {
      while (!stop) {
        try {
          await dispatchNotifications(f.tenantId);
        } catch {
          workerFailures++;
          error('notification_dispatch');
        }
        await delay(250);
      }
    })();
    sampler = (async () => {
      while (!stop) {
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
        await withTenant(owner, f.tenantId, async (tx) => {
          const row = (
            await sql<{
              pending: string;
              notification_pending: string;
              age_ms: string;
              locks: string;
            }>`select (select count(*) from notification_event_queue where status<>'completed')::text notification_pending,(select count(*) from outbox where target like 'conversation:%' and status<>'completed')::text pending,(select coalesce(extract(epoch from clock_timestamp()-min(created_at))*1000,0) from outbox where target like 'conversation:%' and status<>'completed')::text age_ms,(select count(*) from pg_stat_activity where datname=current_database() and wait_event_type='Lock')::text locks`.execute(
              tx,
            )
          ).rows[0]!;
          maximumPending = Math.max(maximumPending, Number(row.pending));
          maximumNotificationPending = Math.max(
            maximumNotificationPending,
            Number(row.notification_pending),
          );
          queueAgeMs = Math.max(queueAgeMs, Number(row.age_ms));
          maximumLockWaiters = Math.max(maximumLockWaiters, Number(row.locks));
        });
        await delay(1000);
      }
    })();
    const cursors: string[] = [];
    for (const stream of streams)
      cursors.push((await sync.snapshot(f.bob, stream.id, { limit: 100 })).cursor);
    process.stdout.write(JSON.stringify({ stage: 'connecting', requested: connections }) + '\n');
    async function connect(index: number) {
      await new Promise<void>((resolve) => {
        const stream = streams[index % 50]!,
          socket = new WebSocket(
            address.replace('http:', 'ws:') + '/v1/ws?tenant_id=' + f.tenantId,
            { headers: { origin, cookie: 'imbox_session=' + recipient.token } },
          );
        sockets.push(socket);
        let settled = false;
        const finish = () => {
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              resolve();
            }
          },
          timeout = setTimeout(() => {
            error('connection_timeout');
            socket.terminate();
            finish();
          }, 20000);
        socket.on('open', () =>
          socket.send(
            JSON.stringify({ type: 'hello', protocol_version: 1, client_id: randomUUID() }),
          ),
        );
        socket.on('message', (data) => {
          const frame = JSON.parse(data.toString()) as {
            type: string;
            nonce?: string;
            stream_id?: string;
            cursor?: string;
            payload?: { message?: { id: string } };
          };
          if (frame.type === 'welcome')
            socket.send(
              JSON.stringify({
                type: 'subscribe',
                stream_id: stream.id,
                cursor: cursors[index % 50],
              }),
            );
          if (frame.type === 'subscribed') {
            subscribed++;
            finish();
          }
          if (frame.type === 'ping')
            socket.send(JSON.stringify({ type: 'pong', nonce: frame.nonce }));
          if (frame.type === 'projection.upsert' || frame.type === 'projection.remove') {
            const id = frame.payload?.message?.id;
            if (id && committed.has(id)) {
              const key = index + ':' + id;
              if (seen.has(key)) duplicateDeliveries++;
              else {
                seen.add(key);
                visible.push(performance.now() - committed.get(id)!);
              }
            }
            socket.send(
              JSON.stringify({ type: 'ack', stream_id: frame.stream_id, cursor: frame.cursor }),
            );
          }
          if (frame.type === 'access_revoked' || frame.type === 'resync_required')
            error(frame.type);
        });
        socket.on('error', () => {
          error('socket_error');
          finish();
        });
        socket.on('close', () => {
          if (!stop) closedDuringLoad++;
          finish();
        });
      });
    }
    for (let start = 0; start < connections; start += 50)
      await Promise.all(
        Array.from({ length: Math.min(50, connections - start) }, (_, i) => connect(start + i)),
      );
    const loadedAt = performance.now();
    let saved = 0;
    const flights: Promise<void>[] = [];
    process.stdout.write(
      JSON.stringify({ stage: 'sending', connections: subscribed, rate, seconds }) + '\n',
    );
    for (let i = 0; i < rate * seconds; i++) {
      const expected = loadedAt + (i * 1000) / rate;
      await delay(Math.max(0, expected - performance.now()));
      const before = performance.now();
      const operation = fetch(address + '/v1/conversations/' + streams[i % 50]!.id + '/messages', {
        method: 'POST',
        headers: {
          cookie: 'imbox_session=' + sender.token,
          origin,
          'x-imbox-tenant-id': f.tenantId,
          'x-csrf-token': sender.csrfToken,
          'idempotency-key': randomUUID(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ body: 'Load probe ' + i, client_message_id: randomUUID() }),
        signal: AbortSignal.timeout(20000),
      })
        .then(async (response) => {
          await response.arrayBuffer();
          if (response.status === 201) {
            saved++;
            save.push(performance.now() - before);
          } else error('http_' + response.status);
        })
        .catch(() => error('http_transport'));
      flights.push(operation);
    }
    await Promise.all(flights);
    const sendElapsed = performance.now() - loadedAt;
    // Observe the full recipient denominator, not only the fastest delivered sample.
    const drainStarted = performance.now();
    const drainDeadline = drainStarted + 60_000;
    while (seen.size < expectedDeliveries && performance.now() < drainDeadline) await delay(250);
    const drainElapsed = performance.now() - drainStarted;
    // Reconnection to 1,000 incremental facts is a separate scenario, not asserted by this probe.
    const report = {
      version: 2,
      started_at: started,
      finished_at: new Date().toISOString(),
      fixture: {
        historical_messages: history,
        history_conversations: 10,
        history_bulk_seeded: true,
        live_streams: 50,
        workspaces: 1,
        distinct_actors: 2,
        requested_connections: connections,
        subscribed_connections: subscribed,
        requested_message_rate: rate,
        duration_seconds: seconds,
      },
      environment: {
        logical_cpus: cpus().length,
        host_memory_gib: Math.round((totalmem() / 1024 ** 3) * 100) / 100,
        node: process.version,
        api_processes: 1,
        worker_loops: 2,
        application_pool: 10,
        identity_pool: 5,
        worker_pool: 5,
        network: 'host loopback; PostgreSQL Docker; shared development host',
      },
      results: {
        notification_source_plan: notificationPlan,
        saved_messages: saved,
        committed_messages: committed.size,
        expected_recipient_deliveries: expectedDeliveries,
        observed_recipient_deliveries: seen.size,
        missing_recipient_deliveries: Math.max(0, expectedDeliveries - seen.size),
        drain_elapsed_ms: Math.round(drainElapsed),
        drain_deadline_ms: 60_000,
        delivery_latency_complete: seen.size === expectedDeliveries,
        delivery_latency_censored: seen.size < expectedDeliveries,
        offered_messages: rate * seconds,
        achieved_save_rate: saved / (sendElapsed / 1000),
        save_http_ms: { p50: percentile(save, 0.5), p95: percentile(save, 0.95) },
        history_page_ms: {
          p50: percentile(historyReads, 0.5),
          p95: percentile(historyReads, 0.95),
        },
        commit_return_to_ws_receive_ms: {
          p50: percentile(visible, 0.5),
          p95: percentile(visible, 0.95),
          samples: visible.length,
        },
        duplicate_deliveries: duplicateDeliveries,
        closed_during_load: closedDuringLoad,
        errors,
        maximum_pending_conversation_outbox: maximumPending,
        maximum_pending_notification_events: maximumNotificationPending,
        maximum_queue_age_ms: queueAgeMs,
        maximum_lock_waiters: maximumLockWaiters,
        worker_failures: workerFailures,
        peak_process_rss_mib: peakRss / 1024 ** 2,
        event_loop_p95_ms: lag.percentile(95) / 1e6,
        cpu_usage: process.cpuUsage(cpu),
      },
      design_environment_equivalent: false,
      reconnect_storm_verified: false,
      slow_model_and_file_contention_verified: false,
      production_capacity_claim: false,
    };
    await mkdir('.artifacts', { recursive: true });
    await writeFile('.artifacts/capacity-probe.json', JSON.stringify(report, null, 2) + '\n', {
      mode: 0o600,
    });
    process.stdout.write(JSON.stringify(report) + '\n');
    return report;
  } finally {
    stop = true;
    for (const socket of sockets) socket.terminate();
    await Promise.allSettled(
      [pump, notificationPump, sampler].filter((p): p is Promise<void> => !!p),
    );
    app?.server.closeAllConnections();
    if (app) await app.close();
    lag.disable();
    await Promise.all([db.destroy(), identityDb.destroy(), workerDb.destroy(), owner.destroy()]);
    for (let i = 0; i < 50; i++) {
      const row = (
        await sql<{
          n: string;
        }>`select count(*)::text n from pg_stat_activity where datname=${name}`.execute(management)
      ).rows[0]!;
      if (row.n === '0') break;
      await delay(50);
    }
    await sql.raw('drop database if exists "' + name + '"').execute(management);
    await management.destroy();
  }
}
if (process.argv[1]?.endsWith('capacity-probe.ts'))
  runCapacityProbe().catch((error) => {
    process.stderr.write(
      JSON.stringify({
        stage: 'failed',
        name: error instanceof Error ? error.name : 'Unknown',
        code:
          typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : undefined,
      }) + '\n',
    );
    process.exitCode = 1;
  });
