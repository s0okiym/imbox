import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { createIdentityService } from '@imbox/auth';
import {
  createOutboxProcessor,
  createSyncService,
  createTaskMaintenance,
  createTaskService,
} from '@imbox/application';
import { runtimeCompletionGate, runtimePromotionPort } from '@imbox/runtime';
import { requiredActionsClosed } from '@imbox/actions';
import { createSchedulingService } from '@imbox/scheduling';
import { sql, withTenant } from '@imbox/db';
import { createApp } from '../../apps/api/src/app.js';
import { modelFixture } from '../helpers/model.js';
import { testDatabases } from '../helpers/database.js';

const origin = 'http://127.0.0.1:4173';
const secret = 'playwright-finite-schedules-promotion-escalations-real-api-secret';
async function fixture(page: Page) {
  const databases = await testDatabases();
  const f = await modelFixture(databases);
  const tasks = createTaskService(databases.db, secret, {
    promotion: runtimePromotionPort(),
    requiredActionsClosed: async (tx, id) =>
      (await runtimeCompletionGate(tx, id)) && (await requiredActionsClosed(tx, id)),
  });
  const scheduling = createSchedulingService({ db: databases.db, cursorSecret: secret });
  const maintenance = createTaskMaintenance(databases.db, secret);
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
    tasks,
    runtime: f.runtime,
    messaging: f.messaging,
    scheduling,
    maintenance,
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
  const session = await identity.devLogin({ principalId: f.alice.principalId, origin });
  await page
    .context()
    .addCookies([
      { name: 'imbox_session', value: session.token, url: origin, httpOnly: true, sameSite: 'Lax' },
    ]);
  await page.addInitScript((tenant) => localStorage.setItem('imbox.tenant', tenant), f.tenantId);
  // Only forwards to a separate real server. No business response is mocked.
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
  return {
    ...f,
    databases,
    tasks,
    scheduling,
    maintenance,
    close: async () => {
      if (!page.isClosed()) await page.close().catch(() => {});
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await pumping.catch(() => {});
      // route.fetch uses Playwright's API request transport, whose connections can
      // outlive the browser page. All business commands are awaited above; only
      // the fixture's background reads may still own a socket at this point.
      app.server.closeAllConnections();
      await app.close().catch(() => {});
      await databases.close();
    },
  };
}
async function openRun(page: Page, id: string) {
  await page.goto('/');
  await page.getByRole('button', { name: '运行与行动', exact: true }).click();
  await page.getByRole('button', { name: '按运行 ID 打开', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '按运行 ID 打开', exact: true });
  await dialog.getByRole('textbox', { name: '运行 ID', exact: true }).fill(id);
  await dialog.getByRole('button', { name: '打开运行', exact: true }).click();
  await expect(page.getByLabel('运行详情')).toBeVisible();
}

