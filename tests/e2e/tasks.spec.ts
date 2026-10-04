import { test, expect, type Page } from '@playwright/test';
async function login(page: Page, name: 'Alice' | 'Bob' | 'Charlie') {
  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await expect(page.getByRole('navigation', { name: '会话列表' })).toBeVisible();
  await page.getByRole('button', { name: '任务工作台', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '任务列表' })).toBeVisible();
}
async function create(page: Page, title: string) {
  await page.getByRole('button', { name: '新建任务', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('任务标题', { exact: true }).fill(title);
  await dialog.getByLabel('目标', { exact: true }).fill('交付一份可复核的测试报告');
  await dialog.getByLabel(/^验收标准/).fill('包含实际结果与限制');
  await dialog.getByLabel(/^预算上限/).fill('0');
  await dialog.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: '开始任务', exact: true }).click();
  const start = page.getByRole('dialog');
  await start.getByLabel('操作理由', { exact: true }).fill('确认范围与验收条件');
  await start.getByRole('button', { name: '确认开始任务', exact: true }).click();
  await expect(page.getByRole('button', { name: '提交结果与证据', exact: true })).toBeVisible();
}
test('a human explicitly submits fixed evidence and separately accepts it before a task completes', async ({
  page,
}) => {
  await login(page, 'Alice');
  const title = `E2E 任务验收 ${Date.now()}`;
  await create(page, title);
  await page.getByRole('button', { name: '提交结果与证据', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('结果摘要', { exact: true }).fill('已完成可复核报告');
  await dialog.getByLabel(/^固定文字证据/).fill('复核结果：3 项符合。限制：仅限本次明确输入。');
  await dialog.getByRole('button', { name: '提交验收', exact: true }).click();
  await expect(page.getByLabel('任务详情').getByText('待验收', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '验收这次提交', exact: true }).click();
  const review = page.getByRole('dialog');
  await review.getByRole('combobox').selectOption('accept');
  await review.getByRole('textbox').fill('已核对固定版本和证据');
  await review.getByRole('checkbox').check();
  await review.getByRole('button', { name: '提交验收决定', exact: true }).click();
  await expect(page.getByLabel('任务详情').getByText('已完成', { exact: true })).toBeVisible();
  await expect(page.getByText('通过验收', { exact: true })).toBeVisible();
});
test('reading a handoff proposal does not change ownership; explicit acceptance changes both views', async ({
  browser,
}) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const alice = await a.newPage();
  const bob = await b.newPage();
  try {
    await login(alice, 'Alice');
    await login(bob, 'Bob');
    const title = `E2E 显式交接 ${Date.now()}`;
    await create(alice, title);
    await expect(
      bob.getByRole('navigation', { name: '任务列表' }).getByText(title, { exact: true }),
    ).toHaveCount(0);
    await alice.getByRole('button', { name: '发起协作提案', exact: true }).click();
    const dialog = alice.getByRole('dialog');
    await dialog
      .getByRole('combobox', { name: '收件人', exact: true })
      .selectOption({ label: 'Bob' });
    await dialog
      .getByLabel('对收件人披露的说明', { exact: true })
      .fill('仅披露此处所列目标、预算与验收约定');
    await dialog.getByLabel('已完成内容', { exact: true }).fill('已明确验收条件');
    await dialog.getByLabel('待完成内容', { exact: true }).fill('编写报告并提交验收');
    await dialog.getByRole('button', { name: '发送提案', exact: true }).click();
    await bob.getByRole('tab', { name: /协作请求/ }).click();
    await bob
      .getByRole('navigation', { name: '协作请求列表' })
      .getByRole('button', { name: new RegExp(title) })
      .click();
    await expect(bob.getByRole('button', { name: '明确接受提案' })).toBeDisabled();
    await expect(
      alice.getByLabel('任务详情').getByRole('button', { name: '提交结果与证据', exact: true }),
    ).toBeVisible();
    await bob.getByRole('checkbox', { name: /我已阅读目标/ }).check();
    await bob.getByRole('button', { name: '明确接受提案', exact: true }).click();
    await bob.getByRole('button', { name: '打开已获授权的任务', exact: true }).click();
    await expect(
      bob.getByLabel('任务详情').getByRole('heading', { name: title, level: 1 }),
    ).toBeVisible();
    await expect(bob.getByRole('button', { name: '提交结果与证据', exact: true })).toBeVisible();
    await expect(
      alice.getByLabel('任务详情').getByRole('button', { name: '发起协作提案', exact: true }),
    ).toHaveCount(0);
    await expect(
      alice.getByLabel('任务详情').getByText('负责人 · 执行与协调', { exact: true }).locator('..'),
    ).toContainText('Bob');
  } finally {
    await a.close();
    await b.close();
  }
});

test('a rejected delegation leaves the parent owned and lets its owner delegate to another person', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
    browser.newContext(),
  ]);
  const [a, b, c] = contexts;
  if (!a || !b || !c) throw new Error('Expected three independent identities');
  const alice = await a.newPage(),
    bob = await b.newPage(),
    charlie = await c.newPage();
  for (const page of [alice, bob, charlie]) page.setDefaultTimeout(10_000);
  const parentTitle = `E2E 委派被拒后重派 ${Date.now()}`;
  const rejectedTitle = `${parentTitle} 初次范围`,
    acceptedTitle = `${parentTitle} 调整后范围`;
  async function propose(title: string, recipient: 'Bob' | 'Charlie') {
    await alice.getByRole('button', { name: '发起协作提案', exact: true }).click();
    const dialog = alice.getByRole('dialog');
    await dialog.getByRole('combobox', { name: '协作方式', exact: true }).selectOption('delegate');
    await dialog
      .getByRole('combobox', { name: '收件人', exact: true })
      .selectOption({ label: recipient });
    await dialog.getByLabel('提案标题', { exact: true }).fill(title);
    await dialog
      .getByLabel('对收件人披露的说明', { exact: true })
      .fill('只承诺本提案范围，父任务权限不随接受开放');
    await dialog.getByRole('button', { name: '发送提案', exact: true }).click();
    await expect(dialog).not.toBeVisible();
  }
  async function openRequest(page: Page, title: string) {
    await page.getByRole('tab', { name: /协作请求/ }).click();
    await page
      .getByRole('navigation', { name: '协作请求列表' })
      .getByRole('button', { name: new RegExp(title) })
      .click();
  }
  try {
    await login(alice, 'Alice');
    await login(bob, 'Bob');
    await login(charlie, 'Charlie');
    await create(alice, parentTitle);
    await propose(rejectedTitle, 'Bob');
    await openRequest(bob, rejectedTitle);
    await bob
      .getByLabel('回应说明（请求澄清时必填）', { exact: true })
      .fill('当前不能承担此范围，请重新安排');
    await bob.getByRole('button', { name: '拒绝提案', exact: true }).click();
    await expect(bob.getByLabel('协作提案详情').getByText('已拒绝', { exact: true })).toBeVisible();
    await expect(bob.getByRole('button', { name: '明确接受提案', exact: true })).toHaveCount(0);
    await bob.getByRole('tab', { name: '任务', exact: true }).click();
    await expect(
      bob.getByRole('navigation', { name: '任务列表' }).getByText(rejectedTitle, { exact: true }),
    ).toHaveCount(0);
    await expect(
      alice.getByLabel('任务详情').getByText('负责人 · 执行与协调', { exact: true }).locator('..'),
    ).toContainText('Alice');
    await expect(alice.getByRole('button', { name: '提交结果与证据', exact: true })).toBeVisible();
    await propose(acceptedTitle, 'Charlie');
    await openRequest(charlie, acceptedTitle);
    await charlie.getByRole('checkbox', { name: /我已阅读目标/ }).check();
    await charlie.getByRole('button', { name: '明确接受提案', exact: true }).click();
    await charlie.getByRole('button', { name: '打开已获授权的任务', exact: true }).click();
    const child = charlie
      .getByRole('navigation', { name: '任务列表' })
      .getByRole('button', { name: new RegExp(acceptedTitle) });
    await expect(child).toHaveCount(1);
    await child.click();
    await expect(
      charlie.getByLabel('任务详情').getByRole('heading', { name: acceptedTitle, level: 1 }),
    ).toBeVisible();
    await expect(
      charlie
        .getByLabel('任务详情')
        .getByText('负责人 · 执行与协调', { exact: true })
        .locator('..'),
    ).toContainText('Charlie');
    await expect(
      charlie
        .getByLabel('任务详情')
        .getByText('最终责任人 · 结果责任', { exact: true })
        .locator('..'),
    ).toContainText('Alice');
    await expect(
      charlie.getByRole('navigation', { name: '任务列表' }).getByText(parentTitle, { exact: true }),
    ).toHaveCount(0);
    await alice.reload();
    await alice
      .getByRole('navigation', { name: '任务列表' })
      .getByText(parentTitle, { exact: true })
      .click();
    await expect(
      alice.getByLabel('任务详情').getByRole('heading', { name: parentTitle, level: 1 }),
    ).toBeVisible();
    await expect(
      alice.getByLabel('任务详情').getByText('负责人 · 执行与协调', { exact: true }).locator('..'),
    ).toContainText('Alice');
    await expect(alice.getByRole('button', { name: '提交结果与证据', exact: true })).toBeVisible();
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test('creating a task retains its selection across an older list response and a page reload', async ({
  page,
}) => {
  await login(page, 'Alice');
  let holdNext = true,
    captured = false,
    released = false;
  let release!: () => void, finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await page.route('**/v1/tasks?*', async (route) => {
    if (!holdNext) {
      await route.continue();
      return;
    }
    holdNext = false;
    try {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      captured = true;
      await gate;
      await route.fulfill({ response });
    } catch (error: unknown) {
      // An obsolete browser read may already have been aborted by the refresh.
      if (!released) throw error;
    } finally {
      finish();
    }
  });
  try {
    await expect.poll(() => captured).toBe(true);
    const title = `E2E 新建任务旧轮询 ${Date.now()}`;
    await create(page, title);
    released = true;
    release();
    await finished;
    await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
    await page.reload();
    await expect(
      page.getByLabel('任务详情').getByRole('heading', { name: title, level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: '提交结果与证据', exact: true })).toBeVisible();
  } finally {
    released = true;
    release();
    if (captured) await finished;
  }
});
