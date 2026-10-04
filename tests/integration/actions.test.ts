import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createActionService,
  createFileJournal,
  createHttpToolRegistry,
  createToolRunner,
  requiredActionsClosed,
  type ActionService,
  type JournalPort,
} from '@imbox/actions';
import { createTaskService, type TaskService } from '@imbox/application';
import { runtimeCompletionGate } from '@imbox/runtime';
import type { ContractTypes as C } from '@imbox/contracts';
import { sql, withTenant } from '@imbox/db';
import { tenantFixture, testDatabases } from '../helpers/database.js';
import { createIdentityService } from '@imbox/auth';
import { createApp } from '../../apps/api/src/app.js';
import { acceptHandoff, proposeHandoff } from '../helpers/handoff.js';
let databases: Awaited<ReturnType<typeof testDatabases>>,
  fixture: Awaited<ReturnType<typeof tenantFixture>>,
  actions: ActionService,
  tasks: TaskService,
  journal: JournalPort;
let task: C['Task'];
let directory: string;
let sideEffects: number;
let attempts: number;
let mode: 'normal' | 'drop' | 'no_effect' | 'hold' = 'normal';
let heldResponse: ServerResponse | undefined;
let effectObserved: Promise<void>;
let observeEffect: () => void;
const cleanup: Array<() => Promise<void>> = [];
const receipts = new Map<
  string,
  {
    status: 'succeeded';
    receipt_id: string;
    fingerprint: string;
    cost_microunits: string;
    safe_retry: boolean;
  }
