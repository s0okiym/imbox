import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  allocateMessageSequence,
  allocateStreamSequence,
  createDatabase,
  migrateToLatest,
  withTenant,
  type TenantTransaction,
} from '../src/index.js';
import { bootstrapDevelopmentRole } from '../src/testing.js';
import { tenantTableNames } from '../src/migrations/001-foundation.js';
import { synchronizationTableNames } from '../src/migrations/003-synchronization.js';
import { taskTableNames } from '../src/migrations/004-tasks.js';
import { runtimeTableNames } from '../src/migrations/006-runtime.js';
import { actionTableNames } from '../src/migrations/008-actions.js';

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
if (!ownerUrl || !appUrl)
  throw new Error(
    'Real PostgreSQL integration tests require TEST_DATABASE_URL and TEST_APP_DATABASE_URL; this suite cannot be silently skipped.',
  );
const owner = createDatabase(ownerUrl, { applicationName: 'imbox-db-test-owner' });
const app = createDatabase(appUrl, { applicationName: 'imbox-db-test-app', max: 8 });
const singleConnection = createDatabase(appUrl, {
  applicationName: 'imbox-db-test-reused',
  max: 1,
});
const tenantA = randomUUID();
const tenantB = randomUUID();
const alice = randomUUID();
const bob = randomUUID();
const conversationA = randomUUID();
const conversationB = randomUUID();
const streamId = randomUUID();

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function untilLockWait(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await sql<{ count: string }>`select count(*)::text as count from pg_stat_activity
      where application_name = 'imbox-db-test-app' and wait_event_type = 'Lock'`.execute(owner);
    if (result.rows[0]?.count !== '0') return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('Expected concurrent transaction to block on a stream row lock');
}

async function appendDelivery(transaction: TenantTransaction, sequence: string): Promise<void> {
  const eventId = randomUUID();
  const projectionId = randomUUID();
  await transaction
    .insertInto('domain_events')
    .values({
      tenant_id: tenantA,
      id: eventId,
      aggregate_type: 'message',
      aggregate_id: projectionId,
      aggregate_version: '1',
      event_type: 'message.created',
      actor_principal_id: alice,
      payload: { body: `message-${sequence}` },
    })
    .execute();
  await transaction
    .insertInto('projections')
    .values({
      tenant_id: tenantA,
      stream_id: streamId,
      id: projectionId,
      revision: '1',
      entity_type: 'message',
      entity_id: projectionId,
      entity_version: '1',
      authz_generation: '1',
      dto: { body: `message-${sequence}` },
    })
    .execute();
  await transaction
    .insertInto('projection_deliveries')
    .values({
      tenant_id: tenantA,
      stream_id: streamId,
      delivery_seq: sequence,
      projection_id: projectionId,
      revision: '1',
      event_id: eventId,
      authz_generation: '1',
      dto: { body: `message-${sequence}` },
    })
    .execute();
}

beforeAll(async () => {
  await migrateToLatest(owner);
  const credentials = new URL(appUrl);
  await bootstrapDevelopmentRole(owner, {
    environment: 'test',
    role: decodeURIComponent(credentials.username),
    password: decodeURIComponent(credentials.password),
  });
  await owner
    .insertInto('principals')
    .values([
      { id: alice, kind: 'human', display_name: 'Alice' },
      { id: bob, kind: 'human', display_name: 'Bob' },
    ])
    .execute();
  for (const [tenantId, principalId, conversationId] of [
    [tenantA, alice, conversationA],
    [tenantB, bob, conversationB],
  ] as const) {
    await withTenant(owner, tenantId, async (transaction) => {
      await transaction.insertInto('tenants').values({ id: tenantId, name: tenantId }).execute();
      await transaction
        .insertInto('tenant_principals')
        .values({ tenant_id: tenantId, principal_id: principalId, role: 'owner' })
        .execute();
      await transaction
        .insertInto('conversations')
        .values({
          tenant_id: tenantId,
          id: conversationId,
          kind: 'group',
          title: tenantId,
          created_by: principalId,
        })
        .execute();
    });
  }
  await withTenant(app, tenantA, async (transaction) => {
    await transaction
      .insertInto('projection_streams')
      .values({
        tenant_id: tenantA,
        id: streamId,
        scope_type: 'conversation',
        scope_id: conversationA,
      })
      .execute();
  });
}, 30_000);

