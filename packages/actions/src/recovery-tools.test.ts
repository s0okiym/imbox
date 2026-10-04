import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpToolRegistry } from './tools.js';
afterEach(() => vi.unstubAllGlobals());
describe('bound recovery HTTP lookup', () => {
  it('uses only GET and binds provider evidence to tenant/action/attempt/fingerprint', async () => {
    const call = {
      tenantId: randomUUID(),
      actionId: randomUUID(),
      attemptId: randomUUID(),
      businessKey: randomUUID(),
      fingerprint: 'a'.repeat(64),
    };
    const provider = {
      status: 'succeeded',
      receipt_id: 'receipt',
      fingerprint: call.fingerprint,
      cost_microunits: '7',
      tenant_id: call.tenantId,
      action_id: call.actionId,
      attempt_id: call.attemptId,
    };
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify(provider), { headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetcher);
    const tool = createHttpToolRegistry([
      {
        id: 'test',
        version: '1',
        targetId: 'fixed',
        executeUrl: 'https://provider.invalid/execute',
        lookupUrl: 'https://provider.invalid/lookup',
      },
    ]).get('test', '1', 'fixed');
    expect(await tool.lookupRecovery!(call)).toMatchObject({
      status: 'succeeded',
      actualMicrounits: '7',
    });
    const request = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(request[1].method).toBe('GET');
    expect(request[1].body).toBeUndefined();
    expect(request[0].searchParams.get('tenant_id')).toBe(call.tenantId);
    expect(request[0].searchParams.get('action_id')).toBe(call.actionId);
    expect(request[0].searchParams.get('attempt_id')).toBe(call.attemptId);
    for (const field of ['tenant_id', 'action_id', 'attempt_id', 'fingerprint'] as const) {
      fetcher.mockImplementation(
        async () =>
          new Response(JSON.stringify({ ...provider, [field]: randomUUID() }), {
            headers: { 'content-type': 'application/json' },
          }),
      );
      expect(await tool.lookupRecovery!(call)).toEqual({
        status: 'unknown',
        reason: 'invalid_response',
      });
    }
  });
  it('preserves unknown for not_found, absent binding and an out-of-range amount', async () => {
    const call = {
      tenantId: randomUUID(),
      actionId: randomUUID(),
      attemptId: randomUUID(),
      businessKey: randomUUID(),
      fingerprint: 'a'.repeat(64),
    };
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: 'not_found' }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const tool = createHttpToolRegistry([
      {
        id: 'test',
        version: '1',
        targetId: 'fixed',
        executeUrl: 'https://provider.invalid/execute',
        lookupUrl: 'https://provider.invalid/lookup',
      },
    ]).get('test', '1', 'fixed');
    expect(await tool.lookupRecovery!(call)).toEqual({ status: 'unknown', reason: 'not_found' });
    for (const body of [
      {
        status: 'succeeded',
        receipt_id: 'receipt',
        fingerprint: call.fingerprint,
        cost_microunits: '7',
      },
      {
        status: 'succeeded',
        receipt_id: 'receipt',
        fingerprint: call.fingerprint,
        cost_microunits: '9999999999999999999',
        tenant_id: call.tenantId,
        action_id: call.actionId,
        attempt_id: call.attemptId,
      },
    ]) {
      fetcher.mockImplementation(
        async () =>
          new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
      );
      expect(await tool.lookupRecovery!(call)).toEqual({
        status: 'unknown',
        reason: 'invalid_response',
      });
    }
  });
});
