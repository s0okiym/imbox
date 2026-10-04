import { expect, it } from 'vitest';
import { NotificationApi } from './notification-api.js';
const id = '10000000-0000-4000-8000-000000000001';
it('marks only the displayed notification version as read with the authenticated tenant and CSRF token', async () => {
  const api = new NotificationApi(id, 'test-csrf', async (url, options) => {
    expect(url).toBe(`/v1/notifications/${id}/read`);
    expect(options?.method).toBe('POST');
    expect(options?.cache).toBe('no-store');
    expect(options?.credentials).toBe('same-origin');
    const headers = new Headers(options?.headers);
    expect(headers.get('X-Imbox-Tenant-Id')).toBe(id);
    expect(headers.get('X-CSRF-Token')).toBe('test-csrf');
    expect(headers.get('If-Match')).toBe('"7"');
    return Response.json({ id, version: '7', read: true });
  });
  expect(await api.read(id, '7', new AbortController().signal)).toMatchObject({ read: true });
});
it('rejects stale authority and malformed deep-link responses', async () => {
  const denied = new NotificationApi(id, 'test', async () => new Response(null, { status: 404 }));
  await expect(denied.open(id, new AbortController().signal)).rejects.toMatchObject({
    status: 404,
  });
  const forged = new NotificationApi(id, 'test', async () =>
    Response.json({ target: { type: 'message', id: '../admin' }, url: 'https://outside.test' }),
  );
  await expect(forged.open(id, new AbortController().signal)).rejects.toThrow();
});