>();
const secret = 'actions-cursor-test-secret-at-least-thirty-two-characters';
const key = () => randomUUID();
beforeAll(async () => {
  databases = await testDatabases();
});
afterAll(async () => {
  await databases?.close();
});
beforeEach(async () => {
  fixture = await tenantFixture(databases.owner);
  directory = await mkdtemp(join(tmpdir(), 'imbox-action-journal-'));
  journal = await createFileJournal({ directory, signingKey: secret });
  sideEffects = 0;
  attempts = 0;
  mode = 'normal';
  receipts.clear();
  heldResponse = undefined;
  effectObserved = new Promise<void>((resolve) => {
    observeEffect = resolve;
  });
  const send = (response: ServerResponse, value: unknown) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(value));
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    if (request.method === 'GET') {
      send(
        response,
        receipts.get(url.searchParams.get('business_key')!) ?? { status: 'not_found' },
      );
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (part) => (body += part));
    request.on('end', () => {
      const input = JSON.parse(body) as { business_key: string; fingerprint: string };
      attempts++;
      if (mode === 'no_effect' && attempts === 1) {
        send(response, {
          status: 'no_effect',
          receipt_id: key(),
          fingerprint: input.fingerprint,
          cost_microunits: '0',
          safe_retry: true,
        });
        return;
      }
      let receipt = receipts.get(input.business_key);
      if (!receipt) {
        sideEffects++;
        receipt = {
          status: 'succeeded',
          receipt_id: key(),
          fingerprint: input.fingerprint,
          cost_microunits: '7',
          safe_retry: false,
        };
        receipts.set(input.business_key, receipt);
      }
      if (mode === 'hold') {
        heldResponse = response;
        observeEffect();
        return;
      }
      if (mode === 'drop') {
        response.destroy();
        return;
      }
      send(response, receipt);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  actions = createActionService({
    db: databases.db,
    journal,
    cursorSecret: secret,
    tools: createHttpToolRegistry([
      {
        id: 'demo.delivery',
        version: '1',
        targetId: 'demo',
        executeUrl: `${origin}/execute`,
        lookupUrl: `${origin}/lookup`,
        allowInsecureLoopback: true,
        retryDelayMs: 0,
      },
    ]),
  });
  tasks = createTaskService(databases.db, secret, {
    requiredActionsClosed: async (tx, id) =>
      (await runtimeCompletionGate(tx, id)) && (await requiredActionsClosed(tx, id)),
  });
  task = await tasks.createTask(
    fixture.alice,
    {
      workspace_id: fixture.workspaceId,
      title: 'Controlled delivery',
      goal: 'Deliver exactly one approved message',
      acceptance_criteria: ['Receipt confirms the approved version'],
      reviewer_principal_ids: [fixture.alice.principalId],
      budget: { currency: 'USD', limit_microunits: '100' },
    },
    key(),
  );
  task = await tasks.changeParticipant(
    fixture.alice,
    task.id,
    fixture.bob.principalId,
    'contributor',
    task.version,
    key(),
  );
  task = await tasks.changeState(fixture.alice, task.id, { state: 'active' }, task.version, key());
});
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function proposed() {
  const grant = await actions.createGrant(
    fixture.alice,
    {
      task_id: task.id,
      executor_principal_id: fixture.bob.principalId,
      tool_id: 'demo.delivery',
      tool_version: '1',
      target_id: 'demo',
      allow_execute: true,
      allow_disclosure: true,
      resource_versions: [{ type: 'task', id: task.id, version: task.version }],
      approver_principal_ids: [fixture.alice.principalId],
      budget: { currency: 'USD', limit_microunits: '10' },
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    },
    key(),
  );
  const action = await actions.createAction(
    fixture.bob,
    {
      task_id: task.id,
      grant_id: grant.id,
      executor_principal_id: fixture.bob.principalId,
      tool_id: 'demo.delivery',
      tool_version: '1',
      target_id: 'demo',
      parameters: { text: 'A deliberately approved delivery' },
      resource_versions: [{ type: 'task', id: task.id, version: task.version }],
      business_key: key(),
      estimate: { currency: 'USD', limit_microunits: '10' },
    },
    key(),
  );
  return { grant, action };
}
const approve = (action: C['Action']) =>
  actions.decideApproval(
    fixture.alice,
    action.id,
    {
      decision: 'approve',
      action_version: action.approval_binding_version,
      fingerprint: action.fingerprint,
      comment: 'Reviewed exact text and destination',
    },
    action.version,
    key(),
  );
const runner = () => createToolRunner({ actions, workerId: 'test-tool-worker' });

describe('controlled actions with real PostgreSQL, HTTP and independent signed journal', () => {
  it('requires explicit approval, records durable intent before the effect, and settles once', async () => {
    const { action } = await proposed();
    await expect(runner().runOnce(fixture.tenantId, action.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(sideEffects).toBe(0);
    const approved = await approve(action);
    expect(await runner().runOnce(fixture.tenantId, approved.id)).toMatchObject({
      status: 'succeeded',
    });
    expect(sideEffects).toBe(1);
    const records = await journal.records(fixture.tenantId);
    expect(records.filter((row) => row.kind === 'intent')).toHaveLength(1);
    expect(records.filter((row) => row.kind === 'receipt')).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain('A deliberately approved delivery');
    expect(
      await withTenant(databases.db, fixture.tenantId, (tx) => requiredActionsClosed(tx, task.id)),
    ).toBe(true);
    expect(
      (
        await withTenant(databases.db, fixture.tenantId, (tx) =>
          sql`select reserved_microunits,spent_microunits from task_budgets where task_id=${task.id}`.execute(
            tx,
          ),
        )
      ).rows[0],
    ).toEqual({ reserved_microunits: '0', spent_microunits: '7' });
    await expect(runner().runOnce(fixture.tenantId, action.id)).rejects.toBeDefined();
    expect(sideEffects).toBe(1);
  });
  it('retains an unknown result after response loss, queries it, and never resends the business action', async () => {
    mode = 'drop';
    const { action } = await proposed();
    await approve(action);
    expect(await runner().runOnce(fixture.tenantId, action.id)).toMatchObject({
      status: 'unknown',
    });
    expect(sideEffects).toBe(1);
    expect(
      await withTenant(databases.db, fixture.tenantId, (tx) => requiredActionsClosed(tx, task.id)),
    ).toBe(false);
    await expect(runner().runOnce(fixture.tenantId, action.id)).rejects.toBeDefined();
    expect(attempts).toBe(1);
    const unknown = await actions.getAction(fixture.alice, action.id);
    const reconcileKey = key();
    const result = await actions.reconcile(
      fixture.alice,
      action.id,
      { reason: 'Check the recorded business key' },
      unknown.version,
      reconcileKey,
    );
    expect(result.outcome).toBe('succeeded');
    expect(sideEffects).toBe(1);
    expect(attempts).toBe(1);
    expect(
      await actions.reconcile(
        fixture.alice,
        action.id,
        { reason: 'Check the recorded business key' },
        unknown.version,
        reconcileKey,
      ),
    ).toMatchObject({ outcome: 'succeeded' });
    await expect(
      actions.reconcile(
        fixture.alice,
        action.id,
        { reason: 'Different request' },
        unknown.version,
        reconcileKey,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('discloses only explicit same-task action references and rejects omitted or foreign references', async () => {
    const { action } = await proposed();
    expect(await tasks.handoffActions(fixture.alice, task.id)).toEqual({
      task_id: task.id,
      task_version: task.version,
      pending_action_ids: [action.id],
    });
    await expect(tasks.handoffActions(fixture.bob, task.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(tasks.handoffActions(fixture.charlie, task.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      proposeHandoff(tasks, task, fixture.alice, fixture.charlie, []),
    ).rejects.toMatchObject({ code: 'HANDOFF_ACTIONS_CHANGED' });
    await expect(
      proposeHandoff(tasks, task, fixture.alice, fixture.charlie, [key()]),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const other = await tasks.createTask(
      fixture.alice,
      {
        workspace_id: fixture.workspaceId,
        title: 'Separate scope',
        goal: task.goal,
        acceptance_criteria: ['Independent work'],
        reviewer_principal_ids: [fixture.alice.principalId],
        budget: { currency: 'USD', limit_microunits: '100' },
      },
      key(),
    );
    await expect(
      proposeHandoff(tasks, other, fixture.alice, fixture.charlie, [action.id]),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const cancelled = await tasks.cancelTask(
      fixture.alice,
      other.id,
      { reason: 'No work needed' },
      other.version,
      key(),
    );
    await expect(tasks.handoffActions(fixture.charlie, other.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await tasks.handoffActions(fixture.alice, other.id)).toEqual({
      task_id: other.id,
      task_version: cancelled.version,
      pending_action_ids: [],
    });
    const request = await proposeHandoff(tasks, task, fixture.alice, fixture.charlie);
    const disclosed = await tasks.getRequest(fixture.charlie, request.id);
    expect(disclosed.proposal.handoff?.pending_action_ids).toEqual([action.id]);
    expect(JSON.stringify(disclosed)).not.toContain('A deliberately approved delivery');
    await expect(actions.getAction(fixture.charlie, action.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it('refuses oversized outstanding manifests instead of silently dropping action references', async () => {
    const { grant } = await proposed();
    const add = () =>
      actions.createAction(
        fixture.bob,
        {
          task_id: task.id,
          grant_id: grant.id,
          executor_principal_id: fixture.bob.principalId,
          tool_id: 'demo.delivery',
          tool_version: '1',
          target_id: 'demo',
          parameters: { text: 'Bounded pending work' },
          resource_versions: [{ type: 'task', id: task.id, version: task.version }],
          business_key: key(),
          estimate: { currency: 'USD', limit_microunits: '10' },
        },
        key(),
      );
    for (let i = 0; i < 99; i++) await add();
    const snapshot = await tasks.handoffActions(fixture.alice, task.id);
    expect(snapshot.pending_action_ids).toHaveLength(100);
    await add();
    await expect(tasks.handoffActions(fixture.alice, task.id)).rejects.toMatchObject({
      code: 'HANDOFF_ACTIONS_LIMIT',
    });
    await expect(
      proposeHandoff(tasks, task, fixture.alice, fixture.charlie, snapshot.pending_action_ids),
    ).rejects.toMatchObject({ code: 'HANDOFF_ACTIONS_LIMIT' });
    expect((await tasks.getTask(fixture.alice, task.id)).owner_principal_id).toBe(
      fixture.alice.principalId,
    );
    expect(attempts).toBe(0);
  });
  it('requires renewed agreement for actions added after a handoff offer and permits already completed references', async () => {
    const first = await proposed();
    const request = await proposeHandoff(tasks, task, fixture.alice, fixture.charlie);
    const second = await proposed();
    await expect(
      tasks.decideRequest(
        fixture.charlie,
        request.id,
        {
          decision: 'accept',
          proposal_version: request.proposal_version,
          expected_task_version: request.expected_task_version,
        },
        request.version,
        key(),
      ),
    ).rejects.toMatchObject({ code: 'HANDOFF_ACTIONS_CHANGED' });
    expect((await tasks.getTask(fixture.alice, task.id)).owner_principal_id).toBe(
      fixture.alice.principalId,
    );
    expect((await tasks.getRequest(fixture.charlie, request.id)).status).toBe('pending');
    const revised = await tasks.reviseRequest(
      fixture.alice,
      request.id,
      {
        proposal: {
          ...request.proposal,
          handoff: {
            ...request.proposal.handoff!,
            pending_action_ids: [first.action.id, second.action.id],
          },
        },
        expected_task_version: task.version,
        request_expires_at: request.request_expires_at,
      },
      request.version,
      key(),
    );
    await approve(first.action);
    await runner().runOnce(fixture.tenantId, first.action.id);
    expect((await tasks.handoffActions(fixture.alice, task.id)).pending_action_ids).toEqual([
      second.action.id,
    ]);
    await tasks.decideRequest(
      fixture.charlie,
      revised.id,
      {
        decision: 'accept',
        proposal_version: revised.proposal_version,
        expected_task_version: revised.expected_task_version,
      },
      revised.version,
      key(),
    );
    expect((await tasks.getTask(fixture.charlie, task.id)).owner_principal_id).toBe(
      fixture.charlie.principalId,
    );
    expect((await actions.getAction(fixture.charlie, first.action.id)).status).toBe('succeeded');
    expect(attempts).toBe(1);
  });
  it('serializes accepting a handoff against creating newly undisclosed work', async () => {
    const request = await proposeHandoff(tasks, task, fixture.alice, fixture.charlie);
    const outcomes = await Promise.allSettled([
      tasks.decideRequest(
        fixture.charlie,
        request.id,
        {
          decision: 'accept',
          proposal_version: request.proposal_version,
          expected_task_version: request.expected_task_version,
        },
        request.version,
        key(),
      ),
      proposed(),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const current = await tasks.getTask(fixture.alice, task.id);
    expect(current.owner_principal_id).toBe(
      outcomes[0]!.status === 'fulfilled' ? fixture.charlie.principalId : fixture.alice.principalId,
    );
    expect(attempts).toBe(0);
  });
  it('fences a prepared dispatch after real handoff and releases its unused reservation', async () => {
    const { action } = await proposed();
    await approve(action);
    const claim = await actions.claim(fixture.tenantId, action.id, 'old-owner-worker');
    await actions.persistIntent(claim);
    const transferred = await acceptHandoff(tasks, task, fixture.alice, fixture.charlie);
    expect(transferred.owner_principal_id).toBe(fixture.charlie.principalId);
    expect(transferred.accountable_principal_id).toBe(task.accountable_principal_id);
    expect(BigInt(transferred.execution_epoch)).toBe(BigInt(task.execution_epoch) + 1n);
    await expect(actions.dispatch(claim)).rejects.toMatchObject({
      code: 'EXECUTION_FENCE_CONFLICT',
    });
    await actions.abortPrepared(claim);
    expect(attempts).toBe(0);
    expect(sideEffects).toBe(0);
    expect((await actions.getAction(fixture.charlie, action.id)).status).toBe('failed');
    expect(
      (
        await withTenant(databases.db, fixture.tenantId, (tx) =>
          sql`select reserved_microunits,spent_microunits from task_budgets where task_id=${task.id}`.execute(
            tx,
          ),
        )
      ).rows[0],
    ).toEqual({ reserved_microunits: '0', spent_microunits: '0' });
  });
  it('hands off during a committed external effect and lets the new owner reconcile without resending', async () => {
    mode = 'hold';
    const { action } = await proposed();
    await approve(action);
    const execution = runner().runOnce(fixture.tenantId, action.id);
    // Race the actual HTTP effect against early runner failure; no timing sleeps.
    try {
      await Promise.race([
        effectObserved,
        execution.then(() => {
          throw new Error('Execution ended before the held response');
        }),
      ]);
      expect(sideEffects).toBe(1);
      const transferred = await acceptHandoff(tasks, task, fixture.alice, fixture.charlie);
      expect(BigInt(transferred.execution_epoch)).toBe(BigInt(task.execution_epoch) + 1n);
    } finally {
      heldResponse?.destroy();
      await execution;
    }
    expect(await execution).toMatchObject({ status: 'unknown' });
    expect(
      await withTenant(databases.db, fixture.tenantId, (tx) => requiredActionsClosed(tx, task.id)),
    ).toBe(false);
    await expect(runner().runOnce(fixture.tenantId, action.id)).rejects.toBeDefined();
    const unknown = await actions.getAction(fixture.charlie, action.id);
    const reconcileKey = key();
    const reason = { reason: 'New owner checks the inherited business key' };
    expect(
      await actions.reconcile(fixture.charlie, action.id, reason, unknown.version, reconcileKey),
    ).toMatchObject({ outcome: 'succeeded' });
    expect(
      await actions.reconcile(fixture.charlie, action.id, reason, unknown.version, reconcileKey),
    ).toMatchObject({ outcome: 'succeeded' });
    expect(attempts).toBe(1);
    expect(sideEffects).toBe(1);
    expect(
      await withTenant(databases.db, fixture.tenantId, (tx) => requiredActionsClosed(tx, task.id)),
    ).toBe(true);
    expect(
      (
        await withTenant(databases.db, fixture.tenantId, (tx) =>
          sql`select reserved_microunits,spent_microunits from task_budgets where task_id=${task.id}`.execute(
            tx,
          ),
        )
      ).rows[0],
    ).toEqual({ reserved_microunits: '0', spent_microunits: '7' });
  });
  it('retries confirmed no-effect attempts under the same action, fingerprint and business key', async () => {
    mode = 'no_effect';
    const { action } = await proposed();
    await approve(action);
    expect(await runner().runOnce(fixture.tenantId, action.id)).toMatchObject({ status: 'ready' });
    expect(sideEffects).toBe(0);
    expect(await runner().runOnce(fixture.tenantId, action.id)).toMatchObject({
      status: 'succeeded',
    });
    expect(sideEffects).toBe(1);
    expect(attempts).toBe(2);
    const intents = (await journal.records(fixture.tenantId)).filter(
      (row) => row.kind === 'intent',
    );
    expect(intents).toHaveLength(2);
    expect(new Set(intents.map((row) => row.action_id)).size).toBe(1);
    expect(new Set(intents.map((row) => row.business_key)).size).toBe(1);
  });
  it('invalidates old approval after changing parameters and refuses revoked grants before effects', async () => {
    const { action, grant } = await proposed();
    const approved = await approve(action);
    const revised = await actions.reviseAction(
      fixture.bob,
      action.id,
      { parameters: { text: 'Different text' }, resource_versions: action.resource_versions },
      approved.version,
      key(),
    );
    expect(revised.fingerprint).not.toBe(action.fingerprint);
    expect(revised.status).toBe('awaiting_approval');
    await expect(runner().runOnce(fixture.tenantId, action.id)).rejects.toBeDefined();
    await approve(revised);
    await actions.revokeGrant(fixture.alice, grant.id, grant.revision, key());
    await expect(runner().runOnce(fixture.tenantId, action.id)).rejects.toBeDefined();
    expect(sideEffects).toBe(0);
  });
  it('rejects an approved stale task version before claim and permits newly authorized work', async () => {
    const { action } = await proposed();
    await approve(action);
    const previousEpoch = task.execution_epoch;
    task = await tasks.updateTask(
      fixture.alice,
      task.id,
      { title: 'Updated delivery title' },
      task.version,
      key(),
    );
    // A title edit preserves the execution epoch, isolating the resource-version fence.
    expect(task.execution_epoch).toBe(previousEpoch);
    await expect(runner().runOnce(fixture.tenantId, action.id)).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    expect(attempts).toBe(0);
    expect(await journal.records(fixture.tenantId)).toHaveLength(0);
    const fresh = await proposed();
    await approve(fresh.action);
    expect(await runner().runOnce(fixture.tenantId, fresh.action.id)).toMatchObject({
      status: 'succeeded',
    });
    expect(attempts).toBe(1);
    expect(sideEffects).toBe(1);
  });
  it('rechecks the task version after durable intent and releases an unsent reservation', async () => {
    const { action } = await proposed();
    await approve(action);
    const claim = await actions.claim(fixture.tenantId, action.id, 'stale-resource-worker');
    await actions.persistIntent(claim);
    const previousEpoch = task.execution_epoch;
    task = await tasks.updateTask(
      fixture.alice,
      task.id,
      { title: 'Changed after durable intent' },
      task.version,
      key(),
    );
    expect(task.execution_epoch).toBe(previousEpoch);
    await expect(actions.dispatch(claim)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await actions.abortPrepared(claim);
    expect(attempts).toBe(0);
    expect(sideEffects).toBe(0);
    expect((await actions.getAction(fixture.alice, action.id)).status).toBe('failed');
    expect(
      (
        await withTenant(databases.db, fixture.tenantId, (tx) =>
          sql`select reserved_microunits,spent_microunits from task_budgets where task_id=${task.id}`.execute(
            tx,
          ),
        )
      ).rows[0],
    ).toEqual({ reserved_microunits: '0', spent_microunits: '0' });
  });
  it('rejects expired leases even before takeover and retains unresolved attempts', async () => {
    const { action } = await proposed();
    await approve(action);
    const claim = await actions.claim(fixture.tenantId, action.id, 'test-tool-worker');
    await actions.persistIntent(claim);
    await withTenant(databases.owner, fixture.tenantId, (tx) =>
      sql`update actions set lease_expires_at=clock_timestamp()-interval '1 second' where id=${action.id}`.execute(
        tx,
      ),
    );
    await expect(actions.dispatch(claim)).rejects.toMatchObject({ code: 'LEASE_EXPIRED' });
    expect(sideEffects).toBe(0);
    await actions.expireLeases(fixture.tenantId);
    expect((await actions.getAction(fixture.alice, action.id)).status).toBe('unknown');
  });
  it('does not revive a grant or action when a disabled global identity is re-enabled', async () => {
    const { action } = await proposed();
    await approve(action);
    await databases.identityDb
      .updateTable('principals')
      .set({ status: 'disabled', version: sql`version+1` })
      .where('id', '=', fixture.bob.principalId)
      .execute();
    await expect(runner().runOnce(fixture.tenantId, action.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await databases.identityDb
      .updateTable('principals')
      .set({ status: 'active', version: sql`version+1` })
      .where('id', '=', fixture.bob.principalId)
      .execute();
    await expect(runner().runOnce(fixture.tenantId, action.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(sideEffects).toBe(0);
  });
  it('does not revive old authority after task membership removal/reinvitation or epoch changes', async () => {
    const { action } = await proposed();
    await approve(action);
    await withTenant(databases.owner, fixture.tenantId, async (tx) => {
      await sql`update task_participants set status='removed',version=version+1 where task_id=${task.id} and principal_id=${fixture.bob.principalId}`.execute(
        tx,
      );
      await sql`update task_participants set status='active',version=version+1 where task_id=${task.id} and principal_id=${fixture.bob.principalId}`.execute(
        tx,
      );
    });
    await expect(runner().runOnce(fixture.tenantId, action.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(sideEffects).toBe(0);
    const fresh = await proposed();
    await approve(fresh.action);
    await withTenant(databases.owner, fixture.tenantId, (tx) =>
      sql`update tasks set execution_epoch=execution_epoch+1 where id=${task.id}`.execute(tx),
    );
    await expect(runner().runOnce(fixture.tenantId, fresh.action.id)).rejects.toMatchObject({
      code: 'EXECUTION_FENCE_CONFLICT',
    });
    await expect(
      actions.createAction(
        fixture.bob,
        {
          task_id: task.id,
          grant_id: fresh.grant.id,
          executor_principal_id: fixture.bob.principalId,
          tool_id: 'demo.delivery',
          tool_version: '1',
          target_id: 'demo',
          parameters: { text: 'Cannot reuse an old grant' },
          resource_versions: [],
          business_key: key(),
          estimate: { currency: 'USD', limit_microunits: '10' },
        },
        key(),
      ),
    ).rejects.toMatchObject({ code: 'EXECUTION_FENCE_CONFLICT' });
    expect(sideEffects).toBe(0);
  });
  it('rejects an expired approval before opening a network attempt', async () => {
    const { action } = await proposed();
    await approve(action);
    await withTenant(databases.owner, fixture.tenantId, (tx) =>
      sql`update action_approvals set expires_at=clock_timestamp()-interval '1 second' where action_id=${action.id}`.execute(
        tx,
      ),
    );
    await expect(runner().runOnce(fixture.tenantId, action.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(attempts).toBe(0);
  });
  it('deduplicates the same receipt and preserves a conflicting late receipt as an open case', async () => {
    const { action } = await proposed();
    await approve(action);
    const claim = await actions.claim(fixture.tenantId, action.id, 'test-tool-worker');
    await actions.persistIntent(claim);
    const admitted = await actions.dispatch(claim);
    const receipt = await admitted.tool.execute(admitted.call);
    await actions.recordOutcome(claim, receipt);
    await actions.recordOutcome(claim, receipt);
    const count = (
      await withTenant(databases.db, fixture.tenantId, (tx) =>
        sql`select id from action_receipts`.execute(tx),
      )
    ).rows.length;
    expect(count).toBe(1);
    if (receipt.status === 'unknown') throw new Error('Expected confirmed fixture receipt');
    expect(
      await actions.recordOutcome(claim, { ...receipt, actualMicrounits: '99' }),
    ).toMatchObject({ status: 'succeeded', conflict: true });
    expect(
      await withTenant(databases.db, fixture.tenantId, (tx) => requiredActionsClosed(tx, task.id)),
    ).toBe(false);
    expect(sideEffects).toBe(1);
  });
  it('enforces human HTTP approval contracts and never exposes internal execution/report capabilities', async () => {
    const { action } = await proposed();
    const origin = 'http://actions.test';
    const identity = createIdentityService({
      db: databases.db,
      identityDb: databases.identityDb,
      publicOrigin: origin,
      sessionSecret: secret,
      environment: 'test',
      enableDevAuth: true,
      devPrincipalIds: [fixture.alice.principalId],
    });
    const app = createApp({ readiness: async () => {}, identity, actions, tasks });
    await app.ready();
    try {
      const session = await identity.devLogin({ principalId: fixture.alice.principalId, origin });
      const headers = {
        origin,
        cookie: `imbox_session=${session.token}`,
        'x-imbox-tenant-id': fixture.tenantId,
        'x-csrf-token': session.csrfToken,
        'idempotency-key': key(),
        'if-match': `"${action.version}"`,
      };
      expect(
        (await app.inject({ method: 'GET', url: `/v1/actions/${action.id}`, headers })).statusCode,
      ).toBe(200);
      const handoffResponse = await app.inject({
        method: 'GET',
        url: `/v1/tasks/${task.id}/handoff-actions`,
        headers,
      });
      expect(handoffResponse.statusCode).toBe(200);
      expect(handoffResponse.json()).toEqual({
        task_id: task.id,
        task_version: task.version,
        pending_action_ids: [action.id],
      });
      const payload = {
        decision: 'approve',
        action_version: action.approval_binding_version,
        fingerprint: action.fingerprint,
        comment: 'Explicit HTTP review',
      };
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/v1/actions/${action.id}/approvals/decisions`,
            headers,
            payload: { ...payload, actor_id: fixture.bob.principalId },
          })
        ).statusCode,
      ).toBe(400);
      const approved = await app.inject({
        method: 'POST',
        url: `/v1/actions/${action.id}/approvals/decisions`,
        headers,
        payload,
      });
      expect(approved.statusCode).toBe(200);
      expect(approved.json()).toMatchObject({
        status: 'ready',
        approval: { decided_by: fixture.alice.principalId },
      });
      // An approved action cannot be retargeted or reassigned through revision.
      for (const injected of [
        { target_id: 'unapproved-destination' },
        { executor_principal_id: fixture.charlie.principalId },
        { tool_id: 'unapproved.tool' },
        { tool_version: '2' },
      ]) {
        const changed = await app.inject({
          method: 'PATCH',
          url: `/v1/actions/${action.id}`,
          headers: {
            ...headers,
            'idempotency-key': key(),
            'if-match': `"${approved.json<C['Action']>().version}"`,
          },
          payload: {
            parameters: action.parameters,
            resource_versions: action.resource_versions,
            ...injected,
          },
        });
        expect(changed.statusCode).toBe(400);
        expect(await actions.getAction(fixture.alice, action.id)).toMatchObject({
          status: 'ready',
          fingerprint: action.fingerprint,
          executor_id: fixture.bob.principalId,
          target_id: 'demo',
          tool_id: 'demo.delivery',
          tool_version: '1',
        });
      }
      for (const command of ['claim', 'dispatch', 'record-outcome', 'receipts'])
        expect(
          (
            await app.inject({
              method: 'POST',
              url: `/v1/actions/${action.id}/${command}`,
              headers,
              payload: { status: 'succeeded' },
            })
          ).statusCode,
        ).toBe(404);
      expect(sideEffects).toBe(0);
    } finally {
      await app.close();
    }
  });
  it('finds a whole action lost across a simulated database recovery and freezes new execution', async () => {
    const { action } = await proposed();
    await approve(action);
    await runner().runOnce(fixture.tenantId, action.id);
    // The separate journal survives while this test removes the business rows as if
    // restoring a PG snapshot taken before the action existed. No shared DB is reset.
    await withTenant(databases.owner, fixture.tenantId, async (tx) => {
      for (const table of [
        'action_receipts',
        'action_budget_reservations',
        'action_attempts',
        'action_approvals',
        'actions',
      ])
        await sql.raw(`delete from ${table} where tenant_id='${fixture.tenantId}'`).execute(tx);
    });
    await expect(actions.auditJournal(fixture.tenantId)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(await journal.frozen(fixture.tenantId)).toBe(true);
    const cases = (
      await withTenant(databases.db, fixture.tenantId, (tx) =>
        sql`select reason,status from action_reconciliation_cases`.execute(tx),
      )
    ).rows;
    expect(cases).toEqual([{ reason: 'missing_after_restore', status: 'open' }]);
    expect(sideEffects).toBe(1);
  });
});
