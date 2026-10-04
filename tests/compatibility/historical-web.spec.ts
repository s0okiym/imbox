import { test, expect, type Page } from '@playwright/test';

const commit = process.env.IMBOX_COMPAT_CLIENT_COMMIT ?? '2f751069fc11062f48cfd5d377db2970e9088268';
async function login(page: Page, name: 'Alice' | 'Bob') {
  const session = await page.context().request.post('http://127.0.0.1:4173/v1/auth/dev-login', {
    headers: { origin: 'http://127.0.0.1:4173' },
    data: {
      principal_id:
        name === 'Alice'
          ? '30000000-0000-4000-8000-000000000001'
          : '30000000-0000-4000-8000-000000000002',
    },
  });
  expect(session.ok()).toBe(true);
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: '会话列表' })).toBeVisible();
}
async function send(page: Page, body: string) {
  await expect(page.getByText('实时同步', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '消息内容', exact: true }).fill(body);
  const response = page.waitForResponse(
    (reply) =>
      reply.request().method() === 'POST' && new URL(reply.url()).pathname.endsWith('/messages'),
  );
  await page.getByRole('button', { name: '发送消息' }).click();
  expect((await response).status()).toBe(201);
  await expect(page.getByLabel('消息记录').getByText(body, { exact: true })).toBeVisible();
  await expect(page.getByLabel('正在发送的消息')).toHaveCount(0);
}
test('historical compiled client and current client exchange live messages and safely render future display events', async ({
  browser,
}) => {
  const oldContext = await browser.newContext({ serviceWorkers: 'block' });
  const currentContext = await browser.newContext({ serviceWorkers: 'block' });
  const old = await oldContext.newPage(),
    current = await currentContext.newPage();
  const errors: string[] = [];
  old.on('pageerror', (error) => errors.push(error.name));
  try {
    await oldContext.addCookies([
      { name: 'imbox_compat_client', value: commit, url: 'http://127.0.0.1:4173', httpOnly: true },
    ]);
    let historicalScript = false;
    old.on('response', (response) => {
      if (
        new URL(response.url()).pathname.endsWith('.js') &&
        response.headers()['x-imbox-test-client'] === commit
      )
        historicalScript = true;
    });
    expect(
      (await (await oldContext.request.get('http://127.0.0.1:4173/_compat/identity')).json())
        .client,
    ).toBe(commit);
    await login(old, 'Alice');
    await login(current, 'Bob');
    const title = `Historical client ${Date.now()}`;
    await old.getByRole('button', { name: '新建会话', exact: true }).first().click();
    const dialog = old.getByRole('dialog');
    await dialog.getByLabel('会话名称', { exact: true }).fill(title);
    await dialog.getByRole('checkbox', { name: /Bob/ }).check();
    await dialog.getByRole('button', { name: '创建会话', exact: true }).click();
    await expect(old.getByRole('heading', { name: title, exact: true, level: 1 })).toBeVisible();
    await current
      .getByRole('navigation', { name: '会话列表' })
      .getByRole('button', { name: new RegExp(title) })
      .click();
    await send(old, '历史制品发送的消息');
    await expect(
      current.getByLabel('消息记录').getByText('历史制品发送的消息', { exact: true }),
    ).toBeVisible();
    await send(current, '当前制品实时回复');
    await expect(
      old.getByLabel('消息记录').getByText('当前制品实时回复', { exact: true }),
    ).toBeVisible();
    let injected = false;
    await old.route('**/v1/streams/*/snapshot?*', async (route) => {
      const response = await route.fetch();
      if (response.status() !== 200) return route.fulfill({ response });
      const snapshot = await response.json();
      const source = snapshot.items.find(
        (item: { entity: { type: string } }) => item.entity.type === 'message',
      );
      if (!source) return route.fulfill({ response });
      injected = true;
      await route.fulfill({
        response,
        json: {
          ...snapshot,
          items: [
            ...snapshot.items,
            {
              ...source,
              projection_id: '90000000-0000-4000-8000-000000000002',
              entity: {
                type: 'future.card',
                id: '90000000-0000-4000-8000-000000000002',
                version: '1',
              },
              payload: {
                summary: '<script>window.__futureExecuted=true</script>private-future-body',
                command: { type: 'action.execute' },
              },
            },
          ],
        },
      });
    });
    await old.reload();
    await expect(
      old.getByText('此会话包含当前版本无法展示的内容，请更新客户端查看。', { exact: true }),
    ).toBeVisible();
    expect(injected).toBe(true);
    await expect(old.getByText(/private-future-body/)).toHaveCount(0);
    expect(
      await old.evaluate(() => (window as unknown as Record<string, unknown>).__futureExecuted),
    ).toBeUndefined();
    await send(old, '降级提示之后继续协作');
    await expect(
      current.getByLabel('消息记录').getByText('降级提示之后继续协作', { exact: true }),
    ).toBeVisible();
    expect(historicalScript).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await oldContext.close();
    await currentContext.close();
  }
});
