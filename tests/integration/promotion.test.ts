import { createIdentityService } from '@imbox/auth';
import { createApp } from '../../apps/api/src/app.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { createTaskService } from '@imbox/application';
import { runtimePromotionPort } from '@imbox/runtime';
import { sql, withTenant } from '@imbox/db';
import type { ContractTypes as C } from '@imbox/contracts';
import { modelFixture } from '../helpers/model.js';
import { testDatabases } from '../helpers/database.js';
let db: Awaited<ReturnType<typeof testDatabases>>, f: Awaited<ReturnType<typeof modelFixture>>;
const secret = 'run-promotion-integration-secret-longer-than-thirty-two-characters';
const key = () => randomUUID();
const tasks = () => createTaskService(db.db, secret, { promotion: runtimePromotionPort() });
beforeAll(async () => {
  db = await testDatabases();
});
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  f = await modelFixture(db);
  await f.messaging.changeMember(
    f.alice,
    f.chat.id,
    f.bob.principalId,
    'add',
    f.chat.version,
    key(),
  );
});
const input = (): C['PromoteRunInput'] => ({
  confirm_new_authorization: true,
  task: {
    workspace_id: f.workspaceId,
    title: 'New authorized target',
    goal: 'Explicitly continue this work under a separate task',
    acceptance_criteria: ['Human checks the fixed result'],
    reviewer_principal_ids: [f.bob.principalId],
    budget: { currency: 'USD', limit_microunits: '100' },
  },
});
async function completed() {
  const run = await f.createRun();
  const claim = await f.worker.claim(f.tenantId, run.id);
  await f.worker.report(
    claim!,
    { status: 'completed', checkpoint: {}, output: 'A preliminary answer' },
    key(),
  );
  return f.runtime.getRun(f.alice, run.id);
}
describe('conversation Run promotion creates new authority without rewriting history', () => {
  it('atomically promotes once, preserves the original scope/budget and requires fresh Agent access for continuation', async () => {
    const original = await completed(),
      body = input(),
      token = key();
    const [a, b] = await Promise.all([
      tasks().promoteRun(f.alice, original.id, body, original.version, token),
      tasks().promoteRun(f.alice, original.id, body, original.version, token),
    ]);
    expect(a.id).toBe(b.id);
    expect(a.owner_principal_id).toBe(f.alice.principalId);
    expect(a.budget.limit_microunits).toBe('100');
    expect(a.goal).not.toContain('A preliminary answer');
    const before = await f.runtime.getRun(f.alice, original.id);
    expect(before).toEqual(original);
    expect(before.task_id).toBeNull();
    expect(before.budget.limit_microunits).toBe('0');
    expect(await tasks().runOrigin(f.alice, a.id)).toMatchObject({
      access: 'available',
      run_id: original.id,
      run_version: original.version,
      conversation_id: f.chat.id,
    });
    expect(await tasks().runOrigin(f.bob, a.id)).toEqual({ access: 'restricted' });
    const nextInput = {
      agent_id: f.installation.id,
      agent_revision: '1',
      task_id: a.id,
      previous_run_id: original.id,
      context: [],
      purpose: 'New task authority',
      destination: 'model:local',
      budget: { currency: 'USD', limit_microunits: '10' },
    };
    await expect(f.runtime.createRun(f.alice, nextInput, key())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await tasks().changeParticipant(f.alice, a.id, f.agentId, 'contributor', a.version, key());
    const next = await f.runtime.createRun(f.alice, nextInput, key());
    expect(next.task_id).toBe(a.id);
    expect(next.conversation_id).toBeNull();
    expect(next.id).not.toBe(original.id);
    await withTenant(db.db, f.tenantId, async (tx) => {
      expect((await sql`select 1 from task_run_origins`.execute(tx)).rows).toHaveLength(1);
      expect(
        (
          await sql`select 1 from domain_events where event_type='task.promoted_from_run'`.execute(
            tx,
          )
        ).rows,
      ).toHaveLength(1);
    });
  });
  it('serializes distinct promotion commands for the same original Run', async () => {
    const r = await completed();
    const results = await Promise.allSettled([
      tasks().promoteRun(f.alice, r.id, input(), r.version, key()),
      tasks().promoteRun(f.alice, r.id, input(), r.version, key()),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((x) => x.status === 'rejected')).toHaveLength(1);
    await withTenant(db.db, f.tenantId, async (tx) =>
      expect((await sql`select 1 from tasks`.execute(tx)).rows).toHaveLength(1),
    );
  });
  it('does not promote an unfinished run, stale version, other actor or expanded reviewer audience', async () => {
    const queued = await f.createRun();
    await expect(
      tasks().promoteRun(f.alice, queued.id, input(), queued.version, key()),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const r = await completed();
    await expect(tasks().promoteRun(f.alice, r.id, input(), '1', key())).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    await expect(tasks().promoteRun(f.bob, r.id, input(), r.version, key())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const wider = input();
    wider.task.reviewer_principal_ids = [f.charlie.principalId];
    await expect(tasks().promoteRun(f.alice, r.id, wider, r.version, key())).rejects.toMatchObject({
      code: 'DISCLOSURE_DENIED',
    });
    await withTenant(db.db, f.tenantId, async (tx) =>
      expect((await sql`select 1 from tasks`.execute(tx)).rows).toHaveLength(0),
    );
  });
  it('rechecks original sources on replay and hides origin metadata when access is revoked', async () => {
    const r = await completed(),
      body = input(),
      token = key();
    const t = await tasks().promoteRun(f.alice, r.id, body, r.version, token);
    await f.messaging.changeMessage(f.alice, f.message.id, null, f.message.version, key());
    expect(await tasks().runOrigin(f.alice, t.id)).toEqual({ access: 'restricted' });
    await expect(tasks().promoteRun(f.alice, r.id, body, r.version, token)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect((await tasks().getTask(f.alice, t.id)).title).toBe(body.task.title);
  });
});

it('exposes promotion and origin through strict HTTP contracts with fresh explicit authorization', async () => {
  const original = await completed(),
    origin = 'http://promotion.test';
  const identity = createIdentityService({
    db: db.db,
    identityDb: db.identityDb,
    sessionSecret: secret,
    publicOrigin: origin,
    environment: 'test',
    enableDevAuth: true,
    devPrincipalIds: [f.alice.principalId],
  });
  const app = createApp({
    identity,
    tasks: tasks(),
    runtime: f.runtime,
    readiness: async () => {},
  });
  try {
    const session = await identity.devLogin({ principalId: f.alice.principalId, origin });
    const headers = {
      origin,
      cookie: `imbox_session=${session.token}`,
      'x-csrf-token': session.csrfToken,
      'x-imbox-tenant-id': f.tenantId,
      'idempotency-key': key(),
      'if-match': `"${original.version}"`,
    };
    const response = await app.inject({
      method: 'POST',
      url: `/v1/agent-runs/${original.id}/promote`,
      headers,
      payload: input(),
    });
    expect(response.statusCode, response.body).toBe(201);
    const task = response.json<C['Task']>();
    expect(response.headers.etag).toBe(`"${task.version}"`);
    const recorded = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${task.id}/run-origin`,
      headers,
    });
    expect(recorded.statusCode, recorded.body).toBe(200);
    expect(recorded.json()).toMatchObject({ access: 'available', run_id: original.id });
    const forged = await app.inject({
      method: 'POST',
      url: `/v1/agent-runs/${original.id}/promote`,
      headers,
      payload: { ...input(), actor: f.bob.principalId },
    });
    expect(forged.statusCode).toBe(400);
  } finally {
    await app.close();
  }
});
