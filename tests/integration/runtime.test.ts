import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createRuntimeService,
  createRuntimeWorker,
  runtimeCompletionGate,
  type RuntimeService,
  type RuntimeWorker,
  type CreateRunInput,
} from '@imbox/runtime';
import { createMessagingService, type MessagingService } from '@imbox/application';
import { assertContract } from '@imbox/contracts';
import { createIdentityService, registerAuthRoutes } from '@imbox/auth';
import { assertRuntimeRole, sql, withTenant } from '@imbox/db';
import { createApp } from '../../apps/api/src/app.js';
import { registerRuntimeRoutes } from '../../apps/api/src/runtime-routes.js';
import { tenantFixture, testDatabases } from '../helpers/database.js';
import { withRuntimeTransaction as runtimeTransaction } from '@imbox/runtime';
let databases: Awaited<ReturnType<typeof testDatabases>>;
let fixture: Awaited<ReturnType<typeof tenantFixture>>;
let runtime: RuntimeService;
let worker: RuntimeWorker;
let messaging: MessagingService;
let agentPrincipal: string;
let installationId: string;
const key = () => randomUUID();
const secret = 'runtime-test-secret-longer-than-thirty-two-characters';
beforeAll(async () => {
  databases = await testDatabases();
});
afterAll(async () => {
  await databases?.close();
});
beforeEach(async () => {
  fixture = await tenantFixture(databases.owner);
  runtime = createRuntimeService({ db: databases.db });
  worker = createRuntimeWorker({ db: databases.db, workerId: 'trusted-runtime-worker' });
  messaging = createMessagingService(databases.db, secret);
  agentPrincipal = key();
  await databases.identityDb
    .insertInto('principals')
    .values({ id: agentPrincipal, kind: 'agent', display_name: 'Test Agent' })
    .execute();
  await withTenant(databases.owner, fixture.tenantId, async (tx) => {
    await tx
      .insertInto('tenant_principals')
      .values({ tenant_id: fixture.tenantId, principal_id: agentPrincipal, role: 'agent' })
      .execute();
    await tx
      .insertInto('memberships')
      .values({
        tenant_id: fixture.tenantId,
        workspace_id: fixture.workspaceId,
        principal_id: agentPrincipal,
        role: 'member',
      })
      .execute();
  });
  installationId = (
    await runtime.installAgent(
      fixture.alice,
      {
        principal_id: agentPrincipal,
        revision: '1',
        mode: 'hosted',
        config: { provider: 'test-adapter-not-implemented' },
        capabilities: ['conversation_reply'],
      },
      key(),
    )
  ).id;
});
async function conversation() {
  return messaging.createConversation(
    fixture.alice,
    {
      workspace_id: fixture.workspaceId,
      kind: 'group',
      title: 'Agent chat',
      member_ids: [agentPrincipal, fixture.bob.principalId],
      history_policy: 'all',
    },
    key(),
  );
}
async function task(parentId?: string, limit = '100') {
  const id = key();
  return withTenant(databases.owner, fixture.tenantId, async (tx) => {
    const parent = parentId
      ? await tx
          .selectFrom('tasks')
          .selectAll()
          .where('id', '=', parentId)
          .executeTakeFirstOrThrow()
      : null;
    await tx
      .insertInto('tasks')
      .values({
        tenant_id: fixture.tenantId,
        id,
        root_task_id: parent?.root_task_id ?? id,
        parent_task_id: parentId ?? null,
        workspace_id: fixture.workspaceId,
        owner_principal_id: fixture.alice.principalId,
        accountable_principal_id: fixture.alice.principalId,
        created_by: fixture.alice.principalId,
        title: 'Runtime task',
        goal: 'Work within explicit scope',
        acceptance_criteria: {},
        reviewer_ids: sql`${JSON.stringify([fixture.alice.principalId])}::jsonb`,
      })
      .execute();
    await tx
      .insertInto('task_participants')
      .values([
        {
          tenant_id: fixture.tenantId,
          task_id: id,
          principal_id: fixture.alice.principalId,
          role: 'owner',
        },
        {
          tenant_id: fixture.tenantId,
          task_id: id,
          principal_id: agentPrincipal,
          role: 'contributor',
        },
      ])
      .execute();
    await sql`insert into task_budgets(tenant_id,task_id,currency,limit_microunits) values(${fixture.tenantId},${id},'USD',${limit})`.execute(
      tx,
    );
    return id;
  });
}
const input = (
  scope: { task_id: string } | { conversation_id: string },
  context: CreateRunInput['context'] = [],
  limit = '100',
): CreateRunInput => ({
  agent_id: installationId,
  agent_revision: '1',
  ...scope,
  context,
  purpose: 'Explicitly authorized work',
  destination: 'platform:model',
  budget: { currency: 'USD', limit_microunits: limit },
});
async function start(
  scope: { task_id: string } | { conversation_id: string },
  context: CreateRunInput['context'] = [],
  limit = '100',
) {
  const run = await runtime.createRun(fixture.alice, input(scope, context, limit), key());
  const claim = await worker.claim(fixture.tenantId, run.id);
  expect(claim).not.toBeNull();
  return { run, claim: claim! };
}