afterAll(async () => {
  await Promise.all([owner.destroy(), app.destroy(), singleConnection.destroy()]);
});

describe('PostgreSQL isolation and persistence invariants', () => {
  it('runs migrations idempotently and forces RLS on every tenant table', async () => {
    expect(await migrateToLatest(owner)).toEqual([]);
    const tables = await sql<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>`
      select relname, relrowsecurity, relforcerowsecurity from pg_class
      where relnamespace = current_schema()::regnamespace and relkind = 'r'
    `.execute(owner);
    for (const table of [
      ...tenantTableNames,
      ...synchronizationTableNames,
      ...taskTableNames,
      ...runtimeTableNames,
      ...actionTableNames,
    ]) {
      expect(
        tables.rows.find((row) => row.relname === table),
        table,
      ).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    }
    const role = await sql<{
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`.execute(app);
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const ownership = await sql<{ count: string }>`select count(*)::text as count from pg_class
      where relnamespace = current_schema()::regnamespace and relowner = (select oid from pg_roles where rolname = current_user)`.execute(
      app,
    );
    expect(ownership.rows[0]?.count).toBe('0');
  });

  it('fails closed without tenant context and never grants credential reads to application role', async () => {
    expect(await app.selectFrom('conversations').selectAll().execute()).toEqual([]);
    await expect(
      app
        .insertInto('conversations')
        .values({
          tenant_id: tenantA,
          id: randomUUID(),
          kind: 'group',
          title: 'forbidden',
          created_by: alice,
        })
        .execute(),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(app.selectFrom('sessions').selectAll().execute()).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('resets transaction-local tenant context on a reused pool connection after commit and rollback', async () => {
    const first = await withTenant(singleConnection, tenantA, (transaction) =>
      transaction.selectFrom('conversations').select('id').execute(),
    );
    expect(first.map((row) => row.id)).toEqual([conversationA]);
    expect(await singleConnection.selectFrom('conversations').select('id').execute()).toEqual([]);
    await expect(
      withTenant(singleConnection, tenantB, async (transaction) => {
        expect(
          (await transaction.selectFrom('conversations').select('id').execute()).map(
            (row) => row.id,
          ),
        ).toEqual([conversationB]);
        throw new Error('abort transaction');
      }),
    ).rejects.toThrow('abort transaction');
    expect(await singleConnection.selectFrom('conversations').select('id').execute()).toEqual([]);
    expect(
      (
        await withTenant(singleConnection, tenantA, (transaction) =>
          transaction.selectFrom('conversations').select('id').execute(),
        )
      ).map((row) => row.id),
    ).toEqual([conversationA]);
  });

  it('rejects cross-tenant writes and composite FK references even when UUIDs are known', async () => {
    await expect(
      withTenant(app, tenantA, (transaction) =>
        transaction
          .insertInto('conversations')
          .values({
            tenant_id: tenantB,
            id: randomUUID(),
            kind: 'group',
            title: 'forbidden',
            created_by: bob,
          })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      withTenant(app, tenantA, (transaction) =>
        transaction
          .insertInto('messages')
          .values({
            tenant_id: tenantA,
            id: randomUUID(),
            conversation_id: conversationB,
            sender_principal_id: alice,
            seq: '1',
            body: 'cross-tenant',
          })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      withTenant(app, tenantA, (transaction) =>
        transaction
          .insertInto('conversation_members')
          .values({ tenant_id: tenantA, conversation_id: conversationA, principal_id: bob })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('keeps stream sequence allocation in commit order when the first transaction stalls', async () => {
    const allocated = barrier();
    const release = barrier();
    const first = withTenant(app, tenantA, async (transaction) => {
      const sequence = await allocateStreamSequence(transaction, streamId);
      allocated.resolve();
      await release.promise;
      await appendDelivery(transaction, sequence);
      return sequence;
    });
    await allocated.promise;
    const second = withTenant(app, tenantA, async (transaction) => {
      const sequence = await allocateStreamSequence(transaction, streamId);
      await appendDelivery(transaction, sequence);
      return sequence;
    });
    try {
      await untilLockWait();
      const beforeCommit = await withTenant(app, tenantA, (transaction) =>
        transaction
          .selectFrom('projection_streams')
          .select('head_seq')
          .where('id', '=', streamId)
          .executeTakeFirstOrThrow(),
      );
      expect(beforeCommit.head_seq).toBe('0');
    } finally {
      release.resolve();
    }
    expect(await Promise.all([first, second])).toEqual(['1', '2']);
    const delivered = await withTenant(app, tenantA, (transaction) =>
      transaction
        .selectFrom('projection_deliveries')
        .select('delivery_seq')
        .where('stream_id', '=', streamId)
        .orderBy('delivery_seq')
        .execute(),
    );
    expect(delivered.map((row) => row.delivery_seq)).toEqual(['1', '2']);
  });

  it('rolls back sequence reservations and preserves bigint precision', async () => {
    await expect(
      withTenant(app, tenantA, async (transaction) => {
        await allocateMessageSequence(transaction, conversationA);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(
      await withTenant(app, tenantA, (transaction) =>
        allocateMessageSequence(transaction, conversationA),
      ),
    ).toBe('1');
    await withTenant(app, tenantA, (transaction) =>
      transaction
        .updateTable('conversations')
        .set({ message_head_seq: '9007199254740992' })
        .where('id', '=', conversationA)
        .execute(),
    );
    expect(
      await withTenant(app, tenantA, (transaction) =>
        allocateMessageSequence(transaction, conversationA),
      ),
    ).toBe('9007199254740993');
  });

  it('atomically rolls back business mutation, domain event, and outbox intent', async () => {
    const eventId = randomUUID();
    await expect(
      withTenant(app, tenantA, async (transaction) => {
        await transaction
          .updateTable('conversations')
          .set({ title: 'must rollback' })
          .where('id', '=', conversationA)
          .execute();
        await transaction
          .insertInto('domain_events')
          .values({
            tenant_id: tenantA,
            id: eventId,
            aggregate_type: 'conversation',
            aggregate_id: conversationA,
            aggregate_version: '2',
            event_type: 'conversation.updated',
            actor_principal_id: alice,
            payload: {},
          })
          .execute();
        await transaction
          .insertInto('outbox')
          .values({ tenant_id: tenantA, id: randomUUID(), event_id: eventId, target: 'projector' })
          .execute();
        throw new Error('crash before commit');
      }),
    ).rejects.toThrow('crash before commit');
    await withTenant(app, tenantA, async (transaction) => {
      expect(
        (
          await transaction
            .selectFrom('conversations')
            .select('title')
            .where('id', '=', conversationA)
            .executeTakeFirstOrThrow()
        ).title,
      ).toBe(tenantA);
      expect(
        await transaction
          .selectFrom('domain_events')
          .select('id')
          .where('id', '=', eventId)
          .execute(),
      ).toEqual([]);
      expect(
        await transaction
          .selectFrom('outbox')
          .select('id')
          .where('event_id', '=', eventId)
          .execute(),
      ).toEqual([]);
    });
  });

  it('enforces root ancestry and prevents moving a task tree after creation', async () => {
    const root = randomUUID();
    const otherRoot = randomUUID();
    const child = randomUUID();
    const task = (id: string, rootId: string, parentId: string | null) => ({
      tenant_id: tenantA,
      id,
      root_task_id: rootId,
      parent_task_id: parentId,
      owner_principal_id: alice,
      accountable_principal_id: alice,
      created_by: alice,
      title: id,
      goal: 'test ancestry',
      acceptance_criteria: {},
    });
    await withTenant(app, tenantA, async (transaction) => {
      await transaction
        .insertInto('tasks')
        .values(task(root, root, null))
        .execute();
      await transaction
        .insertInto('tasks')
        .values(task(otherRoot, otherRoot, null))
        .execute();
      await transaction
        .insertInto('tasks')
        .values(task(child, root, root))
        .execute();
    });
    await expect(
      withTenant(app, tenantA, (transaction) =>
        transaction
          .insertInto('tasks')
          .values(task(randomUUID(), otherRoot, child))
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      withTenant(app, tenantA, (transaction) =>
        transaction
          .updateTable('tasks')
          .set({ root_task_id: otherRoot, parent_task_id: otherRoot })
          .where('id', '=', child)
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
