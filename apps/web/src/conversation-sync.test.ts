import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message, ProjectionEnvelope, StreamSnapshot } from '@imbox/contracts';
import { startConversationSync } from './conversation-sync.js';
import type { SyncApi, SyncCallbacks, SyncSocket } from './conversation-sync.js';
import { parseServerFrame, projectedMessage } from './sync-parser.js';

const view = {
  tenantId: 'tenant',
  principalId: 'alice',
  scopeId: 'conversation',
  authzGeneration: '1',
};
function envelope(overrides: Partial<ProjectionEnvelope> = {}): ProjectionEnvelope {
  const message: Message = {
    id: 'message',
    conversation_id: 'conversation',
    client_message_id: 'client-message',
    actor: { id: 'bob', kind: 'human', display_name: 'Bob', status: 'active' },
    version: '1',
    seq: '9007199254740993',
    body: '正文',
    format: 'text',
    attachment_ids: [],
    created_at: '2026-10-04T10:00:00Z',
    deleted: false,
    view_scope: 'conversation',
    authz_generation: '1',
    projection_id: 'message',
    projection_revision: '1',
  };
  return {
    type: 'projection.upsert',
    protocol_version: 1,
    schema_version: 1,
    stream_id: 'conversation',
    view_scope: 'conversation',
    authz_generation: '1',
    projection_id: 'message',
    projection_revision: '1',
    event_id: 'event',
    entity: { type: 'message', id: 'message', version: '1' },
    cursor: 'delivery-cursor',
    payload: { summary: '正文', message },
    ...overrides,
  };
}
function snapshot(overrides: Partial<StreamSnapshot> = {}): StreamSnapshot {
  return {
    stream_id: 'conversation',
    view_scope: 'conversation',
    authz_generation: '1',
    snapshot_id: 'snapshot',
    cursor: 'snapshot-head',
    items: [],
    complete: true,
    ...overrides,
  };
}
class Socket implements SyncSocket {
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: Array<Record<string, unknown>> = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.readyState = 3;
  }
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}
const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
});
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}
function harness(api?: Partial<SyncApi>) {
  const socket = new Socket();
  const callbacks: SyncCallbacks = {
    reset: vi.fn(),
    replace: vi.fn(),
    apply: vi.fn(),
    status: vi.fn(),
    accessLost: vi.fn(),
    unsupportedProjection: vi.fn(),
  };
  const openSocket = vi.fn(() => socket);
  const stop = startConversationSync({
    view,
    callbacks,
    openSocket,
    clientId: 'browser',
    retryMilliseconds: 10,
    api: {
      streamSnapshot: async () => snapshot(),
      streamEvents: async () => ({
        stream_id: 'conversation',
        view_scope: 'conversation',
        authz_generation: '1',
        items: [],
        cursor: 'after-poll',
        has_more: false,
      }),
      ...api,
    },
  });
  stops.push(stop);
  return { socket, callbacks, openSocket };
}
function subscribe(socket: Socket): void {
  socket.onopen?.();
  socket.receive({
    type: 'welcome',
    protocol_version: 1,
    connection_id: 'connection',
    heartbeat_seconds: 15,
  });
  socket.receive({
    type: 'subscribed',
    stream_id: 'conversation',
    authz_generation: '1',
    cursor: 'snapshot-head',
  });
}

