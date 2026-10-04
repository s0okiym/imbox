import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createIdentityService } from '@imbox/auth';
import { assertContract } from '@imbox/contracts';
import { sql, withTenant } from '@imbox/db';
import { createRuntimeService, createRuntimeWorker, type RuntimeService } from '@imbox/runtime';
import {
  createSchedulingService,
  type SchedulingService,
  type CreateScheduleInput,
} from '@imbox/scheduling';
import { createApp } from '../../apps/api/src/app.js';
import { tenantFixture, testDatabases } from '../helpers/database.js';

const secret = 'scheduling-integration-secret-longer-than-thirty-two-characters';
let databases: Awaited<ReturnType<typeof testDatabases>>;
let fixture: Awaited<ReturnType<typeof tenantFixture>>;
let runtime: RuntimeService;
let schedules: SchedulingService;
let agentPrincipal: string, installationId: string, taskId: string, runId: string;
beforeAll(async () => {
  databases = await testDatabases();
});
afterAll(async () => {
  await databases?.close();
});
beforeEach(async () => {
  fixture = await tenantFixture(databases.owner);
  runtime = createRuntimeService({ db: databases.db });
  schedules = createSchedulingService({ db: databases.db, cursorSecret: secret });
  agentPrincipal = randomUUID();
  await databases.identityDb
    .insertInto('principals')
    .values({ id: agentPrincipal, kind: 'agent', display_name: 'Scheduled agent' })
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
        config: { provider: 'not-invoked' },
        capabilities: ['task_work'],
      },
      randomUUID(),
    )
  ).id;
  taskId = await makeTask();
  runId = await makePausedRun(taskId);
});
async function makeTask(parent?: string): Promise<string> {
  const id = randomUUID();
  await withTenant(databases.owner, fixture.tenantId, async (tx) => {
    await tx
      .insertInto('tasks')
      .values({
        tenant_id: fixture.tenantId,
        id,
        root_task_id: parent ?? id,
        parent_task_id: parent ?? null,
        workspace_id: fixture.workspaceId,
        owner_principal_id: fixture.alice.principalId,
        accountable_principal_id: fixture.alice.principalId,
        created_by: fixture.alice.principalId,
        title: 'Scheduled work',
        goal: 'Continue the authorized work',
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
    await sql`insert into task_budgets(tenant_id,task_id,currency,limit_microunits) values(${fixture.tenantId},${id},'USD',100)`.execute(
      tx,
    );
  });
  return id;
}
async function makePausedRun(task: string): Promise<string> {
  const run = await runtime.createRun(
    fixture.alice,
    {
      agent_id: installationId,
      agent_revision: '1',
      task_id: task,
      context: [],
      purpose: 'Explicit finite schedule',
      destination: 'platform:model',
      budget: { currency: 'USD', limit_microunits: '100' },
    },
    randomUUID(),
  );
  await runtime.controlRun(fixture.alice, run.id, 'pause', run.version, randomUUID());
  return run.id;
}
const input = (): CreateScheduleInput => ({
  task_id: taskId,
  run_id: runId,
  timezone: 'UTC',
  trigger: { kind: 'once' },
  start_at: new Date(Date.now() + 60_000).toISOString(),
  deadline: new Date(Date.now() + 3_600_000).toISOString(),
  missed_policy: 'coalesce',
  maximum_wakeups: 1,
});
async function makeDue(id: string, seconds = 1): Promise<void> {
  await withTenant(databases.owner, fixture.tenantId, (tx) =>
    sql`update schedules set start_at=clock_timestamp()-${seconds}*interval '1 second',next_at=clock_timestamp()-${seconds}*interval '1 second' where id=${id}`.execute(
      tx,
    ),
  );
}
const status = async () =>
  (
    await withTenant(databases.db, fixture.tenantId, (tx) =>
      sql<{ status: string }>`select status from agent_runs where id=${runId}`.execute(tx),
    )
  ).rows[0]!.status;

describe('durable bounded schedule dispatch', () => {
  it('creates one occurrence/outbox and one Run wake under simultaneous scanners and dispatchers', async () => {
    const body = input(),
      key = randomUUID();
    const [a, b] = await Promise.all([
      schedules.create(fixture.alice, body, key),
      schedules.create(fixture.alice, body, key),
    ]);
    expect(a.id).toBe(b.id);
    expect(() => assertContract('Schedule', a)).not.toThrow();
    await makeDue(a.id);
    expect(
      (
        await Promise.all(Array.from({ length: 6 }, () => schedules.collectDue(fixture.tenantId)))
      ).reduce((x, y) => x + y, 0),
    ).toBe(1);
    expect(
      (
        await Promise.all(
          Array.from({ length: 6 }, () => schedules.dispatchPending(fixture.tenantId)),
        )
      ).reduce((x, y) => x + y, 0),
    ).toBe(1);
    expect(await status()).toBe('queued');
    expect((await schedules.occurrences(fixture.alice, a.id)).items).toHaveLength(1);
    expect((await schedules.get(fixture.alice, a.id)).status).toBe('completed');
    const facts = await withTenant(databases.db, fixture.tenantId, (tx) =>
      sql<{
        event_type: string;
      }>`select event_type from domain_events e join outbox o on o.tenant_id=e.tenant_id and o.event_id=e.id where aggregate_id in (${a.id},${runId}) and event_type in ('schedule.occurrence_ready','run.schedule_wake')`.execute(
        tx,
      ),
    );
    expect(facts.rows.map((r) => r.event_type).sort()).toEqual([
      'run.schedule_wake',
      'schedule.occurrence_ready',
    ]);
  });
  it('revalidates disabled revision after an occurrence was queued, including a concurrent blocked dispatcher', async () => {
    const schedule = await schedules.create(fixture.alice, input(), randomUUID());
    await makeDue(schedule.id);
    await schedules.collectDue(fixture.tenantId);
    let pending: Promise<number> | undefined;
    await withTenant(databases.owner, fixture.tenantId, async (tx) => {
      await sql`select id from schedules where id=${schedule.id} for update`.execute(tx);
      pending = schedules.dispatchPending(fixture.tenantId);
      await sql`update schedules set status='disabled',revision=revision+1,version=version+1 where id=${schedule.id}`.execute(
        tx,
      );
    });
    expect(await pending).toBe(0);
    expect(await status()).toBe('paused');
    expect((await schedules.occurrences(fixture.alice, schedule.id)).items[0]).toMatchObject({
      status: 'skipped',
      reason: 'schedule_changed',
    });
  });
  it('never trusts client clocks, allows no dispatch before due and enforces a hard deadline', async () => {
    await expect(
      schedules.create(
        fixture.alice,
        { ...input(), deadline: new Date(Date.now() + 2 * 86_400_000).toISOString() },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 400 });
    const schedule = await schedules.create(fixture.alice, input(), randomUUID());
    expect(await schedules.collectDue(fixture.tenantId)).toBe(0);
    expect(await schedules.dispatchPending(fixture.tenantId)).toBe(0);
    await makeDue(schedule.id);
    await schedules.collectDue(fixture.tenantId);
    await withTenant(databases.owner, fixture.tenantId, (tx) =>
      sql`update schedules set start_at=clock_timestamp()-interval '2 minute',deadline=clock_timestamp()-interval '1 minute' where id=${schedule.id}`.execute(
        tx,
      ),
    );
    expect(await schedules.dispatchPending(fixture.tenantId)).toBe(0);
    expect(await status()).toBe('paused');
    expect((await schedules.occurrences(fixture.alice, schedule.id)).items[0]?.reason).toBe(
      'deadline_expired',
    );
  });
  it('persists skip versus coalesce and counts finite occurrence allowance across revisions', async () => {
    const skip = await schedules.create(
      fixture.alice,
      { ...input(), missed_policy: 'skip' },
      randomUUID(),
    );
    await makeDue(skip.id, 120);
    expect(await schedules.collectDue(fixture.tenantId)).toBe(0);
    expect(await schedules.get(fixture.alice, skip.id)).toMatchObject({
      status: 'completed',
      missed_count: 1,
      occurrences_created: 0,
    });
    const coalesce = await schedules.create(fixture.alice, input(), randomUUID());
    await makeDue(coalesce.id, 120);
    expect(await schedules.collectDue(fixture.tenantId)).toBe(1);
    expect(await schedules.dispatchPending(fixture.tenantId)).toBe(1);
    const run = await runtime.getRun(fixture.alice, runId);
    await runtime.controlRun(fixture.alice, runId, 'pause', run.version, randomUUID());
    const current = await schedules.get(fixture.alice, coalesce.id);
    const revised = await schedules.revise(
      fixture.alice,
      coalesce.id,
      { ...input(), enabled: true },
      current.version,
      randomUUID(),
    );
    await makeDue(revised.id);
    expect(await schedules.collectDue(fixture.tenantId)).toBe(0);
    expect((await schedules.get(fixture.alice, coalesce.id)).occurrences_created).toBe(1);
  });
  it('skips overlap without resuming a queued Run or resetting its lifecycle', async () => {
    const schedule = await schedules.create(fixture.alice, input(), randomUUID());
    const paused = await runtime.getRun(fixture.alice, runId);
    await runtime.controlRun(fixture.alice, runId, 'resume', paused.version, randomUUID());
    await makeDue(schedule.id);
    await schedules.collectDue(fixture.tenantId);
    expect(await schedules.dispatchPending(fixture.tenantId)).toBe(0);
    expect((await schedules.occurrences(fixture.alice, schedule.id)).items[0]).toMatchObject({
      status: 'skipped',
      reason: 'overlap',
    });
  });
  it('invalidates descendants after ancestor epoch change before dispatch', async () => {
    const root = taskId;
    taskId = await makeTask(root);
    runId = await makePausedRun(taskId);
    const schedule = await schedules.create(fixture.alice, input(), randomUUID());
    await makeDue(schedule.id);
    await schedules.collectDue(fixture.tenantId);
    await withTenant(databases.owner, fixture.tenantId, (tx) =>
      sql`update tasks set execution_epoch=execution_epoch+1 where id=${root}`.execute(tx),
    );
    expect(await schedules.dispatchPending(fixture.tenantId)).toBe(0);
    expect((await schedules.occurrences(fixture.alice, schedule.id)).items[0]).toMatchObject({
      status: 'denied',
      reason: 'VERSION_CONFLICT',
    });
    expect(await status()).toBe('paused');
  });
  it('denies global identity disable/re-enable and tenant or installation revocation', async () => {
    for (const change of ['global', 'tenant', 'installation'] as const) {
      const schedule = await schedules.create(fixture.alice, input(), randomUUID());
      await makeDue(schedule.id);
      await schedules.collectDue(fixture.tenantId);
      if (change === 'global')
        await databases.identityDb
          .updateTable('principals')
          .set({ version: sql`version+1` })
          .where('id', '=', agentPrincipal)
          .execute();
      else
        await withTenant(databases.owner, fixture.tenantId, (tx) =>
          change === 'tenant'
            ? sql`update tenant_principals set authz_revision=authz_revision+1 where principal_id=${agentPrincipal}`.execute(
                tx,
              )
            : sql`update agent_installations set authz_revision=authz_revision+1 where id=${installationId}`.execute(
                tx,
              ),
        );
      expect(await schedules.dispatchPending(fixture.tenantId)).toBe(0);
      expect((await schedules.occurrences(fixture.alice, schedule.id)).items[0]?.status).toBe(
        'denied',
      );
      runId = await makePausedRun(taskId);
    }
  });
  it('denies held or unknown usage, blocked budgets, exhausted steps and expired Run lifetime', async () => {
    for (const changed of ['usage', 'budget', 'steps', 'lifetime'] as const) {
      const schedule = await schedules.create(fixture.alice, input(), randomUUID());
      await makeDue(schedule.id);
      await schedules.collectDue(fixture.tenantId);
      await withTenant(databases.owner, fixture.tenantId, async (tx) => {
        if (changed === 'usage')
          await sql`insert into runtime_reservations(tenant_id,id,run_id,task_id,root_task_id,reservation_key,account_ids,currency,amount_microunits,status) values(${fixture.tenantId},${randomUUID()},${runId},${taskId},${taskId},'uncertain','[]'::jsonb,'USD',0,'unknown')`.execute(
            tx,
          );
        if (changed === 'budget')
          await sql`update agent_runs set budget_blocked=true where id=${runId}`.execute(tx);
        if (changed === 'steps')
          await sql`update agent_runs set checkpoint_seq=20 where id=${runId}`.execute(tx);
        if (changed === 'lifetime')
          await sql`update agent_runs set created_at=clock_timestamp()-interval '25 hour' where id=${runId}`.execute(
            tx,
          );
      });
      expect(await schedules.dispatchPending(fixture.tenantId)).toBe(0);
      expect((await schedules.occurrences(fixture.alice, schedule.id)).items[0]?.status).toBe(
        'denied',
      );
      runId = await makePausedRun(taskId);
    }
  });
  it('never revives a completed Run and rejects Agent-authored recursive schedules or substituted bindings', async () => {
    const schedule = await schedules.create(fixture.alice, input(), randomUUID());
    await makeDue(schedule.id);
    await schedules.collectDue(fixture.tenantId);
    const paused = await runtime.getRun(fixture.alice, runId);
    await runtime.controlRun(fixture.alice, runId, 'resume', paused.version, randomUUID());
    const worker = createRuntimeWorker({ db: databases.db, workerId: 'schedule-terminal-test' });
    const lease = await worker.claim(fixture.tenantId, runId);
    await worker.report(lease!, { status: 'completed', checkpoint: { done: true } }, randomUUID());
    expect(await schedules.dispatchPending(fixture.tenantId)).toBe(0);
    expect(await status()).toBe('completed');
    await expect(
      schedules.create(
        { ...fixture.alice, principalId: agentPrincipal, kind: 'agent' },
        input(),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(schedules.create(fixture.bob, input(), randomUUID())).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      schedules.create(fixture.alice, { ...input(), task_id: randomUUID() }, randomUUID()),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('enforces tenant RLS and owner-only plan visibility independently of task participation', async () => {
    const schedule = await schedules.create(fixture.alice, input(), randomUUID());
    await expect(schedules.get(fixture.bob, schedule.id)).rejects.toMatchObject({ status: 404 });
    const other = await tenantFixture(databases.owner);
    expect(
      (
        await withTenant(databases.db, other.tenantId, (tx) =>
          sql`select * from schedules where id=${schedule.id}`.execute(tx),
        )
      ).rows,
    ).toEqual([]);
    await expect(schedules.get(other.alice, schedule.id)).rejects.toMatchObject({ status: 404 });
  });
  it('hides Task/Run source identifiers from detail, occurrence history and lists after live ACL revocation', async () => {
    const schedule = await schedules.create(fixture.alice, input(), randomUUID());
    await withTenant(databases.owner, fixture.tenantId, (tx) =>
      sql`update task_participants set status='removed',version=version+1 where task_id=${taskId} and principal_id=${fixture.alice.principalId}`.execute(
        tx,
      ),
    );
    await expect(schedules.get(fixture.alice, schedule.id)).rejects.toMatchObject({ status: 404 });
    await expect(schedules.occurrences(fixture.alice, schedule.id)).rejects.toMatchObject({
      status: 404,
    });
    expect((await schedules.list(fixture.alice)).items).toEqual([]);
  });
  it('validates real HTTP contracts, CSRF/version headers and explicit delete-as-disable', async () => {
    const identity = createIdentityService({
      db: databases.db,
      identityDb: databases.identityDb,
      publicOrigin: 'http://schedules.test',
      sessionSecret: secret,
      environment: 'test',
      enableDevAuth: true,
      devPrincipalIds: [fixture.alice.principalId],
    });
    const app = createApp({ identity, scheduling: schedules, readiness: async () => {} });
    const failures: string[] = [];
    app.addHook('onError', async (_request, _reply, error) => {
      failures.push(error.message);
    });
    await app.ready();
    try {
      const session = await identity.devLogin({
        principalId: fixture.alice.principalId,
        origin: 'http://schedules.test',
      });
      const headers = {
        origin: 'http://schedules.test',
        cookie: `imbox_session=${session.token}`,
        'x-imbox-tenant-id': fixture.tenantId,
        'x-csrf-token': session.csrfToken,
        'idempotency-key': randomUUID(),
      };
      const response = await app.inject({
        method: 'POST',
        url: '/v1/schedules',
        headers,
        payload: input(),
      });
      expect(response.statusCode, `${response.body}; ${failures.join('; ')}`).toBe(201);
      const schedule = response.json<{ id: string; version: string }>();
      expect(response.headers.etag).toBe(`"${schedule.version}"`);
      expect(
        (await app.inject({ method: 'GET', url: '/v1/schedules?limit=10', headers })).statusCode,
      ).toBe(400);
      expect((await app.inject({ method: 'GET', url: '/v1/schedules', headers })).statusCode).toBe(
        200,
      );
      expect(
        (await app.inject({ method: 'DELETE', url: `/v1/schedules/${schedule.id}`, headers }))
          .statusCode,
      ).toBe(400);
      const disabled = await app.inject({
        method: 'DELETE',
        url: `/v1/schedules/${schedule.id}`,
        headers: {
          ...headers,
          'idempotency-key': randomUUID(),
          'if-match': `"${schedule.version}"`,
        },
      });
      expect(disabled.statusCode, disabled.body).toBe(200);
      expect(disabled.json().status).toBe('disabled');
    } finally {
      await app.close();
    }
  });
});
