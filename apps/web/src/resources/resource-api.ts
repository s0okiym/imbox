import type {
  ArtifactBranch,
  ArtifactBranchPage,
  CreateStoredArtifactInput,
  CreateUploadInput,
  ResourceDeletion,
  StoredArtifact,
  StoredArtifactPage,
  StoredArtifactVersionPage,
  StoredResource,
  StoredResourcePage,
  UploadTicket,
} from '@imbox/contracts';
import { ApiError, describeError } from '../api.js';
import type { FetchLike } from '../api.js';
export type ResourceScope = { readonly type: 'task' | 'conversation'; readonly id: string };
export const MAX_TEXT_BYTES = 8 * 1024 * 1024;
export function resourceError(error: unknown): string {
  if (error instanceof ApiError && error.code === 'RESOURCE_IN_USE')
    return '此文件已被消息、制品或提交证据引用，不能直接删除。';
  if (error instanceof Error && /^(文件|请|上传)/.test(error.message)) return error.message;
  return describeError(error);
}
export async function sha256(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}
export function textFileType(
  file: Pick<File, 'name' | 'size' | 'type'>,
): CreateUploadInput['content_type'] {
  if (file.size > MAX_TEXT_BYTES) throw new Error('文件不能超过 8 MiB。');
  const extension = file.name.toLowerCase().split('.').at(-1);
  if (extension === 'md' || extension === 'markdown') return 'text/markdown';
  if (extension === 'json') return 'application/json';
  if (extension === 'txt' || file.type === 'text/plain') return 'text/plain';
  throw new Error('请选择 UTF-8 的 TXT、Markdown 或 JSON 文件。');
}
export class ResourceApi {
  constructor(
    readonly tenantId: string,
    readonly csrfToken: string,
    private readonly fetcher: FetchLike = (url, init) => globalThis.fetch(url, init),
  ) {}
  private async request<T>(
    path: string,
    signal: AbortSignal,
    command?: { body?: unknown; key: string; version?: string; method?: 'DELETE' },
  ): Promise<T> {
    const headers = new Headers({ 'X-Imbox-Tenant-Id': this.tenantId, Accept: 'application/json' });
    if (command) {
      headers.set('X-CSRF-Token', this.csrfToken);
      headers.set('Idempotency-Key', command.key);
      if (command.version !== undefined) headers.set('If-Match', `"${command.version}"`);
      if (command.body !== undefined) headers.set('Content-Type', 'application/json');
    }
    const response = await this.fetcher(path, {
      method: command?.method ?? (command ? 'POST' : 'GET'),
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
      ...(command?.body === undefined ? {} : { body: JSON.stringify(command.body) }),
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ApiError(
        response.ok ? 502 : response.status,
        'INVALID_RESPONSE',
        '无法读取文件响应',
      );
    }
    if (!response.ok) {
      const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
      throw new ApiError(
        response.status,
        typeof record['code'] === 'string' ? record['code'] : 'REQUEST_FAILED',
        '文件操作未完成',
      );
    }
    return body as T;
  }
  resource(id: string, signal: AbortSignal): Promise<StoredResource> {
    return this.request(`/v1/resources/${encodeURIComponent(id)}`, signal);
  }
  resources(
    scope: ResourceScope,
    signal: AbortSignal,
    cursor?: string,
  ): Promise<StoredResourcePage> {
    return this.request(
      `/v1/resources?${new URLSearchParams({ [scope.type === 'task' ? 'task_id' : 'conversation_id']: scope.id, limit: '100', ...(cursor ? { cursor } : {}) })}`,
      signal,
    );
  }
  artifacts(
    scope: ResourceScope,
    signal: AbortSignal,
    cursor?: string,
  ): Promise<StoredArtifactPage> {
    return this.request(
      `/v1/artifacts?${new URLSearchParams({ [scope.type === 'task' ? 'task_id' : 'conversation_id']: scope.id, limit: '100', ...(cursor ? { cursor } : {}) })}`,
      signal,
    );
  }
  ticket(input: CreateUploadInput, key: string, signal: AbortSignal): Promise<UploadTicket> {
    return this.request('/v1/uploads', signal, { body: input, key });
  }
  complete(id: string, key: string, signal: AbortSignal): Promise<StoredResource> {
    return this.request(`/v1/uploads/${encodeURIComponent(id)}/complete`, signal, { key });
  }
  remove(resource: StoredResource, key: string, signal: AbortSignal): Promise<ResourceDeletion> {
    return this.request(`/v1/resources/${encodeURIComponent(resource.id)}`, signal, {
      key,
      version: resource.version,
      method: 'DELETE',
    });
  }
  artifact(id: string, signal: AbortSignal): Promise<StoredArtifact> {
    return this.request(`/v1/artifacts/${encodeURIComponent(id)}`, signal);
  }
  createArtifact(
    input: CreateStoredArtifactInput,
    key: string,
    signal: AbortSignal,
  ): Promise<StoredArtifact> {
    return this.request('/v1/artifacts', signal, { key, body: input });
  }
  appendVersion(
    artifact: StoredArtifact,
    resourceId: string,
    key: string,
    signal: AbortSignal,
  ): Promise<StoredArtifact> {
    return this.request(`/v1/artifacts/${encodeURIComponent(artifact.id)}/versions`, signal, {
      key,
      version: artifact.version,
      body: { resource_id: resourceId },
    });
  }
  createBranch(
    id: string,
    baseVersionId: string,
    resourceId: string,
    key: string,
    signal: AbortSignal,
  ): Promise<ArtifactBranch> {
    return this.request(`/v1/artifacts/${encodeURIComponent(id)}/branches`, signal, {
      key,
      body: { base_version_id: baseVersionId, resource_id: resourceId },
    });
  }
  branches(id: string, signal: AbortSignal, cursor?: string): Promise<ArtifactBranchPage> {
    return this.request(
      `/v1/artifacts/${encodeURIComponent(id)}/branches?${new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) })}`,
      signal,
    );
  }
  mergeBranch(
    artifact: StoredArtifact,
    branchId: string,
    resourceId: string,
    key: string,
    signal: AbortSignal,
  ): Promise<StoredArtifact> {
    return this.request(`/v1/artifacts/${encodeURIComponent(artifact.id)}/branch-merges`, signal, {
      key,
      version: artifact.version,
      body: { branch_id: branchId, resource_id: resourceId },
    });
  }
  versions(id: string, signal: AbortSignal, cursor?: string): Promise<StoredArtifactVersionPage> {
    return this.request(
      `/v1/artifacts/${encodeURIComponent(id)}/versions?${new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) })}`,
      signal,
    );
  }
  async put(ticket: UploadTicket, file: File, signal: AbortSignal): Promise<void> {
    const url = new URL(ticket.upload_url);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      file.size > ticket.max_bytes
    )
      throw new Error('上传地址或文件大小不符合要求。');
    // Content-Length is browser controlled; File establishes the exact signed byte length.
    const headers = new Headers();
    for (const [name, value] of Object.entries(ticket.upload_headers)) {
      if (name.toLowerCase() === 'content-type' || name.toLowerCase().startsWith('x-amz-'))
        headers.set(name, value);
    }
    const response = await this.fetcher(ticket.upload_url, {
      method: 'PUT',
      headers,
      body: file,
      signal,
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) throw new Error('上传未被存储服务确认，请重试；过期后需重新选择文件。');
  }
  async download(resource: StoredResource, signal: AbortSignal): Promise<Blob> {
    // Never trust a download URL to forward identity headers outside this origin.
    const response = await this.fetcher(
      `/v1/resources/${encodeURIComponent(resource.id)}/content`,
      {
        headers: { 'X-Imbox-Tenant-Id': this.tenantId },
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal,
      },
    );
    if (!response.ok)
      throw new ApiError(
        response.status,
        response.status === 401
          ? 'UNAUTHENTICATED'
          : response.status === 403
            ? 'FORBIDDEN'
            : response.status === 404
              ? 'NOT_FOUND'
              : 'REQUEST_FAILED',
        '文件下载未完成',
      );
    if (!response.body) throw new Error('文件下载未完成。');
    const reader = response.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    try {
      while (true) {
        const value = await reader.read();
        if (value.done) break;
        size += value.value.byteLength;
        if (size > MAX_TEXT_BYTES || size > resource.byte_size) {
          await reader.cancel();
          throw new Error('文件大小校验失败。');
        }
        chunks.push(new Uint8Array(value.value));
      }
    } finally {
      reader.releaseLock();
    }
    const blob = new Blob(chunks, { type: resource.content_type });
    if (size !== resource.byte_size || (await sha256(await blob.arrayBuffer())) !== resource.sha256)
      throw new Error('文件内容校验失败，请重新下载。');
    return blob;
  }
}

/** A retained attempt resumes complete after a lost response instead of opening another upload. */
export class TextUpload {
  private ticketValue: UploadTicket | null = null;
  private transferred = false;
  private completed: StoredResource | null = null;
  private readonly createKey = crypto.randomUUID();
  private readonly completeKey = crypto.randomUUID();
  constructor(
    private readonly api: ResourceApi,
    private readonly file: File,
    private readonly scope: ResourceScope,
  ) {}
  async run(
    signal: AbortSignal,
    stage: (value: 'preparing' | 'uploading' | 'verifying') => void,
  ): Promise<StoredResource> {
    if (this.completed) return this.completed;
    const contentType = textFileType(this.file);
    stage('preparing');
    if (!this.ticketValue) {
      const checksum = await sha256(await this.file.arrayBuffer());
      signal.throwIfAborted();
      this.ticketValue = await this.api.ticket(
        {
          [this.scope.type === 'task' ? 'task_id' : 'conversation_id']: this.scope.id,
          filename: this.file.name,
          content_type: contentType,
          byte_size: this.file.size,
          sha256: checksum,
        },
        this.createKey,
        signal,
      );
    }
    if (!this.transferred) {
      if (Date.parse(this.ticketValue.expires_at) <= Date.now())
        throw new Error('上传凭证已过期，请重新选择文件。');
      stage('uploading');
      await this.api.put(this.ticketValue, this.file, signal);
      this.transferred = true;
    }
    stage('verifying');
    this.completed = await this.api.complete(this.ticketValue.id, this.completeKey, signal);
    return this.completed;
  }
}
