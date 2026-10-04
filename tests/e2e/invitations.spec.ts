import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { createDatabase, sql, withTenant } from '@imbox/db';

const alice = '30000000-0000-4000-8000-000000000001',
  bob = '30000000-0000-4000-8000-000000000002',
  charlie = '30000000-0000-4000-8000-000000000003';
test('a logged-in unjoined person uses their own account identity to accept a bound invitation; owners can revoke unused codes', async ({
  page,
  browser,
}) => {
  test.setTimeout(60_000);
  const tenant = randomUUID(),
    workspace = randomUUID(),
    name = `入组浏览器工作区 ${Date.now()}`;
  const owner = createDatabase(process.env.TEST_DATABASE_URL!, { max: 1 });
  try {
    await withTenant(owner, tenant, async (tx) => {
      await sql`insert into tenants(id,name) values(${tenant},${name})`.execute(tx);
      await sql`insert into tenant_principals(tenant_id,principal_id,role) values(${tenant},${alice},'owner')`.execute(
        tx,
      );
      await sql`insert into workspaces(tenant_id,id,name) values(${tenant},${workspace},${name})`.execute(
        tx,
      );
      await sql`insert into memberships(tenant_id,workspace_id,principal_id,role) values(${tenant},${workspace},${alice},'admin')`.execute(
        tx,
      );
    });
  } finally {
    await owner.destroy();
  }
  await page.addInitScript((value) => localStorage.setItem('imbox.tenant', value), tenant);
  await page.goto('/');
  await page.getByRole('button', { name: /Alice/ }).click();
  await page.getByRole('button', { name: '账号与加入组织', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '账号与加入组织' });
  await expect(dialog.getByLabel('我的账号标识', { exact: true })).toHaveValue(alice);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '组织与成员', exact: true }).click();
  const invite = page.getByRole('region', { name: '邀请新成员', exact: true });
  const create = async (id: string) => {
    await invite.getByLabel('被邀请账号标识', { exact: true }).fill(id);
    await invite
      .getByRole('combobox', { name: '邀请加入工作区', exact: true })
      .selectOption(workspace);
    await invite.getByLabel('邀请理由', { exact: true }).fill('已核对对方提供的账号标识');
    await invite
      .getByRole('checkbox', { name: '已核对目标账号、工作区和权限', exact: true })
      .check();
    await invite.getByRole('button', { name: '创建邀请', exact: true }).click();
    const field = invite.getByLabel('新邀请码', { exact: true });
    await expect(field).toBeVisible();
    await expect(field).toHaveAttribute('type', 'password');
    return field.inputValue();
  };
  const recipientContext = await browser.newContext();
  try {
    const recipient = await recipientContext.newPage();
    await recipient.addInitScript((value) => localStorage.setItem('imbox.tenant', value), tenant);
    await recipient.goto('/');
    await recipient.getByRole('button', { name: /Charlie/ }).click();
    await expect(recipient.getByLabel('我的账号标识', { exact: true })).toHaveValue(charlie);
    await recipient.getByRole('button', { name: '退出当前账号', exact: true }).click();
    await expect(recipient.getByLabel('我的账号标识', { exact: true })).toHaveCount(0);
    await recipient.getByRole('button', { name: /Charlie/ }).click();
    await expect(recipient.getByLabel('我的账号标识', { exact: true })).toHaveValue(charlie);
    const code = await create(charlie);
    // Keep one-time grant text out of assertion diagnostics, URLs and browser storage.
    expect(code.length > 100).toBe(true);
    expect(
      await page.evaluate(
        (value) =>
          !JSON.stringify(localStorage).includes(value) &&
          !JSON.stringify(sessionStorage).includes(value),
        code,
      ),
    ).toBe(true);
    await recipient.getByLabel('邀请码', { exact: true }).fill(code);
    await expect(
      recipient.getByRole('button', { name: '接受邀请并进入组织', exact: true }),
    ).toBeDisabled();
    await recipient.getByRole('button', { name: '查看邀请', exact: true }).click();
    await expect(recipient.getByRole('region', { name: '邀请信息' })).toContainText(name);
    await recipient
      .getByRole('checkbox', { name: '我已核对组织、工作区和权限，确认接受', exact: true })
      .check();
    await recipient.getByRole('button', { name: '接受邀请并进入组织', exact: true }).click();
    await expect(recipient.getByRole('navigation', { name: '应用导航' })).toContainText(name);
    await recipient.reload();
    await expect(recipient.getByRole('navigation', { name: '应用导航' })).toContainText(name);
    await invite.getByRole('button', { name: '刷新邀请', exact: true }).click();
    const accepted = invite
      .getByRole('table', { name: '组织邀请' })
      .getByRole('row')
      .filter({ hasText: charlie });
    await expect(accepted.getByRole('cell', { name: '已接受', exact: true })).toBeVisible();
    await invite.getByRole('button', { name: '隐藏邀请码', exact: true }).click();
    await create(bob);
    const pending = invite
      .getByRole('table', { name: '组织邀请' })
      .getByRole('row')
      .filter({ hasText: bob });
    await pending.getByRole('button', { name: /撤销邀请/ }).click();
    await invite.getByLabel('撤销邀请理由', { exact: true }).fill('成员入组计划取消');
    await invite.getByRole('button', { name: '确认撤销邀请', exact: true }).click();
    await expect(pending.getByRole('cell', { name: '已撤销', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('新邀请码', { exact: true })).toHaveCount(0);
  } finally {
    await recipientContext.close();
  }
});
