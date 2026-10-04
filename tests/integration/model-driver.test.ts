import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createModelDriver, createOllamaAdapter } from '@imbox/model-runtime';
import { createRuntimeWorker } from '@imbox/runtime';
import { sql, withTenant } from '@imbox/db';
import { testDatabases } from '../helpers/database.js';
import { modelFixture } from '../helpers/model.js';
let databases: Awaited<ReturnType<typeof testDatabases>>;
let fixture: Awaited<ReturnType<typeof modelFixture>>;
const cleanups: Array<() => Promise<void>> = [];
const digest = 'sha256:' + 'a'.repeat(64);
beforeAll(async () => {
  databases = await testDatabases();
});
afterAll(async () => {
  await databases.close();
});
beforeEach(async () => {
  fixture = await modelFixture(databases);
});
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
function success(response: ServerResponse) {
  response.end(
    JSON.stringify({
      model: 'qwen3:0.6b',
      done: true,
      done_reason: 'stop',
      message: { role: 'assistant', content: 'IMBOX_OK' },
      prompt_eval_count: 100,
      eval_count: 4,
    }),
  );
}
async function model(
  onGenerate = (response: ServerResponse) => Promise.resolve(success(response)),
) {
  let requests = 0;
  const server = createServer((request, response) => {
    if (request.url === '/api/tags') {
      response.end(JSON.stringify({ models: [{ name: 'qwen3:0.6b', digest }] }));
      return;
    }
    request.resume();
    request.on('end', () => {
      requests++;
      void onGenerate(response).catch(() => response.destroy());
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
  const adapter = createOllamaAdapter({
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    model: 'qwen3:0.6b',
    digest,
    allowLoopbackHttp: true,
    timeoutMs: 5000,
  });
  const models = new Map([['local', adapter]]);
  return {
    adapter,
    models,
    requests: () => requests,
    driver: createModelDriver({ worker: fixture.worker, models, heartbeatMs: 25 }),
  };
}
describe('durable model execution against PostgreSQL and HTTP', () => {
  it('saves the authorized result and settles measured tokens once before completion', async () => {
    const remote = await model();
    const run = await fixture.createRun();
    expect(await remote.driver.execute(fixture.tenantId, run.id)).toBe('completed');
    expect(await fixture.runtime.getRun(fixture.alice, run.id)).toMatchObject({
      status: 'completed',
      output: 'IMBOX_OK',
      budget: { spent_microunits: '0', reserved_microunits: '0' },
    });
    const facts = await withTenant(databases.db, fixture.tenantId, (tx) =>
      sql<{ evidence: Record<string, unknown> }>`select * from runtime_usage_records`.execute(tx),
    );
    expect(facts.rows).toHaveLength(1);
    expect(facts.rows[0]!.evidence).toMatchObject({
      billing_policy: 'local-unmetered',
      usage: { inputTokens: 100, outputTokens: 4 },
    });
    expect(await remote.driver.execute(fixture.tenantId, run.id)).toBe('fenced');
    expect(remote.requests()).toBe(1);
  });
  it('holds unknown usage after a lost response and never blindly resends the invocation', async () => {
    const remote = await model(async (response) => {
      response.destroy();
    });
    const run = await fixture.createRun();
    expect(await remote.driver.execute(fixture.tenantId, run.id)).toBe('waiting');
    expect(await fixture.runtime.getRun(fixture.alice, run.id)).toMatchObject({
      status: 'waiting_dependency',
      output: null,
    });
    expect(
      (
        await withTenant(databases.db, fixture.tenantId, (tx) =>
          sql`select status from runtime_reservations where run_id=${run.id}`.execute(tx),
        )
      ).rows,
    ).toEqual([{ status: 'unknown' }]);
    await remote.driver.execute(fixture.tenantId, run.id);
    expect(remote.requests()).toBe(1);
  });
  it('records late billing facts without publishing output after source membership is revoked', async () => {
    const remote = await model(async (response) => {
      await fixture.messaging.changeMember(
        fixture.alice,
        fixture.chat.id,
        fixture.agentId,
        'remove',
        fixture.chat.version,
        randomUUID(),
      );
      success(response);
    });
    const run = await fixture.createRun();
    expect(await remote.driver.execute(fixture.tenantId, run.id)).toBe('fenced');
    await expect(fixture.runtime.getRun(fixture.alice, run.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const stored = (
      await withTenant(databases.owner, fixture.tenantId, (tx) =>
        sql`select output from agent_runs where id=${run.id}`.execute(tx),
      )
    ).rows[0];
    expect(stored).toEqual({ output: null });
    expect(
      (
        await withTenant(databases.db, fixture.tenantId, (tx) =>
          sql`select * from runtime_usage_records`.execute(tx),
        )
      ).rows,
    ).toHaveLength(1);
  });
  it('restores a settled checkpoint after a worker crash without another model call', async () => {
    const remote = await model();
    const run = await fixture.createRun();
    const claim = (await fixture.worker.claim(fixture.tenantId, run.id))!;
    const execution = await fixture.worker.getExecution(claim);
    const reservation = await fixture.worker.reserve(claim, {
      reservation_key: 'model:step:1',
      amount_microunits: '0',
      currency: 'USD',
    });
    const result = await remote.adapter.generate({
      invocationId: reservation.id,
      purpose: execution.manifest.purpose,
      context: execution.items,
      signal: new AbortController().signal,
    });
    await fixture.worker.completeStep(
      claim,
      reservation.id,
      {
        usage_key: `ollama:${reservation.id}`,
        actual_microunits: '0',
        evidence: { ...result.receipt, usage: result.usage },
      },
      {
        model_step: { state: 'generated', manifest_hash: execution.manifest.content_hash, result },
      },
    );
    await withTenant(databases.owner, fixture.tenantId, (tx) =>
      sql`update agent_runs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${run.id}`.execute(
        tx,
      ),
    );
    const replacement = createModelDriver({
      worker: createRuntimeWorker({ db: databases.db, workerId: 'replacement-model-worker' }),
      models: remote.models,
    });
    expect(await replacement.execute(fixture.tenantId, run.id)).toBe('completed');
    expect(remote.requests()).toBe(1);
    expect((await fixture.runtime.getRun(fixture.alice, run.id)).output).toBe('IMBOX_OK');
  });
  it('preserves a finished result through pause and resume instead of executing a second step', async () => {
    let runId = '';
    const remote = await model(async (response) => {
      const current = await fixture.runtime.getRun(fixture.alice, runId);
      await fixture.runtime.controlRun(
        fixture.alice,
        runId,
        'pause',
        current.version,
        randomUUID(),
      );
      success(response);
    });
    const run = await fixture.createRun();
    runId = run.id;
    expect(await remote.driver.execute(fixture.tenantId, run.id)).toBe('waiting');
    const paused = await fixture.runtime.getRun(fixture.alice, run.id);
    expect(paused.status).toBe('paused');
    await fixture.runtime.controlRun(fixture.alice, run.id, 'resume', paused.version, randomUUID());
    expect(await remote.driver.execute(fixture.tenantId, run.id)).toBe('completed');
    expect(remote.requests()).toBe(1);
  });
  it('refuses destination mismatch before transmitting context to the model', async () => {
    const remote = await model();
    const run = await fixture.createRun('model:unapproved');
    expect(await remote.driver.execute(fixture.tenantId, run.id)).toBe('failed');
    expect(remote.requests()).toBe(0);
  });
});
