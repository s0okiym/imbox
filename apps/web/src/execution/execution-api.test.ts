import { describe, expect, it } from 'vitest';
import type { Action, RuntimeRun, Schedule } from '@imbox/contracts';
import { ExecutionApi } from './execution-api.js';
describe('runtime and action HTTP boundaries', () => {
  it('binds approval to exact integer-string versions and reuses a caller command key after a lost response', async () => {
    const calls: { path: string; init: RequestInit }[] = [];
    const api = new ExecutionApi('tenant', 'csrf', async (path, init) => {
      calls.push({ path: String(path), init: init! });
      if (calls.length === 1) throw new TypeError('Response lost');
      return new Response('{}');
    });
    const action = { id: 'action', version: '9007199254740993' } as Action;
    const body = {
      decision: 'approve' as const,
      action_version: '9007199254740992',
      fingerprint: 'bound-content',
      comment: 'Checked',
    };
    const signal = new AbortController().signal;
    await expect(api.decide(action, body, 'same-command', signal)).rejects.toThrow('Response lost');
    expect(calls).toHaveLength(1); // no implicit network retries
    await api.decide(action, body, 'same-command', signal);
    expect(calls[0]?.init.body).toBe(calls[1]?.init.body);
    for (const call of calls) {
      const headers = new Headers(call.init.headers);
      expect(headers.get('If-Match')).toBe('"9007199254740993"');
      expect(headers.get('Idempotency-Key')).toBe('same-command');
      expect(headers.get('X-CSRF-Token')).toBe('csrf');
      expect(headers.get('X-Imbox-Tenant-Id')).toBe('tenant');
      expect(call.init.credentials).toBe('same-origin');
      expect(call.init.cache).toBe('no-store');
    }
  });
  it('routes unknown lookup through reconcile and has no worker execution methods', async () => {
    const urls: string[] = [];
    const api = new ExecutionApi('tenant', 'csrf', async (path) => {
      urls.push(String(path));
      return new Response('{}');
    });
    await api.reconcile(
      { id: 'unknown', version: '7' } as Action,
      'Check receipt',
      'key',
      new AbortController().signal,
    );
    expect(urls).toEqual(['/v1/actions/unknown/reconcile']);
    for (const method of ['dispatch', 'execute', 'retry', 'claim', 'recordReceipt'])
      expect(method in api).toBe(false);
  });
  it('keeps listing cursors opaque and binds history to exactly one scope', async () => {
    const paths: string[] = [];
    const api = new ExecutionApi('tenant', 'csrf', async (path) => {
      paths.push(String(path));
      return new Response('{}');
    });
    await api.runs({ type: 'task', id: 'task' }, new AbortController().signal, 'opaque+/=');
    const query = new URL(paths[0]!, 'https://imbox.test').searchParams;
    expect(query.get('task_id')).toBe('task');
    expect(query.has('conversation_id')).toBe(false);
    expect(query.get('cursor')).toBe('opaque+/=');
    await api.control(
      { id: 'run', version: '9' } as RuntimeRun,
      'pause',
      'control-key',
      new AbortController().signal,
    );
    expect(paths[1]).toBe('/v1/agent-runs/run/pause');
  });
  it('uses the cursor-only schedule contract and versioned disable without a cancellation body', async () => {
    const calls: { path: string; init: RequestInit }[] = [];
    const api = new ExecutionApi('tenant', 'csrf', async (path, init) => {
      calls.push({ path: String(path), init: init! });
      return new Response('{}');
    });
    const signal = new AbortController().signal;
    await api.schedules(signal, 'signed+/=');
    await api.occurrences('schedule', signal, 'next+/=');
    for (const call of calls) {
      const query = new URL(call.path, 'https://imbox.test').searchParams;
      expect([...query.keys()]).toEqual(['cursor']);
    }
    await api.disableSchedule(
      { id: 'schedule', version: '9007199254740993' } as Schedule,
      'disable-once',
      signal,
    );
    const request = calls[2]!.init;
    expect(calls[2]!.path).toBe('/v1/schedules/schedule');
    expect(request.method).toBe('DELETE');
    expect(request.body).toBeUndefined();
    expect(new Headers(request.headers).get('If-Match')).toBe('"9007199254740993"');
    expect(new Headers(request.headers).get('Idempotency-Key')).toBe('disable-once');
  });
});
