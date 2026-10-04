import { describe, expect, it } from 'vitest';
import type { StoredResource, UploadTicket } from '@imbox/contracts';
import { ApiError } from '../api.js';
import { MAX_TEXT_BYTES, ResourceApi, sha256, TextUpload, textFileType } from './resource-api.js';
const ticket: UploadTicket = {
  id: 'ticket',
  resource_id: 'resource',
  upload_url: 'https://storage.test/staging?signed=secret',
  upload_headers: {
    'content-type': 'text/plain',
    'content-length': '5',
    authorization: 'must-not-forward',
    'x-imbox-tenant-id': 'must-not-forward',
  },
  expires_at: '2030-01-01T00:00:00.000Z',
  max_bytes: MAX_TEXT_BYTES,
};
describe('browser private resources', () => {
  it('allows only bounded text formats before requesting an upload', () => {
    expect(textFileType(new File(['ok'], 'report.md'))).toBe('text/markdown');
    expect(textFileType(new File(['{}'], 'data.json'))).toBe('application/json');
    expect(() => textFileType({ name: 'photo.png', type: 'image/png', size: 2 })).toThrow('TXT');
    expect(() =>
      textFileType({ name: 'big.txt', type: 'text/plain', size: MAX_TEXT_BYTES + 1 }),
    ).toThrow('8 MiB');
  });
  it('direct upload omits session/tenant/CSRF credentials and lets the browser set signed byte length', async () => {
    let sent: RequestInit | undefined;
    const api = new ResourceApi('private-tenant', 'private-csrf', async (_path, init) => {
      sent = init;
      return new Response('', { status: 200 });
    });
    await api.put(ticket, new File(['hello'], 'hello.txt'), new AbortController().signal);
    const headers = new Headers(sent?.headers);
    for (const name of [
      'content-length',
      'authorization',
      'x-imbox-tenant-id',
      'x-csrf-token',
      'cookie',
    ])
      expect(headers.has(name)).toBe(false);
    expect(headers.get('content-type')).toBe('text/plain');
    expect(sent?.credentials).toBe('omit');
    expect(sent?.redirect).toBe('error');
    expect(sent?.referrerPolicy).toBe('no-referrer');
  });
  it('a lost completion response retries the same complete command without PUT or upload creation again', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let completes = 0;
    const api = new ResourceApi('tenant', 'csrf', async (url, init) => {
      calls.push({ url: String(url), init: init! });
      if (url === '/v1/uploads') return Response.json(ticket);
      if (url === ticket.upload_url) return new Response('');
      completes += 1;
      if (completes === 1) throw new TypeError('Response lost');
      return Response.json({ id: 'resource' });
    });
    const operation = new TextUpload(api, new File(['hello'], 'hello.txt'), {
      type: 'task',
      id: 'task',
    });
    const signal = new AbortController().signal;
    await expect(operation.run(signal, () => {})).rejects.toThrow('Response lost');
    await expect(operation.run(signal, () => {})).resolves.toEqual({ id: 'resource' });
    expect(calls.map((call) => call.url)).toEqual([
      '/v1/uploads',
      ticket.upload_url,
      '/v1/uploads/ticket/complete',
      '/v1/uploads/ticket/complete',
    ]);
    expect(new Headers(calls[2]?.init.headers).get('Idempotency-Key')).toBe(
      new Headers(calls[3]?.init.headers).get('Idempotency-Key'),
    );
  });
  it('downloads through the fixed gateway, verifies bytes and rejects tampered content', async () => {
    const bytes = new TextEncoder().encode('hello');
    const hash = await sha256(bytes.buffer);
    const resource = {
      id: 'resource',
      byte_size: 5,
      content_type: 'text/plain',
      sha256: hash,
      download_path: 'https://evil.test/leak',
    } as StoredResource;
    let requested: string | undefined;
    const api = new ResourceApi('tenant', 'csrf', async (path, init) => {
      requested = String(path);
      expect(init?.redirect).toBe('error');
      return new Response(bytes);
    });
    expect(await (await api.download(resource, new AbortController().signal)).text()).toBe('hello');
    expect(requested).toBe('/v1/resources/resource/content');
    const corrupt = new ResourceApi('tenant', 'csrf', async () => new Response('other'));
    await expect(corrupt.download(resource, new AbortController().signal)).rejects.toThrow(
      '内容校验失败',
    );
    const revoked = new ResourceApi(
      'tenant',
      'csrf',
      async () => new Response('{}', { status: 404 }),
    );
    await expect(revoked.download(resource, new AbortController().signal)).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});
