import { describe, expect, it } from 'vitest';
import { ApiClient, ApiError, describeError, isAccessLoss } from './api.js';
import type { ChatMessage, FetchLike } from './api.js';

describe('same-origin API commands', () => {
  it('binds a reply to its displayed string version and reactions are explicit set/remove commands', async () => {
    const calls: { path: string; init: RequestInit }[] = [];
    const api = new ApiClient('tenant', 'csrf', async (path, init) => {
      calls.push({ path: String(path), init: init! });
      return Response.json({});
    });
    const signal = new AbortController().signal;
    await api.sendMessage('chat', 'client', 'reply', 'message-key', signal, [], {
      id: 'source',
      version: '9007199254740993',
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      reply_to_id: 'source',
      reply_to_version: '9007199254740993',
    });
    expect(JSON.parse(String(calls[0]?.init.body))).not.toHaveProperty('thread_root_id');
    await api.react('source', '👍', true, 'add-key', signal);
    await api.react('source', '👍', false, 'remove-key', signal);
    expect(calls.slice(1).map((call) => call.path)).toEqual([
      '/v1/messages/source/reactions',
      '/v1/messages/source/reactions/remove',
    ]);
    expect(new Headers(calls[2]?.init.headers).get('Idempotency-Key')).toBe('remove-key');
  });
  it('retries an attachment message with the same fixed identifiers instead of uploading again', async () => {
    const bodies: string[] = [];
    const api = new ApiClient('tenant', 'csrf', async (_path, init) => {
      bodies.push(String(init?.body));
      if (bodies.length === 1) throw new TypeError('Response lost');
      return Response.json({});
    });
    const signal = new AbortController().signal;
    await expect(
      api.sendMessage('chat', 'client-id', '报告附件', 'key', signal, ['resource-id']),
    ).rejects.toThrow();
    await api.sendMessage('chat', 'client-id', '报告附件', 'key', signal, ['resource-id']);
    expect(bodies[0]).toBe(bodies[1]);
    expect(JSON.parse(bodies[0]!)).toMatchObject({
      attachment_ids: ['resource-id'],
      client_message_id: 'client-id',
    });
  });
  it('preserves a stable send identity, tenant boundary and CSRF on retries', async () => {
    const requests: RequestInit[] = [];
    const fetcher: FetchLike = async (_path, init) => {
      requests.push(init ?? {});
      if (requests.length === 1) throw new TypeError('Network response lost');
      return new Response(JSON.stringify({ id: 'saved' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const api = new ApiClient('tenant-1', 'csrf-value', fetcher);
    const signal = new AbortController().signal;
    await expect(
      api.sendMessage('chat', 'client-id', '你好', 'original-key', signal),
    ).rejects.toThrow('Network response lost');
    await api.sendMessage('chat', 'client-id', '你好', 'original-key', signal);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.body).toBe(requests[1]?.body);
    for (const request of requests) {
      const headers = new Headers(request.headers);
      expect(headers.get('X-Imbox-Tenant-Id')).toBe('tenant-1');
      expect(headers.get('X-CSRF-Token')).toBe('csrf-value');
      expect(headers.get('Idempotency-Key')).toBe('original-key');
      expect(request.credentials).toBe('same-origin');
      expect(request.cache).toBe('no-store');
      expect(request.signal).toBe(signal);
    }
  });

  it('edits bind the precise string version using a quoted If-Match', async () => {
    let sent: RequestInit | undefined;
    const api = new ApiClient('tenant', 'csrf', async (_path, init) => {
      sent = init;
      return new Response('{}', { status: 200 });
    });
    const message = { id: 'message', version: '9007199254740993' } as ChatMessage;
    await api.editMessage(message, '修改', 'edit-key', new AbortController().signal);
    expect(new Headers(sent?.headers).get('If-Match')).toBe('"9007199254740993"');
  });

  it('development login sends only the chosen principal and keeps tenant in its header', async () => {
    let sent: RequestInit | undefined;
    const api = new ApiClient('tenant', null, async (_path, init) => {
      sent = init;
      return new Response('{}');
    });
    await api.devLogin('alice');
    expect(sent?.body).toBe(JSON.stringify({ principal_id: 'alice' }));
    expect(new Headers(sent?.headers).get('X-Imbox-Tenant-Id')).toBe('tenant');
  });

  it('distinguishes access loss and conflicts without displaying server internals', async () => {
    const api = new ApiClient(
      'tenant',
      'csrf',
      async () =>
        new Response(
          JSON.stringify({
            code: 'FORBIDDEN',
            message: 'Internal SQL or private details',
            request_id: 'trace',
          }),
          { status: 403 },
        ),
    );
    try {
      await api.me();
      throw new Error('Expected rejection');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ApiError);
      expect(isAccessLoss(error)).toBe(true);
      expect(describeError(error)).not.toContain('Internal');
    }
    expect(isAccessLoss(new ApiError(409, 'VERSION_CONFLICT', 'conflict'))).toBe(false);
    expect(isAccessLoss(new ApiError(404, 'NOT_FOUND', 'hidden'))).toBe(true);
  });
});
