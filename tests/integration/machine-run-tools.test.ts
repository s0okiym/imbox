import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect } from 'vitest';
import { createActionService, createFileJournal, createHttpToolRegistry } from '@imbox/actions';
import { createAgentService } from '@imbox/agents';
import { createIdentityService } from '@imbox/auth';
import { createTaskService } from '@imbox/application';
import { createRuntimeService } from '@imbox/runtime';
import {
  createKnowledgeService,
  knowledgeRuntimeSourcePort,
  knowledgeResourceIndex,
} from '@imbox/knowledge';
import { createResourceService, createS3ObjectStore } from '@imbox/resources';
import { MACHINE_SCOPES, assertContract, type ContractTypes as C } from '@imbox/contracts';
import { sql, withTenant } from '@imbox/db';
import { createApp } from '../../apps/api/src/app.js';
import { testDatabases, tenantFixture } from '../helpers/database.js';
const key = randomUUID,
  secret = 'machine-run-tools-secret-at-least-thirty-two';
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
let databases: Awaited<ReturnType<typeof testDatabases>>;
let f: Awaited<ReturnType<typeof setup>>;
const cleanups: Array<() => Promise<void>> = [];
beforeAll(async () => {
  databases = await testDatabases();
  await adminStore.ensureDevelopmentBucket('test');
});
afterAll(async () => {
  store.destroy();
  adminStore.destroy();
  await databases.close();
});
beforeEach(async () => {
  f = await setup();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function setup(artifactBody?: string, approvalRequired = true) {
  const base = await tenantFixture(databases.owner);
  const sources = knowledgeRuntimeSourcePort(
    createKnowledgeService({ db: databases.db, cursorSecret: secret }),
  );
  const resources = createResourceService({
    db: databases.db,
    store,
    cursorSecret: secret,
    textIndex: knowledgeResourceIndex(),
  });
  const agents = createAgentService({
    db: databases.db,
    identityDb: databases.identityDb,
    secret,
    sources,
  });
  const runtime = createRuntimeService({ db: databases.db, sources });
  const tasks = createTaskService(databases.db, secret);
  const installed = await agents.register(
    base.alice,
    {
      workspace_id: base.workspaceId,
      display_name: 'Leased external operator',
      mode: 'external',
      scopes: [...MACHINE_SCOPES],
      capabilities: ['tool_intent'],
      config: {},
    },
    key(),
  );
  const credential = await agents.issueCredential(
    base.alice,
    installed.id,
    { scopes: [...MACHINE_SCOPES], lifetime_seconds: 3600 },
    key(),
  );
  const token = await agents.exchange({
    credential: credential.secret!,
    scopes: [...MACHINE_SCOPES],
  });
  let posts = 0;
  const deliveredTexts: unknown[] = [];
  const provider = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    let body = '';
    request.on('data', (chunk) => (body += String(chunk)));
    request.on('end', () => {
      if (request.method !== 'POST') {
        response.end(JSON.stringify({ status: 'not_found' }));
        return;
      }
      posts++;
      const data = JSON.parse(body) as Record<string, unknown>;
      deliveredTexts.push((data.input as { text: string }).text);
      response.end(
        JSON.stringify({
          status: 'succeeded',
          receipt_id: `receipt:${String(data.business_key)}`,
          fingerprint: data.fingerprint,
          cost_microunits: '3',
          safe_retry: false,
          tenant_id: data.tenant_id,
          action_id: data.action_id,
          attempt_id: data.attempt_id,
        }),
      );
    });
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  cleanups.push(async () => {
    provider.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      provider.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const providerOrigin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  const directory = await mkdtemp(join(tmpdir(), 'imbox-machine-tool-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const actions = createActionService({
    db: databases.db,
    cursorSecret: secret,
    sources,
    journal: await createFileJournal({ directory, signingKey: secret }),
    tools: createHttpToolRegistry([
      {
        id: 'delivery',
        version: '1',
        targetId: 'fixed',
        executeUrl: `${providerOrigin}/execute`,
        lookupUrl: `${providerOrigin}/lookup`,
        approvalRequired,
        estimateMicrounits: '3',
        allowInsecureLoopback: true,
      },
    ]),
  });
  let task = await tasks.createTask(
    base.alice,
    {
      workspace_id: base.workspaceId,
      title: 'Leased external action',
      goal: 'Send one approved marker',
      acceptance_criteria: ['Provider receipt'],
      reviewer_principal_ids: [base.alice.principalId],
      budget: { currency: 'USD', limit_microunits: '100' },
    },
    key(),
  );
  task = await tasks.changeParticipant(
    base.alice,
    task.id,
    installed.principal_id,
    'contributor',
    task.version,
    key(),
  );
  task = await tasks.changeState(base.alice, task.id, { state: 'active' }, task.version, key());
  const refs: C['ActionResourceRef'][] = [{ type: 'task', id: task.id, version: task.version }];
  let file: C['StoredArtifact'] | null = null;
  if (artifactBody !== undefined) {
    const bytes = Buffer.from(artifactBody);
    const ticket = await resources.createUpload(
      base.alice,
      {
        task_id: task.id,
        filename: 'agent-publication.md',
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
      { resource_id: content.id, title: 'Agent fixed publication' },
      key(),
    );
    refs.push({
      type: 'artifact_version',
      id: file.version_id,
      version: file.head_version,
      sha256: file.resource.sha256,
    });
  }
  const grant = await actions.createGrant(
    base.alice,
    {
      task_id: task.id,
      executor_principal_id: installed.principal_id,
      tool_id: 'delivery',
      tool_version: '1',
      target_id: 'fixed',
      allow_execute: true,
      allow_disclosure: true,
      resource_versions: refs,
      approver_principal_ids: [base.alice.principalId],
      budget: { currency: 'USD', limit_microunits: '50' },
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    },
    key(),
  );
  const run = await runtime.createRun(
    base.alice,
    {
      agent_id: installed.id,
      agent_revision: '1',
      task_id: task.id,
      tool_grant_id: grant.id,
      context: refs.map((ref) => ({ ...ref, required: true })),
      purpose: 'Propose the explicitly approved text',
      destination: `agent:${installed.id}`,
      budget: { currency: 'USD', limit_microunits: '50' },
    },
    key(),
  );
  const identity = createIdentityService({
    db: databases.db,
    identityDb: databases.identityDb,
    sessionSecret: secret,
    publicOrigin: 'http://127.0.0.1:4700',
    environment: 'test',
    enableDevAuth: true,
    devPrincipalIds: base.ids.slice(),
  });
  const app = createApp({ identity, agents, runtime, actions, tasks, readiness: async () => {} });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  cleanups.push(() => app.close());
  async function http(
    suffix: string,
    body?: unknown,
    access = token.access_token,
    extra: Record<string, string> = {},
  ) {
    return fetch(`${origin}/v1/machine/agent-runs/${run.id}${suffix}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${access}`,
        'x-imbox-tenant-id': base.tenantId,
        ...(body === undefined
          ? {}
          : { 'content-type': 'application/json', 'idempotency-key': key() }),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function claim() {
    const response = await http('/claim', {});
    expect(response.status).toBe(200);
    return assertContract('MachineClaim', await response.json()).lease!;
  }
  async function approve() {
    const action = await actions.getRunIntent(base.alice, run.id);
    await actions.decideApproval(
      base.alice,
      action.id,
      {
        decision: 'approve',
        action_version: action.approval!.action_version,
        fingerprint: action.fingerprint,
        comment: 'Human approves the exact target and content.',
      },
      action.version,
      key(),
    );
    return action;
  }
  async function resume() {
    const current = await runtime.getRun(base.alice, run.id);
    await runtime.controlRun(base.alice, run.id, 'resume', current.version, key());
  }
  return {
    ...base,
    resources,
    grant,
    file,
    deliveredTexts,
    installed,
    credential,
    token,
    agents,
    runtime,
    actions,
    task,
    run,
    http,
    claim,
    approve,
    resume,
    posts: () => posts,
  };
}
describe('machine tool intention and execution HTTP leases', () => {
  it('publishes a fixed artifact through the external machine lease after exact approval and explicit resume', async () => {
    f = await setup('EXTERNAL_ARTIFACT_ONCE');
    const lease = await f.claim();
    expect(
      (
        await f.http('/tool-intents', {
          generation: lease.generation,
          text: 'Substituted model text',
        })
      ).status,
    ).toBe(409);
    const proposal = await f.http('/tool-intents', {
      generation: lease.generation,
      text: 'EXTERNAL_ARTIFACT_ONCE',
    });
    expect(proposal.status).toBe(201);
    const action = assertContract('Action', await proposal.json());
    expect(action.resource_versions).toContainEqual({
      type: 'artifact_version',
      id: f.file!.version_id,
      version: f.file!.head_version,
      sha256: f.file!.resource.sha256,
    });
    expect(action.status).toBe('awaiting_approval');
    await f.approve();
    expect((await f.http('/tool-execution', { generation: lease.generation })).status).toBe(409);
    await f.resume();
    const next = await f.claim();
    expect((await f.http('/tool-execution', { generation: next.generation })).status).toBe(200);
    expect((await f.http('/tool-execution', { generation: next.generation })).status).toBe(200);
    expect(f.posts()).toBe(1);
    expect(f.deliveredTexts).toEqual(['EXTERNAL_ARTIFACT_ONCE']);
  });
  it('refuses an approved external artifact after source deletion even with the current machine lease', async () => {
    f = await setup('REVOKED_ARTIFACT');
    const lease = await f.claim();
    expect(
      (await f.http('/tool-intents', { generation: lease.generation, text: 'REVOKED_ARTIFACT' }))
        .status,
    ).toBe(201);
    await f.approve();
    await f.resume();
    const next = await f.claim();
    await f.resources.deleteResource(f.alice, f.file!.resource.id, f.file!.resource.version, key());
    expect((await f.http('/tool-execution', { generation: next.generation })).status).toBe(404);
    expect(f.posts()).toBe(0);
  });
  it('rejects artifact publication through an approval-free tool for both direct and machine actions', async () => {
    f = await setup('REQUIRES_HUMAN_APPROVAL', false);
    const lease = await f.claim();
    expect(
      (
        await f.http('/tool-intents', {
          generation: lease.generation,
          text: 'REQUIRES_HUMAN_APPROVAL',
        })
      ).status,
    ).toBe(403);
    await expect(
      f.actions.createAction(
        f.alice,
        {
          task_id: f.task.id,
          grant_id: f.grant.id,
          executor_principal_id: f.installed.principal_id,
          tool_id: 'delivery',
          tool_version: '1',
          target_id: 'fixed',
          parameters: { text: 'REQUIRES_HUMAN_APPROVAL' },
          resource_versions: f.grant.resource_versions,
          business_key: key(),
          estimate: { currency: 'USD', limit_microunits: '3' },
        },
        key(),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.posts()).toBe(0);
  });
  it('cannot execute merely because a human approved; explicit human resume and new lease are required', async () => {
    const lease = await f.claim();
    const proposed = await f.http('/tool-intents', {
      generation: lease.generation,
      text: 'EXTERNAL_ONCE',
    });
    expect(proposed.status).toBe(201);
    const action = assertContract('Action', await proposed.json());
    expect(action.status).toBe('awaiting_approval');
    expect(
      (await f.http('/tool-intents', { generation: lease.generation, text: 'EXTERNAL_ONCE' }))
        .status,
    ).toBe(201);
    expect((await f.http('/tool-execution', { generation: lease.generation })).status).toBe(409);
    await f.approve();
    expect((await f.http('/tool-execution', { generation: lease.generation })).status).toBe(409);
    expect(f.posts()).toBe(0);
    expect((await f.http('/resume', {})).status).toBe(404);
    await f.resume();
    const current = await f.claim();
    expect(current.generation).not.toBe(lease.generation);
    expect((await f.http('/tool-execution', { generation: lease.generation })).status).toBe(409);
    const result = await f.http('/tool-execution', { generation: current.generation });
    expect(result.status).toBe(200);
    expect(assertContract('Action', await result.json()).status).toBe('succeeded');
    expect((await f.http('/tool-execution', { generation: current.generation })).status).toBe(200);
    expect(f.posts()).toBe(1);
    expect((await f.runtime.getRun(f.alice, f.run.id)).budget.spent_microunits).toBe('3');
  });
  it('requires scope, matching credential holder and unexpired DB lease for every proposal', async () => {
    const lease = await f.claim();
    const narrow = await f.agents.exchange({
      credential: f.credential.secret!,
      scopes: ['runs.read'],
    });
    expect(
      (
        await f.http(
          '/tool-intents',
          { generation: lease.generation, text: 'NO' },
          narrow.access_token,
        )
      ).status,
    ).toBe(403);
    const other = await f.agents.issueCredential(
      f.alice,
      f.installed.id,
      { scopes: ['runs.tools', 'runs.execute'], lifetime_seconds: 600 },
      key(),
    );
    const token = await f.agents.exchange({
      credential: other.secret!,
      scopes: ['runs.tools', 'runs.execute'],
    });
    expect(
      (
        await f.http(
          '/tool-intents',
          { generation: lease.generation, text: 'NO' },
          token.access_token,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await f.http(
          '/tool-intents',
          { generation: lease.generation, text: 'NO' },
          f.token.access_token,
          { cookie: 'imbox_session=bad' },
        )
      ).status,
    ).toBe(401);
    await withTenant(databases.owner, f.tenantId, (tx) =>
      sql`update agent_runs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${f.run.id}`.execute(
        tx,
      ),
    );
    expect(
      (await f.http('/tool-intents', { generation: lease.generation, text: 'NO' })).status,
    ).toBe(409);
    expect(f.posts()).toBe(0);
  });
  it('rejects payload authority injection and blocks execution after token revocation', async () => {
    const lease = await f.claim();
    expect(
      (
        await f.http('/tool-intents', {
          generation: lease.generation,
          text: 'NO',
          target_id: 'attacker',
          executor_principal_id: f.bob.principalId,
        })
      ).status,
    ).toBe(400);
    await f.http('/tool-intents', { generation: lease.generation, text: 'WAIT' });
    await f.approve();
    await f.resume();
    const current = await f.claim();
    await f.agents.revokeCredential(f.alice, f.credential.credential.id, key());
    expect((await f.http('/tool-execution', { generation: current.generation })).status).toBe(401);
    expect(f.posts()).toBe(0);
  });
});
