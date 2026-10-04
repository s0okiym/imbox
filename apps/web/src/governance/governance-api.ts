import type { CreateExportInput, ExportJob, GovernancePolicy } from '@imbox/contracts';
import { ApiError, type FetchLike } from '../api.js';

const LIMIT = 128 * 1024 * 1024;
/** Validate the whole transfer before offering it as a completed download. */
export async function verifyExport(bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength > LIMIT) throw new Error('浏览器导出上限为 128 MiB，请缩小导出范围。');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!text.endsWith('\n')) throw new Error('导出不完整，请重试。');
  const lines = text.slice(0, -1).split('\n');
  const footer: unknown = JSON.parse(lines.pop() ?? 'null');
  if (!footer || typeof footer !== 'object') throw new Error('导出不完整，请重试。');
  const end = footer as { type?: unknown; data?: { records?: unknown; sha256?: unknown } };
  if (end.type !== 'complete' || end.data?.records !== lines.length)
    throw new Error('导出被中断，请重新检查当前权限。');
  for (const line of lines) {
    const record: unknown = JSON.parse(line);
    if (
      !record ||
      typeof record !== 'object' ||
      !('type' in record) ||
      record.type === 'error' ||
      record.type === 'complete'
    )
      throw new Error('导出包含无效记录。');
  }
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(lines.join('\n') + '\n'),
  );
  const hex = Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, '0')).join('');
  if (end.data.sha256 !== hex) throw new Error('导出校验失败，请重试。');
}
export class GovernanceApi {
  constructor(
    readonly tenantId: string,
    readonly csrfToken: string,
    private readonly fetcher: FetchLike = (input, init) => fetch(input, init),
  ) {}
  private async request(path: string, signal: AbortSignal, body?: CreateExportInput, key?: string) {
    const headers = new Headers({ 'X-Imbox-Tenant-Id': this.tenantId });
    if (body) {
      headers.set('Content-Type', 'application/json');
      headers.set('X-CSRF-Token', this.csrfToken);
      headers.set('Idempotency-Key', key!);
    }
    const response = await this.fetcher(path, {
      method: body ? 'POST' : 'GET',
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok)
      throw new ApiError(
        response.status,
        'EXPORT_FAILED',
        '导出未完成，请检查当前权限或稍后重试。',
      );
    return response;
  }
  async policy(signal: AbortSignal): Promise<GovernancePolicy> {
    return (
      await this.request('/v1/governance/policy', signal)
    ).json() as Promise<GovernancePolicy>;
  }
  async create(body: CreateExportInput, key: string, signal: AbortSignal): Promise<ExportJob> {
    return (await this.request('/v1/exports', signal, body, key)).json() as Promise<ExportJob>;
  }
  async download(job: ExportJob, signal: AbortSignal): Promise<Blob> {
    const response = await this.request(
      '/v1/exports/' + encodeURIComponent(job.id) + '/content',
      signal,
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error('无法读取导出。');
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > LIMIT) throw new Error('浏览器导出上限为 128 MiB，请缩小导出范围。');
        chunks.push(new Uint8Array(item.value));
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const blob = new Blob(chunks, { type: 'application/x-ndjson' });
    await verifyExport(new Uint8Array(await blob.arrayBuffer()));
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return blob;
  }
}
