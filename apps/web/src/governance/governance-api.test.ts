import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { verifyExport, GovernanceApi } from './governance-api.js';
const prefix =
  JSON.stringify({ type: 'manifest', data: {} }) +
  '\n' +
  JSON.stringify({ type: 'memory', data: { body: '导出内容' } }) +
  '\n';
const complete =
  prefix +
  JSON.stringify({
    type: 'complete',
    data: { records: 2, sha256: createHash('sha256').update(prefix).digest('hex') },
  }) +
  '\n';
const bytes = (s: string) => new TextEncoder().encode(s);
describe('complete export verification', () => {
  it('accepts correct byte hash and rejects truncated, interrupted, corrupt and duplicate footers', async () => {
    await expect(verifyExport(bytes(complete))).resolves.toBeUndefined();
    for (const broken of [
      complete.slice(0, -1),
      prefix,
      complete.replace('导出内容', '篡改内容'),
      complete + complete.slice(prefix.length),
      prefix + JSON.stringify({ type: 'error', data: { code: 'EXPORT_INTERRUPTED' } }) + '\n',
    ])
      await expect(verifyExport(bytes(broken))).rejects.toThrow();
  });
  it('uses the authenticated same-origin resource path and never an export-controlled URL', async () => {
    const calls: { input: string; init: RequestInit }[] = [];
    const api = new GovernanceApi('tenant', 'csrf', async (input, init) => {
      calls.push({ input: String(input), init: init! });
      return new Response(complete);
    });
    const blob = await api.download(
      { id: 'safe-id', content_url: 'https://untrusted.example/export' } as never,
      new AbortController().signal,
    );
    expect(await blob.text()).toBe(complete);
    expect(calls[0]!.input).toBe('/v1/exports/safe-id/content');
    expect(calls[0]!.init.credentials).toBe('same-origin');
    expect(calls[0]!.init.cache).toBe('no-store');
  });
});
