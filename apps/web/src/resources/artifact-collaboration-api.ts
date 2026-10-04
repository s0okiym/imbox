import type {
  ArtifactComment,
  ArtifactCommentPage,
  ArtifactCommentDeletion,
  ArtifactShare,
  ArtifactSharePage,
  ArtifactShareSummary,
  ArtifactShareRevocation,
  CreateArtifactCommentInput,
  CreateArtifactShareInput,
} from '@imbox/contracts';
import { ApiError, type FetchLike } from '../api.js';
import { MAX_TEXT_BYTES, sha256 } from './resource-api.js';
export class ArtifactCollaborationApi {
  constructor(
    readonly tenantId: string,
    readonly csrfToken: string,
    private readonly fetcher: FetchLike = (input, init) => fetch(input, init),
  ) {}
  private async response(
    path: string,
    signal: AbortSignal,
    command?: {
      method: 'POST' | 'PATCH' | 'DELETE';
      body?: unknown;
      key: string;
      version?: string;
    },
  ) {
    const headers = new Headers({ 'X-Imbox-Tenant-Id': this.tenantId });
    if (command) {
      headers.set('X-CSRF-Token', this.csrfToken);
      headers.set('Idempotency-Key', command.key);
      if (command.version) headers.set('If-Match', '"' + command.version + '"');
      if (command.body !== undefined) headers.set('Content-Type', 'application/json');
    }
    const response = await this.fetcher(path, {
      method: command?.method ?? 'GET',
      headers,
      signal,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(command?.body !== undefined ? { body: JSON.stringify(command.body) } : {}),
    });
    if (!response.ok) {
      let code = 'REQUEST_FAILED';
      try {
        const body = (await response.json()) as { code?: unknown };
        if (typeof body.code === 'string') code = body.code;
      } catch {
        /* controlled error */
      }
      throw new ApiError(response.status, code, '制品协作操作未完成');
    }
    return response;
  }
  private async json<T>(
    path: string,
    signal: AbortSignal,
    command?: {
      method: 'POST' | 'PATCH' | 'DELETE';
      body?: unknown;
      key: string;
      version?: string;
    },
  ): Promise<T> {
    return (await this.response(path, signal, command)).json() as Promise<T>;
  }
  comments(
    artifact: string,
    version: string,
    signal: AbortSignal,
    cursor?: string,
  ): Promise<ArtifactCommentPage> {
    return this.json(
      '/v1/artifacts/' +
        encodeURIComponent(artifact) +
        '/comments?' +
        new URLSearchParams({ version_id: version, limit: '100', ...(cursor ? { cursor } : {}) }),
      signal,
    );
  }
  createComment(
    artifact: string,
    input: CreateArtifactCommentInput,
    key: string,
    signal: AbortSignal,
  ): Promise<ArtifactComment> {
    return this.json('/v1/artifacts/' + encodeURIComponent(artifact) + '/comments', signal, {
      method: 'POST',
      body: input,
      key,
    });
  }
  editComment(
    comment: ArtifactComment,
    body: string,
    key: string,
    signal: AbortSignal,
  ): Promise<ArtifactComment> {
    return this.json('/v1/artifact-comments/' + encodeURIComponent(comment.id), signal, {
      method: 'PATCH',
      body: { body },
      key,
      version: comment.version,
    });
  }
  deleteComment(
    comment: ArtifactComment,
    key: string,
    signal: AbortSignal,
  ): Promise<ArtifactCommentDeletion> {
    return this.json('/v1/artifact-comments/' + encodeURIComponent(comment.id), signal, {
      method: 'DELETE',
      key,
      version: comment.version,
    });
  }
  shares(artifact: string, signal: AbortSignal, cursor?: string): Promise<ArtifactSharePage> {
    return this.json(
      '/v1/artifacts/' +
        encodeURIComponent(artifact) +
        '/shares?' +
        new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) }),
      signal,
    );
  }
  createShare(
    artifact: string,
    input: CreateArtifactShareInput,
    key: string,
    signal: AbortSignal,
  ): Promise<ArtifactShare> {
    return this.json('/v1/artifacts/' + encodeURIComponent(artifact) + '/shares', signal, {
      method: 'POST',
      body: input,
      key,
    });
  }
  revoke(
    share: ArtifactShareSummary,
    key: string,
    signal: AbortSignal,
  ): Promise<ArtifactShareRevocation> {
    return this.json('/v1/artifact-shares/' + encodeURIComponent(share.id), signal, {
      method: 'DELETE',
      key,
      version: share.version,
    });
  }
  share(id: string, signal: AbortSignal): Promise<ArtifactShare> {
    return this.json('/v1/artifact-shares/' + encodeURIComponent(id), signal);
  }
  async download(share: ArtifactShare, signal: AbortSignal): Promise<Blob> {
    const response = await this.response(
        '/v1/artifact-shares/' + encodeURIComponent(share.id) + '/content',
        signal,
      ),
      reader = response.body?.getReader();
    if (!reader) throw new Error('文件下载未完成。');
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    try {
      while (true) {
        const value = await reader.read();
        if (value.done) break;
        size += value.value.byteLength;
        if (size > MAX_TEXT_BYTES || size > share.byte_size) throw new Error('文件大小校验失败。');
        chunks.push(new Uint8Array(value.value));
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const blob = new Blob(chunks, { type: share.content_type });
    if (size !== share.byte_size || (await sha256(await blob.arrayBuffer())) !== share.sha256)
      throw new Error('文件内容校验失败。');
    signal.throwIfAborted();
    return blob;
  }
}
/** Range anchors count Unicode code points, while browser text selections count UTF-16 units. */
export function selectedAnchor(text: string, start: number, end: number) {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > text.length
  )
    throw new Error('请先选择一段文字。');
  const codeStart = [...text.slice(0, start)].length,
    codeEnd = [...text.slice(0, end)].length;
  if ([...text].slice(codeStart, codeEnd).join('') !== text.slice(start, end))
    throw new Error('请选择完整字符。');
  return { type: 'text_range' as const, start: codeStart, end: codeEnd };
}
export function shareLink(id: string, origin = location.origin) {
  return origin + '/resources?share=' + encodeURIComponent(id);
}