describe('ordered snapshot and WebSocket synchronization', () => {
  it('preserves the recent snapshot history boundary for explicit older-message loading', async () => {
    const { callbacks } = harness({
      streamSnapshot: async () => snapshot({ window: 'recent', history_truncated: true }),
    });
    await flush();
    expect(callbacks.replace).toHaveBeenCalledWith(view, [], true);
  });

  it('does not expose a partial snapshot or subscribe before the last stable page', async () => {
    let finish: (value: StreamSnapshot) => void = () => {
      throw new Error('not initialized');
    };
    const second = new Promise<StreamSnapshot>((resolve) => {
      finish = resolve;
    });
    const api = vi.fn(async (_id: string, _signal: AbortSignal, cursor?: string) =>
      cursor === undefined
        ? snapshot({ items: [envelope()], next_cursor: 'next-page', complete: false })
        : second,
    );
    const { callbacks, openSocket } = harness({ streamSnapshot: api });
    await flush();
    expect(callbacks.replace).not.toHaveBeenCalled();
    expect(openSocket).not.toHaveBeenCalled();
    finish(snapshot());
    await flush();
    expect(callbacks.replace).toHaveBeenCalledWith(view, [envelope().payload.message], false);
    expect(openSocket).toHaveBeenCalledTimes(1);
  });

  it('ACKs only after applying the event and answers heartbeat without marking read', async () => {
    const { socket, callbacks } = harness();
    await flush();
    subscribe(socket);
    vi.mocked(callbacks.apply).mockImplementation(() => {
      expect(socket.sent.some((frame) => frame['type'] === 'ack')).toBe(false);
    });
    socket.receive(envelope());
    expect(callbacks.apply).toHaveBeenCalledWith(envelope().payload.message);
    expect(socket.sent.at(-1)).toEqual({
      type: 'ack',
      stream_id: 'conversation',
      cursor: 'delivery-cursor',
    });
    socket.receive({ type: 'ping', nonce: 'heartbeat' });
    expect(socket.sent.at(-1)).toEqual({ type: 'pong', nonce: 'heartbeat' });
  });

  it('clears the view before restarting snapshot on authorization resync', async () => {
    const { socket, callbacks } = harness();
    await flush();
    subscribe(socket);
    socket.receive({
      type: 'resync_required',
      stream_id: 'conversation',
      reason: 'authorization_changed',
    });
    expect(callbacks.reset).toHaveBeenCalledTimes(1);
    expect(socket.readyState).toBe(3);
    expect(socket.sent.some((frame) => frame['type'] === 'ack')).toBe(false);
  });

  it('stops and clears content on revoked access, without acknowledging the revocation as read', async () => {
    const { socket, callbacks } = harness();
    await flush();
    subscribe(socket);
    socket.receive({
      type: 'access_revoked',
      stream_id: 'conversation',
      reason: 'authorization_changed',
    });
    expect(callbacks.reset).toHaveBeenCalledTimes(1);
    expect(callbacks.accessLost).toHaveBeenCalledTimes(1);
    expect(socket.readyState).toBe(3);
  });

  it('uses the last applied opaque cursor for HTTP catchup after disconnect', async () => {
    vi.useFakeTimers();
    const streamEvents = vi.fn(async () => ({
      stream_id: 'conversation',
      view_scope: 'conversation',
      authz_generation: '1',
      items: [],
      cursor: 'catchup-head',
      has_more: false,
    }));
    const { socket } = harness({ streamEvents });
    await flush();
    subscribe(socket);
    socket.receive(envelope());
    socket.onclose?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(streamEvents).toHaveBeenCalledWith(
      'conversation',
      'delivery-cursor',
      expect.any(AbortSignal),
    );
  });

  it('closes a silently stalled socket after 45 seconds without server frames', async () => {
    vi.useFakeTimers();
    const { socket } = harness();
    await flush();
    subscribe(socket);
    await vi.advanceTimersByTimeAsync(44_999);
    expect(socket.readyState).toBe(1);
    socket.receive({ type: 'ping', nonce: 'still-alive' });
    await vi.advanceTimersByTimeAsync(44_999);
    expect(socket.readyState).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.readyState).toBe(3);
  });
});

