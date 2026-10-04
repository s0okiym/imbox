import { createServer, request as proxyRequest } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { createIdentityService } from '@imbox/auth';
import {
  createMessagingService,
  createTaskService,
  createSyncService,
  createOutboxProcessor,
} from '@imbox/application';
import { createKnowledgeService } from '@imbox/knowledge';
import { createGovernanceService } from '@imbox/governance';
import { createApp } from '../../apps/api/src/app.js';
import { testDatabases, tenantFixture } from '../helpers/database.js';

test('production shell reloads offline and CacheStorage never contains API or cached message bodies', async ({
  page,
  context,
}) => {
  test.setTimeout(60000);
  const root = resolve('apps/web/dist');
  let apiOrigin = '';
  const shell = createServer((request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname;
    if (path.startsWith('/v1/')) {
      if (!apiOrigin) {
        response.writeHead(503).end();
        return;
      }
      const upstream = proxyRequest(
        new URL(request.url!, apiOrigin),
        { method: request.method, headers: { ...request.headers, host: new URL(apiOrigin).host } },
        (reply) => {
          response.writeHead(reply.statusCode!, reply.headers);
          reply.pipe(response);
        },
      );
      upstream.on('error', () => {
        response.writeHead(502).end();
      });
      request.pipe(upstream);
      return;
    }
    const pathname = extname(path) ? path : '/index.html',
      file = resolve(root, '.' + pathname);
    if (!file.startsWith(root + sep)) {
      response.writeHead(404).end();
      return;
    }
    void readFile(file)
      .then((bytes) => {
        const mime: Record<string, string> = {
          '.html': 'text/html',
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.svg': 'image/svg+xml',
          '.webmanifest': 'application/manifest+json',
        };
        response
          .writeHead(200, {
            'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
            'Cache-Control': 'no-cache',
          })
          .end(bytes);
      })
      .catch(() => response.writeHead(404).end());
  });
  shell.listen(0, '127.0.0.1');
  await once(shell, 'listening');
  const origin = `http://127.0.0.1:${(shell.address() as AddressInfo).port}`;
  const db = await testDatabases(),
    f = await tenantFixture(db.owner),
    secret = 'pwa-real-service-independent-browser-fixture-secret';
  const messaging = createMessagingService(db.db, secret),
    tasks = createTaskService(db.db, secret),
    knowledge = createKnowledgeService({ db: db.db, cursorSecret: secret });
  const identity = createIdentityService({
    db: db.db,
    identityDb: db.identityDb,
    publicOrigin: origin,
    sessionSecret: secret,
    environment: 'test',
    enableDevAuth: true,
    devPrincipalIds: [f.alice.principalId],
  });
  const conversation = await messaging.createConversation(
    f.alice,
    {
      workspace_id: f.workspaceId,
      kind: 'group',
      title: '明确保留的本机副本',
      member_ids: [f.bob.principalId],
      history_policy: 'all',
    },
    randomUUID(),
  );
  const marker = 'PRIVATE_PWA_' + randomUUID();
  await messaging.createMessage(
    f.bob,
    conversation.id,
    { body: marker, client_message_id: randomUUID() },
    randomUUID(),
  );
  const projector = createOutboxProcessor({ db: db.db });
  while ((await projector.processBatch(f.tenantId)).claimed) {
    /* Real initial projection. */
  }
  const app = createApp({
    identity,
    messaging,
    tasks,
    knowledge,
    sync: createSyncService({ db: db.db, cursorSecret: secret }),
    governance: createGovernanceService({
      db: db.db,
      messaging,
      tasks,
      knowledge,
      independentLedger: false,
      offlineMessageCacheAllowed: true,
    }),
    readiness: async () => {},
  });
  try {
    apiOrigin = await app.listen({ host: '127.0.0.1', port: 0 });
    const login = await identity.devLogin({ principalId: f.alice.principalId, origin });
    await context.addCookies([
      { name: 'imbox_session', value: login.token, url: origin, httpOnly: true, sameSite: 'Lax' },
    ]);
    await page.addInitScript((tenant) => localStorage.setItem('imbox.tenant', tenant), f.tenantId);
    await page.goto(origin);
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await page.getByRole('button', { name: '数据与隐私', exact: true }).click();
    await page.getByLabel('在本机保留最近消息', { exact: true }).check();
    await page.getByRole('button', { name: '保存本机设置', exact: true }).click();
    await expect(page.getByText('已保存本机设置。', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '消息', exact: true }).click();
    await page
      .getByRole('navigation', { name: '会话列表' })
      .getByRole('button', { name: /明确保留的本机副本/ })
      .click();
    await expect(page.getByLabel('消息记录').getByText(marker, { exact: true })).toBeVisible();
    await expect(page.getByText('本机副本已更新', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '本机离线数据', exact: true }).click();
    await expect(page.getByRole('button', { name: /明确保留的本机副本/ })).toBeVisible();
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('heading', { name: '本机离线数据', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /明确保留的本机副本/ }).click();
    await expect(page.getByLabel('缓存消息记录').getByText(marker, { exact: true })).toBeVisible();
    const cacheFacts = await page.evaluate(async (text) => {
      const urls: string[] = [];
      let containsPrivateText = false;
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const key of await cache.keys()) {
          urls.push(new URL(key.url).pathname);
          containsPrivateText ||= (await (await cache.match(key))!.text()).includes(text);
        }
      }
      const apiAvailable = await fetch('/v1/me').then(
        () => true,
        () => false,
      );
      return { urls, containsPrivateText, apiAvailable };
    }, marker);
    expect(cacheFacts.urls).toContain('/');
    expect(cacheFacts.urls.some((path) => path.startsWith('/v1/'))).toBe(false);
    expect(cacheFacts.containsPrivateText).toBe(false);
    expect(cacheFacts.apiAvailable).toBe(false);
    await page.getByRole('button', { name: '清除本机数据', exact: true }).click();
    await expect(page.getByText(marker, { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByText('没有已启用的本机离线资料。请联网后在“数据与隐私”中设置。', { exact: true }),
    ).toBeVisible();
  } finally {
    await context.setOffline(false);
    await page.context().close();
    shell.closeAllConnections();
    await new Promise<void>((resolve) => shell.close(() => resolve()));
    app.server.closeAllConnections();
    await app.close();
    await db.close();
  }
});
