import { it, expect } from 'vitest';
import type {ArtifactShare} from '@imbox/contracts';
import { createHash } from 'node:crypto';
import {
  ArtifactCollaborationApi,
  selectedAnchor,
  shareLink,
} from './artifact-collaboration-api.js';
it('maps browser text selection to fixed Unicode character offsets without splitting a surrogate pair', () => {
  expect(selectedAnchor('你好😀 world', 2, 4)).toEqual({ type: 'text_range', start: 2, end: 3 });
  expect(() => selectedAnchor('你好😀', 2, 3)).toThrow();
  expect(() => selectedAnchor('abc', 0, 0)).toThrow();
  expect(shareLink('id', 'https://imbox.example')).toBe('https://imbox.example/resources?share=id');
});
it('downloads only the share endpoint and validates length and immutable hash', async () => {
  const content = '受控的内容',
    seen: string[] = [];
  const api = new ArtifactCollaborationApi('tenant', 'csrf', async (input, init) => {
    seen.push(String(input));
    expect(init!.credentials).toBe('same-origin');
    expect(init!.cache).toBe('no-store');
    return new Response(content);
  });
  const share = {
    id: 'grant',
    byte_size: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex'),
    content_type: 'text/plain',
    download_path: 'https://untrusted.example/',
  } as ArtifactShare;
  expect(await (await api.download(share, new AbortController().signal)).text()).toBe(content);
  expect(seen).toEqual(['/v1/artifact-shares/grant/content']);
  await expect(
    api.download({ ...share, sha256: '0'.repeat(64) }, new AbortController().signal),
  ).rejects.toThrow('文件内容校验失败');
});
