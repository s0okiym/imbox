import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTaskService } from '@imbox/application';
import { sql, withTenant } from '@imbox/db';
import {
  createActionService,
  createFileJournal,
  createHttpToolRegistry,
  type JournalPort,
} from '@imbox/actions';
import { tenantFixture, testDatabases } from '../helpers/database.js';

const secret = 'journal-integration-cursor-secret-at-least-thirty-two-characters';
let databases: Awaited<ReturnType<typeof testDatabases>>;
let fixture: Awaited<ReturnType<typeof tenantFixture>>;
let journal: JournalPort;
let directory: string;
const tools = createHttpToolRegistry([
  {
    id: 'journal.test',
    version: '1',
    targetId: 'test',
    executeUrl: 'https://connector.invalid/execute',
    lookupUrl: 'https://connector.invalid/lookup',
  },
]);
beforeAll(async () => {
  databases = await testDatabases();
});
afterAll(async () => {
  await databases?.close();
});
beforeEach(async () => {
  fixture = await tenantFixture(databases.owner);
  directory = await mkdtemp(join(tmpdir(), 'imbox-journal-pg-'));
  journal = await createFileJournal({ directory, signingKey: secret });
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
function service(port = journal) {
  return createActionService({ db: databases.db, journal: port, tools, cursorSecret: secret });
}
async function prepared() {
  const tasks = createTaskService(databases.db, secret);
  let task = await tasks.createTask(
    fixture.alice,
    {
      workspace_id: fixture.workspaceId,
      title: 'Journal boundary',
      goal: 'Persist intent before dispatch',
      acceptance_criteria: ['Independent durable intent exists'],
      reviewer_principal_ids: [fixture.alice.principalId],
      budget: { currency: 'USD', limit_microunits: '100' },
    },
    randomUUID(),
  );
  task = await tasks.changeParticipant(
    fixture.alice,
    task.id,
    fixture.bob.principalId,
    'contributor',
    task.version,
    randomUUID(),
  );
  task = await tasks.changeState(
    fixture.alice,
    task.id,
    { state: 'active' },
    task.version,
    randomUUID(),
  );
  const actions = service();
  const grant = await actions.createGrant(
    fixture.alice,
    {
      task_id: task.id,
      executor_principal_id: fixture.bob.principalId,
      tool_id: 'journal.test',
      tool_version: '1',
      target_id: 'test',
      allow_execute: true,
      allow_disclosure: true,
      resource_versions: [{ type: 'task', id: task.id, version: task.version }],
      approver_principal_ids: [fixture.alice.principalId],
      budget: { currency: 'USD', limit_microunits: '10' },
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    },
    randomUUID(),
  );
  const action = await actions.createAction(
    fixture.bob,
    {
      task_id: task.id,
      grant_id: grant.id,
      executor_principal_id: fixture.bob.principalId,
      tool_id: 'journal.test',
      tool_version: '1',
      target_id: 'test',
      parameters: { text: 'No network call is made in these tests' },
      resource_versions: [{ type: 'task', id: task.id, version: task.version }],
      business_key: randomUUID(),
      estimate: { currency: 'USD', limit_microunits: '10' },
    },
    randomUUID(),
  );
  await actions.decideApproval(
    fixture.alice,
    action.id,
    {
      decision: 'approve',
      action_version: action.approval_binding_version,
      fingerprint: action.fingerprint,
      comment: 'Approve the fixed journal test parameters',
    },
    action.version,
    randomUUID(),
  );
  const claim = await actions.claim(fixture.tenantId, action.id, 'journal-test-worker');
  return { actions, claim };
}

describe('intent retry and restore fencing with real PostgreSQL and signed files', () => {
  it('retries a durable intent after its acknowledgement is lost without changing its timestamp', async () => {
    const { claim } = await prepared();
    let loseAcknowledgement = true;
    const actions = service({
      ...journal,
      append: async (record) => {
        await journal.append(record);
        if (record.kind === 'intent' && loseAcknowledgement) {
          loseAcknowledgement = false;
          throw new Error('Journal acknowledgement lost');
        }
      },
    });
    await expect(actions.persistIntent(claim)).rejects.toThrow('acknowledgement lost');
    const first = (await journal.records(fixture.tenantId)).find(
      (record) => record.kind === 'intent',
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    const retries = await Promise.all(
      Array.from({ length: 8 }, () => actions.persistIntent(claim)),
    );
    expect(retries.every((record) => JSON.stringify(record) === JSON.stringify(first))).toBe(true);
    const attempt = (
      await withTenant(databases.db, fixture.tenantId, (tx) =>
        sql<{
          created_at: Date;
          journal_intent_id: string;
        }>`select created_at,journal_intent_id from action_attempts where id=${claim.attemptId}`.execute(
          tx,
        ),
      )
    ).rows[0]!;
    expect(first?.created_at).toBe(attempt.created_at.toISOString());
    expect(attempt.journal_intent_id).toBe(claim.attemptId);
    expect(
      (await journal.records(fixture.tenantId)).filter((record) => record.kind === 'intent'),
    ).toHaveLength(1);
  });

  it('rejects an expired claimant before writing any independent intent', async () => {
    const { actions, claim } = await prepared();
    await withTenant(databases.owner, fixture.tenantId, (tx) =>
      sql`update actions set lease_expires_at=clock_timestamp()-interval '1 second' where id=${claim.actionId}`.execute(
        tx,
      ),
    );
    await expect(actions.persistIntent(claim)).rejects.toMatchObject({ code: 'LEASE_EXPIRED' });
    expect(await journal.records(fixture.tenantId)).toEqual([]);
  });

  it('opens a restore case for a terminal attempt with the wrong lease generation', async () => {
    const { actions, claim } = await prepared();
    await actions.persistIntent(claim);
    await withTenant(databases.owner, fixture.tenantId, (tx) =>
      sql`update action_attempts set status='failed',side_effect='none',lease_generation=lease_generation+1 where id=${claim.attemptId}`.execute(
        tx,
      ),
    );
    await expect(actions.auditJournal(fixture.tenantId)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(await journal.frozen(fixture.tenantId)).toBe(true);
    const cases = (
      await withTenant(databases.db, fixture.tenantId, (tx) =>
        sql<{
          reason: string;
          status: string;
        }>`select reason,status from action_reconciliation_cases where attempt_id=${claim.attemptId}`.execute(
          tx,
        ),
      )
    ).rows;
    expect(cases).toEqual([{ reason: 'recovery_identity_conflict', status: 'open' }]);
  });

  it('does not accept a terminal attempt attached to another action as a recovered match', async () => {
    const original = await prepared();
    await original.actions.persistIntent(original.claim);
    const other = await prepared();
    await withTenant(databases.owner, fixture.tenantId, (tx) =>
      sql`update action_attempts set action_id=${other.claim.actionId},attempt_no=2,status='failed',side_effect='none' where id=${original.claim.attemptId}`.execute(
        tx,
      ),
    );
    const recovery = await original.actions.recover(fixture.tenantId);
    expect(recovery.cases).toContainEqual({
      action_id: original.claim.actionId,
      attempt_id: original.claim.attemptId,
      missing: false,
    });
    const cases = (
      await withTenant(databases.db, fixture.tenantId, (tx) =>
        sql<{
          reason: string;
        }>`select reason from action_reconciliation_cases where attempt_id=${original.claim.attemptId}`.execute(
          tx,
        ),
      )
    ).rows;
    expect(cases).toEqual([{ reason: 'recovery_identity_conflict' }]);
  });
});
