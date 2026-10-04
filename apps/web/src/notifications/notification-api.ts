import {
  assertContract,
  type NotificationPreferencesInput,
  type ContractTypes,
} from '@imbox/contracts';
import { ApiError, type FetchLike } from '../api.js';
export class NotificationApi {
  constructor(
    readonly tenantId: string,
    readonly csrfToken: string,
    private readonly fetcher: FetchLike = (input, init) => globalThis.fetch(input, init),
  ) {}
  private async request<K extends keyof ContractTypes>(
    contract: K,
    path: string,
    signal: AbortSignal,
    method = 'GET',
    body?: unknown,
    version?: string,
  ): Promise<ContractTypes[K]> {
    const headers = new Headers({ 'X-Imbox-Tenant-Id': this.tenantId });
    if (method !== 'GET') headers.set('X-CSRF-Token', this.csrfToken);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    if (version !== undefined) headers.set('If-Match', `"${version}"`);
    const response = await this.fetcher(path, {
      method,
      headers,
      signal,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok)
      throw new ApiError(response.status, 'NOTIFICATION_FAILED', '通知操作未完成，请刷新后重试。');
    return assertContract(contract, await response.json());
  }
  list(signal: AbortSignal, cursor?: string) {
    return this.request(
      'NotificationPage',
      `/v1/notifications${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      signal,
    );
  }
  unread(signal: AbortSignal) {
    return this.request('NotificationUnread', '/v1/notifications/unread', signal);
  }
  open(id: string, signal: AbortSignal) {
    return this.request(
      'NotificationLocation',
      `/v1/notifications/${encodeURIComponent(id)}/open`,
      signal,
    );
  }
  read(id: string, version: string, signal: AbortSignal) {
    return this.request(
      'NotificationRead',
      `/v1/notifications/${encodeURIComponent(id)}/read`,
      signal,
      'POST',
      undefined,
      version,
    );
  }
  preferences(signal: AbortSignal) {
    return this.request('NotificationPreferences', '/v1/notification-preferences', signal);
  }
  savePreferences(body: NotificationPreferencesInput, version: string, signal: AbortSignal) {
    return this.request(
      'NotificationPreferences',
      '/v1/notification-preferences',
      signal,
      'PUT',
      body,
      version,
    );
  }
  mute(id: string, muted: boolean, signal: AbortSignal) {
    return this.request(
      'NotificationMute',
      `/v1/notification-mutes/${encodeURIComponent(id)}`,
      signal,
      'PUT',
      { muted },
    );
  }
  pushKey(signal: AbortSignal) {
    return this.request('NotificationPushKey', '/v1/notification-push-key', signal);
  }
  subscribe(
    body: { endpoint: string; keys: { p256dh: string; auth: string } },
    signal: AbortSignal,
  ) {
    return this.request('NotificationDevice', '/v1/notification-subscription', signal, 'PUT', body);
  }
  devices(signal: AbortSignal) {
    return this.request('NotificationDevicePage', '/v1/notification-devices', signal);
  }
  disableDevice(id: string, signal: AbortSignal) {
    return this.request(
      'NotificationDevice',
      `/v1/notification-devices/${encodeURIComponent(id)}`,
      signal,
      'DELETE',
    );
  }
}
