import { test, expect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import * as current from '@imbox/actions';
import type { ContractTypes as C } from '@imbox/contracts';
import { createTaskService } from '@imbox/application';
import { sql, withTenant } from '@imbox/db';
import { tenantFixture, testDatabases } from '../helpers/database.js';

const commit = process.env.IMBOX_COMPAT_CLIENT_COMMIT ?? '2f751069fc11062f48cfd5d377db2970e9088268';
const secret = 'historical-action-test-signing-key-at-least-thirty-two';
const key = () => randomUUID();

async function historicalActions(): Promise<typeof current> {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Full historical commit required');
  const directory = resolve('.artifacts', `historical-web-${commit}`);
  const manifest = JSON.parse(await readFile(join(directory, 'client-build.json'), 'utf8')) as {
    commit: string;
    actionFiles: Record<string, string>;
  };
  expect(manifest.commit).toBe(commit);
  for (const file of ['index.js', 'service.js', 'runner.js', 'tools.js']) {
    const bytes = await readFile(join(directory, 'packages/actions/dist', file));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(manifest.actionFiles[file]);
  }
  // Load the compiled historical package and its own workspace dependencies, not current source.
  return import(pathToFileURL(join(directory, 'packages/actions/dist/index.js')).href);
}

async function verifyHistoricalWriter(phase: 'grant' | 'claim' | 'dispatch' | 'bound_grant') {
  const historical = await historicalActions();
  const databases = await testDatabases();
  const directory = await mkdtemp(join(tmpdir(), 'imbox-historical-actions-'));
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (part: string) => (body += part));
    request.on('end', () => {
      const input = JSON.parse(body) as { fingerprint: string };
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          status: 'succeeded',
          receipt_id: key(),
          fingerprint: input.fingerprint,
          cost_microunits: '1',
          safe_retry: false,
        }),
      );
    });
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const fixture = await tenantFixture(databases.owner);
    const tasks = createTaskService(databases.db, secret);
    let task = await tasks.createTask(
      fixture.alice,
      {
        workspace_id: fixture.workspaceId,
        title: 'Historical execution boundary',
        goal: 'Only the current approved writer sends',
        acceptance_criteria: ['One receipt'],
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
    task = await tasks.changeState(
      fixture.alice,
      task.id,
      { state: 'active' },
      task.version,
      key(),
    );
    const toolConfig = [
      {
        id: 'demo.delivery',
        version: '1',
        targetId: 'demo',
        executeUrl: `${origin}/execute`,
        lookupUrl: `${origin}/lookup`,
        allowInsecureLoopback: true,
        retryDelayMs: 0,
      },
    ];
    const journal = await current.createFileJournal({ directory, signingKey: secret });
    const actions = current.createActionService({
      db: databases.db,
      journal,
      cursorSecret: secret,
      tools: current.createHttpToolRegistry(toolConfig),
    });
    const legacy = historical.createActionService({
      db: databases.db,
      journal,
      cursorSecret: secret,
      tools: historical.createHttpToolRegistry(toolConfig),
    });
    const refs = [{ type: 'task' as const, id: task.id, version: task.version }];
    const input: C['CreateGrantInput'] = {
      task_id: task.id,
      executor_principal_id: fixture.bob.principalId,
      tool_id: 'demo.delivery',
      tool_version: '1',
      target_id: 'demo',
      allow_execute: true,
      allow_disclosure: true,
      resource_versions: refs,
      approver_principal_ids: [fixture.alice.principalId],
      budget: { currency: 'USD', limit_microunits: '10' },
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    };
    const constraint = { code: '23514', constraint: 'action_connector_binding_required' };
    if (phase === 'grant') {
      await expect(legacy.createGrant(fixture.alice, input, key())).rejects.toMatchObject(
        constraint,
      );
      expect((await actions.listGrants(fixture.alice)).items).toHaveLength(0);
    } else {
      const grant = await actions.createGrant(fixture.alice, input, key());
      const action = await actions.createAction(
        fixture.bob,
        {
          task_id: task.id,
          grant_id: grant.id,
          executor_principal_id: fixture.bob.principalId,
          tool_id: 'demo.delivery',
          tool_version: '1',
          target_id: 'demo',
          parameters: { text: 'Exactly approved historical test' },
          resource_versions: refs,
          business_key: key(),
          estimate: { currency: 'USD', limit_microunits: '10' },
        },
        key(),
      );
      await actions.decideApproval(
        fixture.alice,
        action.id,
        {
          decision: 'approve',
          action_version: action.approval_binding_version,
          fingerprint: action.fingerprint,
          comment: 'Review exact version',
        },
        action.version,
        key(),
      );
      const claim =
        phase === 'dispatch'
          ? await actions.claim(fixture.tenantId, action.id, 'historical-worker')
          : null;
      if (claim) await actions.persistIntent(claim);
      if (phase !== 'bound_grant') {
        // Construct an existing pre-upgrade grant; never disable the new database triggers.
        await withTenant(databases.owner, fixture.tenantId, (tx) =>
          sql`update capability_grants set authority_snapshot=authority_snapshot-'tool_binding' where id=${grant.id}`.execute(
            tx,
          ),
        );
      }
      if (claim) {
        await expect(legacy.dispatch(claim)).rejects.toMatchObject(constraint);
        const saved = await withTenant(databases.db, fixture.tenantId, (tx) =>
          sql`select status from action_attempts where id=${claim.attemptId}`.execute(tx),
        );
        expect(saved.rows[0]).toMatchObject({ status: 'prepared' });
        await legacy.abortPrepared(claim);
        expect((await actions.getAction(fixture.alice, action.id)).status).toBe('failed');
      } else {
        await expect(
          historical
            .createToolRunner({ actions: legacy, workerId: 'historical-worker' })
            .runOnce(fixture.tenantId, action.id),
        ).rejects.toMatchObject(phase === 'bound_grant' ? { code: 'FORBIDDEN' } : constraint);
        expect((await actions.getAction(fixture.alice, action.id)).status).toBe('ready');
      }
      expect(requests).toBe(0);
      if (phase === 'bound_grant') {
        await current
          .createToolRunner({ actions, workerId: 'current-worker' })
          .runOnce(fixture.tenantId, action.id);
        expect(requests).toBe(1);
        expect((await actions.getAction(fixture.alice, action.id)).status).toBe('succeeded');
        return;
      }
    }
    expect(requests).toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await databases.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('compiled historical service cannot issue an unbound grant', async () => {
  await verifyHistoricalWriter('grant');
});

test('compiled historical runner cannot claim an unbound legacy grant', async () => {
  await verifyHistoricalWriter('claim');
});

test('compiled historical service cannot dispatch a prepared unbound attempt and can clean it up', async () => {
  await verifyHistoricalWriter('dispatch');
});

test('compiled historical runner rejects new bound authority while the current runner sends once', async () => {
  await verifyHistoricalWriter('bound_grant');
});
