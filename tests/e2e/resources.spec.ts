import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import {
  createResourceService,
  createArtifactCollaborationService,
  createS3ObjectStore,
  resourceApplicationHooks,
} from '@imbox/resources';
import { knowledgeResourceIndex } from '@imbox/knowledge';
import { createIdentityService } from '@imbox/auth';
import {
  createMessagingService,
  createOutboxProcessor,
  createSyncService,
  createTaskService,
} from '@imbox/application';
import { runtimeCompletionGate } from '@imbox/runtime';
import { requiredActionsClosed } from '@imbox/actions';
import { createApp } from '../../apps/api/src/app.js';
import { tenantFixture, testDatabases } from '../helpers/database.js';
const origin = 'http://127.0.0.1:4173';
const secret = 'playwright-resource-ui-real-postgres-and-s3-secret';
async function fixture(page: Page) {
  const databases = await testDatabases();
  const f = await tenantFixture(databases.owner);
  const endpoint = process.env['TEST_S3_ENDPOINT'] ?? 'http://127.0.0.1:18333';
  const config = { endpoint, region: 'us-east-1', bucket: 'imbox-resources-test' };
  const admin = createS3ObjectStore({
    ...config,
    accessKeyId: 'imbox_local_s3_admin',
    secretAccessKey: 'imbox_local_s3_admin_secret',
  });
  const store = createS3ObjectStore({
    ...config,
    accessKeyId: 'imbox_local_s3_app',
    secretAccessKey: 'imbox_local_s3_app_secret',
  });
  await admin.ensureDevelopmentBucket('test');
  await admin.configureDevelopmentCors([origin]);
  const resources = createResourceService({
    db: databases.db,
    store,
    cursorSecret: secret,
    textIndex: knowledgeResourceIndex(),
  });
  const collaboration = createArtifactCollaborationService({
    db: databases.db,
    store,
    cursorSecret: secret,
  });
  const hooks = resourceApplicationHooks();
  const messaging = createMessagingService(databases.db, secret, { resources: hooks.messages });
  const tasks = createTaskService(databases.db, secret, {
    artifacts: hooks.artifacts,
    requiredActionsClosed: async (tx, id) =>
      (await runtimeCompletionGate(tx, id)) && (await requiredActionsClosed(tx, id)),
  });
  const conversation = await messaging.createConversation(
    f.alice,
    {
      workspace_id: f.workspaceId,
      kind: 'group',
      title: '真实文件分享',
      member_ids: [f.bob.principalId],
      history_policy: 'all',
    },
    randomUUID(),
  );
  let task = await tasks.createTask(
    f.alice,
    {
      workspace_id: f.workspaceId,
      title: '固定版本成果验收',
      goal: '验收明确版本而非最新草稿',
      acceptance_criteria: ['依据固定原始内容验收'],
      reviewer_principal_ids: [f.alice.principalId],
      budget: { currency: 'USD', limit_microunits: '0' },
    },
    randomUUID(),
  );
  task = await tasks.changeState(f.alice, task.id, { state: 'active' }, task.version, randomUUID());
  const identity = createIdentityService({
    db: databases.db,
    identityDb: databases.identityDb,
    sessionSecret: secret,
    publicOrigin: origin,
    environment: 'test',
    enableDevAuth: true,
    devPrincipalIds: [...f.ids],
  });
  const app = createApp({
    identity,
    messaging,
    tasks,
    resources,
    collaboration,
    sync: createSyncService({ db: databases.db, cursorSecret: secret }),
    readiness: async () => {},
  });
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
  const apiOrigin = await app.listen({ host: '127.0.0.1', port: 0 });
  const session = await identity.devLogin({ principalId: f.alice.principalId, origin });
  await page
    .context()
    .addCookies([
      { name: 'imbox_session', value: session.token, url: origin, httpOnly: true, sameSite: 'Lax' },
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
  await expect(page.getByRole('button', { name: '文件与制品', exact: true })).toBeVisible();
  return {
    f,
    task,
    conversation,
    resources,
    collaboration,
    login: async (principalId: string) => {
      const login = await identity.devLogin({ principalId, origin });
      await page.context().addCookies([
        {
          name: 'imbox_session',
          value: login.token,
          url: origin,
          httpOnly: true,
          sameSite: 'Lax',
        },
      ]);
      await page.reload();
    },
    messaging,
    tasks,
    close: async () => {
      stopped = true;
      await page
        .context()
        .close()
        .catch(() => {});
      if (timer !== undefined) clearTimeout(timer);
      await pumping.catch(() => {});
      app.server.closeAllConnections();
      await Promise.allSettled([app.close()]);
      store.destroy();
      admin.destroy();
      await Promise.allSettled([databases.close()]);
    },
  };
}
async function upload(page: Page, name: string, content: string) {
  const dialog = page.getByRole('dialog').last();
  await dialog
    .getByLabel('选择文本文件', { exact: true })
    .setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(content) });
  await dialog.getByRole('button', { name: '上传并验证', exact: true }).click();
}
async function downloadedText(page: Page) {
  const ready = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载文件', exact: true }).click();
  const download = await ready;
  const path = await download.path();
  expect(path).not.toBeNull();
  return readFile(path!, 'utf8');
}
test('real browser S3 upload creates immutable versions and submits the selected version as task evidence', async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await page.getByRole('button', { name: '文件与制品', exact: true }).click();
    await page
      .getByRole('combobox', { name: '文件访问范围', exact: true })
      .selectOption(`task:${f.task.id}`);
    await page.getByRole('button', { name: '上传文件', exact: true }).first().click();
    await upload(page, 'evidence-v1.txt', '固定原始证据');
    await expect(
      page.getByLabel('文件详情').getByRole('heading', { name: 'evidence-v1.txt', exact: true }),
    ).toBeVisible();
    expect(await downloadedText(page)).toBe('固定原始证据');
    await page.getByRole('button', { name: '保存为版本化制品', exact: true }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: '制品标题', exact: true }).fill('明确版本的验收报告');
    await dialog.getByRole('button', { name: '创建制品', exact: true }).click();
    await expect(page.getByLabel('制品详情')).toBeVisible();
    const fixedVersion = await page
      .getByRole('textbox', { name: /^版本 1 的固定引用/ })
      .inputValue();
    await page.getByRole('button', { name: '上传新版本', exact: true }).click();
    await upload(page, 'evidence-v2.txt', '更新后的草稿');
    dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '追加新版本', exact: true }).click();
    await expect(page.getByRole('textbox', { name: /^版本 2 的固定引用/ })).toBeVisible();
    await page.getByRole('button', { name: '比较内容', exact: true }).click();
    await expect(page.getByLabel('起始版本变化范围')).toContainText('固定原始证据');
    await expect(page.getByLabel('目标版本变化范围')).toContainText('更新后的草稿');
    await page
      .getByRole('combobox', { name: '比较目标版本', exact: true })
      .selectOption({ label: '版本 1' });
    await page.getByRole('button', { name: '比较内容', exact: true }).click();
    await expect(page.getByText('两个版本内容完全相同。', { exact: true })).toBeVisible();
    const beforeConflict = (await f.resources.listArtifacts(f.f.alice, { task_id: f.task.id }))
      .items[0]!;
    await page.getByRole('button', { name: '上传新版本', exact: true }).click();
    await upload(page, 'conflicting-draft.txt', '需要保留的冲突修改');
    const concurrent = await f.resources.createArtifactVersion(
      f.f.alice,
      beforeConflict.id,
      { resource_id: beforeConflict.resource.id },
      beforeConflict.version,
      randomUUID(),
    );
    await page.getByRole('button', { name: '追加新版本', exact: true }).click();
    await expect(page.getByRole('button', { name: '重新核对最新版本', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '保存为独立分支', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const branches = page.getByLabel('产物分支', { exact: true });
    await branches
      .getByRole('button', { name: 'conflicting-draft.txt · 待合并', exact: true })
      .click();
    expect((await f.resources.getArtifact(f.f.alice, beforeConflict.id)).head_version).toBe('3');
    await branches.getByRole('button', { name: '上传整理后的合并内容', exact: true }).click();
    await upload(page, 'resolved.txt', '已经整理全部冲突的新内容');
    await page
      .getByRole('checkbox', { name: '已核对基础版本、当前主版本与分支内容。', exact: true })
      .check();
    await page.getByRole('button', { name: '合并为新主版本', exact: true }).click();
    await expect(page.getByRole('textbox', { name: /^版本 4 的固定引用/ })).toBeVisible();
    const mergedBranches = await f.resources.listArtifactBranches(f.f.alice, beforeConflict.id);
    expect(mergedBranches.items[0]).toMatchObject({
      status: 'merged',
      base_version_id: beforeConflict.version_id,
      merged_against_version_id: concurrent.version_id,
    });
    await page.getByRole('button', { name: /^版本 1 evidence-v1.txt/ }).click();
    expect(await downloadedText(page)).toBe('固定原始证据');
    const artifact = (await f.resources.listArtifacts(f.f.alice, { task_id: f.task.id })).items[0]!;
    await page.getByRole('button', { name: '任务工作台', exact: true }).click();
    await page
      .getByRole('navigation', { name: '任务列表' })
      .getByRole('button', { name: /固定版本成果验收/ })
      .click();
    await page.getByRole('button', { name: '提交结果与证据', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: '结果摘要', exact: true }).fill('按原始固定版本提交');
    await dialog.getByRole('combobox', { name: '证据制品', exact: true }).selectOption(artifact.id);
    await dialog
      .getByRole('combobox', { name: '证据固定版本', exact: true })
      .selectOption(fixedVersion);
    await dialog.getByRole('button', { name: '加入固定版本证据', exact: true }).click();
    await dialog.getByRole('button', { name: '提交验收', exact: true }).click();
    await expect(page.getByLabel('任务详情').getByText('待验收', { exact: true })).toBeVisible();
    const submission = (await f.tasks.submissions(f.f.alice, f.task.id)).items[0]!;
    expect(submission.evidence[0]).toMatchObject({
      type: 'artifact_version',
      version_id: fixedVersion,
      artifact_id: artifact.id,
    });
    await page.getByRole('button', { name: '查看这一固定版本', exact: true }).click();
    expect(await downloadedText(page)).toBe('固定原始证据');
  } finally {
    await f.close();
  }
});
test('conversation attachments publish after verification and deletion removes the usable attachment', async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await page
      .getByRole('navigation', { name: '会话列表' })
      .getByRole('button', { name: /真实文件分享/ })
      .click();
    await page.getByRole('button', { name: '添加附件', exact: true }).click();
    await upload(page, 'shared.txt', '经过验证的共享附件');
    await expect(page.locator('.composer-attachments')).toContainText('shared.txt');
    await page.getByRole('textbox', { name: '消息内容', exact: true }).fill('请查看附件');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByRole('button', { name: '查看附件 1', exact: true })).toBeVisible();
    const message = (await f.messaging.listMessages(f.f.alice, f.conversation.id)).items[0]!;
    expect(message.attachment_ids).toHaveLength(1);
    await page.getByRole('button', { name: '查看附件 1', exact: true }).click();
    expect(await downloadedText(page)).toBe('经过验证的共享附件');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '关闭', exact: true })
      .last()
      .click();
    await page.getByRole('button', { name: '文件与制品', exact: true }).click();
    await page
      .getByRole('combobox', { name: '文件访问范围', exact: true })
      .selectOption(`conversation:${f.conversation.id}`);
    await page
      .getByRole('navigation', { name: '文件列表' })
      .getByRole('button', { name: /shared.txt/ })
      .click();
    await page.getByRole('button', { name: '删除文件', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('checkbox', { name: '确认删除此文件。', exact: true }).check();
    await dialog.getByRole('button', { name: '确认删除文件', exact: true }).click();
    await expect(
      page
        .getByRole('navigation', { name: '文件列表' })
        .getByRole('button', { name: /shared.txt/ }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: '消息', exact: true }).click();
    await page
      .getByRole('navigation', { name: '会话列表' })
      .getByRole('button', { name: /真实文件分享/ })
      .click();
    await expect(page.getByText('请查看附件', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '查看附件 1', exact: true })).toHaveCount(0);
    expect(
      (await f.messaging.listMessages(f.f.alice, f.conversation.id)).items[0]!.attachment_ids,
    ).toEqual([]);
  } finally {
    await f.close();
  }
});