describe('narrow browser projection parser', () => {
  it('accepts a valid long Unicode message above the smaller client control-frame limit', () => {
    const original = envelope();
    const frame = {
      ...original,
      payload: {
        summary: '🚀'.repeat(2_000),
        message: { ...original.payload.message, body: '🚀'.repeat(16_384) },
      },
    };
    const raw = JSON.stringify(frame);
    expect(new TextEncoder().encode(raw).byteLength).toBeGreaterThan(65_536);
    expect(parseServerFrame(raw)).toEqual(frame);
    expect(() => parseServerFrame(' '.repeat(262_145))).toThrow('INVALID_SYNC_FRAME');
  });
  it('never coerces malformed actor kinds, statuses or control reasons into valid strings', () => {
    const original = envelope();
    for (const field of ['kind', 'status']) {
      const actor = original.payload.message?.actor;
      const malformed = {
        ...original,
        payload: {
          ...original.payload,
          message: {
            ...original.payload.message,
            actor: { ...actor, [field]: [field === 'kind' ? 'human' : 'active'] },
          },
        },
      };
      expect(() => parseServerFrame(JSON.stringify(malformed))).toThrow('INVALID_SYNC_FRAME');
    }
    expect(() =>
      parseServerFrame(
        JSON.stringify({
          type: 'resync_required',
          stream_id: 'conversation',
          reason: ['cursor_expired'],
        }),
      ),
    ).toThrow('INVALID_SYNC_FRAME');
  });
  it('rejects unsupported schema and mismatched projection identities', () => {
    expect(() => parseServerFrame(JSON.stringify({ ...envelope(), schema_version: 2 }))).toThrow(
      'INVALID_SYNC_FRAME',
    );
    expect(() =>
      projectedMessage(envelope({ projection_id: 'another' }), 'conversation', '1'),
    ).toThrow('INCONSISTENT_VIEW');
    expect(() => projectedMessage(envelope(), 'conversation', '2')).toThrow('INCONSISTENT_VIEW');
  });
  it('removes body content whenever the authoritative envelope says remove', () => {
    const removed = projectedMessage(envelope({ type: 'projection.remove' }), 'conversation', '1');
    expect(removed?.deleted).toBe(true);
    expect(removed?.body).toBe('');
  });
});

describe('forward-compatible display projections', () => {
  const future = () => ({
    ...envelope(),
    entity: { type: 'future.card', id: 'future', version: '1' },
    payload: {
      summary: '<script>untrusted summary</script>',
      command: { type: 'approve', token: 'never expose' },
    },
  });
  it('acknowledges an unknown display entity without interpreting its payload and keeps receiving known messages', async () => {
    const { socket, callbacks } = harness();
    await flush();
    subscribe(socket);
    socket.receive(future());
    expect(callbacks.unsupportedProjection).toHaveBeenCalledExactlyOnceWith();
    expect(callbacks.apply).not.toHaveBeenCalled();
    expect(callbacks.reset).not.toHaveBeenCalled();
    expect(socket.sent.at(-1)).toEqual({
      type: 'ack',
      stream_id: 'conversation',
      cursor: 'delivery-cursor',
    });
    socket.receive(envelope({ cursor: 'next-known' }));
    expect(callbacks.apply).toHaveBeenCalledWith(envelope().payload.message);
    expect(socket.sent.at(-1)?.['cursor']).toBe('next-known');
    expect(
      socket.sent.every((frame) => ['hello', 'subscribe', 'ack'].includes(String(frame['type']))),
    ).toBe(true);
  });
  it('handles unknown snapshot entities without persisting their payload or restarting the snapshot', async () => {
    const api = vi.fn(async () =>
      snapshot({ items: [future() as unknown as ProjectionEnvelope, envelope()] }),
    );
    const { callbacks } = harness({ streamSnapshot: api });
    await flush();
    expect(api).toHaveBeenCalledTimes(1);
    expect(callbacks.replace).toHaveBeenCalledWith(view, [envelope().payload.message], false);
    expect(callbacks.unsupportedProjection).toHaveBeenCalledExactlyOnceWith();
  });
  it('counts summary length as Unicode characters like the wire schema', () => {
    const frame = { ...future(), payload: { summary: '😀'.repeat(4000) } };
    expect(parseServerFrame(JSON.stringify(frame))).toEqual(frame);
    expect(() =>
      parseServerFrame(JSON.stringify({ ...frame, payload: { summary: '😀'.repeat(4001) } })),
    ).toThrow('INVALID_SYNC_FRAME');
  });
  it('rejects unfamiliar control frames, incompatible versions, malformed known messages and scope mismatches', () => {
    for (const frame of [
      { type: 'action.execute', payload: { approved: true } },
      { ...future(), protocol_version: 2 },
      { ...future(), schema_version: 2 },
      { ...envelope(), payload: { summary: 'bad known message' } },
      { ...future(), payload: { summary: 'x'.repeat(4001) } },
    ])
      expect(() => parseServerFrame(JSON.stringify(frame))).toThrow('INVALID_SYNC_FRAME');
    expect(() =>
      projectedMessage(
        { ...future(), authz_generation: '2' } as unknown as ProjectionEnvelope,
        'conversation',
        '1',
      ),
    ).toThrow('INCONSISTENT_VIEW');
  });
});
