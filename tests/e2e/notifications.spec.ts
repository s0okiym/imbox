import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { createIdentityService } from '@imbox/auth';
import { createMessagingService, createTaskService } from '@imbox/application';
import { createNotificationService, createNotificationDispatcher } from '@imbox/notifications';
import { createApp } from '../../apps/api/src/app.js';
import { testDatabases, tenantFixture } from '../helpers/database.js';
const origin = 'http://127.0.0.1:4173';
test('opens a notification under current authority, marks it read, and saves reminder preferences', async ({
  page,
}) => {
  const db = await testDatabases(),
    f = await tenantFixture(db.owner),
    secret = 'governance-browser-real-api-session-secret-more-than-32';
  const messaging = createMessagingService(db.db, secret),
    tasks = createTaskService(db.db, secret),
    notifications = createNotificationService({ db: db.db, cursorSecret: secret });
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
  await createNotificationDispatcher({ db: db.db })(f.tenantId);
  const app = createApp({
    identity,
    messaging,
    tasks,
    notifications,
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
    await page.goto('/');
    await page.getByRole('button', { name: '通知中心', exact: true }).click();
    await expect(page.getByText('你有新的待查看事项', { exact: true })).toBeVisible();
    await expect(page.getByText(marker, { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '查看事项', exact: true }).click();
    await expect(page).toHaveURL(
      new RegExp(`/conversations/${conversation.id}.*message=${message.id}`),
    );
    await expect(page.getByText(marker, { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: '通知中心', exact: true }).click();
    await expect(page.getByText('未读 0 项。', { exact: false })).toBeVisible();
    await page.getByLabel('开启免打扰时段', { exact: true }).check();
    await page.getByLabel('时区', { exact: true }).fill('Asia/Shanghai');
    await page.getByLabel('开始', { exact: true }).fill('22:00');
    await page.getByLabel('结束', { exact: true }).fill('08:00');
    await page.getByRole('button', { name: '保存提醒偏好', exact: true }).click();
    await expect
      .poll(async () => (await notifications.getPreferences(f.bob)).dnd)
      .toEqual({ enabled: true, time_zone: 'Asia/Shanghai', start: '22:00', end: '08:00' });
    await page.reload();
    await expect(page.getByLabel('开启免打扰时段', { exact: true })).toBeChecked();
    await expect(page.getByLabel('时区', { exact: true })).toHaveValue('Asia/Shanghai');
  } finally {
    stopping = true;
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await page.close();
    app.server.closeAllConnections();
    await app.close();
    await db.close();
  }
});
