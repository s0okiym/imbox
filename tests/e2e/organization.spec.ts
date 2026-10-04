import { test, expect } from '@playwright/test';
import { createDatabase, sql, withTenant } from '@imbox/db';

const createdWorkspaceIds: string[] = [];
let restoreCharlie = false;
test.afterEach(async () => {
  const db = createDatabase(process.env['TEST_DATABASE_URL']!, { max: 1 });
  try {
    if (restoreCharlie) {
      await withTenant(db, '10000000-0000-4000-8000-000000000001', (tx) =>
        sql`update tenant_principals set role='member',status='active',version=version+1,authz_revision=authz_revision+1,membership_policy_version=membership_policy_version+1 where principal_id='30000000-0000-4000-8000-000000000003'`.execute(
          tx,
        ),
      );
      restoreCharlie = false;
    }
    for (const id of createdWorkspaceIds.splice(0))
      await withTenant(db, '10000000-0000-4000-8000-000000000001', async (tx) => {
        await sql`delete from memberships where workspace_id=${id}`.execute(tx);
        await sql`delete from workspaces where id=${id}`.execute(tx);
      });
  } finally {
    await db.destroy();
  }
});

test('organization owner creates a workspace and explicitly adds, disables and restores an existing member', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Alice/ }).click();
  await page.getByRole('button', { name: '组织与成员', exact: true }).click();
  await expect(page.getByRole('heading', { name: '组织与成员', exact: true })).toBeVisible();
  const name = `E2E 成员管理 ${Date.now()}`;
  await page.getByLabel('新工作区名称', { exact: true }).fill(name);
  const creation = page.waitForResponse(
    (r) =>
      r.url().endsWith('/v1/organization/workspaces') &&
      r.request().method() === 'POST' &&
      r.status() === 201,
  );
  await page.getByRole('button', { name: '创建工作区', exact: true }).click();
  createdWorkspaceIds.push(((await (await creation).json()) as { id: string }).id);
  await expect(page.getByRole('heading', { name: `${name} 的成员` })).toBeVisible();
  await page
    .getByRole('combobox', { name: '组织成员', exact: true })
    .selectOption('30000000-0000-4000-8000-000000000002');
  await page.getByLabel('变更理由', { exact: true }).fill('加入专项工作区');
  await expect(page.getByRole('button', { name: '保存成员权限' })).toBeDisabled();
  await page.getByRole('checkbox', { name: /我已核对人员/ }).check();
  await page.getByRole('button', { name: '保存成员权限' }).click();
  const row = page
    .getByRole('table', { name: '工作区成员' })
    .getByRole('row')
    .filter({ hasText: 'Bob' });
  await expect(row.getByRole('cell', { name: '有效', exact: true })).toBeVisible();
  await row.getByRole('button', { name: '编辑 Bob' }).click();
  await page.getByRole('combobox', { name: '成员状态', exact: true }).selectOption('disabled');
  await page.getByLabel('变更理由', { exact: true }).fill('结束专项访问');
  await page.getByRole('checkbox', { name: /我已核对人员/ }).check();
  await page.getByRole('button', { name: '保存成员权限' }).click();
  await expect(row.getByRole('cell', { name: '已停用', exact: true })).toBeVisible();
  await row.getByRole('button', { name: '编辑 Bob' }).click();
  await page.getByRole('combobox', { name: '成员状态', exact: true }).selectOption('active');
  await page.getByRole('combobox', { name: '成员角色', exact: true }).selectOption('guest');
  await page.getByLabel('变更理由', { exact: true }).fill('恢复为访客');
  await page.getByRole('checkbox', { name: /我已核对人员/ }).check();
  await page.getByRole('button', { name: '保存成员权限' }).click();
  await expect(row.getByRole('cell', { name: '访客', exact: true })).toBeVisible();
  await expect(row.getByRole('cell', { name: '有效', exact: true })).toBeVisible();
  const alice = page
    .getByRole('table', { name: '工作区成员' })
    .getByRole('row')
    .filter({ hasText: 'Alice' });
  await alice.getByRole('button', { name: '编辑 Alice' }).click();
  await page.getByRole('combobox', { name: '成员状态', exact: true }).selectOption('disabled');
  await page.getByLabel('变更理由', { exact: true }).fill('验证最后管理员保护');
  await page.getByRole('checkbox', { name: /我已核对人员/ }).check();
  await page.getByRole('button', { name: '保存成员权限' }).click();
  await expect(page.getByRole('alert')).toContainText('请先指定另一名有效的工作区管理员');
  await page.reload();
  await expect(page.getByRole('heading', { name: '组织与成员', exact: true })).toBeVisible();
  await page
    .getByRole('combobox', { name: '管理的工作区', exact: true })
    .selectOption({ label: name });
  await expect(row.getByRole('cell', { name: '访客', exact: true })).toBeVisible();
});
test('ordinary human sees the organization management boundary', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Charlie/ }).click();
  await page.getByRole('button', { name: '组织与成员', exact: true }).click();
  await expect(
    page.getByText('只有组织所有者或组织管理员可以管理工作区成员。', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '创建工作区' })).toHaveCount(0);
});

test('organization owner changes tenant roles, disables and restores a person while the last owner stays protected', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Alice/ }).click();
  await page.getByRole('button', { name: '组织与成员', exact: true }).click();
  const table = page.getByRole('table', { name: '组织成员权限', exact: true });
  const charlie = table.getByRole('row').filter({ hasText: 'Charlie' });
  await expect(charlie).toBeVisible();
  restoreCharlie = true;
  for (const change of [
    { role: 'admin', status: 'active', label: '管理员' },
    { role: 'member', status: 'disabled', label: '成员' },
    { role: 'member', status: 'active', label: '成员' },
  ]) {
    await charlie.getByRole('button', { name: '管理组织权限 Charlie', exact: true }).click();
    await page.getByRole('combobox', { name: '组织角色', exact: true }).selectOption(change.role);
    await page
      .getByRole('combobox', { name: '组织访问状态', exact: true })
      .selectOption(change.status);
    await page.getByLabel('组织变更理由', { exact: true }).fill('组织生命周期回归');
    await expect(page.getByRole('button', { name: '保存组织权限', exact: true })).toBeDisabled();
    await page.getByRole('checkbox', { name: '我已核对组织级影响，确认变更', exact: true }).check();
    await page.getByRole('button', { name: '保存组织权限', exact: true }).click();
    await expect(charlie.getByRole('cell', { name: change.label, exact: true })).toBeVisible();
    await expect(
      charlie.getByRole('cell', {
        name: change.status === 'active' ? '有效' : '已停用',
        exact: true,
      }),
    ).toBeVisible();
  }
  await table
    .getByRole('row')
    .filter({ hasText: 'Alice' })
    .getByRole('button', { name: '管理组织权限 Alice', exact: true })
    .click();
  await page.getByRole('combobox', { name: '组织角色', exact: true }).selectOption('admin');
  await page.getByLabel('组织变更理由', { exact: true }).fill('最后组织所有者保护');
  await page.getByRole('checkbox', { name: '我已核对组织级影响，确认变更', exact: true }).check();
  await page.getByRole('button', { name: '保存组织权限', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('请先指定另一名有效的组织所有者');
  await page.reload();
  await expect(
    table
      .getByRole('row')
      .filter({ hasText: 'Alice' })
      .getByRole('cell', { name: '所有者', exact: true }),
  ).toBeVisible();
});