test('fixed-version comments anchor selected Unicode text and a controlled share grants only its download until revoked', async ({
  page,
}) => {
  const x = await fixture(page);
  try {
    const target = await x.messaging.createConversation(
      x.f.alice,
      {
        workspace_id: x.f.workspaceId,
        kind: 'group',
        title: '明确的分享接收范围',
        member_ids: [x.f.charlie.principalId],
        history_policy: 'all',
      },
      randomUUID(),
    );
    await page.getByRole('button', { name: '文件与制品', exact: true }).click();
    await page
      .getByRole('combobox', { name: '文件访问范围', exact: true })
      .selectOption('conversation:' + x.conversation.id);
    await page.getByRole('button', { name: '上传文件', exact: true }).first().click();
    await upload(page, 'collaborative.txt', '你好😀 world');
    await page.getByRole('button', { name: '保存为版本化制品', exact: true }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: '制品标题', exact: true }).fill('固定内容共同评阅');
    await dialog.getByRole('button', { name: '创建制品', exact: true }).click();
    await page.getByRole('button', { name: '预览并选择评论片段', exact: true }).click();
    const preview = page.getByLabel('版本正文', { exact: true });
    await expect(preview).toHaveValue('你好😀 world');
    await preview.focus();
    await preview.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(2, 4));
    expect(
      await preview.evaluate((node: HTMLTextAreaElement) => [
        node.selectionStart,
        node.selectionEnd,
      ]),
    ).toEqual([2, 4]);
    await page.getByRole('button', { name: '对选中文字评论', exact: true }).click();
    await expect(page.getByText('评论已选文字（3–3 字符）', { exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: '评论', exact: true }).fill('请确认这个字符');
    await page.getByRole('button', { name: '发表评论', exact: true }).click();
    await expect(page.getByText('请确认这个字符', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '编辑评论', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: '修改评论', exact: true }).fill('已经核对字符');
    await dialog.getByRole('button', { name: '保存评论', exact: true }).click();
    await expect(page.getByText('已经核对字符', { exact: true })).toBeVisible();
    await page
      .getByRole('combobox', { name: '接收范围', exact: true })
      .selectOption('conversation:' + target.id);
    await page.getByRole('checkbox', { name: /允许接收范围的当前成员/ }).check();
    await page.getByRole('button', { name: '创建受控分享', exact: true }).click();
    const link = await page
      .getByRole('status')
      .getByLabel('分享链接', { exact: true })
      .inputValue();
    const id = new URL(link).searchParams.get('share')!;
    await x.login(x.f.charlie.principalId);
    await page.getByRole('button', { name: '文件与制品', exact: true }).click();
    await page.getByRole('button', { name: '打开分享', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '打开受控分享' });
    await dialog.getByRole('textbox', { name: '分享链接或标识', exact: true }).fill(link);
    await dialog.getByRole('button', { name: '读取分享', exact: true }).click();
    await expect(
      dialog.getByRole('heading', { name: '固定内容共同评阅', exact: true }),
    ).toBeVisible();
    const waiting = page.waitForEvent('download');
    await dialog.getByRole('button', { name: '下载分享版本', exact: true }).click();
    const saved = await waiting;
    expect(await readFile((await saved.path())!, 'utf8')).toBe('你好😀 world');
    const share = await x.collaboration.getShare(x.f.alice, id);
    await x.collaboration.revokeShare(x.f.alice, id, share.version, randomUUID());
    await expect(dialog.getByRole('button', { name: '下载分享版本', exact: true })).toHaveCount(0);
  } finally {
    await x.close();
  }
});

