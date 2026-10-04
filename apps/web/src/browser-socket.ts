import type { SyncSocket } from './conversation-sync.js';

export class BrowserSyncSocket implements SyncSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly connection: WebSocket;

  constructor(tenantId: string) {
    const url = new URL('/v1/ws', window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('tenant_id', tenantId);
    this.connection = new WebSocket(url);
    this.connection.onopen = () => this.onopen?.();
    this.connection.onmessage = (event: MessageEvent<unknown>) =>
      this.onmessage?.({ data: event.data });
    this.connection.onclose = () => this.onclose?.();
    this.connection.onerror = () => this.onerror?.();
  }
  get readyState(): number {
    return this.connection.readyState;
  }
  send(data: string): void {
    this.connection.send(data);
  }
  close(): void {
    this.connection.close();
  }
}
