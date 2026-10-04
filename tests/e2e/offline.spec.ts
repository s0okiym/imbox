import { test, expect } from '@playwright/test';
test('explicit device consent queues a message while offline, sends once after reauthorization and erases local data on logout', async ({
  page,
  context,
}) => {
  test.setTimeout(45000);
  await page.goto('/');
  await page.getByRole('button', { name: /Alice/ }).click();
  await expect(page.getByRole('navigation', { name: '会话列表' })).toBeVisible();
  const title = `Offline ${Date.now()}`;
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
  await page
    .getByRole('dialog')
    .getByRole('textbox', { name: '会话名称', exact: true })
    .fill(title);
  await page.getByRole('dialog').getByRole('checkbox', { name: /Bob/ }).check();
  await page.getByRole('dialog').getByRole('button', { name: '创建会话', exact: true }).click();
  await page.getByRole('button', { name: '数据与隐私', exact: true }).click();
  await page.getByLabel('允许消息在本机排队，联网重新核对权限后发送', { exact: true }).check();
  await page.getByRole('button', { name: '保存本机设置', exact: true }).click();
  await expect(page.getByText('已保存本机设置。', { exact: true })).toBeVisible();
  // Hold an actual policy response across erasure; the old background task must not recreate consent.
  let releasePolicy!: () => void, policyHeld!: () => void;
  const release = new Promise<void>((resolve) => {
    releasePolicy = resolve;
  });
  const held = new Promise<void>((resolve) => {
    policyHeld = resolve;
  });
  let intercept = true;
  await page.route('**/v1/governance/policy', async (route) => {
    if (!intercept) {
      await route.continue();
      return;
    }
    intercept = false;
    const response = await route.fetch();
    policyHeld();
    await release;
    await route.fulfill({ response });
  });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await held;
  await page.getByRole('button', { name: '清除本机离线数据', exact: true }).click();
  await expect(page.getByText('已清除本机缓存、草稿及待发消息。', { exact: true })).toBeVisible();
  releasePolicy();
  // Observe across two background polling intervals, not just before the delayed callback has run.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('imbox-device-v1');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const deadline = Date.now() + 6200;
      do {
        const count = await new Promise<number>((resolve, reject) => {
          const request = db.transaction('preferences').objectStore('preferences').count();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        if (count !== 0)
          throw new Error('Erased consent was resurrected by a stale policy response');
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
    } finally {
      db.close();
    }
  });
  await page.unroute('**/v1/governance/policy');

  await page.getByLabel('允许消息在本机排队，联网重新核对权限后发送', { exact: true }).check();
  await page.getByRole('button', { name: '保存本机设置', exact: true }).click();
  await expect(page.getByText('已保存本机设置。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '消息', exact: true }).click();
  await page
    .getByRole('navigation', { name: '会话列表' })
    .getByRole('button', { name: new RegExp(title) })
    .click();
  await expect(page.getByText('实时同步', { exact: true })).toBeVisible();
  const marker = `OFFLINE_ONCE_${Date.now()}`;
  const count = (table: 'outbox' | 'drafts') =>
    page.evaluate(async (table) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('imbox-device-v1');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise<number>((resolve, reject) => {
          const request = db.transaction(table).objectStore(table).count();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      } finally {
        db.close();
      }
    }, table);
  const outbox = () => count('outbox');
  await page.getByRole('textbox', { name: '消息内容', exact: true }).fill('草稿跨页面恢复');
  await expect(page.getByText('文字草稿已保存在本机。', { exact: true })).toBeVisible();
  await expect.poll(() => count('drafts')).toBe(1);
  await page.reload();
  await expect(page.getByRole('textbox', { name: '消息内容', exact: true })).toHaveValue(
    '草稿跨页面恢复',
  );
  await expect(page.getByText('实时同步', { exact: true })).toBeVisible();
  try {
    await context.setOffline(true);
    await page.getByRole('textbox', { name: '消息内容', exact: true }).fill(marker);
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(outbox).toBe(1);
    await expect.poll(() => count('drafts')).toBe(0);
    await context.setOffline(false);
    await expect(
      page.getByLabel('消息记录').locator('.message-bubble').filter({ hasText: marker }),
    ).toHaveCount(1);
    await expect.poll(outbox).toBe(0);
    // The real server's list must contain a single committed message, independent of optimistic UI.
    const matches = await page.evaluate(async (text) => {
      const conversationId = location.pathname.split('/')[2];
      const response = await fetch(`/v1/conversations/${conversationId}/messages`, {
        headers: { 'X-Imbox-Tenant-Id': localStorage.getItem('imbox.tenant')! },
      });
      const page = (await response.json()) as { items: Array<{ body: string }> };
      return page.items.filter((item) => item.body === text).length;
    }, marker);
    expect(matches).toBe(1);
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page.getByRole('button', { name: /Alice/ })).toBeVisible();
    expect(await outbox()).toBe(0);
    expect(await count('drafts')).toBe(0);
  } finally {
    await context.setOffline(false);
  }
});