test('finite wakeup UI creates, revises and disables a plan without resetting or resuming the original run', async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    let task = await f.tasks.createTask(
      f.alice,
      {
        workspace_id: f.workspaceId,
        title: '明确暂停后再唤醒',
        goal: '继续同一授权的工作',
        acceptance_criteria: ['人工核对'],
        reviewer_principal_ids: [f.alice.principalId],
        budget: { currency: 'USD', limit_microunits: '100' },
      },
      randomUUID(),
    );
    task = await f.tasks.changeParticipant(
      f.alice,
      task.id,
      f.agentId,
      'contributor',
      task.version,
      randomUUID(),
    );
    const queued = await f.runtime.createRun(
      f.alice,
      {
        agent_id: f.installation.id,
        agent_revision: '1',
        task_id: task.id,
        context: [],
        purpose: '仅恢复已有工作',
        destination: 'model:local',
        budget: { currency: 'USD', limit_microunits: '50' },
      },
      randomUUID(),
    );
    const paused = await f.runtime.controlRun(
      f.alice,
      queued.id,
      'pause',
      queued.version,
      randomUUID(),
    );
    await openRun(page, paused.id);
    await page.getByRole('button', { name: '设置定时唤醒', exact: true }).click();
    const create = page.getByRole('dialog', { name: '新建唤醒计划', exact: true });
    await expect(
      create.getByRole('combobox', { name: '要恢复的暂停运行', exact: true }),
    ).toHaveValue(paused.id);
    await expect(
      create.getByRole('button', { name: '创建有限唤醒计划', exact: true }),
    ).toBeDisabled();
    await create.getByRole('checkbox', { name: /我确认仅在原权限/ }).check();
    await create.getByRole('button', { name: '创建有限唤醒计划', exact: true }).click();
    const detail = page.getByLabel('唤醒计划详情');
    await expect(detail.getByRole('heading', { name: '一次唤醒', exact: true })).toBeVisible();
    let plan = (await f.scheduling.list(f.alice)).items[0]!;
    expect(plan).toMatchObject({
      run_id: paused.id,
      task_id: task.id,
      maximum_wakeups: 1,
      status: 'enabled',
    });
    await detail.getByRole('button', { name: '修订计划', exact: true }).click();
    const edit = page.getByRole('dialog', { name: '修订唤醒计划', exact: true });
    await edit.getByRole('combobox', { name: '触发方式', exact: true }).selectOption('daily');
    await edit.getByRole('textbox', { name: '每日规则时区', exact: true }).fill('UTC');
    await edit
      .getByLabel(/^每日当地时间/)
      .fill(new Date(Date.now() + 2 * 3_600_000).toISOString().slice(11, 16));
    await edit.getByRole('spinbutton', { name: /^累计触发额度/ }).fill('2');
    await edit.getByRole('checkbox', { name: /我确认仅在原权限/ }).check();
    await edit.getByRole('button', { name: '提交计划修订', exact: true }).click();
    await expect(edit).toBeHidden();
    plan = await f.scheduling.get(f.alice, plan.id);
    expect(plan).toMatchObject({
      revision: '2',
      trigger: { kind: 'daily' },
      timezone: 'UTC',
      maximum_wakeups: 2,
    });
    await detail.getByRole('button', { name: '停用计划', exact: true }).click();
    const disable = page.getByRole('dialog', { name: '停用唤醒计划', exact: true });
    await disable.getByRole('checkbox').check();
    await disable.getByRole('button', { name: '确认停用计划', exact: true }).click();
    await expect(disable).toBeHidden();
    expect(await f.scheduling.get(f.alice, plan.id)).toMatchObject({
      status: 'disabled',
      revision: '3',
      next_at: null,
    });
    expect(await f.runtime.getRun(f.alice, paused.id)).toEqual(paused);
    expect(await f.scheduling.collectDue(f.tenantId)).toBe(0);
    expect(await f.scheduling.dispatchPending(f.tenantId)).toBe(0);
  } finally {
    await f.close();
  }
});

test('conversation run promotion requires a new goal and explicit authorization; revoked origin disappears', async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    const queued = await f.createRun();
    const claim = await f.worker.claim(f.tenantId, queued.id);
    await f.worker.report(
      claim!,
      { status: 'completed', checkpoint: {}, output: 'A preliminary answer, never the new goal' },
      randomUUID(),
    );
    const original = await f.runtime.getRun(f.alice, queued.id);
    await openRun(page, original.id);
    await page.getByRole('button', { name: '升级为独立任务', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '把会话运行升级为新任务', exact: true });
    await expect(dialog.getByRole('textbox', { name: '目标', exact: true })).toHaveValue('');
    await dialog.getByRole('textbox', { name: '任务标题', exact: true }).fill('明确授权的新任务');
    await dialog
      .getByRole('textbox', { name: '目标', exact: true })
      .fill('由用户重新指定目标与边界');
    await dialog.getByRole('textbox', { name: /^验收标准/ }).fill('人工核对新的验收结果');
    await dialog.getByRole('textbox', { name: /^预算上限/ }).fill('0');
    await expect(dialog.getByRole('button', { name: '创建独立任务', exact: true })).toBeDisabled();
    await dialog.getByRole('checkbox', { name: /我确认建立新的任务授权边界/ }).check();
    await dialog.getByRole('button', { name: '创建独立任务', exact: true }).click();
    const detail = page.getByLabel('任务详情');
    await expect(
      detail.getByRole('heading', { name: '明确授权的新任务', exact: true }),
    ).toBeVisible();
    await expect(detail.getByText('由用户重新指定目标与边界', { exact: true })).toBeVisible();
    const task = (await f.tasks.listTasks(f.alice, { limit: 100 })).items[0]!;
    expect(task.goal).not.toContain('preliminary');
    expect(
      (await f.tasks.participants(f.alice, task.id)).items.some(
        (item) => item.principal_id === f.agentId,
      ),
    ).toBe(false);
    expect(await f.runtime.getRun(f.alice, original.id)).toEqual(original);
    await detail.getByRole('button', { name: '查看有权访问的来源运行', exact: true }).click();
    await expect(page.getByLabel('运行详情')).toBeVisible();
    await page.getByRole('button', { name: '任务工作台', exact: true }).click();
    await page
      .getByRole('navigation', { name: '任务列表', exact: true })
      .getByRole('button', { name: /明确授权的新任务/ })
      .click();
    await f.messaging.changeMessage(f.alice, f.message.id, null, f.message.version, randomUUID());
    await expect(
      detail.getByText('当前无权查看来源运行。任务自身的授权与验收边界保持独立。', { exact: true }),
    ).toBeVisible();
    await expect(
      detail.getByRole('button', { name: '查看有权访问的来源运行', exact: true }),
    ).toHaveCount(0);
    await expect(
      detail.getByRole('heading', { name: '明确授权的新任务', exact: true }),
    ).toBeVisible();
  } finally {
    await f.close();
  }
});

