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
  type ActionService,
  type JournalPort,
  type ToolRegistry,
  type IntentRecord,
} from '@imbox/actions';
import { createTaskService } from '@imbox/application';
import { createIdentityService } from '@imbox/auth';
import type { ContractTypes as C } from '@imbox/contracts';
import { sql, withTenant } from '@imbox/db';
import { createApp } from '../../apps/api/src/app.js';
import { tenantFixture, testDatabases } from '../helpers/database.js';
const key = () => randomUUID();
const secret = 'action-recovery-test-secret-longer-than-thirty-two-characters';
let databases: Awaited<ReturnType<typeof testDatabases>>,
  fixture: Awaited<ReturnType<typeof tenantFixture>>;
let actions: ActionService,
  journal: JournalPort,
  tools: ToolRegistry,
  directory: string,
  task: C['Task'];
let postCount: number, getCount: number;
let lookupMode: 'normal' | 'unknown' | 'wrong_tenant' = 'normal';
let providerOutcome: 'succeeded' | 'no_effect' = 'succeeded';
let fixedReceipt: string | null = null;
const receipts = new Map<string, Record<string, unknown>>();
const cleanup: Array<() => Promise<void>> = [];
beforeAll(async () => {
  databases = await testDatabases();
});
afterAll(async () => {
  await databases?.close();
});
beforeEach(async () => {
  fixture = await tenantFixture(databases.owner);
  directory = await mkdtemp(join(tmpdir(), 'imbox-recovery-pg-'));
  journal = await createFileJournal({ directory, signingKey: secret });
  postCount = 0;
  getCount = 0;
  lookupMode = 'normal';
  providerOutcome = 'succeeded';
  fixedReceipt = null;
  receipts.clear();
  const send = (response: ServerResponse, value: unknown) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(value));
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    if (request.method === 'GET') {
      getCount++;
      const receipt = receipts.get(url.searchParams.get('business_key')!);
      if (lookupMode === 'unknown' || !receipt) {
        send(response, { status: 'not_found' });
        return;
      }
      send(response, lookupMode === 'wrong_tenant' ? { ...receipt, tenant_id: key() } : receipt);
      return;
    }
    postCount++;
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (part) => (body += part));
    request.on('end', () => {
      const input = JSON.parse(body) as Record<string, string>;
      receipts.set(input.business_key!, {
        status: providerOutcome,
        receipt_id: fixedReceipt ?? key(),
        fingerprint: input.fingerprint,
        cost_microunits: providerOutcome === 'succeeded' ? '7' : '0',
        tenant_id: input.tenant_id,
        action_id: input.action_id,
        attempt_id: input.attempt_id,
      });
      // The provider commits the effect, then the HTTP response is lost.
      response.destroy();
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
  tools = createHttpToolRegistry([
    {
      id: 'recovery.delivery',
      version: '1',
      targetId: 'fixed-provider',
      executeUrl: `${origin}/execute`,
      lookupUrl: `${origin}/lookup`,
      allowInsecureLoopback: true,
    },
  ]);
  actions = service();
  const tasks = createTaskService(databases.db, secret);
  task = await tasks.createTask(
    fixture.alice,
    {
      workspace_id: fixture.workspaceId,
      title: 'Recovery boundary',
      goal: 'One controlled effect',
      acceptance_criteria: ['Bound provider receipt'],
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
  await rm(directory, { recursive: true, force: true });
});
const service = (port = journal) =>
  createActionService({ db: databases.db, tools, journal: port, cursorSecret: secret });
async function execute() {
  const grant = await actions.createGrant(
    fixture.alice,
    {
      task_id: task.id,
      executor_principal_id: fixture.bob.principalId,
      tool_id: 'recovery.delivery',
      tool_version: '1',
      target_id: 'fixed-provider',
      allow_execute: true,
      allow_disclosure: true,
      resource_versions: [{ type: 'task', id: task.id, version: task.version }],
      approver_principal_ids: [fixture.alice.principalId],
      budget: { currency: 'USD', limit_microunits: '10' },
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    },
    key(),
  );
  const input: C['CreateActionInput'] = {
    task_id: task.id,
    grant_id: grant.id,
    executor_principal_id: fixture.bob.principalId,
    tool_id: 'recovery.delivery',
    tool_version: '1',
    target_id: 'fixed-provider',
    parameters: { text: 'Only this originally approved effect' },
    resource_versions: [{ type: 'task', id: task.id, version: task.version }],
    business_key: key(),
    estimate: { currency: 'USD', limit_microunits: '10' },
  };
  const action = await actions.createAction(fixture.bob, input, key());
  await actions.decideApproval(
    fixture.alice,
    action.id,
    {
      decision: 'approve',
      action_version: action.approval_binding_version,
      fingerprint: action.fingerprint,
      comment: 'Approve exact target and text',
    },
    action.version,
    key(),
  );
  await createToolRunner({ actions, workerId: 'recovery-test-worker' }).runOnce(
    fixture.tenantId,
    action.id,
  );
  return { action, input };
}
async function restoreBeforeActions(): Promise<void> {
  // A dedicated tenant only. Independent provider/journal survive; atomic PG Action/budget facts roll back.
  await withTenant(databases.owner, fixture.tenantId, async (tx) => {
    for (const table of [
      'action_reconciliation_cases',
      'action_provider_receipt_bindings',
      'action_receipts',
      'action_budget_reservations',
      'action_attempts',
      'action_approvals',
      'actions',
    ])
      await sql.raw(`delete from ${table} where tenant_id='${fixture.tenantId}'`).execute(tx);
    await sql`update task_budgets set reserved_microunits=0,spent_microunits=0,blocked=false,overrun_microunits=0 where tenant_id=${fixture.tenantId}`.execute(
      tx,
    );
  });
  await expect(actions.auditJournal(fixture.tenantId)).rejects.toMatchObject({
    code: 'SERVICE_UNAVAILABLE',
  });
}
const firstCase = async () => (await actions.recovery.list(fixture.alice)).items[0]!;
async function resolveCase(item: C['RecoveryCase']) {
  const evidence = await actions.recovery.lookup(fixture.alice, item.id, key());
  expect(evidence.outcome).toBe('succeeded');
  return actions.recovery.confirm(
    fixture.alice,
    item.id,
    {
      evidence_id: evidence.id,
      confirmed: true,
      reason: 'Verified the provider identity and the restored budget chain',
    },
    item.version,
    key(),
  );
}
async function unfreezePayload() {
  const state = await actions.recovery.status(fixture.alice);
  return {
    state,
    input: {
      confirmed: true as const,
      reason: 'Every recovery case has authenticated evidence and accounting',
      freeze_digest: state.freeze_digest,
      journal_digest: state.journal_digest,
    },
  };
}

describe('orphan intent accounting and explicit safe unfreeze', () => {
  it.each(['changed', 'missing'] as const)(
    'keeps orphan recovery frozen without the original connector binding: %s',
    async (kind) => {
      await execute();
      await restoreBeforeActions();
      const item = await firstCase();
      const originalTools = tools;
      if (kind === 'changed') {
        tools = {
          list: () => originalTools.list(),
          get: (id, version, target) => ({
            ...originalTools.get(id, version, target),
            executionBinding: '0'.repeat(64),
          }),
        };
        actions = service();
      } else {
        const records = await journal.records(fixture.tenantId);
        const original = records.find((r): r is IntentRecord => r.kind === 'intent')!;
        const legacy = { ...original, id: key(), attempt_id: key(), action_id: key() };
        legacy.id = legacy.attempt_id;
        delete legacy.tool_binding;
        await journal.append(legacy);
        await actions.recovery.refresh(
          fixture.alice,
          { reason: 'Discover legacy unbound intent' },
          key(),
        );
      }
      const target =
        kind === 'changed'
          ? item
          : (await actions.recovery.list(fixture.alice)).items.find(
              (r) => r.attempt_id !== item.attempt_id,
            )!;
      const proof = await actions.recovery.lookup(fixture.alice, target.id, key());
      expect(proof.outcome).toBe('unknown');
      expect(getCount).toBe(0);
      expect((await actions.recovery.status(fixture.alice)).frozen).toBe(true);
      expect(postCount).toBe(1);
      if (kind === 'changed') {
        tools = originalTools;
        actions = service();
        const recovered = await actions.recovery.lookup(fixture.alice, item.id, key());
        expect(recovered.outcome).toBe('succeeded');
        expect(getCount).toBe(1);
        expect(postCount).toBe(1);
      }
    },
  );
  it('accepts a bound terminal no-effect receipt without charging or retrying the old business action', async () => {
    providerOutcome = 'no_effect';
    await execute();
    await restoreBeforeActions();
    const item = await firstCase();
    const proof = await actions.recovery.lookup(fixture.alice, item.id, key());
    expect(proof).toMatchObject({ outcome: 'no_effect', actual_microunits: '0' });
    await actions.recovery.confirm(
      fixture.alice,
      item.id,
      {
        evidence_id: proof.id,
        confirmed: true,
        reason: 'Provider explicitly confirms no side effect',
      },
      item.version,
      key(),
    );
    const { state, input } = await unfreezePayload();
    expect(
      (await actions.recovery.unfreeze(fixture.alice, input, state.revision, key())).frozen,
    ).toBe(false);
    expect(
      (
        await withTenant(databases.db, fixture.tenantId, (tx) =>
          sql<{
            spent_microunits: string;
          }>`select spent_microunits from task_budgets where task_id=${task.id}`.execute(tx),
        )
      ).rows[0]?.spent_microunits,
    ).toBe('0');
    expect(postCount).toBe(1);
  });
  it('compensates every original ancestor budget exactly once for a restored child task', async () => {
    const root = task.id,
      child = key();
    await withTenant(databases.owner, fixture.tenantId, async (tx) => {
      await tx
        .insertInto('tasks')
        .values({
          tenant_id: fixture.tenantId,
          id: child,
          root_task_id: root,
          parent_task_id: root,
          workspace_id: fixture.workspaceId,
          owner_principal_id: fixture.alice.principalId,
          accountable_principal_id: fixture.alice.principalId,
          created_by: fixture.alice.principalId,
          title: 'Delegated child',
          goal: 'Controlled child effect',
          acceptance_criteria: sql`${JSON.stringify(['Provider confirms the child effect'])}::jsonb`,
          reviewer_ids: sql`${JSON.stringify([fixture.alice.principalId])}::jsonb`,
          status: 'active',
        })
        .execute();
      await tx
        .insertInto('task_participants')
        .values([
          {
            tenant_id: fixture.tenantId,
            task_id: child,
            principal_id: fixture.alice.principalId,
            role: 'owner',
          },
          {
            tenant_id: fixture.tenantId,
            task_id: child,
            principal_id: fixture.bob.principalId,
            role: 'contributor',
          },
        ])
        .execute();
      await sql`insert into task_budgets(tenant_id,task_id,currency,limit_microunits) values(${fixture.tenantId},${child},'USD',50)`.execute(
        tx,
      );
    });
    task = await createTaskService(databases.db, secret).getTask(fixture.alice, child);
    await execute();
    await restoreBeforeActions();
    await resolveCase(await firstCase());
    const accounts = (
      await withTenant(databases.db, fixture.tenantId, (tx) =>
        sql<{
          task_id: string;
          spent_microunits: string;
          reserved_microunits: string;
        }>`select task_id,spent_microunits,reserved_microunits from task_budgets order by task_id`.execute(
          tx,
        ),
      )
    ).rows;
    expect(accounts).toHaveLength(2);
    expect(
      accounts.every(
        (account) => account.spent_microunits === '7' && account.reserved_microunits === '0',
      ),
    ).toBe(true);
    expect(postCount).toBe(1);
  });
  it('performs read-only provider reconciliation, charges once, preserves old keys and explicitly unfreezes', async () => {
    const executed = await execute();
    expect(postCount).toBe(1);
    await restoreBeforeActions();
    const item = await firstCase();
    const requestKey = key();
    const evidence = await actions.recovery.lookup(fixture.alice, item.id, requestKey);
    expect(await actions.recovery.lookup(fixture.alice, item.id, requestKey)).toEqual(evidence);
    expect(getCount).toBe(1);
    expect(evidence).toMatchObject({ outcome: 'succeeded', actual_microunits: '7' });
    const confirmKey = key(),
      body = {
        evidence_id: evidence.id,
        confirmed: true as const,
        reason: 'Verified bound receipt and budget compensation',
      };
    const confirmations = await Promise.all([
      actions.recovery.confirm(fixture.alice, item.id, body, item.version, confirmKey),
      actions.recovery.confirm(fixture.alice, item.id, body, item.version, confirmKey),
    ]);
    expect(confirmations.every((r) => r.status === 'resolved')).toBe(true);
    const budgets = (
      await withTenant(databases.db, fixture.tenantId, (tx) =>
        sql<{
          spent_microunits: string;
          reserved_microunits: string;
        }>`select spent_microunits,reserved_microunits from task_budgets where task_id=${task.id}`.execute(
          tx,
        ),
      )
    ).rows[0];
    expect(budgets).toEqual({ spent_microunits: '7', reserved_microunits: '0' });
    const { state, input } = await unfreezePayload();
    expect(state.frozen).toBe(true);
    expect(
      (await actions.recovery.unfreeze(fixture.alice, input, state.revision, key())).frozen,
    ).toBe(false);
    await actions.auditJournal(fixture.tenantId);
    await expect(actions.createAction(fixture.bob, executed.input, key())).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(postCount).toBe(1);
    expect(
      (await journal.records(fixture.tenantId)).filter((r) => r.kind === 'recovery'),
    ).toHaveLength(1);
    expect(
      (
        await withTenant(databases.db, fixture.tenantId, (tx) =>
          sql`select 1 from domain_events where event_type in ('action.recovery_confirm','action.recovery_unfreeze')`.execute(
            tx,
          ),
        )
      ).rows,
    ).toHaveLength(2);
  });
  it('does not turn missing or incorrectly bound provider evidence into zero cost or permission to unfreeze', async () => {
    await execute();
    await restoreBeforeActions();
    const item = await firstCase();
    for (const mode of ['unknown', 'wrong_tenant'] as const) {
      lookupMode = mode;
      const evidence = await actions.recovery.lookup(fixture.alice, item.id, key());
      expect(evidence).toMatchObject({ outcome: 'unknown', actual_microunits: null });
      await expect(
        actions.recovery.confirm(
          fixture.alice,
          item.id,
          { evidence_id: evidence.id, confirmed: true, reason: 'No authority to assume zero' },
          item.version,
          key(),
        ),
      ).rejects.toMatchObject({ code: 'CHARGE_STATUS_UNKNOWN' });
    }
    const { state, input } = await unfreezePayload();
    await expect(
      actions.recovery.unfreeze(fixture.alice, input, state.revision, key()),
    ).rejects.toMatchObject({ code: 'CHARGE_STATUS_UNKNOWN' });
    expect(await journal.frozen(fixture.tenantId)).toBe(true);
    expect(postCount).toBe(1);
  });
  it('retains the freeze when a signed intent lacks legacy version/budget bindings or its account is missing', async () => {
    await execute();
    await restoreBeforeActions();
    const item = await firstCase();
    await withTenant(databases.owner, fixture.tenantId, (tx) =>
      sql`delete from task_budgets where task_id=${task.id}`.execute(tx),
    );
    const evidence = await actions.recovery.lookup(fixture.alice, item.id, key());
    await expect(
      actions.recovery.confirm(
        fixture.alice,
        item.id,
        {
          evidence_id: evidence.id,
          confirmed: true,
          reason: 'Missing account must remain unresolved',
        },
        item.version,
        key(),
      ),
    ).rejects.toMatchObject({ code: 'CHARGE_STATUS_UNKNOWN' });
    const original = (await journal.records(fixture.tenantId)).find(
      (r): r is IntentRecord => r.kind === 'intent',
    )!;
    const legacy = { ...original, id: key(), attempt_id: key(), action_id: key() };
    legacy.id = legacy.attempt_id;
    delete legacy.tool_version;
    delete legacy.budget_account_ids;
    await journal.append(legacy);
    await actions.recovery.refresh(
      fixture.alice,
      { reason: 'Check restored legacy journal' },
      key(),
    );
    const legacyCase = (await actions.recovery.list(fixture.alice)).items.find(
      (r) => r.attempt_id === legacy.attempt_id,
    )!;
    expect((await actions.recovery.lookup(fixture.alice, legacyCase.id, key())).outcome).toBe(
      'unknown',
    );
    expect((await actions.recovery.status(fixture.alice)).frozen).toBe(true);
  });
  it('retries lost independent unfreeze acknowledgements without repeating accounting or external sends', async () => {
    await execute();
    await restoreBeforeActions();
    await resolveCase(await firstCase());
    let lose = true;
    const unstable = service({
      ...journal,
      append: async (record) => {
        await journal.append(record);
        if (record.kind === 'unfreeze' && lose) {
          lose = false;
          throw new Error('Lost unfreeze acknowledgement');
        }
      },
    });
    const { state, input } = await unfreezePayload(),
      requestKey = key();
    await expect(
      unstable.recovery.unfreeze(fixture.alice, input, state.revision, requestKey),
    ).rejects.toThrow('Lost unfreeze acknowledgement');
    expect(await unstable.recovery.status(fixture.alice)).toMatchObject({
      frozen: true,
      database_frozen: true,
      journal_frozen: false,
    });
    expect(
      (await unstable.recovery.unfreeze(fixture.alice, input, state.revision, requestKey)).frozen,
    ).toBe(false);
    expect(postCount).toBe(1);
    expect(
      (await journal.records(fixture.tenantId)).filter((r) => r.kind === 'unfreeze'),
    ).toHaveLength(1);
  });
  it('requires a fresh human confirmation after a newer freeze and detects conflicting late durable receipts', async () => {
    await execute();
    await restoreBeforeActions();
    await resolveCase(await firstCase());
    const { state, input } = await unfreezePayload();
    await actions.recovery.unfreeze(fixture.alice, input, state.revision, key());
    await journal.freeze(fixture.tenantId, 'restore');
    expect((await actions.recovery.status(fixture.alice)).frozen).toBe(true);
    await expect(
      actions.recovery.unfreeze(fixture.alice, input, state.revision, key()),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await actions.recovery.refresh(
      fixture.alice,
      { reason: 'Recheck a subsequent recovery' },
      key(),
    );
    const next = await unfreezePayload();
    await actions.recovery.unfreeze(fixture.alice, next.input, next.state.revision, key());
    const intent = (await journal.records(fixture.tenantId)).find(
      (r): r is IntentRecord => r.kind === 'intent',
    )!;
    await journal.append({
      kind: 'receipt',
      id: key(),
      tenant_id: fixture.tenantId,
      action_id: intent.action_id,
      attempt_id: intent.attempt_id,
      fingerprint: intent.fingerprint,
      outcome: 'succeeded',
      receipt_id: 'conflicting-late-receipt',
      actual_microunits: '99',
      created_at: new Date().toISOString(),
    });
    await expect(actions.auditJournal(fixture.tenantId)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    expect((await firstCase()).status).toBe('open');
    expect(postCount).toBe(1);
  });
  it('does not reuse a provider receipt across orphan actions and keeps the second charge unresolved', async () => {
    fixedReceipt = 'single-provider-receipt';
    await execute();
    await execute();
    await restoreBeforeActions();
    const items = (await actions.recovery.list(fixture.alice)).items;
    await resolveCase(items[0]!);
    const second = items[1]!,
      evidence = await actions.recovery.lookup(fixture.alice, second.id, key());
    await expect(
      actions.recovery.confirm(
        fixture.alice,
        second.id,
        {
          evidence_id: evidence.id,
          confirmed: true,
          reason: 'Duplicated receipt must not settle twice',
        },
        second.version,
        key(),
      ),
    ).rejects.toMatchObject({ code: 'CHARGE_STATUS_UNKNOWN' });
    expect((await actions.recovery.status(fixture.alice)).frozen).toBe(true);
    expect(
      (
        await withTenant(databases.db, fixture.tenantId, (tx) =>
          sql<{
            spent_microunits: string;
          }>`select spent_microunits from task_budgets where task_id=${task.id}`.execute(tx),
        )
      ).rows[0]?.spent_microunits,
    ).toBe('7');
    expect(postCount).toBe(2);
  });
  it('requires a current human tenant admin and does not expose another tenant recovery case', async () => {
    await execute();
    await restoreBeforeActions();
    const item = await firstCase();
    await expect(actions.recovery.get(fixture.bob, item.id)).rejects.toMatchObject({ status: 403 });
    await expect(
      actions.recovery.status({ ...fixture.alice, kind: 'agent' }),
    ).rejects.toMatchObject({ status: 403 });
    const other = await tenantFixture(databases.owner);
    await expect(actions.recovery.get(other.alice, item.id)).rejects.toMatchObject({ status: 404 });
    await databases.identityDb
      .updateTable('principals')
      .set({ status: 'disabled', version: sql`version+1` })
      .where('id', '=', fixture.alice.principalId)
      .execute();
    await expect(actions.recovery.status(fixture.alice)).rejects.toMatchObject({ status: 403 });
  });
  it('exposes explicit HTTP review without accepting caller-supplied provider evidence', async () => {
    await execute();
    await restoreBeforeActions();
    const item = await firstCase();
    const identity = createIdentityService({
      db: databases.db,
      identityDb: databases.identityDb,
      publicOrigin: 'http://recovery.test',
      sessionSecret: secret,
      environment: 'test',
      enableDevAuth: true,
      devPrincipalIds: [fixture.alice.principalId],
    });
    const app = createApp({ identity, actions, readiness: async () => {} });
    await app.ready();
    try {
      const session = await identity.devLogin({
        principalId: fixture.alice.principalId,
        origin: 'http://recovery.test',
      });
      const headers = {
        origin: 'http://recovery.test',
        cookie: `imbox_session=${session.token}`,
        'x-imbox-tenant-id': fixture.tenantId,
        'x-csrf-token': session.csrfToken,
        'idempotency-key': key(),
      };
      expect(
        (await app.inject({ method: 'GET', url: '/v1/action-recovery', headers })).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/v1/action-recovery/cases/${item.id}/lookup`,
            headers,
            payload: { outcome: 'no_effect', actual_microunits: '0' },
          })
        ).statusCode,
      ).toBe(400);
      const lookedUp = await app.inject({
        method: 'POST',
        url: `/v1/action-recovery/cases/${item.id}/lookup`,
        headers,
        payload: {},
      });
      expect(lookedUp.statusCode, lookedUp.body).toBe(200);
      const evidence = lookedUp.json<C['RecoveryEvidence']>();
      const confirmed = await app.inject({
        method: 'POST',
        url: `/v1/action-recovery/cases/${item.id}/confirm`,
        headers: { ...headers, 'idempotency-key': key(), 'if-match': `"${item.version}"` },
        payload: {
          evidence_id: evidence.id,
          confirmed: true,
          reason: 'Explicit human recovery confirmation',
        },
      });
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      expect(confirmed.json().resolved_by).toBe(fixture.alice.principalId);
    } finally {
      await app.close();
    }
    expect(postCount).toBe(1);
  });
});
