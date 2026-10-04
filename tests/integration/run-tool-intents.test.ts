import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect } from 'vitest';
import {
  createActionService,
  createFileJournal,
  createHttpToolRegistry,
  createToolRunner,
} from '@imbox/actions';
import { createModelDriver, createOllamaAdapter } from '@imbox/model-runtime';
import { createSchedulingService } from '@imbox/scheduling';
import {
  createKnowledgeService,
  knowledgeRuntimeSourcePort,
  knowledgeResourceIndex,
} from '@imbox/knowledge';
import { createResourceService, createS3ObjectStore } from '@imbox/resources';
import { createRuntimeService, createRuntimeWorker } from '@imbox/runtime';
import type { ContractTypes as C } from '@imbox/contracts';
import { createTaskService } from '@imbox/application';
import { sql, withTenant } from '@imbox/db';
import { modelFixture } from '../helpers/model.js';
import { testDatabases } from '../helpers/database.js';
const key = randomUUID,
  secret = 'run-tool-intents-integration-secret-at-least-32',
  digest = 'sha256:' + 'a'.repeat(64);
const store = createS3ObjectStore({
  endpoint: process.env.TEST_S3_ENDPOINT ?? 'http://127.0.0.1:18333',
  region: 'us-east-1',
  bucket: 'imbox-resources-test',
  accessKeyId: 'imbox_local_s3_app',
  secretAccessKey: 'imbox_local_s3_app_secret',
});
const adminStore = createS3ObjectStore({
  endpoint: process.env.TEST_S3_ENDPOINT ?? 'http://127.0.0.1:18333',
  region: 'us-east-1',
  bucket: 'imbox-resources-test',
  accessKeyId: 'imbox_local_s3_admin',
  secretAccessKey: 'imbox_local_s3_admin_secret',
});
let dbs: Awaited<ReturnType<typeof testDatabases>>;
let fixture: Awaited<ReturnType<typeof setup>>;
const cleanups: Array<() => Promise<void>> = [];
beforeAll(async () => {
  dbs = await testDatabases();
  await adminStore.ensureDevelopmentBucket('test');
});
afterAll(async () => {
  store.destroy();
  adminStore.destroy();
  await dbs.close();
});
beforeEach(async () => {
  fixture = await setup();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function setup(withArtifact = false) {
  const base = await modelFixture(dbs),
    tasks = createTaskService(dbs.db, secret);
  const sources = knowledgeRuntimeSourcePort(
    createKnowledgeService({ db: dbs.db, cursorSecret: secret }),
  );
  base.runtime = createRuntimeService({ db: dbs.db, sources });
  base.worker = createRuntimeWorker({ db: dbs.db, workerId: 'artifact-model-worker', sources });
  const resources = createResourceService({
    db: dbs.db,
    store,
    cursorSecret: secret,
    textIndex: knowledgeResourceIndex(),
  });
  let task = await tasks.createTask(
    base.alice,
    {
      workspace_id: base.workspaceId,
      title: 'One explicitly approved delivery',
      goal: 'Send the exact verification marker to the fixed provider',
      acceptance_criteria: ['Provider confirms delivery'],
      reviewer_principal_ids: [base.alice.principalId],
      budget: { currency: 'USD', limit_microunits: '100' },
    },
    key(),
  );
  task = await tasks.changeParticipant(
    base.alice,
    task.id,
    base.agentId,
    'contributor',
    task.version,
    key(),
  );
  task = await tasks.changeState(base.alice, task.id, { state: 'active' }, task.version, key());
  const refs: C['ActionResourceRef'][] = [{ type: 'task', id: task.id, version: task.version }];
  let file: C['StoredArtifact'] | null = null;
  if (withArtifact) {
    const bytes = Buffer.from('IMBOX_TOOL_OK');
    const ticket = await resources.createUpload(
      base.alice,
      {
        task_id: task.id,
        filename: 'hosted-publication.md',
        content_type: 'text/markdown',
        byte_size: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
      key(),
    );
    expect(
      (
        await fetch(ticket.upload_url, {
          method: 'PUT',
          headers: ticket.upload_headers,
          body: bytes,
        })
      ).status,
    ).toBe(200);
    const content = await resources.completeUpload(base.alice, ticket.id, key());
    file = await resources.createArtifact(
      base.alice,
      { resource_id: content.id, title: 'Hosted fixed publication' },
      key(),
    );
    refs.push({
      type: 'artifact_version',
      id: file.version_id,
      version: file.head_version,
      sha256: file.resource.sha256,
    });
  }
  const deliveredTexts: unknown[] = [];
  let posts = 0,
    generations = 0,
    loseResponse = false,
    modelDecision: { kind: 'final' | 'tool_intent'; text: string } = {
      kind: 'tool_intent',
      text: 'IMBOX_TOOL_OK',
    };
  const receipts = new Map<string, Record<string, unknown>>();
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const url = new URL(request.url!, 'http://127.0.0.1');
    if (url.pathname === '/api/tags') {
      response.end(JSON.stringify({ models: [{ name: 'qwen3:0.6b', digest }] }));
      return;
    }
    if (url.pathname === '/lookup') {
      response.end(
        JSON.stringify(
          receipts.get(url.searchParams.get('business_key')!) ?? { status: 'not_found' },
        ),
      );
      return;
    }
    let text = '';
    request.on('data', (chunk) => (text += String(chunk)));
    request.on('end', () => {
      const data = JSON.parse(text) as Record<string, unknown>;
      if (url.pathname === '/execute') {
        deliveredTexts.push((data.input as { text: string }).text);
        posts++;
        const receipt = {
          status: 'succeeded',
          receipt_id: `provider:${String(data.business_key)}`,
          fingerprint: data.fingerprint,
          cost_microunits: '7',
          safe_retry: false,
          tenant_id: data.tenant_id,
          action_id: data.action_id,
          attempt_id: data.attempt_id,
        };
        receipts.set(String(data.business_key), receipt);
        if (loseResponse) {
          response.destroy();
          return;
        }
        response.end(JSON.stringify(receipt));
        return;
      }
      generations++;
      response.end(
        JSON.stringify({
          model: 'qwen3:0.6b',
          done: true,
          done_reason: 'stop',
          message: {
            role: 'assistant',
            content: data.format
              ? JSON.stringify(modelDecision)
              : 'Provider confirmed IMBOX_TOOL_OK.',
          },
          prompt_eval_count: 100,
          eval_count: 12,
        }),
      );
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const directory = await mkdtemp(join(tmpdir(), 'imbox-run-tools-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const journal = await createFileJournal({ directory, signingKey: secret });
  const tools = createHttpToolRegistry([
    {
      id: 'demo.delivery',
      version: '1',
      targetId: 'fixed-provider',
      executeUrl: `${origin}/execute`,
      lookupUrl: `${origin}/lookup`,
      allowInsecureLoopback: true,
      approvalRequired: true,
      estimateMicrounits: '5',
    },
  ]);
  const actions = createActionService({
    db: dbs.db,
    tools,
    journal,
    cursorSecret: secret,
    sources,
  });
  const grant = await actions.createGrant(
    base.alice,
    {
      task_id: task.id,
      executor_principal_id: base.agentId,
      tool_id: 'demo.delivery',
      tool_version: '1',
      target_id: 'fixed-provider',
      allow_execute: true,
      allow_disclosure: true,
      resource_versions: refs,
      approver_principal_ids: [base.alice.principalId],
      budget: { currency: 'USD', limit_microunits: '50' },
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    },
    key(),
  );
  const adapter = createOllamaAdapter({
    origin,
    model: 'qwen3:0.6b',
    digest,
    allowLoopbackHttp: true,
  });
  const driver = createModelDriver({
    worker: base.worker,
    actions,
    models: new Map([['local', adapter]]),
    heartbeatMs: 25,
  });
  const input = {
    agent_id: base.installation.id,
    agent_revision: '1',
    task_id: task.id,
    tool_grant_id: grant.id,
    context: refs.map((ref) => ({ ...ref, required: true })),
    purpose: 'Propose sending IMBOX_TOOL_OK to the fixed provider; wait for approval.',
    destination: 'model:local',
    budget: { currency: 'USD', limit_microunits: '50' },
  };
  const createRun = () => base.runtime.createRun(base.alice, input, key());
  const approve = async (actionId: string) => {
    const action = await actions.getAction(base.alice, actionId);
    return actions.decideApproval(
      base.alice,
      actionId,
      {
        decision: 'approve',
        action_version: action.approval!.action_version,
        fingerprint: action.fingerprint,
        comment: 'Explicitly reviewed the fixed target and exact text.',
      },
      action.version,
      key(),
    );
  };
  const resume = async (runId: string) => {
    const run = await base.runtime.getRun(base.alice, runId);
    return base.runtime.controlRun(base.alice, runId, 'resume', run.version, key());
  };
  return {
    ...base,
    file,
    deliveredTexts,
    task,
    tasks,
    grant,
    actions,
    journal,
    adapter,
    driver,
    input,
    createRun,
    approve,
    resume,
    posts: () => posts,
    generations: () => generations,
    loseResponse: () => {
      loseResponse = true;
    },
    modelFinal: () => {
      modelDecision = { kind: 'final', text: 'No tool needed.' };
    },
  };
}
describe('bounded structured model intention, explicit human approval and fresh leased execution', () => {
  it('publishes a fixed artifact from the hosted structured model path only after human approval and resume', async () => {
    fixture = await setup(true);
    const run = await fixture.createRun();
    expect(await fixture.driver.execute(fixture.tenantId, run.id)).toBe('waiting');
    const action = await fixture.actions.getRunIntent(fixture.alice, run.id);
    expect(action.resource_versions).toContainEqual({
      type: 'artifact_version',
      id: fixture.file!.version_id,
      version: fixture.file!.head_version,
      sha256: fixture.file!.resource.sha256,
    });
    expect(fixture.posts()).toBe(0);
    await fixture.approve(action.id);
    await fixture.resume(run.id);
    expect(await fixture.driver.execute(fixture.tenantId, run.id)).toBe('completed');
    expect(fixture.deliveredTexts).toEqual(['IMBOX_TOOL_OK']);
    expect(fixture.posts()).toBe(1);
  });
  it('persists one Action then requires human resume and charges both Run and Task exactly once', async () => {
    const run = await fixture.createRun();
    expect(await fixture.driver.execute(fixture.tenantId, run.id)).toBe('waiting');
    expect(fixture.generations()).toBe(1);
    expect(fixture.posts()).toBe(0);
    const action = await fixture.actions.getRunIntent(fixture.alice, run.id);
    expect(action.status).toBe('awaiting_approval');
    await expect(fixture.resume(run.id)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    await fixture.approve(action.id);
    expect(await fixture.actions.pending(fixture.tenantId)).not.toContain(action.id);
    expect(await fixture.driver.execute(fixture.tenantId, run.id)).toBe('fenced');
    expect(fixture.posts()).toBe(0);
    await fixture.resume(run.id);
    expect(await fixture.driver.execute(fixture.tenantId, run.id)).toBe('completed');
    expect(fixture.posts()).toBe(1);
    expect(fixture.generations()).toBe(2);
    expect(await fixture.runtime.getRun(fixture.alice, run.id)).toMatchObject({
      status: 'completed',
      budget: { spent_microunits: '7', reserved_microunits: '0' },
    });
    expect((await fixture.tasks.getTask(fixture.alice, fixture.task.id)).budget).toMatchObject({
      spent_microunits: '7',
      reserved_microunits: '0',
    });
    const facts = await withTenant(dbs.db, fixture.tenantId, (tx) =>
      sql`select * from action_budget_reservations where run_id=${run.id}`.execute(tx),
    );
    expect(facts.rows).toHaveLength(1);
    const intents = (await fixture.journal.records(fixture.tenantId)).filter(
      (record) => record.kind === 'intent',
    );
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ run_id: run.id });
  });
  it('replays a lost proposal response without a second Action but rejects a changed intent', async () => {
    const run = await fixture.createRun(),
      claim = (await fixture.worker.claim(fixture.tenantId, run.id))!;
    const [one, two] = await Promise.all([
      fixture.actions.proposeForRun(claim, 'One exact action'),
      fixture.actions.proposeForRun(claim, 'One exact action'),
    ]);
    expect(two.id).toBe(one.id);
    await expect(fixture.actions.proposeForRun(claim, 'A changed action')).rejects.toMatchObject({
      status: 409,
    });
    expect((await fixture.actions.listActions(fixture.alice)).items).toHaveLength(1);
    await fixture.approve(one.id);
    await fixture.resume(run.id);
    const next = (await fixture.worker.claim(fixture.tenantId, run.id))!;
    expect(next.generation).not.toBe(claim.generation);
    await expect(
      createToolRunner({ actions: fixture.actions, workerId: 'stale' }).runOnce(
        fixture.tenantId,
        one.id,
        claim,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(fixture.posts()).toBe(0);
  });
  it('holds unknown tool cost and blocks resume and any blind redispatch', async () => {
    fixture.loseResponse();
    const run = await fixture.createRun();
    await fixture.driver.execute(fixture.tenantId, run.id);
    const action = await fixture.actions.getRunIntent(fixture.alice, run.id);
    await fixture.approve(action.id);
    await fixture.resume(run.id);
    expect(await fixture.driver.execute(fixture.tenantId, run.id)).toBe('waiting');
    expect(fixture.posts()).toBe(1);
    expect(fixture.generations()).toBe(1);
    expect(await fixture.runtime.getRun(fixture.alice, run.id)).toMatchObject({
      status: 'waiting_dependency',
      budget: { reserved_microunits: '5', spent_microunits: '0' },
    });
    await expect(fixture.resume(run.id)).rejects.toMatchObject({ code: 'ACTION_OUTCOME_UNKNOWN' });
    expect(await fixture.driver.execute(fixture.tenantId, run.id)).toBe('fenced');
    expect(fixture.posts()).toBe(1);
    const unknown = await fixture.actions.getAction(fixture.alice, action.id);
    const reconciled = await fixture.actions.reconcile(
      fixture.alice,
      action.id,
      { reason: 'Check the original provider receipt' },
      unknown.version,
      key(),
    );
    expect(reconciled.outcome).toBe('succeeded');
    await fixture.resume(run.id);
    expect(await fixture.driver.execute(fixture.tenantId, run.id)).toBe('completed');
    expect(fixture.posts()).toBe(1);
    expect(fixture.generations()).toBe(2);
    expect((await fixture.runtime.getRun(fixture.alice, run.id)).budget).toMatchObject({
      reserved_microunits: '0',
      spent_microunits: '7',
    });
  });
  it('rejects scheduling a tool-authorized Run so approval cannot be followed by an automatic resume', async () => {
    const run = await fixture.createRun();
    await fixture.runtime.controlRun(fixture.alice, run.id, 'pause', run.version, key());
    const schedules = createSchedulingService({ db: dbs.db, cursorSecret: secret });
    await expect(
      schedules.create(
        fixture.alice,
        {
          task_id: fixture.task.id,
          run_id: run.id,
          timezone: 'UTC',
          trigger: { kind: 'once' },
          start_at: new Date(Date.now() + 60000).toISOString(),
          deadline: new Date(Date.now() + 3600000).toISOString(),
          missed_policy: 'coalesce',
          maximum_wakeups: 1,
        },
        key(),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fixture.posts()).toBe(0);
  });
  it('cancels an approved but undispatched bound Action with the Run', async () => {
    const run = await fixture.createRun();
    await fixture.driver.execute(fixture.tenantId, run.id);
    const action = await fixture.actions.getRunIntent(fixture.alice, run.id);
    await fixture.approve(action.id);
    const current = await fixture.runtime.getRun(fixture.alice, run.id);
    await fixture.runtime.controlRun(fixture.alice, run.id, 'cancel', current.version, key());
    expect((await fixture.actions.getAction(fixture.alice, action.id)).status).toBe('cancelled');
    await expect(
      createToolRunner({ actions: fixture.actions, workerId: 'not-a-run' }).runOnce(
        fixture.tenantId,
        action.id,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fixture.posts()).toBe(0);
  });
  it('finishes a structured final response without manufacturing a tool effect', async () => {
    fixture.modelFinal();
    const run = await fixture.createRun();
    expect(await fixture.driver.execute(fixture.tenantId, run.id)).toBe('completed');
    expect(fixture.posts()).toBe(0);
    expect(fixture.generations()).toBe(1);
    expect((await fixture.actions.listActions(fixture.alice)).items).toHaveLength(0);
  });
  it('rejects mixed source disclosure before a tool-enabled Run is queued', async () => {
    await expect(
      fixture.runtime.createRun(
        fixture.alice,
        {
          ...fixture.input,
          context: [
            ...fixture.input.context,
            {
              type: 'message',
              id: fixture.message.id,
              version: fixture.message.version,
              required: true,
            },
          ],
        },
        key(),
      ),
    ).rejects.toMatchObject({ code: 'DISCLOSURE_DENIED' });
    expect(fixture.generations()).toBe(0);
    expect(fixture.posts()).toBe(0);
  });
});
