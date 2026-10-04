import { test, expect, type Page } from '@playwright/test';

async function login(page: Page, name: 'Alice' | 'Bob') {
  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await expect(page.getByRole('navigation', { name: '会话列表' })).toBeVisible();
}
async function createConversation(page: Page, title: string) {
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('会话名称', { exact: true }).fill(title);
  await dialog.getByRole('checkbox', { name: /Bob/ }).check();
  await dialog.getByRole('button', { name: '创建会话', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: '发送消息' })).toBeDisabled();
}
async function send(page: Page, body: string) {
  await page.getByRole('textbox', { name: '消息内容', exact: true }).fill(body);
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.getByLabel('消息记录').getByText(body, { exact: true })).toBeVisible();
}

test('two people exchange messages, see edits/retractions, and never execute message markup', async ({
  browser,
}) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  try {
    await login(alice, 'Alice');
    await login(bob, 'Bob');
    const title = `E2E 协作 ${Date.now()}`;
    await createConversation(alice, title);
    await bob
      .getByRole('navigation', { name: '会话列表' })
      .getByRole('button', { name: new RegExp(title) })
      .click();
    const text = '中文 IME 与 <img src=x onerror="window.__imboxXss=true">';
    await send(alice, text);
    await expect(bob.getByLabel('消息记录').getByText(text, { exact: true })).toBeVisible();
    expect(
      await bob.evaluate(() => (window as unknown as Record<string, unknown>)['__imboxXss']),
    ).toBeUndefined();
    await send(bob, '收到，Bob 已确认');
    await expect(
      alice.getByLabel('消息记录').getByText('收到，Bob 已确认', { exact: true }),
    ).toBeVisible();
    await alice.getByRole('button', { name: '编辑消息', exact: true }).click();
    const dialog = alice.getByRole('dialog');
    await dialog.getByLabel('消息内容', { exact: true }).fill('Alice 修订后的内容');
    await dialog.getByRole('button', { name: '保存修改' }).click();
    await expect(
      bob.getByLabel('消息记录').getByText('Alice 修订后的内容', { exact: true }),
    ).toBeVisible();
    await alice.getByRole('button', { name: '删除消息', exact: true }).click();
    await alice.getByRole('dialog').getByRole('button', { name: '确认删除' }).click();
    await expect(
      bob.getByLabel('消息记录').getByText('这条消息已被删除', { exact: true }),
    ).toBeVisible();
    await expect(bob.getByText('Alice 修订后的内容', { exact: true })).toHaveCount(0);
    await alice.getByRole('button', { name: '退出登录' }).click();
    await expect(alice.getByRole('link', { name: /使用组织账号登录/ })).toBeVisible();
    await expect(alice.getByText('收到，Bob 已确认', { exact: true })).toHaveCount(0);
  } finally {
    await aliceContext.close();
    await bobContext.close();
  }
});

test('a lost POST response reconciles to one persisted message and mobile layout remains usable', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'Alice');
  const title = `E2E 网络 ${Date.now()}`;
  await createConversation(page, title);
  let dropped = false;
  await page.route('**/v1/conversations/*/messages', async (route) => {
    if (route.request().method() === 'POST' && !dropped) {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      dropped = true;
      await route.abort('failed');
    } else await route.continue();
  });
  const body = `响应丢失后仍只有一条 ${Date.now()}`;
  await send(page, body);
  await expect(page.getByLabel('正在发送的消息')).toHaveCount(0);
  await expect(page.getByLabel('消息记录').getByText(body, { exact: true })).toHaveCount(1);
  expect(dropped).toBe(true);
  await context.setOffline(true);
  await expect(page.getByRole('button', { name: '发送消息' })).toBeDisabled();
  await expect(page.getByText('网络已断开', { exact: true })).toBeVisible();
  await context.setOffline(false);
  await page.reload();
  // Native URL restoration opens the conversation directly, including on narrow screens.
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.getByLabel('消息记录').getByText(body, { exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: '返回会话列表', exact: true }).click();
  await page
    .getByRole('navigation', { name: '会话列表' })
    .getByRole('button', { name: new RegExp(title) })
    .click();
  await expect(page.getByLabel('消息记录').getByText(body, { exact: true })).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
