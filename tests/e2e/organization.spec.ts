import { test, expect } from '@playwright/test';
import { createDatabase, sql, withTenant } from '@imbox/db';

const createdWorkspaceIds: string[] = [];
test.afterEach(async () => {
  const db = createDatabase(process.env['TEST_DATABASE_URL']!, { max: 1 });
  try {
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
