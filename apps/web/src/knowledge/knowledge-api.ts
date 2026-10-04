import type {
  CreateMemoryInput,
  ExplicitMemory,
  ExplicitMemoryPage,
  KnowledgeSearchPage,
  KnowledgeSearchQuery,
  MemoryDeletion,
  UpdateMemoryInput,
} from '@imbox/contracts';
import { ApiError, type FetchLike } from '../api.js';

export interface MemoryQuery {
  conversation_id?: string;
  task_id?: string;
  cursor?: string;
  limit?: number;
}
export class KnowledgeApi {
  constructor(
    readonly tenantId: string,
    readonly csrfToken: string,
    private readonly fetcher: FetchLike = (input, init) => globalThis.fetch(input, init),
  ) {}
  private async request<T>(
    path: string,
    signal: AbortSignal,
    command?: {
      method: 'POST' | 'PATCH' | 'DELETE';
      body?: unknown;
      key: string;
      version?: string;
    },
  ): Promise<T> {
    const headers = new Headers({ Accept: 'application/json', 'X-Imbox-Tenant-Id': this.tenantId });
    if (command) {
      headers.set('X-CSRF-Token', this.csrfToken);
      headers.set('Idempotency-Key', command.key);
      if (command.version !== undefined) headers.set('If-Match', `"${command.version}"`);
      if (command.body !== undefined) headers.set('Content-Type', 'application/json');
    }
    const response = await this.fetcher(path, {
      method: command?.method ?? 'GET',
      signal,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(command?.body === undefined ? {} : { body: JSON.stringify(command.body) }),
    });
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new ApiError(response.ok ? 502 : response.status, 'INVALID_RESPONSE', '无法读取响应');
    }
    if (!response.ok) {
      const record =
        typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
      throw new ApiError(
        response.status,
        typeof record['code'] === 'string' ? record['code'] : 'REQUEST_FAILED',
        '知识操作未完成',
      );
    }
    return value as T;
  }
  search(query: KnowledgeSearchQuery, signal: AbortSignal): Promise<KnowledgeSearchPage> {
    return this.request(`/v1/search?${parameters(query)}`, signal);
  }
  memories(query: MemoryQuery, signal: AbortSignal): Promise<ExplicitMemoryPage> {
    return this.request(`/v1/memories?${parameters(query)}`, signal);
  }
  memory(id: string, signal: AbortSignal): Promise<ExplicitMemory> {
    return this.request(`/v1/memories/${encodeURIComponent(id)}`, signal);
  }
  create(input: CreateMemoryInput, key: string, signal: AbortSignal): Promise<ExplicitMemory> {
    return this.request('/v1/memories', signal, { method: 'POST', body: input, key });
  }
  update(
    memory: ExplicitMemory,
    input: UpdateMemoryInput,
    key: string,
    signal: AbortSignal,
  ): Promise<ExplicitMemory> {
    return this.request(`/v1/memories/${encodeURIComponent(memory.id)}`, signal, {
      method: 'PATCH',
      body: input,
      key,
      version: memory.version,
    });
  }
  delete(memory: ExplicitMemory, key: string, signal: AbortSignal): Promise<MemoryDeletion> {
    return this.request(`/v1/memories/${encodeURIComponent(memory.id)}`, signal, {
      method: 'DELETE',
      key,
      version: memory.version,
    });
  }
}
function parameters(value: object) {
  return new URLSearchParams(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, String(item)]),
  );
}
export const MEMORY_CONFIRMATION = {
  confirmed: '人工已确认',
  needs_confirmation: '待人工确认',
  conflicted: '存在冲突',
} as const;
export const SOURCE_KIND = {
  message: '消息',
  task: '任务',
  artifact_version: '制品固定版本',
  memory: '显式记忆',
} as const;
export function knowledgeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'VERSION_CONFLICT')
      return '内容或来源版本已改变。请重新读取来源、核对内容后再提交。';
    if (error.code === 'DISCLOSURE_DENIED')
      return '共享范围与来源权限不一致，无法保存。共享记忆的来源必须属于同一会话或任务。';
    if (error.code === 'VALIDATION_FAILED') return '请核对查询长度、范围、有效期及完整来源。';
    if ([403, 404].includes(error.status))
      return '内容或来源已不可访问，相关列表、详情与草稿已隐藏。';
    if (error.status === 401) return '登录已失效，请重新登录。';
  }
  return '暂时无法验证当前内容，已隐藏本次结果。联网后可重新读取。';
}