describe('durable runtime identity, leases and context', () => {
  it('rejects owner credentials, binds immutable agent revisions, and creates an idempotent task-free conversation run', async () => {
    await expect(assertRuntimeRole(databases.owner)).rejects.toThrow('Runtime database role');
    await assertRuntimeRole(databases.db);
    await assertRuntimeRole(databases.identityDb);
    const chat = await conversation();
    const body = input({ conversation_id: chat.id });
    const requestKey = key();
    const runs = await Promise.all([
      runtime.createRun(fixture.alice, body, requestKey),
      runtime.createRun(fixture.alice, body, requestKey),
    ]);
    expect(runs[0]!.id).toBe(runs[1]!.id);
    expect(runs[0]!.task_id).toBeNull();
    await expect(
      runtime.installAgent(
        fixture.alice,
        {
          principal_id: agentPrincipal,
          revision: '1',
          mode: 'hosted',
          config: { provider: 'changed' },
          capabilities: [],
        },
        key(),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const claimed = await worker.claim(fixture.tenantId, runs[0]!.id);
    const report = {
      status: 'completed' as const,
      checkpoint: { delivered: true },
      output: 'Verified worker result',
    };
    const reportKey = key();
    const reports = await Promise.all([
      worker.report(claimed!, report, reportKey),
      worker.report(claimed!, report, reportKey),
    ]);
    expect(reports.map((row) => row.status)).toEqual(['completed', 'completed']);
    expect(
      await withTenant(databases.db, fixture.tenantId, (tx) =>
        sql`select * from run_checkpoints where run_id=${runs[0]!.id}`.execute(tx),
      ),
    ).toMatchObject({ rows: expect.any(Array) });
  });
  it('scans hosted durable candidates and exposes only the fixed execution revision and explicit manifest', async () => {
    const chat = await conversation();
    const body = input({ conversation_id: chat.id });
    const run = await runtime.createRun(fixture.alice, body, key());
    expect(await worker.listRunnable(fixture.tenantId)).toContain(run.id);
    const claim = await worker.claim(fixture.tenantId, run.id);
    expect(await worker.listRunnable(fixture.tenantId)).not.toContain(run.id);
    expect(await worker.getExecution(claim!)).toMatchObject({
      agent_revision: '1',
      mode: 'hosted',
      config: { provider: 'test-adapter-not-implemented' },
      manifest: { purpose: body.purpose, destination: body.destination },
      items: [],
      budget: { currency: 'USD', limit_microunits: '100' },
    });
  });
  it('rejects heartbeat/report after expiry even before takeover, increments generation on recovery, and rejects the old holder', async () => {
    const chat = await conversation();
    const { run, claim } = await start({ conversation_id: chat.id });
    await withTenant(databases.owner, fixture.tenantId, (tx) =>
      sql`update agent_runs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${run.id}`.execute(
        tx,
      ),
    );
    await expect(worker.heartbeat(claim)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(
      worker.report(claim, { status: 'completed', checkpoint: {} }, key()),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const next = createRuntimeWorker({ db: databases.db, workerId: 'replacement-worker' });
    const replacement = await next.claim(fixture.tenantId, run.id);
    expect(BigInt(replacement!.generation)).toBe(BigInt(claim.generation) + 1n);
    await expect(
      worker.report(claim, { status: 'running', checkpoint: {} }, key()),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(next.heartbeat(replacement!)).resolves.toHaveProperty('expires_at');
  });
  it('invalidates old runs after an ancestor closes and reopens, and checks all ancestor deadlines', async () => {
    const root = await task();
    const child = await task(root);
    const { run, claim } = await start({ task_id: child });
    await withTenant(databases.owner, fixture.tenantId, (tx) =>
      sql`update tasks set status='cancelled',execution_epoch=execution_epoch+1 where id=${root}`.execute(
        tx,
      ),
    );
    await expect(
      worker.reserve(claim, { reservation_key: key(), amount_microunits: '1', currency: 'USD' }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await withTenant(databases.owner, fixture.tenantId, (tx) =>
      sql`update tasks set status='active',execution_epoch=execution_epoch+1 where id=${root}`.execute(
        tx,
      ),
    );
    await expect(
      worker.report(claim, { status: 'completed', checkpoint: {} }, key()),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const fresh = await runtime.createRun(fixture.alice, input({ task_id: child }), key());
    await withTenant(databases.owner, fixture.tenantId, (tx) =>
      sql`update tasks set execution_deadline=clock_timestamp()-interval '1 second' where id=${root}`.execute(
        tx,
      ),
    );
    await expect(worker.claim(fixture.tenantId, fresh.id)).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    expect((await runtime.getRun(fixture.alice, run.id)).status).toBe('running');
  });
  it('captures only explicit source versions/hashes and refuses context use/submission after source revocation', async () => {
    const chat = await conversation();
    const message = await messaging.createMessage(
      fixture.alice,
      chat.id,
      { client_message_id: key(), body: 'Explicit input' },
      key(),
    );
    const { run, claim } = await start({ conversation_id: chat.id }, [
      { type: 'message', id: message.id, version: '1', required: true },
    ]);
    const manifest = await runtime.getContextManifest(fixture.alice, run.id);
    expect(manifest.items).toHaveLength(1);
    expect(manifest.items[0]).toMatchObject({
      source_version: '1',
      trust_level: 'untrusted_user_content',
      payload: { body: 'Explicit input' },
    });
    expect((await worker.getContext(claim)).items).toHaveLength(1);
    await messaging.changeMember(
      fixture.alice,
      chat.id,
      agentPrincipal,
      'remove',
      chat.version,
      key(),
    );
    await expect(
      worker.report(
        claim,
        { status: 'completed', checkpoint: {}, output: 'Must not publish' },
        key(),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(runtime.getContextManifest(fixture.alice, run.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it('rejects private task input in conversation runs, oversized context and stale source versions without persisting partial runs', async () => {
    const chat = await conversation();
    const privateTask = await task();
    const message = await messaging.createMessage(
      fixture.alice,
      chat.id,
      { client_message_id: key(), body: 'sensitive payload' },
      key(),
    );
    await expect(
      runtime.createRun(
        fixture.alice,
        input({ conversation_id: chat.id }, [
          { type: 'task', id: privateTask, version: '1', required: true },
        ]),
        key(),
      ),
    ).rejects.toMatchObject({ code: 'DISCLOSURE_DENIED' });
    const constrained = createRuntimeService({ db: databases.db, maxContextBytes: 3 });
    await expect(
      constrained.createRun(
        fixture.alice,
        input({ conversation_id: chat.id }, [
          { type: 'message', id: message.id, version: '1', required: true },
        ]),
        key(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      runtime.createRun(
        fixture.alice,
        input({ conversation_id: chat.id }, [
          { type: 'message', id: message.id, version: '99', required: true },
        ]),
        key(),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const rows = await withTenant(databases.db, fixture.tenantId, (tx) =>
      sql`select id from agent_runs`.execute(tx),
    );
    expect(rows.rows).toEqual([]);
  });
  it('freezes global creator and agent identity revisions so disabling and re-enabling never revives an old run', async () => {
    const chat = await conversation();
    const original = await start({ conversation_id: chat.id });
    await databases.identityDb
      .updateTable('principals')
      .set({ status: 'disabled', version: sql`version+1` })
      .where('id', '=', fixture.alice.principalId)
      .execute();
    await expect(worker.heartbeat(original.claim)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await databases.identityDb
      .updateTable('principals')
      .set({ status: 'active', version: sql`version+1` })
      .where('id', '=', fixture.alice.principalId)
      .execute();
    await expect(
      worker.report(original.claim, { status: 'completed', checkpoint: {} }, key()),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const fresh = await start({ conversation_id: chat.id });
    await databases.identityDb
      .updateTable('principals')
      .set({ status: 'disabled', version: sql`version+1` })
      .where('id', '=', agentPrincipal)
      .execute();
    await expect(worker.heartbeat(fresh.claim)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await databases.identityDb
      .updateTable('principals')
      .set({ status: 'active', version: sql`version+1` })
      .where('id', '=', agentPrincipal)
      .execute();
    await expect(worker.heartbeat(fresh.claim)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('rejects prior task participation after removal and reinvitation even with current tenant membership', async () => {
    const root = await task();
    const { claim } = await start({ task_id: root });
    await withTenant(databases.owner, fixture.tenantId, (tx) =>
      sql`update task_participants set status='removed',version=version+1 where task_id=${root} and principal_id=${agentPrincipal}`.execute(
        tx,
      ),
    );
    await expect(worker.heartbeat(claim)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await withTenant(databases.owner, fixture.tenantId, (tx) =>
      sql`update task_participants set status='active',version=version+1 where task_id=${root} and principal_id=${agentPrincipal}`.execute(
        tx,
      ),
    );
    await expect(worker.heartbeat(claim)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('withholds previously generated output when a separate context source is later revoked', async () => {
    const root = await task();
    const chat = await conversation();
    const message = await messaging.createMessage(
      fixture.alice,
      chat.id,
      { client_message_id: key(), body: 'Confidential source' },
      key(),
    );
    const { run, claim } = await start({ task_id: root }, [
      { type: 'message', id: message.id, version: '1', required: true },
    ]);
    await worker.report(
      claim,
      { status: 'completed', checkpoint: {}, output: 'Derived confidential content' },
      key(),
    );
    await messaging.changeMember(
      fixture.alice,
      chat.id,
      agentPrincipal,
      'remove',
      chat.version,
      key(),
    );
    await expect(runtime.getRun(fixture.alice, run.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it('persists pause/checkpoint/resume and requires an explicit worker cancellation acknowledgement', async () => {
    const chat = await conversation();
    const { run, claim } = await start({ conversation_id: chat.id });
    const running = await runtime.getRun(fixture.alice, run.id);
    const requested = await runtime.controlRun(
      fixture.alice,
      run.id,
      'pause',
      running.version,
      key(),
    );
    expect(requested.pause_requested).toBe(true);
    expect(requested.status).toBe('running');
    const paused = await worker.report(
      claim,
      { status: 'paused', checkpoint: { next_step: 2 } },
      key(),
    );
    expect(paused.status).toBe('paused');
    const resumed = await runtime.controlRun(
      fixture.alice,
      run.id,
      'resume',
      paused.version,
      key(),
    );
    expect(resumed.status).toBe('queued');
    const next = await worker.claim(fixture.tenantId, run.id);
    const current = await runtime.getRun(fixture.alice, run.id);
    const cancelled = await runtime.controlRun(
      fixture.alice,
      run.id,
      'cancel',
      current.version,
      key(),
    );
    expect(cancelled.status).toBe('cancelling');
    const repeated = await runtime.controlRun(
      fixture.alice,
      run.id,
      'cancel',
      cancelled.version,
      key(),
    );
    expect(repeated.status).toBe('cancelling');
    expect((await worker.heartbeat(next!)).cancellation_requested).toBe(true);
    expect(
      (await worker.report(next!, { status: 'cancelled', checkpoint: { stopped: true } }, key()))
        .status,
    ).toBe('cancelled');
  });
});

describe('atomic root-shared budget and late accounting facts', () => {
  it('concurrent child reservations share the root limit without double counting usage', async () => {
    const root = await task(undefined, '100');
    const a = await task(root, '80');
    const b = await task(root, '80');
    const left = await start({ task_id: a });
    const right = await start({ task_id: b });
    const results = await Promise.allSettled([
      worker.reserve(left.claim, {
        reservation_key: 'left',
        amount_microunits: '70',
        currency: 'USD',
      }),
      worker.reserve(right.claim, {
        reservation_key: 'right',
        amount_microunits: '70',
        currency: 'USD',
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const reserved = results.find((r) => r.status === 'fulfilled')!;
    if (reserved.status !== 'fulfilled') throw new Error('Missing reservation');
    await worker.settle(fixture.tenantId, reserved.value.id, {
      usage_key: 'provider:one',
      actual_microunits: '60',
      evidence: { receipt: 'r1' },
    });
    await worker.settle(fixture.tenantId, reserved.value.id, {
      usage_key: 'provider:one',
      actual_microunits: '60',
      evidence: { receipt: 'r1' },
    });
    const budgets = await withTenant(databases.db, fixture.tenantId, (tx) =>
      sql<{
        task_id: string;
        reserved_microunits: string;
        spent_microunits: string;
      }>`select * from task_budgets`.execute(tx),
    );
    expect(budgets.rows.find((row) => row.task_id === root)).toMatchObject({
      reserved_microunits: '0',
      spent_microunits: '60',
    });
    expect(
      (
        await withTenant(databases.db, fixture.tenantId, (tx) =>
          sql`select * from runtime_usage_records`.execute(tx),
        )
      ).rows,
    ).toHaveLength(1);
  });
  it('retains unknown reservations, refuses unproven release, and records overspend after task cancellation', async () => {
    const root = await task(undefined, '100');
    const { claim } = await start({ task_id: root });
    const reservation = await worker.reserve(claim, {
      reservation_key: 'model-step-1',
      amount_microunits: '40',
      currency: 'USD',
    });
    const replay = await worker.reserve(claim, {
      reservation_key: 'model-step-1',
      amount_microunits: '40',
      currency: 'USD',
    });
    expect(replay.id).toBe(reservation.id);
    expect(replay.newly_reserved).toBe(false);
    await worker.markUnknown(fixture.tenantId, reservation.id);
    await expect(
      worker.release(fixture.tenantId, reservation.id, {
        confirmed_no_charge: false,
        reference: 'timeout',
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(
      worker.reserve(claim, { reservation_key: 'step-2', amount_microunits: '1', currency: 'USD' }),
    ).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    await withTenant(databases.owner, fixture.tenantId, (tx) =>
      sql`update tasks set status='cancelled',execution_epoch=execution_epoch+1 where id=${root}`.execute(
        tx,
      ),
    );
    await worker.settle(fixture.tenantId, reservation.id, {
      usage_key: 'provider:late',
      actual_microunits: '140',
      evidence: { invoice: 'actual-cost' },
    });
    const budget = (
      await withTenant(databases.db, fixture.tenantId, (tx) =>
        sql`select * from task_budgets where task_id=${root}`.execute(tx),
      )
    ).rows[0];
    expect(budget).toMatchObject({
      reserved_microunits: '0',
      spent_microunits: '140',
      blocked: true,
      overrun_microunits: '40',
    });
    await withTenant(databases.owner, fixture.tenantId, (tx) =>
      sql`update tasks set status='active',execution_epoch=execution_epoch+1 where id=${root}`.execute(
        tx,
      ),
    );
    const fresh = await start({ task_id: root });
    await expect(
      worker.reserve(fresh.claim, {
        reservation_key: 'after-overrun',
        amount_microunits: '1',
        currency: 'USD',
      }),
    ).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
  });
  it('gates completion on live runs and unresolved accounting across the complete task subtree', async () => {
    const root = await task();
    const child = await task(root);
    const { claim } = await start({ task_id: child });
    const gate = () =>
      withTenant(databases.db, fixture.tenantId, (tx) => runtimeCompletionGate(tx, root));
    expect(await gate()).toBe(false);
    const reserved = await worker.reserve(claim, {
      reservation_key: 'pending-cost',
      amount_microunits: '10',
      currency: 'USD',
    });
    await expect(
      worker.report(claim, { status: 'completed', checkpoint: {} }, key()),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await worker.settle(fixture.tenantId, reserved.id, {
      usage_key: 'model:complete',
      actual_microunits: '10',
      evidence: { receipt: 'complete' },
    });
    expect(await gate()).toBe(false);
    await worker.report(claim, { status: 'completed', checkpoint: {} }, key());
    expect(await gate()).toBe(true);
  });
  it('atomically persists usage and a result checkpoint, then resumes after a crash without dispatching again', async () => {
    const chat = await conversation();
    const { run, claim } = await start({ conversation_id: chat.id });
    const reserved = await worker.reserve(claim, {
      reservation_key: 'model:1',
      amount_microunits: '20',
      currency: 'USD',
    });
    const usage = {
      usage_key: 'model:receipt:1',
      actual_microunits: '12',
      evidence: { receipt: 'provider-result' },
    };
    const checkpoint = { model_step: { result: 'Durable actual model output' } };
    await Promise.all([
      worker.completeStep(claim, reserved.id, usage, checkpoint),
      worker.completeStep(claim, reserved.id, usage, checkpoint),
    ]);
    expect((await worker.getExecution(claim)).latest_checkpoint).toMatchObject({
      seq: '1',
      payload: checkpoint,
    });
    await withTenant(databases.owner, fixture.tenantId, (tx) =>
      sql`update agent_runs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${run.id}`.execute(
        tx,
      ),
    );
    const replacement = createRuntimeWorker({ db: databases.db, workerId: 'recover-model-worker' });
    const next = await replacement.claim(fixture.tenantId, run.id);
    expect(next).not.toBeNull();
    expect((await replacement.getExecution(next!)).latest_checkpoint?.payload).toEqual(checkpoint);
    expect(
      (
        await replacement.reserve(next!, {
          reservation_key: 'model:1',
          amount_microunits: '20',
          currency: 'USD',
        })
      ).newly_reserved,
    ).toBe(false);
    await replacement.report(
      next!,
      { status: 'completed', checkpoint, output: checkpoint.model_step.result },
      key(),
    );
    const usageRows = await withTenant(databases.db, fixture.tenantId, (tx) =>
      sql`select * from runtime_usage_records where reservation_id=${reserved.id}`.execute(tx),
    );
    expect(usageRows.rows).toHaveLength(1);
  });
  it('refuses expired result checkpoints while accepting the late accounting fact separately', async () => {
    const chat = await conversation();
    const { run, claim } = await start({ conversation_id: chat.id });
    const reserved = await worker.reserve(claim, {
      reservation_key: 'model:expired',
      amount_microunits: '20',
      currency: 'USD',
    });
    const usage = {
      usage_key: 'model:late:1',
      actual_microunits: '10',
      evidence: { receipt: 'actual-late' },
    };
    await withTenant(databases.owner, fixture.tenantId, (tx) =>
      sql`update agent_runs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${run.id}`.execute(
        tx,
      ),
    );
    await expect(
      worker.completeStep(claim, reserved.id, usage, { model_step: { result: 'Expired output' } }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await worker.settle(fixture.tenantId, reserved.id, usage);
    expect(
      (
        await withTenant(databases.db, fixture.tenantId, (tx) =>
          sql`select * from run_checkpoints where run_id=${run.id}`.execute(tx),
        )
      ).rows,
    ).toHaveLength(0);
  });
  it('does not blindly reclaim a crashed model step with outstanding usage', async () => {
    const chat = await conversation();
    const { run, claim } = await start({ conversation_id: chat.id });
    const reserved = await worker.reserve(claim, {
      reservation_key: 'step',
      amount_microunits: '20',
      currency: 'USD',
    });
    await withTenant(databases.owner, fixture.tenantId, (tx) =>
      sql`update agent_runs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${run.id}`.execute(
        tx,
      ),
    );
    const replacement = createRuntimeWorker({ db: databases.db, workerId: 'replacement-worker' });
    expect(await replacement.claim(fixture.tenantId, run.id)).toBeNull();
    expect((await runtime.getRun(fixture.alice, run.id)).status).toBe('waiting_dependency');
    await worker.release(fixture.tenantId, reserved.id, {
      confirmed_no_charge: true,
      reference: 'provider-confirmed-not-accepted',
    });
    const current = await runtime.getRun(fixture.alice, run.id);
    await runtime.controlRun(fixture.alice, run.id, 'resume', current.version, key());
    expect(await replacement.claim(fixture.tenantId, run.id)).not.toBeNull();
  });
});

it('exposes only human authorization/control routes; worker completion and budget writes have no public endpoint', async () => {
  const chat = await conversation();
  const identity = createIdentityService({
    db: databases.db,
    identityDb: databases.identityDb,
    publicOrigin: 'http://runtime.test',
    sessionSecret: secret,
    environment: 'test',
    enableDevAuth: true,
    devPrincipalIds: [fixture.alice.principalId],
  });
  const app = createApp({ readiness: async () => {} });
  app.register(async (scope) => {
    await registerAuthRoutes(scope, { identity });
    await registerRuntimeRoutes(scope, { identity, runtime });
  });
  await app.ready();
  try {
    const session = await identity.devLogin({
      principalId: fixture.alice.principalId,
      origin: 'http://runtime.test',
    });
    const headers = {
      origin: 'http://runtime.test',
      cookie: `imbox_session=${session.token}`,
      'x-imbox-tenant-id': fixture.tenantId,
      'x-csrf-token': session.csrfToken,
      'idempotency-key': key(),
    };
    const sourceMessage = await messaging.createMessage(
      fixture.alice,
      chat.id,
      { client_message_id: key(), body: 'Fixed context source' },
      key(),
    );
    const created = await app.inject({
      method: 'POST',
      url: '/v1/agent-runs',
      headers,
      payload: input({ conversation_id: chat.id }, [
        { type: 'message', id: sourceMessage.id, version: sourceMessage.version, required: true },
      ]),
    });
    expect(created.statusCode).toBe(201);
    const runId = created.json().id;
    const manifest = await app.inject({
      method: 'GET',
      url: `/v1/agent-runs/${runId}/context-manifest`,
      headers,
    });
    expect(manifest.statusCode).toBe(200);
    const dto = assertContract('RuntimeContextManifest', manifest.json());
    expect(dto.items[0]?.payload.body).toBe('Fixed context source');
    expect(dto.items[0]).not.toHaveProperty('tenant_id');
    expect(dto.items[0]).not.toHaveProperty('manifest_id');
    for (const path of ['claim', 'heartbeat', 'report', 'reserve', 'settle'])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/v1/agent-runs/${runId}/${path}`,
            headers,
            payload: { status: 'completed' },
          })
        ).statusCode,
      ).toBe(404);
  } finally {
    await app.close();
  }
});

it('retries a real PostgreSQL deadlock without duplicating committed transaction writes', async () => {
  const left = await conversation();
  const right = await conversation();
  let arrivals = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const attempts = [0, 0];
  const update = (a: string, b: string, index: number) =>
    runtimeTransaction(databases.db, fixture.tenantId, async (tx) => {
      attempts[index] = attempts[index]! + 1;
      await sql`update conversations set version=version+1 where id=${a}`.execute(tx);
      if (attempts[index] === 1) {
        arrivals++;
        if (arrivals === 2) release();
        await ready;
      }
      await sql`update conversations set version=version+1 where id=${b}`.execute(tx);
    });
  await Promise.all([update(left.id, right.id, 0), update(right.id, left.id, 1)]);
  expect(attempts.reduce((a, b) => a + b, 0)).toBe(3);
  const rows = await withTenant(databases.db, fixture.tenantId, (tx) =>
    tx
      .selectFrom('conversations')
      .select('version')
      .where('id', 'in', [left.id, right.id])
      .execute(),
  );
  expect(rows.map((row) => row.version)).toEqual(['3', '3']);
});

describe('bounded V1 execution', () => {
  it('serializes concurrent claims across the entire root tree and releases a slot on terminal report', async () => {
    const root = await task();
    const child = await task(root);
    const runs = [];
    for (let i = 0; i < 5; i++)
      runs.push(
        await runtime.createRun(fixture.alice, input({ task_id: i % 2 ? child : root }), key()),
      );
    const claims = await Promise.allSettled(runs.map((r) => worker.claim(fixture.tenantId, r.id)));
    const granted = claims.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []));
    expect(granted).toHaveLength(4);
    expect(claims.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const blocked = runs[claims.findIndex((r) => r.status === 'rejected')]!;
    await worker.report(granted[0]!, { status: 'completed', checkpoint: {} }, key());
    expect(await worker.claim(fixture.tenantId, blocked.id)).not.toBeNull();
  });
  it('bounds zero-cost invocations and durable progress steps without blocking final completion', async () => {
    const chat = await conversation();
    const { run, claim } = await start({ conversation_id: chat.id });
    for (let i = 0; i < 20; i++) {
      const reservation = await worker.reserve(claim, {
        reservation_key: `bounded-${i}`,
        amount_microunits: '0',
        currency: 'USD',
      });
      await worker.release(fixture.tenantId, reservation.id, {
        confirmed_no_charge: true,
        reference: `not-sent:${i}`,
      });
      await worker.report(claim, { status: 'running', checkpoint: { step: i } }, key());
    }
    await expect(
      worker.reserve(claim, { reservation_key: 'excess', amount_microunits: '0', currency: 'USD' }),
    ).rejects.toMatchObject({ code: 'STEP_LIMIT_EXCEEDED' });
    await expect(
      worker.report(claim, { status: 'running', checkpoint: { step: 21 } }, key()),
    ).rejects.toMatchObject({ code: 'STEP_LIMIT_EXCEEDED' });
    expect(
      (
        await worker.report(
          claim,
          { status: 'completed', checkpoint: {}, output: 'Bounded work complete' },
          key(),
        )
      ).status,
    ).toBe('completed');
    expect((await runtime.getRun(fixture.alice, run.id)).budget.spent_microunits).toBe('0');
  });
  it('does not renew an execution beyond its absolute lifetime even when its lease is current', async () => {
    const chat = await conversation();
    const { run, claim } = await start({ conversation_id: chat.id });
    await withTenant(databases.owner, fixture.tenantId, (tx) =>
      sql`update agent_runs set created_at=clock_timestamp()-interval '25 hours' where id=${run.id}`.execute(
        tx,
      ),
    );
    await expect(worker.heartbeat(claim)).rejects.toMatchObject({ code: 'EXECUTION_EXPIRED' });
    await expect(
      worker.reserve(claim, {
        reservation_key: 'expired',
        amount_microunits: '0',
        currency: 'USD',
      }),
    ).rejects.toMatchObject({ code: 'EXECUTION_EXPIRED' });
  });
});

it('paginates authorized run history with cursors bound to the current scope', async () => {
  const first = await conversation();
  const second = await conversation();
  const ids = [];
  for (let i = 0; i < 3; i++)
    ids.push(
      (await runtime.createRun(fixture.alice, input({ conversation_id: first.id }), key())).id,
    );
  const page = await runtime.listRuns(fixture.alice, { conversation_id: first.id }, { limit: 2 });
  expect(page.items).toHaveLength(2);
  expect(page.next_cursor).toBeTruthy();
  const tail = await runtime.listRuns(
    fixture.alice,
    { conversation_id: first.id },
    { limit: 2, cursor: page.next_cursor! },
  );
  expect(tail.items).toHaveLength(1);
  expect(new Set([...page.items, ...tail.items].map((r) => r.id))).toEqual(new Set(ids));
  await expect(
    runtime.listRuns(fixture.alice, { conversation_id: second.id }, { cursor: page.next_cursor! }),
  ).rejects.toMatchObject({ code: 'RESYNC_REQUIRED' });
  expect((await runtime.listRuns(fixture.bob, { conversation_id: first.id })).items).toEqual([]);
});
