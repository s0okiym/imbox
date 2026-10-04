import { createModelDriver, createOllamaAdapter } from '@imbox/model-runtime';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { createAgentService } from '@imbox/agents';
import {
  createActionService,
  createFileJournal,
  createHttpToolRegistry,
  createToolRunner,
  requiredActionsClosed,
  cancelPendingTaskActions,
} from '@imbox/actions';
import { createIdentityService } from '@imbox/auth';
import { createMessagingService, createTaskService } from '@imbox/application';
import {
  createRuntimeService,
  createRuntimeWorker,
  runtimeCompletionGate,
  stopTaskRuns,
} from '@imbox/runtime';
import type { Action } from '@imbox/contracts';
import { sql, withTenant } from '@imbox/db';
import { createApp } from '../../apps/api/src/app.js';
import { tenantFixture, testDatabases } from '../helpers/database.js';

const origin = 'http://127.0.0.1:4173';
const secret = 'playwright-runtime-actions-independent-real-services-secret';
const modelDigest = 'sha256:' + 'd'.repeat(64);
async function fixture(page: Page) {
  const databases = await testDatabases();
  const f = await tenantFixture(databases.owner);
  const directory = await mkdtemp(join(tmpdir(), 'imbox-web-actions-'));
  let stopped = false;
  let sends = 0;
  let effects = 0;
  const receipts = new Map<string, unknown>();
  const connector = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/tags') {
      response.end(JSON.stringify({ models: [{ name: 'qwen3:0.6b', digest: modelDigest }] }));
      return;
    }
    if (request.method === 'GET') {
      response.end(
        JSON.stringify(
          receipts.get(url.searchParams.get('business_key')!) ?? { status: 'not_found' },
        ),
      );
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const input = JSON.parse(body) as {
        business_key: string;
        fingerprint: string;
        format?: unknown;
        tenant_id: string;
        action_id: string;
        attempt_id: string;
      };
      if (url.pathname === '/api/chat') {
        response.end(
          JSON.stringify({
            model: 'qwen3:0.6b',
            done: true,
            done_reason: 'stop',
            message: {
              role: 'assistant',
              content: input.format
                ? JSON.stringify({ kind: 'tool_intent', text: 'Browser fixed tool delivery' })
                : 'Provider confirmed the original delivery; no second send.',
            },
            prompt_eval_count: 100,
            eval_count: 12,
          }),
        );
        return;
      }
      sends += 1;
      if (!receipts.has(input.business_key)) {
        effects += 1;
        receipts.set(input.business_key, {
          status: 'succeeded',
          receipt_id: randomUUID(),
          fingerprint: input.fingerprint,
          cost_microunits: '7',
          safe_retry: false,
          tenant_id: input.tenant_id,
          action_id: input.action_id,
          attempt_id: input.attempt_id,
        });
      }
      response.destroy(); // Real remote effect followed by a lost response, never a mocked API reply.
    });
  });
  connector.listen(0, '127.0.0.1');
  await once(connector, 'listening');
  const connectorOrigin = `http://127.0.0.1:${(connector.address() as AddressInfo).port}`;
  const journal = await createFileJournal({ directory, signingKey: secret });
  const actions = createActionService({
    db: databases.db,
    journal,
    cursorSecret: secret,
    tools: createHttpToolRegistry([
      {
        id: 'demo.delivery',
        version: '1',
        targetId: 'demo-provider',
        executeUrl: `${connectorOrigin}/execute`,
        lookupUrl: `${connectorOrigin}/lookup`,
        allowInsecureLoopback: true,
        retryDelayMs: 0,
        approvalRequired: true,
        estimateMicrounits: '7',
      },
    ]),
  });
  const tasks = createTaskService(databases.db, secret, {
    stopTaskExecution: async (tx, auth, id) => {
      await stopTaskRuns(tx, auth, id);
      await cancelPendingTaskActions(tx, auth, id);
    },
    requiredActionsClosed: async (tx, id) =>
      (await runtimeCompletionGate(tx, id)) && (await requiredActionsClosed(tx, id)),
  });
  const runtime = createRuntimeService({ db: databases.db, cursorSecret: secret });
  const agents = createAgentService({ db: databases.db, identityDb: databases.identityDb, secret });
  const agent = await agents.register(
    f.alice,
    {
      workspace_id: f.workspaceId,
      display_name: 'Browser test assistant',
      mode: 'hosted',
      scopes: ['tasks.read', 'runs.read', 'runs.execute'],
      capabilities: ['text_generation'],
      config: { model_alias: 'local' },
    },
    randomUUID(),
  );
  let task = await tasks.createTask(
    f.alice,
    {
      workspace_id: f.workspaceId,
      title: '浏览器真实执行边界',
      goal: '只处理明确输入，逐项核对外部效果',
      acceptance_criteria: ['记录明确回执'],
      reviewer_principal_ids: [f.alice.principalId],
      budget: { currency: 'USD', limit_microunits: '1000000' },
    },
    randomUUID(),
  );
  task = await tasks.changeParticipant(
    f.alice,
    task.id,
    f.bob.principalId,
    'contributor',
    task.version,
    randomUUID(),
  );
  task = await tasks.changeParticipant(
    f.alice,
    task.id,
    agent.principal_id,
    'contributor',
    task.version,
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
    devPrincipalIds: [f.alice.principalId],
  });
  const app = createApp({
    identity,
    agents,
    runtime,
    tasks,
    actions,
    messaging: createMessagingService(databases.db, secret),
    readiness: async () => {},
  });
  const apiOrigin = await app.listen({ host: '127.0.0.1', port: 0 });
  const login = await identity.devLogin({ principalId: f.alice.principalId, origin });
  await page
    .context()
    .addCookies([
      { name: 'imbox_session', value: login.token, url: origin, httpOnly: true, sameSite: 'Lax' },
    ]);
  await page.addInitScript((tenant) => localStorage.setItem('imbox.tenant', tenant), f.tenantId);
  // Browser-level forwarding keeps the existing Vite server; every response comes from the real API + PostgreSQL.
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
  await page.getByRole('button', { name: '运行与行动', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '运行列表' })).toBeVisible();
  return {
    f,
    task,
    agent,
    actions,
    runtime,
    tasks,
    databases,
    driver: createModelDriver({
      worker: createRuntimeWorker({ db: databases.db, workerId: 'browser-hosted-model' }),
      actions,
      models: new Map([
        [
          'local',
          createOllamaAdapter({
            origin: connectorOrigin,
            model: 'qwen3:0.6b',
            digest: modelDigest,
            allowLoopbackHttp: true,
          }),
        ],
      ]),
    }),
    effects: () => effects,
    sends: () => sends,
    close: async () => {
      stopped = true;
      // Playwright may already have closed a timed-out page. Cleanup must not replace its assertion failure.
      await page
        .context()
        .close()
        .catch(() => {});
      app.server.closeAllConnections();
      connector.closeAllConnections();
      await Promise.allSettled([
        app.close(),
        new Promise<void>((resolve, reject) =>
          connector.close((error) => (error ? reject(error) : resolve())),
        ),
      ]);
      await Promise.allSettled([
        databases.close(),
        rm(directory, { recursive: true, force: true }),
      ]);
    },
  };
}
async function createRun(page: Page, f: Awaited<ReturnType<typeof fixture>>, grantId?: string) {
  await page.getByRole('button', { name: '新建运行', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: '执行 Agent', exact: true }).selectOption(f.agent.id);
  await dialog.getByRole('combobox', { name: '关联任务', exact: true }).selectOption(f.task.id);
  await dialog.getByRole('checkbox', { name: /任务标题与目标/ }).check();
  if (grantId)
    await dialog
      .getByRole('combobox', { name: '本次运行的工具授权', exact: true })
      .selectOption(grantId);
  if (grantId) {
    await expect(dialog.getByRole('alert')).toContainText('运行预算必须');
    await expect(dialog.getByRole('button', { name: '创建运行', exact: true })).toBeDisabled();
    await dialog.getByLabel('运行预算上限', { exact: true }).fill('0.001');
  }
  await dialog.getByRole('textbox', { name: '处理目的', exact: true }).fill('检查明确输入');
  await expect(dialog.getByRole('textbox', { name: /^处理目的地/ })).toHaveValue('model:local');
  await dialog.getByRole('checkbox', { name: /我已核对 Agent/ }).check();
  await dialog.getByRole('button', { name: '创建运行', exact: true }).click();
  await expect(
    page.getByLabel('运行详情').getByRole('heading', { name: '排队中', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('运行详情').getByText('model:local', { exact: true })).toBeVisible();
}
test('runtime UI discloses fixed context and budget, controls real runs, and restores scoped history', async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await createRun(page, f);
    await expect(page.getByLabel('运行详情').getByText(/目标: 只处理明确输入/)).toBeVisible();
    await expect(page.getByLabel('运行预算')).toContainText('USD');
    for (const [label, state] of [
      ['暂停运行', '已暂停'],
      ['继续运行', '排队中'],
      ['取消运行', '已取消'],
    ] as const) {
      await page.getByRole('button', { name: label, exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('checkbox').check();
      await dialog.getByRole('button', { name: `确认${label}`, exact: true }).click();
      await expect(
        page.getByLabel('运行详情').getByRole('heading', { name: state, exact: true }),
      ).toBeVisible();
    }
    await expect(page.getByText('尚无执行器停止确认。', { exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: '运行与行动', exact: true }).click();
    await page
      .getByRole('combobox', { name: '运行记录范围', exact: true })
      .selectOption(`task:${f.task.id}`);
    await expect(
      page.getByRole('navigation', { name: '运行列表' }).getByText('已取消', { exact: true }),
    ).toBeVisible();
  } finally {
    await f.close();
  }
});
test('runtime UI shows worker stop confirmation separately from the cancellation request', async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await createRun(page, f);
    const run = (await f.runtime.listRuns(f.f.alice, { task_id: f.task.id })).items[0]!;
    const worker = createRuntimeWorker({
      db: f.databases.db,
      workerId: 'browser-cancellation-ack',
    });
    const claim = await worker.claim(f.f.tenantId, run.id);
    expect(claim).not.toBeNull();
    await page.getByRole('button', { name: '刷新运行', exact: true }).click();
    await expect(
      page.getByLabel('运行详情').getByRole('heading', { name: '运行中', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '取消运行', exact: true }).click();
    await page.getByRole('dialog').getByRole('checkbox').check();
    await page.getByRole('button', { name: '确认取消运行', exact: true }).click();
    await expect(page.getByText('尚无执行器停止确认。', { exact: true })).toBeVisible();
    await worker.report(
      claim!,
      { status: 'cancelled', checkpoint: { stopped: true } },
      randomUUID(),
    );
    await page.getByRole('button', { name: '刷新运行', exact: true }).click();
    await expect(
      page.getByLabel('运行详情').getByRole('heading', { name: '已取消', exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/^执行器已确认停止：/)).toBeVisible();
  } finally {
    await f.close();
  }
});
test('task cancellation signals the running worker and displays its later stop acknowledgement', async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await createRun(page, f);
    const run = (await f.runtime.listRuns(f.f.alice, { task_id: f.task.id })).items[0]!;
    const worker = createRuntimeWorker({
      db: f.databases.db,
      workerId: 'browser-cancellation-ack',
    });
    const claim = await worker.claim(f.f.tenantId, run.id);
    expect(claim).not.toBeNull();
    await page.getByRole('button', { name: '刷新运行', exact: true }).click();
    await expect(
      page.getByLabel('运行详情').getByRole('heading', { name: '运行中', exact: true }),
    ).toBeVisible();
    await f.tasks.cancelTask(
      f.f.alice,
      f.task.id,
      { reason: 'Cancel task and execution' },
      f.task.version,
      randomUUID(),
    );
    await page.getByRole('button', { name: '刷新运行', exact: true }).click();
    expect((await worker.heartbeat(claim!)).cancellation_requested).toBe(true);
    await expect(page.getByText('尚无执行器停止确认。', { exact: true })).toBeVisible();
    await worker.report(
      claim!,
      { status: 'cancelled', checkpoint: { stopped: true } },
      randomUUID(),
    );
    await page.getByRole('button', { name: '刷新运行', exact: true }).click();
    await expect(
      page.getByLabel('运行详情').getByRole('heading', { name: '已取消', exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/^执行器已确认停止：/)).toBeVisible();
  } finally {
    await f.close();
  }
});
test('grant → proposal → exact human approval → lost response → lookup has one external effect', async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await page.getByRole('tab', { name: '授权', exact: true }).click();
    await page.getByRole('button', { name: '新建授权', exact: true }).first().click();
    let dialog = page.getByRole('dialog');
    await dialog
      .getByRole('combobox', { name: '授权所属任务', exact: true })
      .selectOption(f.task.id);
    await dialog
      .getByRole('combobox', { name: '获授权的执行者', exact: true })
      .selectOption(f.f.bob.principalId);
    await dialog.getByRole('checkbox', { name: /Alice/ }).check();
    await dialog.getByLabel(/^授权预算上限/).fill('0.00001');
    await dialog.getByRole('checkbox', { name: /允许此执行者/ }).check();
    await dialog.getByRole('checkbox', { name: /允许将经人工审批/ }).check();
    await dialog.getByRole('button', { name: '签发授权', exact: true }).click();
    await expect(page.getByLabel('授权详情')).toBeVisible();
    await page.getByRole('button', { name: '使用此授权提出行动', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('将发送给目标的完整内容', { exact: true }).fill('唯一的已批准消息');
    await dialog.getByLabel(/^本次费用预估上限/).fill('0.00001');
    await dialog.getByRole('checkbox', { name: /我已核对授权/ }).check();
    await dialog.getByRole('button', { name: '提交行动提案', exact: true }).click();
    await expect(
      page.getByLabel('行动详情').getByRole('heading', { name: '等待人工审批', exact: true }),
    ).toBeVisible();
    expect(f.effects()).toBe(0);
    await page.getByRole('button', { name: '核对并批准', exact: true }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByText('唯一的已批准消息', { exact: true })).toBeVisible();
    await dialog.getByLabel('决定说明', { exact: true }).fill('核对了完整内容、目标与费用');
    await dialog.getByRole('checkbox', { name: /我已逐项核对/ }).check();
    await dialog.getByRole('button', { name: '提交明确决定', exact: true }).click();
    await expect(
      page.getByLabel('行动详情').getByRole('heading', { name: '等待执行', exact: true }),
    ).toBeVisible();
    const action = (await f.actions.listActions(f.f.alice, {})).items[0] as Action;
    await createToolRunner({ actions: f.actions, workerId: 'browser-real-tool-worker' }).runOnce(
      f.f.tenantId,
      action.id,
    );
    await page.getByRole('button', { name: '刷新行动', exact: true }).click();
    await expect(
      page.getByLabel('行动详情').getByRole('heading', { name: '结果未知', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /重新执行|重新发送|重试行动/ })).toHaveCount(0);
    await page.getByRole('button', { name: '查询外部结果', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('查询理由', { exact: true }).fill('只查询已有回执');
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: '仅查询已有结果', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('没有再次发送');
    expect(f.sends()).toBe(1);
    expect(f.effects()).toBe(1);
    await dialog.getByRole('button', { name: '关闭', exact: true }).last().click();
    await expect(
      page.getByLabel('行动详情').getByRole('heading', { name: '外部结果已确认', exact: true }),
    ).toBeVisible();
  } finally {
    await f.close();
  }
});
test('a revoked source removes previously visible run context from the browser', async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await createRun(page, f);
    await withTenant(f.databases.owner, f.f.tenantId, (tx) =>
      sql`update task_participants set status='removed',version=version+1 where task_id=${f.task.id} and principal_id=${f.f.alice.principalId}`.execute(
        tx,
      ),
    );
    // Background authorization polling can remove this panel before any manual refresh.
    // Verify automatic redaction rather than racing a button that should disappear.
    await expect(page.getByLabel('运行详情')).toHaveCount(0);
    await expect(page.getByText('model:local', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => Object.keys(localStorage))).toEqual(['imbox.tenant']);
  } finally {
    await f.close();
  }
});

test('Run-bound tool UI requires human approval and explicit resume, reconciles one unknown effect, then only summarizes', async ({
  page,
}) => {
  test.setTimeout(60000);
  const f = await fixture(page);
  try {
    const grant = await f.actions.createGrant(
      f.f.alice,
      {
        task_id: f.task.id,
        executor_principal_id: f.agent.principal_id,
        tool_id: 'demo.delivery',
        tool_version: '1',
        target_id: 'demo-provider',
        allow_execute: true,
        allow_disclosure: true,
        resource_versions: [{ type: 'task', id: f.task.id, version: f.task.version }],
        approver_principal_ids: [f.f.alice.principalId],
        budget: { currency: 'USD', limit_microunits: '1000' },
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      },
      randomUUID(),
    );
    await page.reload();
    await createRun(page, f, grant.id);
    const run = (await f.runtime.listRuns(f.f.alice, { task_id: f.task.id })).items[0]!;
    expect(run.tool_grant_id).toBe(grant.id);
    expect(await f.driver.execute(f.f.tenantId, run.id)).toBe('waiting');
    await page.getByRole('button', { name: '刷新运行', exact: true }).click();
    await page.getByRole('button', { name: '查看并审批关联行动', exact: true }).click();
    await page.getByRole('button', { name: '核对并批准', exact: true }).click();
    let dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Browser fixed tool delivery', { exact: true })).toBeVisible();
    await dialog.getByLabel('决定说明', { exact: true }).fill('核对固定内容、目标、上下文与费用');
    await dialog.getByRole('checkbox', { name: /我已逐项核对/ }).check();
    await dialog.getByRole('button', { name: '提交明确决定', exact: true }).click();
    expect(await f.driver.execute(f.f.tenantId, run.id)).toBe('fenced');
    expect(f.effects()).toBe(0);
    const resume = async () => {
      await page.goto(`/runs/${run.id}`);
      await page.getByRole('button', { name: '继续运行', exact: true }).click();
      const control = page.getByRole('dialog');
      await control.getByRole('checkbox').check();
      await control.getByRole('button', { name: '确认继续运行', exact: true }).click();
      await expect(
        page.getByLabel('运行详情').getByRole('heading', { name: '排队中', exact: true }),
      ).toBeVisible();
    };
    await resume();
    expect(await f.driver.execute(f.f.tenantId, run.id)).toBe('waiting');
    expect(f.effects()).toBe(1);
    expect(f.sends()).toBe(1);
    await page.getByRole('button', { name: '刷新运行', exact: true }).click();
    await page.getByRole('button', { name: '查看并审批关联行动', exact: true }).click();
    await expect(
      page.getByLabel('行动详情').getByRole('heading', { name: '结果未知', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '查询外部结果', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('查询理由', { exact: true }).fill('核对原回执，不重发');
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: '仅查询已有结果', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('没有再次发送');
    await dialog.getByRole('button', { name: '关闭', exact: true }).last().click();
    await resume();
    expect(await f.driver.execute(f.f.tenantId, run.id)).toBe('completed');
    await page.getByRole('button', { name: '刷新运行', exact: true }).click();
    await expect(page.getByLabel('运行详情')).toContainText(
      'Provider confirmed the original delivery; no second send.',
    );
    expect(f.sends()).toBe(1);
    expect(f.effects()).toBe(1);
    expect((await f.runtime.getRun(f.f.alice, run.id)).budget).toMatchObject({
      spent_microunits: '7',
      reserved_microunits: '0',
    });
  } finally {
    await f.close();
  }
});

test('handoff UI requires explicit disclosure of the outstanding action manifest', async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    const grant = await f.actions.createGrant(
      f.f.alice,
      {
        task_id: f.task.id,
        executor_principal_id: f.f.bob.principalId,
        tool_id: 'demo.delivery',
        tool_version: '1',
        target_id: 'demo-provider',
        allow_execute: true,
        allow_disclosure: true,
        resource_versions: [{ type: 'task', id: f.task.id, version: f.task.version }],
        approver_principal_ids: [f.f.alice.principalId],
        budget: { currency: 'USD', limit_microunits: '100' },
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      },
      randomUUID(),
    );
    const action = await f.actions.createAction(
      f.f.bob,
      {
        task_id: f.task.id,
        grant_id: grant.id,
        executor_principal_id: f.f.bob.principalId,
        tool_id: 'demo.delivery',
        tool_version: '1',
        target_id: 'demo-provider',
        parameters: { text: 'Parameters must not appear in a handoff offer' },
        resource_versions: [{ type: 'task', id: f.task.id, version: f.task.version }],
        business_key: randomUUID(),
        estimate: { currency: 'USD', limit_microunits: '10' },
      },
      randomUUID(),
    );
    await page.getByRole('button', { name: '任务工作台', exact: true }).click();
    await page
      .getByRole('navigation', { name: '任务列表' })
      .getByText(f.task.title, { exact: true })
      .click();
    await page.getByRole('button', { name: '发起协作提案', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog
      .getByRole('combobox', { name: '收件人', exact: true })
      .selectOption({ label: 'Charlie' });
    await dialog
      .getByLabel('对收件人披露的说明', { exact: true })
      .fill('共享待处理行动编号，接受后独立核对');
    await dialog.getByLabel('已完成内容', { exact: true }).fill('已确认任务范围');
    await dialog.getByLabel('待完成内容', { exact: true }).fill('核对遗留行动，再完成任务');
    await expect(
      dialog.getByLabel('交接行动清单').getByText(action.id, { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByRole('button', { name: '发送提案', exact: true })).toBeDisabled();
    await dialog.getByRole('checkbox', { name: /我已核对并同意将以上行动编号/ }).check();
    await dialog.getByRole('button', { name: '发送提案', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page.getByRole('tab', { name: /协作请求/ }).click();
    await page.getByRole('button', { name: '发出的', exact: true }).click();
    await page
      .getByRole('navigation', { name: '协作请求列表' })
      .getByRole('button', { name: new RegExp(f.task.title) })
      .click();
    await expect(
      page.getByLabel('提案行动编号').getByText(action.id, { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('协作提案详情')).not.toContainText(
      'Parameters must not appear in a handoff offer',
    );
    expect(f.sends()).toBe(0);
    expect(f.effects()).toBe(0);
  } finally {
    await f.close();
  }
});

test('recovery UI freezes, verifies an orphan through read-only provider evidence, accounts once and explicitly unfreezes', async ({
  page,
}) => {
  test.setTimeout(60000);
  const f = await fixture(page);
  try {
    const grant = await f.actions.createGrant(
      f.f.alice,
      {
        task_id: f.task.id,
        executor_principal_id: f.f.bob.principalId,
        tool_id: 'demo.delivery',
        tool_version: '1',
        target_id: 'demo-provider',
        allow_execute: true,
        allow_disclosure: true,
        resource_versions: [{ type: 'task', id: f.task.id, version: f.task.version }],
        approver_principal_ids: [f.f.alice.principalId],
        budget: { currency: 'USD', limit_microunits: '100' },
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      },
      randomUUID(),
    );
    const action = await f.actions.createAction(
      f.f.bob,
      {
        task_id: f.task.id,
        grant_id: grant.id,
        executor_principal_id: f.f.bob.principalId,
        tool_id: 'demo.delivery',
        tool_version: '1',
        target_id: 'demo-provider',
        parameters: { text: 'Original approved orphan delivery' },
        resource_versions: [{ type: 'task', id: f.task.id, version: f.task.version }],
        business_key: randomUUID(),
        estimate: { currency: 'USD', limit_microunits: '10' },
      },
      randomUUID(),
    );
    await f.actions.decideApproval(
      f.f.alice,
      action.id,
      {
        decision: 'approve',
        action_version: action.approval_binding_version,
        fingerprint: action.fingerprint,
        comment: 'Approve original effect',
      },
      action.version,
      randomUUID(),
    );
    await createToolRunner({ actions: f.actions, workerId: 'browser-orphan-effect' }).runOnce(
      f.f.tenantId,
      action.id,
    );
    expect(f.effects()).toBe(1);
    // Isolated fixture simulates missing restored Action rows; the independent signed journal and real HTTP provider survive.
    // Actual pg_dump/restore evidence is covered separately by recovery-drill.test.ts.
    await withTenant(f.databases.owner, f.f.tenantId, async (tx) => {
      for (const table of [
        'action_reconciliation_cases',
        'action_provider_receipt_bindings',
        'action_receipts',
        'action_budget_reservations',
        'action_attempts',
        'action_approvals',
        'actions',
      ])
        await sql`delete from ${sql.table(table)} where tenant_id=${f.f.tenantId}`.execute(tx);
      await sql`update task_budgets set reserved_microunits=0,spent_microunits=0,blocked=false,overrun_microunits=0 where tenant_id=${f.f.tenantId}`.execute(
        tx,
      );
    });
    await expect(f.actions.auditJournal(f.f.tenantId)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    await page.getByRole('button', { name: '恢复核对', exact: true }).click();
    await expect(page.getByText('外部执行已冻结', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '人工确认解冻', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '冻结并重新核对日志', exact: true }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel('恢复确认理由').fill('核对独立日志与缺失的恢复记录');
    await dialog.getByRole('button', { name: '确认冻结并核对', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole('complementary', { name: '恢复案例' }).getByRole('button').first().click();
    await page.getByRole('button', { name: '查询供应方（只读）', exact: true }).click();
    await expect(page.getByRole('heading', { name: '供应方确认成功', exact: true })).toBeVisible();
    expect(f.sends()).toBe(1);
    await page.getByRole('button', { name: '核对并确认这份证据', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('恢复确认理由').fill('已核对绑定回执与原预算，确认一次记账');
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: '确认记账并封存', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: '人工确认解冻', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('恢复确认理由').fill('全部未知结果和费用已核对');
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: '确认解冻', exact: true }).click();
    await expect(page.getByText('外部执行未冻结', { exact: true })).toBeVisible();
    expect(f.sends()).toBe(1);
    expect(f.effects()).toBe(1);
    const budget = (
      await sql<{
        spent_microunits: string;
        reserved_microunits: string;
      }>`select spent_microunits,reserved_microunits from task_budgets where tenant_id=${f.f.tenantId} and task_id=${f.task.id}`.execute(
        f.databases.owner,
      )
    ).rows[0];
    expect(budget).toEqual({ spent_microunits: '7', reserved_microunits: '0' });
  } finally {
    await f.close();
  }
});
