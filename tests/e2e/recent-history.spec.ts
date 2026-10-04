import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { createIdentityService } from '@imbox/auth';
import {
  createMessagingService,
  createTaskService,
  createSyncService,
  createOutboxProcessor,
} from '@imbox/application';
import { createApp } from '../../apps/api/src/app.js';
import { testDatabases, tenantFixture } from '../helpers/database.js';
const origin = 'http://127.0.0.1:4173';
test('loads older messages beyond the bounded recent snapshot and resolves a deep link outside that window', async ({
  page,
}) => {
  test.setTimeout(180000);
  const db = await testDatabases(),
    f = await tenantFixture(db.owner),
    secret = 'governance-browser-real-api-session-secret-more-than-32';
  const messaging = createMessagingService(db.db, secret),
    tasks = createTaskService(db.db, secret),
    sync = createSyncService({ db: db.db, cursorSecret: secret });
  const identity = createIdentityService({
    db: db.db,
    identityDb: db.identityDb,
    sessionSecret: secret,
    publicOrigin: origin,
    environment: 'test',
    enableDevAuth: true,
    devPrincipalIds: [f.bob.principalId],
  });
  const marker = 'NOTIFICATION_MESSAGE_' + randomUUID();
  const conversation = await messaging.createConversation(
    f.alice,
    {
      workspace_id: f.workspaceId,
      kind: 'group',
      title: 'Notification browser verification',
      member_ids: [f.bob.principalId],
      history_policy: 'all',
    },
    randomUUID(),
  );
  const message = await messaging.createMessage(
    f.alice,
    conversation.id,
    { body: marker, client_message_id: randomUUID() },
    randomUUID(),
  );
  for (let i = 1; i < 1055; i++)
    await messaging.createMessage(
      f.alice,
      conversation.id,
      { body: `HISTORY_${i}`, client_message_id: randomUUID() },
      randomUUID(),
    );
  const processor = createOutboxProcessor({ db: db.db });
  for (let i = 0; i < 120; i++) if (!(await processor.processBatch(f.tenantId)).claimed) break;
  const app = createApp({
    identity,
    messaging,
    tasks,
    sync,
    readiness: async () => {},
  });
  let stopping = false;
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 }),
      login = await identity.devLogin({ principalId: f.bob.principalId, origin });
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
    await page.goto(`/conversations/${conversation.id}?tenant=${f.tenantId}`);
    const records = page.getByLabel('消息记录', { exact: true });
    await expect(records.getByRole('article')).toHaveCount(50);
    await expect(records.getByText(marker, { exact: true })).toHaveCount(0);
    for (const count of [100, 150, 200]) {
      await page.getByRole('button', { name: '加载更早的消息', exact: true }).click();
      await expect(records.getByRole('article')).toHaveCount(count);
    }
    for (let count = 250; count <= 1000; count += 50) {
      await page.getByRole('button', { name: '加载更早的消息', exact: true }).click();
      await expect(records.locator('[data-virtual-messages]')).toHaveAttribute(
        'data-virtual-messages',
        String(count),
      );
      await expect.poll(() => records.getByRole('article').count()).toBeLessThan(60);
    }
    await page.getByRole('button', { name: '查看更早的历史窗口', exact: true }).click();
    await expect(records.getByRole('article')).toHaveCount(50);
    await expect(records).toContainText('正在查看较早历史');
    await page.getByRole('button', { name: '加载更早的消息', exact: true }).click();
    await expect(records.getByRole('article')).toHaveCount(55);
    await expect(records.getByText(marker, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '加载更早的消息', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '回到最新消息 ↓', exact: true }).click();
    await expect(records.getByText('HISTORY_1054', { exact: true })).toBeVisible();
    await expect(records.getByRole('article')).toHaveCount(50);
    await page.goto(`/conversations/${conversation.id}?tenant=${f.tenantId}&message=${message.id}`);
    await expect(
      page.getByLabel('链接指向的消息').getByText(marker, { exact: true }),
    ).toBeVisible();
    await messaging.changeMessage(f.alice, message.id, null, message.version, randomUUID());
    await expect(page.getByLabel('链接指向的消息')).toContainText('此消息不可用或当前无权查看');
    await expect(page.getByText(marker, { exact: true })).toHaveCount(0);
  } finally {
    stopping = true;
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await page.context().close();
    app.server.closeAllConnections();
    await app.close();
    await db.close();
  }
});
