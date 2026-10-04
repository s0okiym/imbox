import { expect, it } from 'vitest';
import type { ExplicitMemory, UpdateMemoryInput } from '@imbox/contracts';
import { KnowledgeApi } from './knowledge-api.js';

it('keeps source versions and hashes unchanged when a human updates confirmation after response loss', async () => {
  const calls: { path: string; init: RequestInit }[] = [];
  const api = new KnowledgeApi('tenant', 'csrf', async (path, init) => {
    calls.push({ path: String(path), init: init! });
    if (calls.length === 1) throw new TypeError('Connection lost');
    return new Response('{}');
  });
  const memory = { id: 'memory', version: '9007199254740993' } as ExplicitMemory;
  const input: UpdateMemoryInput = {
    scope: 'personal',
    body: 'Verified by a human',
    source_refs: [
      { kind: 'message', id: 'message', version: '9007199254740992', sha256: 'a'.repeat(64) },
    ],
    confidence: 80,
    confirmation: 'confirmed',
    status: 'active',
    expires_at: null,
  };
  const signal = new AbortController().signal;
  await expect(api.update(memory, input, 'same-intent', signal)).rejects.toThrow('Connection lost');
  expect(calls).toHaveLength(1);
  await api.update(memory, input, 'same-intent', signal);
  expect(calls[0]!.init.body).toEqual(calls[1]!.init.body);
  for (const { init } of calls) {
    expect(JSON.parse(String(init.body))).toEqual(input);
    expect(new Headers(init.headers).get('If-Match')).toBe('"9007199254740993"');
    expect(new Headers(init.headers).get('Idempotency-Key')).toBe('same-intent');
    expect(init.credentials).toBe('same-origin');
    expect(init.cache).toBe('no-store');
  }
});

it('encodes literal search and opaque cursors and only deletes the selected memory', async () => {
  const calls: { path: string; init: RequestInit }[] = [];
  const api = new KnowledgeApi('tenant', 'csrf', async (path, init) => {
    calls.push({ path: String(path), init: init! });
    return new Response('{}');
  });
  const signal = new AbortController().signal;
  await api.search(
    { q: '查询 <script>&?', task_id: 'task', kind: 'message', cursor: 'opaque+/=', limit: 50 },
    signal,
  );
  const query = new URL(calls[0]!.path, 'https://imbox.test').searchParams;
  expect(query.get('q')).toBe('查询 <script>&?');
  expect(query.get('cursor')).toBe('opaque+/=');
  expect(query.has('conversation_id')).toBe(false);
  await api.delete({ id: 'memory', version: '9' } as ExplicitMemory, 'delete-once', signal);
  expect(calls[1]!.path).toBe('/v1/memories/memory');
  expect(calls[1]!.init.method).toBe('DELETE');
  expect(calls[1]!.init.body).toBeUndefined();
});
