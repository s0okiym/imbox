import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { createIdentityService } from '@imbox/auth';
import {
  createMessagingService,
  createOutboxProcessor,
  createSyncService,
  createTaskService,
} from '@imbox/application';
import { createKnowledgeService } from '@imbox/knowledge';
import { sql, withTenant } from '@imbox/db';
import { createApp } from '../../apps/api/src/app.js';
import { tenantFixture, testDatabases } from '../helpers/database.js';

const origin = 'http://127.0.0.1:4173';
const secret = 'playwright-knowledge-human-memory-live-permissions-secret';
async function fixture(page: Page) {
  const databases = await testDatabases();
  const f = await tenantFixture(databases.owner);
  const messaging = createMessagingService(databases.db, secret);
  const knowledge = createKnowledgeService({ db: databases.db, cursorSecret: secret });
  const marker = `检索依据${randomUUID().slice(0, 8)}`;
  const shared = await messaging.createConversation(
    f.bob,
    {
      workspace_id: f.workspaceId,
      kind: 'group',
      title: '明确共享的检索来源',
      member_ids: [f.alice.principalId],
      history_policy: 'all',
    },
    randomUUID(),
  );
  const message = await messaging.createMessage(
    f.bob,
    shared.id,
    { body: `${marker} 当前可见的原始依据`, client_message_id: randomUUID() },
    randomUUID(),
  );
  const hidden = await messaging.createConversation(
    f.bob,
    {
      workspace_id: f.workspaceId,
      kind: 'group',
      title: '不可访问的检索范围',
      member_ids: [f.charlie.principalId],
      history_policy: 'all',
    },
    randomUUID(),
  );
  const privateText = `${marker} PRIVATE_CONTENT_MUST_NOT_APPEAR`;
  await messaging.createMessage(
    f.bob,
    hidden.id,
    { body: privateText, client_message_id: randomUUID() },
    randomUUID(),
  );
  const identity = createIdentityService({
    db: databases.db,
    identityDb: databases.identityDb,
    sessionSecret: secret,
    publicOrigin: origin,
    environment: 'test',
    enableDevAuth: true,
    devPrincipalIds: [f.alice.principalId],
  });
  const app = createApp({
    identity,
    messaging,
    knowledge,
    tasks: createTaskService(databases.db, secret),
    sync: createSyncService({ db: databases.db, cursorSecret: secret }),
    readiness: async () => {},
  });
  const apiOrigin = await app.listen({ host: '127.0.0.1', port: 0 });
  const processor = createOutboxProcessor({ db: databases.db });
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pumping: Promise<unknown> = Promise.resolve();
  const pump = () => {
    pumping = processor.processBatch(f.tenantId).finally(() => {
      if (!stopped) timer = setTimeout(pump, 25);
    });
    void pumping.catch(() => {});
  };
  pump();
  const login = await identity.devLogin({ principalId: f.alice.principalId, origin });
  await page
    .context()
    .addCookies([
      { name: 'imbox_session', value: login.token, url: origin, httpOnly: true, sameSite: 'Lax' },
    ]);
  await page.addInitScript((tenant) => localStorage.setItem('imbox.tenant', tenant), f.tenantId);
  await page.route('**/v1/**', async (route) => {
    try {
      const url = new URL(route.request().url());
      const response = await route.fetch({
        url: `${apiOrigin}${url.pathname}${url.search}`,
        headers: { ...route.request().headers(), host: new URL(apiOrigin).host },
      });
      await route.fulfill({ response });
    } catch (error: unknown) {
      if (!stopped && !page.isClosed()) throw error;
    }
  });
  await page.goto('/');
  await page.getByRole('button', { name: '搜索与记忆', exact: true }).click();
  return {
    ...f,
    databases,
    knowledge,
    messaging,
    marker,
    message,
    shared,
    privateText,
    close: async () => {
      stopped = true;
      await page
        .context()
        .close()
        .catch(() => {});
      if (timer !== undefined) clearTimeout(timer);
      await pumping.catch(() => {});
      app.server.closeAllConnections();
      await app.close().catch(() => {});
      await databases.close();
    },
  };
}
async function search(page: Page, query: string, kind: 'message' | 'memory') {
  await page.getByRole('tab', { name: '搜索', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索关键词', exact: true }).fill(query);
  await page.getByRole('combobox', { name: '内容类型', exact: true }).selectOption(kind);
  await page.getByRole('button', { name: '搜索当前可读内容', exact: true }).click();
}
async function createFromSource(page: Page, marker: string, body: string) {
  await search(page, marker, 'message');
  await page
    .getByLabel('搜索结果', { exact: true })
    .getByRole('button', { name: '以此为来源建立记忆', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: '建立显式记忆', exact: true });
  await dialog.getByRole('textbox', { name: '记忆内容', exact: true }).fill(body);
  await expect(dialog.getByRole('combobox', { name: '人工确认状态', exact: true })).toHaveValue(
    'needs_confirmation',
  );
  await expect(dialog.getByRole('button', { name: '保存显式记忆', exact: true })).toBeDisabled();
  await dialog.getByRole('checkbox', { name: /我已核对内容、来源固定版本/ }).check();
  await dialog.getByRole('button', { name: '保存显式记忆', exact: true }).click();
  await expect(
    page.getByLabel('记忆详情').getByRole('heading', { name: '待人工确认', exact: true }),
  ).toBeVisible();
}

test('search excludes private content and explicit memory supports human confirmation, conflict, disable and deletion', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const f = await fixture(page);
  try {
    const body = `人工结论${randomUUID().slice(0, 8)} 来自明确的固定来源`;
    await createFromSource(page, f.marker, body);
    await expect(page.getByText(f.privateText, { exact: true })).toHaveCount(0);
    const memory = (await f.knowledge.listMemories(f.alice)).items[0]!;
    expect(memory).toMatchObject({
      confirmation: 'needs_confirmation',
      source_refs: [{ kind: 'message', id: f.message.id, version: f.message.version }],
    });
    expect((await f.knowledge.search(f.alice, { q: body, kind: 'memory' })).items).toHaveLength(0);
    await page.getByRole('button', { name: '修订内容、状态与有效期', exact: true }).click();
    let edit = page.getByRole('dialog', { name: '修订显式记忆', exact: true });
    await expect(edit.getByRole('combobox', { name: /^记忆可见范围/ })).toBeDisabled();
    await edit
      .getByRole('combobox', { name: '人工确认状态', exact: true })
      .selectOption('confirmed');
    const expiration = new Date(Date.now() + 86_400_000).toISOString().slice(0, 16);
    await edit.getByLabel('记忆有效期（本机时区，可选）', { exact: true }).fill(expiration);
    await edit.getByRole('checkbox', { name: /我已核对内容、来源固定版本/ }).check();
    await edit.getByRole('button', { name: '保存记忆修订', exact: true }).click();
    await expect(edit).toBeHidden();
    await search(page, body, 'memory');
    await page
      .getByLabel('搜索结果', { exact: true })
      .getByRole('button', { name: '读取当前记忆详情', exact: true })
      .click();
    await expect(
      page.getByLabel('记忆详情').getByRole('heading', { name: '人工已确认', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '修订内容、状态与有效期', exact: true }).click();
    edit = page.getByRole('dialog', { name: '修订显式记忆', exact: true });
    await edit
      .getByRole('combobox', { name: '人工确认状态', exact: true })
      .selectOption('conflicted');
    await edit.getByRole('checkbox', { name: /我已核对内容、来源固定版本/ }).check();
    await edit.getByRole('button', { name: '保存记忆修订', exact: true }).click();
    await expect(
      page.getByLabel('记忆详情').getByRole('heading', { name: '存在冲突', exact: true }),
    ).toBeVisible();
    expect((await f.knowledge.search(f.alice, { q: body, kind: 'memory' })).items).toHaveLength(0);
    await page.getByRole('button', { name: '修订内容、状态与有效期', exact: true }).click();
    edit = page.getByRole('dialog', { name: '修订显式记忆', exact: true });
    await edit.getByRole('checkbox', { name: /启用此记忆/ }).uncheck();
    await edit.getByRole('checkbox', { name: /我已核对内容、来源固定版本/ }).check();
    await edit.getByRole('button', { name: '保存记忆修订', exact: true }).click();
    await expect(
      page.getByLabel('记忆详情').getByRole('heading', { name: '已停用的记忆', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '删除此记忆', exact: true }).click();
    const deletion = page.getByRole('dialog', { name: '删除显式记忆', exact: true });
    await deletion.getByRole('checkbox').check();
    await deletion.getByRole('button', { name: '确认删除记忆', exact: true }).click();
    await expect(deletion).toBeHidden();
    await expect(page.getByLabel('记忆详情')).toHaveCount(0);
    await expect(page.getByText(body, { exact: true })).toHaveCount(0);
    const revisions = await withTenant(f.databases.db, f.tenantId, (tx) =>
      sql<{ body: string }>`select body from memory_revisions where memory_id=${memory.id}`.execute(
        tx,
      ),
    );
    expect(revisions.rows.length).toBeGreaterThan(1);
    expect(revisions.rows.every((item) => item.body === '')).toBe(true);
  } finally {
    await f.close();
  }
});

test('source membership revocation clears personal derived memory, visible details and an open editing draft', async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    const body = `撤权必须隐藏的派生结论 ${randomUUID()}`;
    await createFromSource(page, f.marker, body);
    await page.getByRole('button', { name: '修订内容、状态与有效期', exact: true }).click();
    const edit = page.getByRole('dialog', { name: '修订显式记忆', exact: true });
    await expect(edit.getByRole('textbox', { name: '记忆内容', exact: true })).toHaveValue(body);
    const current = await f.messaging.getConversation(f.bob, f.shared.id);
    await f.messaging.changeMember(
      f.bob,
      f.shared.id,
      f.alice.principalId,
      'remove',
      current.version,
      randomUUID(),
    );
    await expect(edit).toBeHidden();
    await expect(page.getByLabel('记忆详情')).toHaveCount(0);
    await expect(page.getByText(body, { exact: true })).toHaveCount(0);
    expect((await f.knowledge.listMemories(f.alice)).items).toHaveLength(0);
    await search(page, f.marker, 'message');
    await expect(
      page
        .getByLabel('搜索结果', { exact: true })
        .getByText('当前条件下没有可显示的结果。', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(f.message.body, { exact: true })).toHaveCount(0);
  } finally {
    await f.close();
  }
});
