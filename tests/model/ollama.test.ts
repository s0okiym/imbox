import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { createOllamaAdapter, createModelDriver } from '@imbox/model-runtime';
import { sql, withTenant } from '@imbox/db';
import { testDatabases } from '../helpers/database.js';
import { modelFixture } from '../helpers/model.js';
let databases: Awaited<ReturnType<typeof testDatabases>>;
beforeAll(async () => {
  databases = await testDatabases();
});
afterAll(async () => {
  await databases.close();
});
it('completes an authorized durable run using a real pinned local Qwen model', async () => {
  const fixture = await modelFixture(databases);
  const model = 'qwen3:0.6b';
  const digest = 'sha256:7df6b6e09427a769808717c0a93cadc4ae99ed4eb8bf5ca557c90846becea435';
  const adapter = createOllamaAdapter({
    origin: process.env.OLLAMA_ORIGIN ?? 'http://127.0.0.1:11435',
    model,
    digest,
    allowLoopbackHttp: true,
    maxOutputTokens: 256,
  });
  const driver = createModelDriver({
    worker: fixture.worker,
    models: new Map([['local', adapter]]),
  });
  const run = await fixture.createRun();
  const started = Date.now();
  expect(await driver.execute(fixture.tenantId, run.id)).toBe('completed');
  const stored = await fixture.runtime.getRun(fixture.alice, run.id);
  expect(stored.output).toContain('IMBOX_OK');
  const rows = (
    await withTenant(databases.db, fixture.tenantId, (tx) =>
      sql<{
        evidence: { usage: { inputTokens: number; outputTokens: number } };
      }>`select evidence from runtime_usage_records`.execute(tx),
    )
  ).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.evidence.usage.inputTokens).toBeGreaterThan(0);
  expect(rows[0]!.evidence.usage.outputTokens).toBeGreaterThan(0);
  await mkdir('.artifacts', { recursive: true });
  await writeFile(
    '.artifacts/model-evidence.json',
    JSON.stringify(
      {
        verified_at: new Date().toISOString(),
        provider: 'ollama',
        model,
        digest,
        real_model: true,
        elapsed_ms: Date.now() - started,
        run_id: run.id,
        context_manifest_id: stored.context_manifest_id,
        result_contains_expected_marker: true,
        usage: rows[0]!.evidence.usage,
        billing_policy: 'local-unmetered',
      },
      null,
      2,
    ) + '\n',
  );
});