test('administrator sees escalation metadata only until explicitly taking responsibility for the private task', async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    const privateTask = await f.tasks.createTask(
      f.bob,
      {
        workspace_id: f.workspaceId,
        title: '原本私有的任务正文',
        goal: '接管之前不得泄露的私有目标',
        acceptance_criteria: ['原任务约定'],
        reviewer_principal_ids: [f.bob.principalId],
        budget: { currency: 'USD', limit_microunits: '0' },
      },
      randomUUID(),
    );
    await f.databases.identityDb
      .updateTable('principals')
      .set({ status: 'disabled' })
      .where('id', '=', f.bob.principalId)
      .execute();
    await f.maintenance.process(f.tenantId);
    await expect(f.tasks.getTask(f.alice, privateTask.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const bodyReads: string[] = [];
    page.on('request', (request) => {
      if (
        request.method() === 'GET' &&
        new URL(request.url()).pathname === `/v1/tasks/${privateTask.id}`
      )
        bodyReads.push(request.url());
    });
    await page.goto('/');
    await page.getByRole('button', { name: '任务工作台', exact: true }).click();
    await page.getByRole('button', { name: '任务升级待处理', exact: true }).click();
    const inbox = page.getByRole('dialog', { name: '任务升级待处理', exact: true });
    await expect(
      inbox.getByRole('heading', { name: '任务负责人当前不可用', exact: true }),
    ).toBeVisible();
    await expect(page.getByText(privateTask.goal, { exact: true })).toHaveCount(0);
    await expect(page.getByText(privateTask.title, { exact: true })).toHaveCount(0);
    await inbox.getByRole('button', { name: '核对并接管此任务', exact: true }).click();
    const takeover = page.getByRole('dialog', { name: '明确接管任务', exact: true });
    await takeover
      .getByRole('textbox', { name: '管理员接管理由', exact: true })
      .fill('原负责人不可用，由我明确接管处理');
    await takeover.getByRole('checkbox', { name: /我确认承担此任务/ }).check();
    expect(bodyReads).toHaveLength(0);
    await takeover.getByRole('button', { name: '确认接管并打开任务', exact: true }).click();
    await expect(
      page.getByLabel('任务详情').getByRole('heading', { name: privateTask.title, exact: true }),
    ).toBeVisible();
    const result = await f.tasks.getTask(f.alice, privateTask.id);
    expect(result.owner_principal_id).toBe(f.alice.principalId);
    expect(BigInt(result.execution_epoch)).toBeGreaterThan(BigInt(privateTask.execution_epoch));
    const oldOwner = await withTenant(f.databases.db, f.tenantId, (tx) =>
      sql<{
        role: string;
        status: string;
      }>`select role,status from task_participants where task_id=${privateTask.id} and principal_id=${f.bob.principalId}`.execute(
        tx,
      ),
    );
    expect(oldOwner.rows[0]).not.toMatchObject({ role: 'owner', status: 'active' });
  } finally {
    await f.close();
  }
});
