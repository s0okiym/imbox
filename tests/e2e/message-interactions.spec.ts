import { test, expect, type Page } from '@playwright/test';
async function login(page: Page, name: 'Alice' | 'Bob') {
  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await expect(page.getByRole('navigation', { name: '会话列表' })).toBeVisible();
}
async function send(page: Page, body: string) {
  await page.getByRole('textbox', { name: '消息内容', exact: true }).fill(body);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(
    page.getByLabel('消息记录').locator('.message-bubble').filter({ hasText: body }),
  ).toBeVisible();
}
test('human replies bind fixed text, thread replies share the root, and reaction removal affects only oneself', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const a = await browser.newContext();
  const b = await browser.newContext();
  const alice = await a.newPage();
  const bob = await b.newPage();
  try {
    await login(alice, 'Alice');
    await login(bob, 'Bob');
    const title = `E2E 固定引用 ${Date.now()}`;
    await alice.getByRole('button', { name: '新建会话', exact: true }).first().click();
    let dialog = alice.getByRole('dialog');
    await dialog.getByRole('textbox', { name: '会话名称', exact: true }).fill(title);
    await dialog.getByRole('checkbox', { name: /Bob/ }).check();
    await dialog.getByRole('button', { name: '创建会话', exact: true }).click();
    await bob
      .getByRole('navigation', { name: '会话列表' })
      .getByRole('button', { name: new RegExp(title) })
      .click();
    await send(alice, '原始约定：交付三项');
    const source = (page: Page) =>
      page
        .getByLabel('消息记录')
        .getByRole('article')
        .filter({
          has: page.locator('.message-bubble').filter({ hasText: /^原始约定：交付三项$/ }),
        });
    await expect(source(bob)).toBeVisible();
    await source(bob).getByRole('button', { name: '回应', exact: true }).click();
    let reactions = bob.getByRole('dialog');
    await reactions.getByRole('button', { name: '添加 👍', exact: true }).click();
    await expect(reactions.getByRole('button', { name: '撤销我的 👍', exact: true })).toBeVisible();
    await reactions.getByRole('button', { name: '关闭', exact: true }).last().click();
    await source(alice).getByRole('button', { name: '回应', exact: true }).click();
    reactions = alice.getByRole('dialog');
    await reactions.getByRole('button', { name: '添加 👍', exact: true }).click();
    await expect(reactions.getByRole('button', { name: '撤销我的 👍', exact: true })).toBeVisible();
    await reactions.getByRole('button', { name: '撤销我的 👍', exact: true }).click();
    await expect(reactions.getByRole('button', { name: '添加 👍', exact: true })).toBeVisible();
    await reactions.getByRole('button', { name: '关闭', exact: true }).last().click();
    await expect(
      source(alice).getByRole('button', { name: '查看 👍 回应，共 1 人', exact: true }),
    ).toBeVisible();
    await source(bob).getByRole('button', { name: '引用回复', exact: true }).click();
    await expect(bob.locator('.composer-quote')).toContainText('原始约定：交付三项');
    await send(bob, '我按这个版本处理');
    const reply = (page: Page) =>
      page
        .getByLabel('消息记录')
        .getByRole('article')
        .filter({ has: page.locator('.message-bubble').filter({ hasText: /^我按这个版本处理$/ }) });
    await expect(reply(alice).locator('.message-quote')).toContainText('原始约定：交付三项');
    await source(alice).getByRole('button', { name: '编辑消息', exact: true }).click();
    dialog = alice.getByRole('dialog');
    await dialog.getByRole('textbox', { name: '消息内容', exact: true }).fill('修订约定：交付四项');
    await dialog.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(
      bob
        .getByLabel('消息记录')
        .locator('.message-bubble')
        .filter({ hasText: /^修订约定：交付四项$/ }),
    ).toBeVisible();
    await expect(reply(bob).locator('.message-quote')).toContainText('原始约定：交付三项');
    await reply(bob).getByRole('button', { name: '查看线程', exact: true }).click();
    const thread = bob.getByRole('dialog');
    await expect(thread.locator('.thread-root')).toContainText('修订约定：交付四项');
    await thread
      .getByRole('article')
      .filter({ hasText: '我按这个版本处理' })
      .getByRole('button', { name: '回复这一条', exact: true })
      .click();
    await thread
      .getByRole('textbox', { name: '线程回复内容', exact: true })
      .fill('线程中的补充说明');
    await thread.getByRole('button', { name: '发送线程回复', exact: true }).click();
    await expect(thread.getByRole('article').filter({ hasText: '线程中的补充说明' })).toBeVisible();
    await thread.getByRole('button', { name: '关闭', exact: true }).last().click();
    await expect(
      bob
        .getByLabel('消息记录')
        .locator('.message-bubble')
        .filter({ hasText: /^线程中的补充说明$/ }),
    ).toBeVisible();
    const edited = alice
      .getByLabel('消息记录')
      .getByRole('article')
      .filter({
        has: alice.locator('.message-bubble').filter({ hasText: /^修订约定：交付四项$/ }),
      });
    await edited.getByRole('button', { name: '删除消息', exact: true }).click();
    await alice.getByRole('dialog').getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(reply(bob).locator('.message-quote')).toContainText('原消息不可用或无权查看');
    await expect(bob.getByText('原始约定：交付三项', { exact: true })).toHaveCount(0);
  } finally {
    await a.close();
    await b.close();
  }
});
