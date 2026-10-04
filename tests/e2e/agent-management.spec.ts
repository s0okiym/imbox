import { test, expect } from '@playwright/test';
test('administrator registers an external Agent, issues a one-time credential, revokes it after reload and disables the installation', async ({
  page,
}) => {
  test.setTimeout(45000);
  await page.goto('/');
  await page.getByRole('button', { name: /Alice/ }).click();
  await page.getByRole('button', { name: 'Agent 目录', exact: true }).click();
  const form = page.getByRole('form', { name: '注册 Agent' }),
    name = `Browser Agent ${Date.now()}`;
  await form.getByLabel('Agent 名称', { exact: true }).fill(name);
  const registered = page.waitForResponse(
    (response) => response.url().endsWith('/v1/agents') && response.request().method() === 'POST',
  );
  await form.getByRole('button', { name: '注册并安装', exact: true }).click();
  expect((await registered).status()).toBe(201);
  await expect(
    page.getByRole('region', { name: 'Agent 详情' }).getByRole('heading', { name, exact: true }),
  ).toBeVisible();
  const issue = page.getByRole('form', { name: '签发 Agent 凭证' });
  await issue.getByLabel('读取 Agent 目录', { exact: true }).check();
  await issue.getByRole('button', { name: '签发凭证', exact: true }).click();
  const secret = page.getByLabel('一次性密钥', { exact: true });
  await expect(secret).toHaveAttribute('type', 'password');
  expect((await secret.inputValue()).startsWith('imbox_cred_')).toBe(true);
  // Never print or attach a secret in assertions. The comparison stays inside the page.
  expect(
    await page.evaluate(() => {
      const value = (document.querySelector('input[autocomplete="off"]') as HTMLInputElement).value;
      return (
        !JSON.stringify(localStorage).includes(value) &&
        !JSON.stringify(sessionStorage).includes(value)
      );
    }),
  ).toBe(true);
  await page.getByRole('button', { name: '我已保存，隐藏密钥', exact: true }).click();
  await expect(secret).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name, exact: true }).click();
  await expect(page.getByLabel('一次性密钥', { exact: true })).toHaveCount(0);
  await page
    .getByRole('list', { name: '凭证列表' })
    .getByRole('button', { name: '撤销此凭证', exact: true })
    .click();
  await page.getByRole('button', { name: '确认撤销', exact: true }).click();
  await expect(page.getByRole('list', { name: '凭证列表' })).toContainText('已撤销');
  await page.getByLabel('确认停用此 Agent，阻断其后续运行和机器访问', { exact: true }).check();
  await page.getByRole('button', { name: '停用 Agent', exact: true }).click();
  await expect(page.getByText('Agent 已停用。', { exact: true })).toBeVisible();
  await expect(page.getByRole('form', { name: '签发 Agent 凭证' })).toHaveCount(0);
});
