import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { createAgentService, type AgentService } from '@imbox/agents';
import { ImboxAgentClient } from '@imbox/agent-sdk';
import { createIdentityService } from '@imbox/auth';
import {
  createMessagingService,
  createTaskService,
  type MessagingService,
  type TaskService,
} from '@imbox/application';
import {
  createRuntimeService,
  createRuntimeWorker,
  createRuntimeMaintenance,
  type RuntimeService,
} from '@imbox/runtime';
import { withTenant, sql } from '@imbox/db';
import { MACHINE_SCOPES, type ContractTypes as C } from '@imbox/contracts';
import { createApp } from '../../apps/api/src/app.js';
import { testDatabases, tenantFixture } from '../helpers/database.js';
const key = () => randomUUID();
const secret = 'machine-test-hash-secret-longer-than-thirty-two-characters';
let databases: Awaited<ReturnType<typeof testDatabases>>;
let f: Awaited<ReturnType<typeof tenantFixture>>;
let agents: AgentService;
let runtime: RuntimeService;
let messaging: MessagingService;
let tasks: TaskService;
let app: ReturnType<typeof createApp>;
let origin: string;
beforeAll(async () => {
  databases = await testDatabases();
});
afterAll(async () => {
  await databases?.close();
});
beforeEach(async () => {
  f = await tenantFixture(databases.owner);
  agents = createAgentService({ db: databases.db, identityDb: databases.identityDb, secret });
  runtime = createRuntimeService({ db: databases.db });
  messaging = createMessagingService(databases.db, secret);
  tasks = createTaskService(databases.db, secret);
  const identity = createIdentityService({
    db: databases.db,
    identityDb: databases.identityDb,
    sessionSecret: secret,
    publicOrigin: 'http://127.0.0.1:4700',
    environment: 'test',
    enableDevAuth: true,
    devPrincipalIds: f.ids.slice(),
  });
  app = createApp({ identity, agents, runtime, messaging, tasks, readiness: async () => {} });
  origin = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterEach(async () => {
  await app?.close();
});
function registration(): C['RegisterAgentInput'] {
  return {
    workspace_id: f.workspaceId,
    display_name: 'External assistant',
    mode: 'external',
    scopes: [...MACHINE_SCOPES],
    capabilities: ['text_generation'],
    config: {},
  };
}
async function agent(scopes: C['IssueAgentCredentialInput']['scopes'] = [...MACHINE_SCOPES]) {
  const installed = await agents.register(f.alice, registration(), key());
  const credential = await agents.issueCredential(
    f.alice,
    installed.id,
    { scopes, lifetime_seconds: 3600 },
    key(),
  );
  const client = new ImboxAgentClient({ origin, tenantId: f.tenantId, allowLoopbackHttp: true });
  await client.exchange({ credential: credential.secret!, scopes });
  const token = await agents.exchange({ credential: credential.secret!, scopes });
  const auth = await agents.authenticate(`Bearer ${token.access_token}`, f.tenantId, scopes[0]);
  return { installed, credential, client, token, auth };
}
async function run(a: Awaited<ReturnType<typeof agent>>, budget = '0') {
  const chat = await messaging.createConversation(
    f.alice,
    { workspace_id: f.workspaceId, kind: 'group', member_ids: [a.installed.principal_id] },
    key(),
  );
  const message = await messaging.createMessage(
    f.alice,
    chat.id,
    { client_message_id: key(), body: 'Explicitly disclosed context' },
    key(),
  );
  const created = await runtime.createRun(
    f.alice,
    {
      agent_id: a.installed.id,
      agent_revision: '1',
      conversation_id: chat.id,
      context: [{ type: 'message', id: message.id, version: message.version, required: true }],
      purpose: 'Read the explicit reference',
      destination: `agent:${a.installed.id}`,
      budget: { currency: 'USD', limit_microunits: budget },
    },
    key(),
  );
  return { created, chat, message };
}
async function http(
  a: Awaited<ReturnType<typeof agent>>,
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
) {
  return fetch(`${origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${a.token.access_token}`,
      'x-imbox-tenant-id': f.tenantId,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
describe('M4 machine identity and real HTTP external execution', () => {
  it('provisions one identity across concurrent retries and does not grant conversation or task access', async () => {
    const input = registration(),
      k = key();
    const rows = await Promise.all(
      Array.from({ length: 4 }, () => agents.register(f.alice, input, k)),
    );
    expect(new Set(rows.map((r) => r.id)).size).toBe(1);
    await expect(
      agents.register(f.alice, { ...input, display_name: 'changed' }, k),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(agents.register(f.bob, input, key())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const a = await agent();
    const privateChat = await messaging.createConversation(
      f.alice,
      { workspace_id: f.workspaceId, kind: 'group', member_ids: [f.bob.principalId] },
      key(),
    );
    await expect(a.client.listMessages(privateChat.id)).rejects.toMatchObject({ status: 404 });
    expect(
      (await a.client.directory(f.workspaceId)).items.some((x) => x.id === a.installed.id),
    ).toBe(true);
  });
  it('stores only credential/token hashes and withholds one-time secrets on replay', async () => {
    const installed = await agents.register(f.alice, registration(), key()),
      k = key();
    const input: C['IssueAgentCredentialInput'] = {
      scopes: ['messages.read'],
      lifetime_seconds: 600,
    };
    const issued = await agents.issueCredential(f.alice, installed.id, input, k),
      replay = await agents.issueCredential(f.alice, installed.id, input, k);
    expect(issued.secret_returned).toBe(true);
    expect(replay).toMatchObject({
      secret: null,
      secret_returned: false,
      credential: { id: issued.credential.id },
    });
    await expect(
      agents.exchange({ credential: issued.secret!, scopes: ['messages.write'] }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const token = await agents.exchange({ credential: issued.secret!, scopes: ['messages.read'] });
    await withTenant(databases.db, f.tenantId, async (tx) => {
      const records = (
        await sql`select row_to_json(c) as data from agent_credentials c union all select row_to_json(t) from agent_access_tokens t`.execute(
          tx,
        )
      ).rows;
      expect(JSON.stringify(records)).not.toContain(issued.secret!);
      expect(JSON.stringify(records)).not.toContain(token.access_token);
    });
  });
  it('binds message authors server-side, deduplicates writes and enforces token scope and tenant', async () => {
    const a = await agent(['messages.read', 'messages.write']);
    const { chat } = await run(a),
      k = key(),
      body = { client_message_id: key(), body: 'Machine says hello' };
    const sent = await a.client.sendMessage(chat.id, body, k);
    expect((await a.client.sendMessage(chat.id, body, k)).id).toBe(sent.id);
    expect(sent.actor.id).toBe(a.installed.principal_id);
    expect(
      (
        await http(
          a,
          `/v1/machine/conversations/${chat.id}/messages`,
          { ...body, actor_id: f.alice.principalId },
          { 'idempotency-key': key() },
        )
      ).status,
    ).toBe(400);
    expect((await http(a, '/v1/machine/agent-runs')).status).toBe(403);
    expect(
      (
        await http(a, `/v1/machine/conversations/${chat.id}/messages`, undefined, {
          'x-imbox-tenant-id': key(),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await http(a, `/v1/machine/conversations/${chat.id}/messages`, undefined, {
          cookie: 'imbox_session=invalid',
        })
      ).status,
    ).toBe(401);
  });
  it('revokes already-authenticated contexts inside business transactions and expires tokens by database clock', async () => {
    const a = await agent();
    const { chat } = await run(a);
    await agents.revokeCredential(f.alice, a.credential.credential.id, key());
    await expect(a.client.listMessages(chat.id)).rejects.toMatchObject({ status: 401 });
    await expect(messaging.listMessages(a.auth, chat.id)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    await expect(
      agents.exchange({ credential: a.credential.secret!, scopes: ['messages.read'] }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const b = await agent();
    const { chat: other } = await run(b);
    await withTenant(databases.owner, f.tenantId, async (tx) => {
      await sql`update agent_access_tokens set expires_at=clock_timestamp()-interval '1 second' where installation_id=${b.installed.id}`.execute(
        tx,
      );
    });
    await expect(b.client.listMessages(other.id)).rejects.toMatchObject({ status: 401 });
  });
  it('idempotently claims a lease, rejects other agents and fences expired/rotated workers', async () => {
    const a = await agent(),
      b = await agent();
    const { created } = await run(a);
    const k = key();
    const claim = await a.client.claim(created.id, k);
    expect(claim.lease).not.toBeNull();
    expect(await a.client.claim(created.id, k)).toEqual(claim);
    await expect(a.client.claim(created.id, key())).rejects.toMatchObject({ status: 409 });
    await expect(b.client.claim(created.id, key())).rejects.toMatchObject({ status: 404 });
    expect(
      (await a.client.heartbeat(created.id, claim.lease!.generation)).cancellation_requested,
    ).toBe(false);
    await withTenant(databases.owner, f.tenantId, async (tx) => {
      await sql`update agent_runs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${created.id}`.execute(
        tx,
      );
    });
    await expect(a.client.heartbeat(created.id, claim.lease!.generation)).rejects.toMatchObject({
      status: 409,
    });
    const second = await a.client.claim(created.id, key());
    expect(BigInt(second.lease!.generation)).toBe(BigInt(claim.lease!.generation) + 1n);
    await expect(a.client.claim(created.id, k)).rejects.toMatchObject({ status: 409 });
    await agents.revokeCredential(f.alice, a.credential.credential.id, key());
    await expect(
      agents.heartbeat(a.auth, created.id, second.lease!.generation),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
  it('marks completed external reports as unverified and rechecks authorization on report replay', async () => {
    const a = await agent();
    const { created } = await run(a);
    const { lease } = await a.client.claim(created.id, key());
    const k = key();
    const body: C['MachineReportInput'] = {
      generation: lease!.generation,
      status: 'completed',
      checkpoint: { step: 'done' },
      output: 'Externally produced answer',
    };
    const result = await a.client.report(created.id, body, k);
    expect(result).toMatchObject({
      status: 'completed',
      report_source: 'external_report',
      execution_location: 'external',
    });
    expect((await a.client.report(created.id, body, k)).version).toBe(result.version);
    await agents.revokeCredential(f.alice, a.credential.credential.id, key());
    await expect(agents.report(a.auth, created.id, body, k)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });
  it('distinguishes platform cancellation from a reconnected external worker acknowledgement and retries a lost receipt once', async () => {
    const a = await agent();
    const { created } = await run(a);
    const claim = await a.client.claim(created.id, key());
    const running = await runtime.getRun(f.alice, created.id);
    const cancelling = await runtime.controlRun(
      f.alice,
      created.id,
      'cancel',
      running.version,
      key(),
    );
    expect(cancelling).toMatchObject({ status: 'cancelling', cancellation_acknowledged_at: null });
    let reports = 0;
    const recovered = new ImboxAgentClient({
      origin,
      tenantId: f.tenantId,
      allowLoopbackHttp: true,
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (String(input).endsWith(`/agent-runs/${created.id}/reports`) && response.ok) {
          reports++;
          if (reports === 1) {
            await response.body?.cancel();
            throw new TypeError('Receipt lost after cancellation acknowledgement commit');
          }
        }
        return response;
      },
    });
    await recovered.exchange({ credential: a.credential.secret!, scopes: [...MACHINE_SCOPES] });
    expect(
      (await recovered.heartbeat(created.id, claim.lease!.generation)).cancellation_requested,
    ).toBe(true);
    await expect(
      recovered.report(
        created.id,
        {
          generation: claim.lease!.generation,
          status: 'completed',
          checkpoint: {},
          output: 'Must not publish after cancellation',
        },
        key(),
      ),
    ).rejects.toMatchObject({ status: 409 });
    const reportKey = key();
    const body: C['MachineReportInput'] = {
      generation: claim.lease!.generation,
      status: 'cancelled',
      checkpoint: { stopped: true },
    };
    const stopped = await recovered.report(created.id, body, reportKey);
    expect(reports).toBe(2);
    expect(stopped).toMatchObject({
      status: 'cancelled',
      execution_location: 'external',
      report_source: 'external_report',
      output: null,
      cancellation_acknowledged_at: expect.any(String),
    });
    expect((await recovered.report(created.id, body, reportKey)).cancellation_acknowledged_at).toBe(
      stopped.cancellation_acknowledged_at,
    );
    const stored = await withTenant(databases.db, f.tenantId, (tx) =>
      sql<{ count: string }>`select count(*) from run_reports where run_id=${created.id}`.execute(
        tx,
      ),
    );
    expect(stored.rows[0]!.count).toBe('1');
    const offline = await run(a);
    const stale = await a.client.claim(offline.created.id, key());
    await withTenant(databases.owner, f.tenantId, (tx) =>
      sql`update agent_runs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${offline.created.id}`.execute(
        tx,
      ),
    );
    const before = await runtime.getRun(f.alice, offline.created.id);
    const platformCancelled = await runtime.controlRun(
      f.alice,
      before.id,
      'cancel',
      before.version,
      key(),
    );
    expect(platformCancelled).toMatchObject({
      status: 'cancelled',
      cancellation_acknowledged_at: null,
    });
    await expect(
      a.client.report(
        before.id,
        { generation: stale.lease!.generation, status: 'cancelled', checkpoint: { stopped: true } },
        key(),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect((await runtime.getRun(f.alice, before.id)).cancellation_acknowledged_at).toBeNull();
    const late = await a.client.acknowledgeCancellation(before.id, stale.lease!.generation, key());
    expect(await runtime.getRun(f.alice, before.id)).toMatchObject({
      status: 'cancelled',
      cancellation_acknowledged_at: late.acknowledged_at,
    });
  });
  it('accepts only the last external worker late stop acknowledgement without restoring execution or publishing output', async () => {
    const a = await agent(),
      other = await agent();
    const { created } = await run(a, '100');
    const first = await a.client.claim(created.id, key());
    await withTenant(databases.owner, f.tenantId, (tx) =>
      sql`update agent_runs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${created.id}`.execute(
        tx,
      ),
    );
    await expect(
      a.client.acknowledgeCancellation(created.id, first.lease!.generation, key()),
    ).rejects.toMatchObject({ status: 409 });
    const latest = await a.client.claim(created.id, key());
    const holder = `external:${a.installed.id}:${a.credential.credential.id}`;
    const accounting = createRuntimeWorker({ db: databases.db, workerId: holder });
    const reservation = await accounting.reserve(
      { tenantId: f.tenantId, runId: created.id, holder, generation: latest.lease!.generation },
      { reservation_key: key(), amount_microunits: '5', currency: 'USD' },
    );
    const current = await runtime.getRun(f.alice, created.id);
    await runtime.controlRun(f.alice, created.id, 'cancel', current.version, key());
    await expect(
      a.client.acknowledgeCancellation(created.id, latest.lease!.generation, key()),
    ).rejects.toMatchObject({ status: 409 });
    await withTenant(databases.owner, f.tenantId, (tx) =>
      sql`update agent_runs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${created.id}`.execute(
        tx,
      ),
    );
    await expect(
      a.client.acknowledgeCancellation(created.id, first.lease!.generation, key()),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      other.client.acknowledgeCancellation(created.id, latest.lease!.generation, key()),
    ).rejects.toMatchObject({ status: 404 });
    const forged = await http(
      a,
      `/v1/machine/agent-runs/${created.id}/cancellation-ack`,
      { generation: latest.lease!.generation, output: 'No output channel' },
      { 'idempotency-key': key() },
    );
    expect(forged.status).toBe(400);
    const replacementCredential = await agents.issueCredential(
      f.alice,
      a.installed.id,
      { scopes: [...MACHINE_SCOPES], lifetime_seconds: 3600 },
      key(),
    );
    const replacementClient = new ImboxAgentClient({
      origin,
      tenantId: f.tenantId,
      allowLoopbackHttp: true,
    });
    await replacementClient.exchange({
      credential: replacementCredential.secret!,
      scopes: [...MACHINE_SCOPES],
    });
    await expect(
      replacementClient.acknowledgeCancellation(created.id, latest.lease!.generation, key()),
    ).rejects.toMatchObject({ status: 409 });
    const token = key();
    const receipt = await a.client.acknowledgeCancellation(
      created.id,
      latest.lease!.generation,
      token,
    );
    expect(Object.keys(receipt).sort()).toEqual([
      'acknowledged_at',
      'generation',
      'report_source',
      'run_id',
    ]);
    expect(
      await a.client.acknowledgeCancellation(created.id, latest.lease!.generation, token),
    ).toEqual(receipt);
    expect(
      await a.client.acknowledgeCancellation(created.id, latest.lease!.generation, key()),
    ).toEqual(receipt);
    const stopped = await runtime.getRun(f.alice, created.id);
    expect(stopped).toMatchObject({
      status: 'cancelled',
      cancellation_acknowledged_at: receipt.acknowledged_at,
      output: null,
      budget: current.budget,
      lease_generation: latest.lease!.generation,
    });
    expect(stopped.budget.reserved_microunits).toBe('5');
    const retained = await withTenant(databases.db, f.tenantId, (tx) =>
      sql`select status,amount_microunits,actual_microunits from runtime_reservations where id=${reservation.id}`.execute(
        tx,
      ),
    );
    expect(retained.rows).toEqual([
      { status: 'held', amount_microunits: '5', actual_microunits: null },
    ]);
    await expect(a.client.heartbeat(created.id, latest.lease!.generation)).rejects.toMatchObject({
      status: 409,
    });
    await expect(a.client.claim(created.id, key())).rejects.toMatchObject({ status: 409 });
    await expect(
      a.client.report(
        created.id,
        {
          generation: latest.lease!.generation,
          status: 'completed',
          checkpoint: {},
          output: 'late output',
        },
        key(),
      ),
    ).rejects.toMatchObject({ status: 409 });
    const events = await withTenant(databases.db, f.tenantId, (tx) =>
      sql<{
        count: string;
      }>`select count(*) from domain_events where aggregate_id=${created.id} and event_type='run.cancellation_acknowledged' and actor_principal_id=${a.installed.principal_id}`.execute(
        tx,
      ),
    );
    expect(events.rows[0]!.count).toBe('1');
    await agents.revokeCredential(f.alice, a.credential.credential.id, key());
    await expect(
      a.client.acknowledgeCancellation(created.id, latest.lease!.generation, token),
    ).rejects.toMatchObject({ status: 401 });
  });
  it('records late confirmation after platform expiry without replacing the expired state or its generation fence', async () => {
    const a = await agent();
    const { created } = await run(a);
    const claim = await a.client.claim(created.id, key());
    await withTenant(databases.owner, f.tenantId, (tx) =>
      sql`update agent_runs set created_at=clock_timestamp()-interval '2 days' where id=${created.id}`.execute(
        tx,
      ),
    );
    await createRuntimeMaintenance(databases.db)(f.tenantId);
    const expired = await runtime.getRun(f.alice, created.id);
    expect(expired.status).toBe('expired');
    expect(BigInt(expired.lease_generation)).toBeGreaterThan(BigInt(claim.lease!.generation));
    const receipt = await a.client.acknowledgeCancellation(
      created.id,
      claim.lease!.generation,
      key(),
    );
    expect(await runtime.getRun(f.alice, created.id)).toMatchObject({
      status: 'expired',
      lease_generation: expired.lease_generation,
      cancellation_acknowledged_at: receipt.acknowledged_at,
      output: null,
      budget: expired.budget,
    });
  });
  it('does not revive old tokens after global disable/re-enable or installation disable', async () => {
    const a = await agent();
    await databases.identityDb
      .updateTable('principals')
      .set({ status: 'disabled', version: sql`version+1` })
      .where('id', '=', a.installed.principal_id)
      .execute();
    await expect(a.client.directory(f.workspaceId)).rejects.toMatchObject({ status: 401 });
    await databases.identityDb
      .updateTable('principals')
      .set({ status: 'active', version: sql`version+1` })
      .where('id', '=', a.installed.principal_id)
      .execute();
    await expect(a.client.directory(f.workspaceId)).rejects.toMatchObject({ status: 401 });
    await a.client.exchange({ credential: a.credential.secret!, scopes: ['agents.read'] });
    expect((await a.client.directory(f.workspaceId)).items.length).toBeGreaterThan(0);
    await agents.disable(f.alice, a.installed.id, key());
    await expect(a.client.directory(f.workspaceId)).rejects.toMatchObject({ status: 401 });
  });
  it('requires explicit handoff acceptance for human→agent and agent→agent ownership changes', async () => {
    const a = await agent(),
      b = await agent();
    let task = await tasks.createTask(
      f.alice,
      {
        workspace_id: f.workspaceId,
        title: 'Explicit ownership',
        goal: 'Deliver evidence',
        acceptance_criteria: ['Verified result'],
        reviewer_principal_ids: [f.alice.principalId],
        budget: { currency: 'USD', limit_microunits: '0' },
      },
      key(),
    );
    const proposal: C['WorkProposal'] = {
      title: task.title,
      goal: task.goal,
      inputs: [],
      deliverable_schema: 'imbox.text-evidence.v1',
      acceptance: { criteria: ['Verified result'], reviewer_principal_ids: [f.alice.principalId] },
      budget: { currency: 'USD', limit_microunits: '0' },
      allowed_actions: [],
      disclosure: { scope: 'request_recipients', summary: 'Shared work proposal' },
      dependencies: [],
      cancellation_rule: 'owner_or_accountable',
      escalation_principal_id: f.alice.principalId,
      handoff: {
        completed_summary: '',
        pending_summary: 'All work remains',
        pending_action_ids: [],
      },
    };
    const request = await tasks.createRequest(
      f.alice,
      task.id,
      {
        kind: 'handoff',
        recipient_principal_id: a.installed.principal_id,
        proposal,
        request_expires_at: new Date(Date.now() + 600000).toISOString(),
      },
      task.version,
      key(),
    );
    await a.client.getRequest(request.id);
    const ackKey = key();
    const ack = await a.client.acknowledgeRequest(request.id, request.proposal_version, ackKey);
    expect(await a.client.acknowledgeRequest(request.id, request.proposal_version, ackKey)).toEqual(
      ack,
    );
    expect(await a.client.getRequest(request.id)).toMatchObject({
      status: 'pending',
      version: request.version,
      received_at: ack.received_at,
    });
    expect((await tasks.getTask(f.alice, task.id)).owner_principal_id).toBe(f.alice.principalId);
    await expect(a.client.getTask(task.id)).rejects.toMatchObject({ status: 404 });
    await expect(a.client.getTaskHandoffActions(task.id)).rejects.toMatchObject({ status: 404 });
    await a.client.decideRequest(
      request.id,
      request.version,
      {
        decision: 'accept',
        proposal_version: request.proposal_version,
        expected_task_version: request.expected_task_version,
      },
      key(),
    );
    task = await a.client.getTask(task.id);
    expect(task.owner_principal_id).toBe(a.installed.principal_id);
    expect(task.accountable_principal_id).toBe(f.alice.principalId);
    expect(await a.client.getTaskHandoffActions(task.id)).toEqual({
      task_id: task.id,
      task_version: task.version,
      pending_action_ids: [],
    });
    const limited = new ImboxAgentClient({ origin, tenantId: f.tenantId, allowLoopbackHttp: true });
    await limited.exchange({ credential: a.credential.secret!, scopes: ['requests.read'] });
    await expect(limited.getTaskHandoffActions(task.id)).rejects.toMatchObject({ status: 403 });
    const next = await a.client.createTaskRequest(
      task.id,
      task.version,
      {
        kind: 'handoff',
        recipient_principal_id: b.installed.principal_id,
        proposal,
        request_expires_at: new Date(Date.now() + 600000).toISOString(),
      },
      key(),
    );
    await b.client.getRequest(next.id);
    expect((await a.client.getTask(task.id)).owner_principal_id).toBe(a.installed.principal_id);
    await b.client.decideRequest(
      next.id,
      next.version,
      {
        decision: 'accept',
        proposal_version: next.proposal_version,
        expected_task_version: next.expected_task_version,
      },
      key(),
    );
    expect((await b.client.getTask(task.id)).owner_principal_id).toBe(b.installed.principal_id);
  });
});

it('SDK retries a lost command response with identical key/body and produces one message', async () => {
  const a = await agent(['messages.read', 'messages.write']);
  const { chat } = await run(a);
  let dropped = false;
  let attempts = 0;
  const client = new ImboxAgentClient({
    origin,
    tenantId: f.tenantId,
    allowLoopbackHttp: true,
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (String(input).endsWith(`/conversations/${chat.id}/messages`) && init?.method === 'POST') {
        attempts++;
        if (!dropped) {
          dropped = true;
          await response.body?.cancel();
          throw new TypeError('Simulated response loss after server commit');
        }
      }
      return response;
    },
  });
  await client.exchange({
    credential: a.credential.secret!,
    scopes: ['messages.read', 'messages.write'],
  });
  const message = await client.sendMessage(
    chat.id,
    { client_message_id: key(), body: 'response-loss-proof' },
    key(),
  );
  expect(attempts).toBe(2);
  expect(
    (await client.listMessages(chat.id)).items.filter((item) => item.id === message.id),
  ).toHaveLength(1);
});

describe('human Agent management read boundaries', () => {
  it('lists credential metadata with actor-bound paging, never hashes or recoverable secrets', async () => {
    const registered = await agents.register(f.alice, registration(), key());
    const credentials: Awaited<ReturnType<AgentService['issueCredential']>>[] = [];
    for (let n = 0; n < 3; n++)
      credentials.push(
        await agents.issueCredential(
          f.alice,
          registered.id,
          { scopes: ['agents.read'], lifetime_seconds: 3600 },
          key(),
        ),
      );
    expect(await agents.managementAccess(f.alice)).toEqual({ can_manage: true });
    expect(await agents.managementAccess(f.bob)).toEqual({ can_manage: false });
    await expect(agents.credentials(f.bob, registered.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const first = await agents.credentials(f.alice, registered.id, { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.next_cursor).toBeDefined();
    expect(Object.keys(first.items[0]!).sort()).toEqual([
      'expires_at',
      'id',
      'installation_id',
      'revision',
      'scopes',
      'status',
    ]);
    const second = await agents.credentials(f.alice, registered.id, {
      limit: 2,
      cursor: first.next_cursor!,
    });
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(3);
    const other = await agents.register(
      f.alice,
      { ...registration(), display_name: 'Another installation' },
      key(),
    );
    await expect(
      agents.credentials(f.alice, other.id, { cursor: first.next_cursor! }),
    ).rejects.toMatchObject({ code: 'RESYNC_REQUIRED' });
    await agents.revokeCredential(f.alice, credentials[0]!.credential.id, key());
    expect(
      (await agents.credentials(f.alice, registered.id)).items.find(
        (item) => item.id === credentials[0]!.credential.id,
      )?.status,
    ).toBe('revoked');
    await sql`update tenant_principals set role='member' where tenant_id=${f.tenantId} and principal_id=${f.alice.principalId}`.execute(
      databases.owner,
    );
    expect(await agents.managementAccess(f.alice)).toEqual({ can_manage: false });
    await expect(
      agents.credentials(f.alice, registered.id, { cursor: first.next_cursor! }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