test('task contributor appends an Artifact version and loses the edit entry after demotion', async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    const work = await f.tasks.changeParticipant(
      f.f.alice,
      f.task.id,
      f.f.bob.principalId,
      'contributor',
      f.task.version,
      randomUUID(),
    );
    await page.getByRole('button', { name: '文件与制品', exact: true }).click();
    await page
      .getByRole('combobox', { name: '文件访问范围', exact: true })
      .selectOption(`task:${work.id}`);
    await page.getByRole('button', { name: '上传文件', exact: true }).first().click();
    await upload(page, 'owner.txt', '负责人原始版本');
    await expect(page.getByLabel('文件详情')).toBeVisible();
    await page.getByRole('button', { name: '保存为版本化制品', exact: true }).click();
    await page.getByRole('textbox', { name: '制品标题', exact: true }).fill('多人协作成果');
    await page.getByRole('button', { name: '创建制品', exact: true }).click();
    await expect(page.getByLabel('制品详情')).toBeVisible();
    const artifact = (await f.resources.listArtifacts(f.f.alice, { task_id: work.id })).items[0]!;
    await f.login(f.f.bob.principalId);
    await page.getByRole('button', { name: '文件与制品', exact: true }).click();
    await page
      .getByRole('combobox', { name: '文件访问范围', exact: true })
      .selectOption(`task:${work.id}`);
    await page.getByRole('tab', { name: '制品版本', exact: true }).click();
    await page
      .getByRole('navigation', { name: '制品列表' })
      .getByRole('button', { name: /多人协作成果/ })
      .click();
    await page.getByRole('button', { name: '上传新版本', exact: true }).click();
    await upload(page, 'contributor.txt', '贡献者新增版本');
    await page.getByRole('button', { name: '追加新版本', exact: true }).click();
    await expect(page.getByRole('textbox', { name: /^版本 2 的固定引用/ })).toBeVisible();
    const versions = await f.resources.listArtifactVersions(f.f.alice, artifact.id);
    expect(versions.items.at(-1)?.created_by).toBe(f.f.bob.principalId);
    await page.getByRole('button', { name: /^版本 2 contributor.txt/ }).click();
    expect(await downloadedText(page)).toBe('贡献者新增版本');
    await f.tasks.changeParticipant(
      f.f.alice,
      work.id,
      f.f.bob.principalId,
      'observer',
      work.version,
      randomUUID(),
    );
    await page.getByRole('button', { name: '刷新资源', exact: true }).click();
    await expect(page.getByRole('button', { name: '上传新版本', exact: true })).toHaveCount(0);
    expect((await f.resources.getArtifact(f.f.bob, artifact.id)).can_append_version).toBe(false);
  } finally {
    await f.close();
  }
});
