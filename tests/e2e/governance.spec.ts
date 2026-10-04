import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { createIdentityService } from '@imbox/auth';
import { createMessagingService, createTaskService } from '@imbox/application';
import { createKnowledgeService } from '@imbox/knowledge';
import { createGovernanceService } from '@imbox/governance';
import { createApp } from '../../apps/api/src/app.js';
import { testDatabases, tenantFixture } from '../helpers/database.js';
const origin = 'http://127.0.0.1:4173';
test('exports only the selected live scope, verifies a complete file, and shows deployed privacy policy', async ({
  page,
}) => {
  const db = await testDatabases(),
    f = await tenantFixture(db.owner),
    secret = 'governance-browser-real-api-session-secret-more-than-32';
  const messaging = createMessagingService(db.db, secret),
    tasks = createTaskService(db.db, secret),
    knowledge = createKnowledgeService({ db: db.db, cursorSecret: secret });
  const identity = createIdentityService({
    db: db.db,
    identityDb: db.identityDb,
    sessionSecret: secret,
    publicOrigin: origin,
    environment: 'test',
    enableDevAuth: true,
    devPrincipalIds: [f.alice.principalId],
  });
  const marker = 'PERSONAL_EXPORT_' + randomUUID();
  await knowledge.createMemory(
    f.alice,
    {
      scope: 'personal',
      body: marker,
      source_refs: [],
      confidence: 100,
      confirmation: 'confirmed',
    },
    randomUUID(),
  );
  await knowledge.createMemory(
    f.bob,
    {
      scope: 'personal',
      body: 'MUST_NOT_EXPORT_BOB',
      source_refs: [],
      confidence: 100,
      confirmation: 'confirmed',
    },
    randomUUID(),
  );
  const app = createApp({
    identity,
    messaging,
    tasks,
    knowledge,
    governance: createGovernanceService({
      db: db.db,
      messaging,
      tasks,
      knowledge,
      independentLedger: false,
    }),
    readiness: async () => {},
  });
  let stopping = false;
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 }),
      login = await identity.devLogin({ principalId: f.alice.principalId, origin });
    await page
      .context()
      .addCookies([
        { name: 'imbox_session', value: login.token, url: origin, httpOnly: true, sameSite: 'Lax' },
      ]);
    await page.addInitScript((tenant) => localStorage.setItem('imbox.tenant', tenant), f.tenantId);
    await page.route('**/v1/**', async (route) => {
      try {
        const url = new URL(route.request().url()),
          response = await route.fetch({
            url: address + url.pathname + url.search,
            headers: { ...route.request().headers(), host: new URL(address).host },
          });
        if (!stopping) await route.fulfill({ response });
      } catch (error) {
        if (!stopping) throw error;
      }
    });
    await page.goto('/');
    await page.getByRole('button', { name: '数据与隐私', exact: true }).click();
    await expect(page.getByRole('heading', { name: '当前保留策略' })).toBeVisible();
    await expect(page.getByText('此部署已关闭', { exact: true })).toBeVisible();
    const saving = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出并下载', exact: true }).click();
    const download = await saving;
    expect(await download.failure()).toBeNull();
    const file = await download.path();
    expect(file).not.toBeNull();
    const body = await readFile(file!, 'utf8');
    expect(body).toContain(marker);
    expect(body).not.toContain('MUST_NOT_EXPORT_BOB');
    const records = body
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records.at(-1).type).toBe('complete');
    await expect(
      page.getByRole('status').filter({ hasText: '导出已通过完整性校验' }),
    ).toBeVisible();
  } finally {
    stopping = true;
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await page.close();
    app.server.closeAllConnections();
    await app.close();
    await db.close();
  }
});
