import type {
  RecoveryCase,
  RecoveryCasePage,
  RecoveryConfirmInput,
  RecoveryEvidence,
  RecoveryStatus,
  RecoveryUnfreezeInput,
} from '@imbox/contracts';
import { ApiError, type FetchLike } from '../api.js';
export class RecoveryApi {
  constructor(
    readonly tenantId: string,
    readonly csrfToken: string,
    private readonly fetcher: FetchLike = (input, init) => globalThis.fetch(input, init),
  ) {}
  private async request<T>(
    path: string,
    signal: AbortSignal,
    command?: { body: unknown; key: string; version?: string },
  ): Promise<T> {
    const headers = new Headers({ 'X-Imbox-Tenant-Id': this.tenantId, Accept: 'application/json' });
    if (command) {
      headers.set('Content-Type', 'application/json');
      headers.set('X-CSRF-Token', this.csrfToken);
      headers.set('Idempotency-Key', command.key);
      if (command.version) headers.set('If-Match', '"' + command.version + '"');
    }
    const response = await this.fetcher(path, {
      method: command ? 'POST' : 'GET',
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
      ...(command ? { body: JSON.stringify(command.body) } : {}),
    });
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new ApiError(
        response.ok ? 502 : response.status,
        'INVALID_RESPONSE',
        '无法读取恢复响应',
      );
    }
    if (!response.ok) {
      const error =
        typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
      throw new ApiError(
        response.status,
        typeof error.code === 'string' ? error.code : 'REQUEST_FAILED',
        '恢复操作未完成',
      );
    }
    return value as T;
  }
  status(signal: AbortSignal): Promise<RecoveryStatus> {
    return this.request('/v1/action-recovery', signal);
  }
  cases(signal: AbortSignal, cursor?: string): Promise<RecoveryCasePage> {
    return this.request(
      '/v1/action-recovery/cases' + (cursor ? '?' + new URLSearchParams({ cursor }) : ''),
      signal,
    );
  }
  get(id: string, signal: AbortSignal): Promise<RecoveryCase> {
    return this.request('/v1/action-recovery/cases/' + encodeURIComponent(id), signal);
  }
  refresh(reason: string, key: string, signal: AbortSignal): Promise<RecoveryStatus> {
    return this.request('/v1/action-recovery/refresh', signal, { body: { reason }, key });
  }
  lookup(id: string, key: string, signal: AbortSignal): Promise<RecoveryEvidence> {
    return this.request('/v1/action-recovery/cases/' + encodeURIComponent(id) + '/lookup', signal, {
      body: {},
      key,
    });
  }
  confirm(
    item: RecoveryCase,
    body: RecoveryConfirmInput,
    key: string,
    signal: AbortSignal,
  ): Promise<RecoveryCase> {
    return this.request(
      '/v1/action-recovery/cases/' + encodeURIComponent(item.id) + '/confirm',
      signal,
      { body, key, version: item.version },
    );
  }
  unfreeze(
    state: RecoveryStatus,
    body: RecoveryUnfreezeInput,
    key: string,
    signal: AbortSignal,
  ): Promise<RecoveryStatus> {
    return this.request('/v1/action-recovery/unfreeze', signal, {
      body,
      key,
      version: state.revision,
    });
  }
}
