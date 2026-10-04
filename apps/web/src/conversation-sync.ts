import type {
  ProjectionEnvelope,
  StreamEvents,
  StreamSnapshot,
  WsClientFrame,
} from '@imbox/contracts';
import type { ChatMessage } from './api.js';
import { ApiError, isAccessLoss } from './api.js';
import { applyMessageMutation, compareDecimal } from './message-state.js';
import type { MessageSnapshot, ViewIdentity } from './message-state.js';
import { parseServerFrame, projectedMessage } from './sync-parser.js';

export type SyncStatus = 'loading' | 'live' | 'fallback' | 'reconnecting';
export interface SyncApi {
  streamSnapshot(id: string, signal: AbortSignal, cursor?: string): Promise<StreamSnapshot>;
  streamEvents(id: string, cursor: string, signal: AbortSignal): Promise<StreamEvents>;
}
export interface SyncSocket {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}
export interface SyncCallbacks {
  reset(): void;
  replace(view: ViewIdentity, messages: readonly ChatMessage[], truncated: boolean): void;
  apply(message: ChatMessage): void;
  status(status: SyncStatus): void;
  accessLost(error: unknown): void;
}
export interface SyncOptions {
  readonly api: SyncApi;
  readonly view: ViewIdentity;
  readonly callbacks: SyncCallbacks;
  readonly openSocket: () => SyncSocket;
  readonly clientId: string;
  readonly retryMilliseconds?: number;
}

/** One ordered delivery source at a time. Its cursor exists only for this memory view. */
export function startConversationSync(options: SyncOptions): () => void {
  const { api, callbacks } = options;
  const retryMilliseconds = options.retryMilliseconds ?? 2_000;
  let stopped = false;
  let epoch = 0;
  let controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let socket: SyncSocket | null = null;
  let cursor: string | null = null;
  let generation = options.view.authzGeneration;
  let nextSocketAttempt = 0;
  let connectionFailures = 0;
  const schedule = (work: () => void, delay = retryMilliseconds): void => {
    if (timer !== undefined) clearTimeout(timer);
    if (!stopped) timer = setTimeout(work, delay);
  };
  const disconnect = (): void => {
    if (deadline !== undefined) clearTimeout(deadline);
    const old = socket;
    socket = null;
    if (old !== null) {
      old.onopen = null;
      old.onmessage = null;
      old.onclose = null;
      old.onerror = null;
      old.close();
    }
  };
  const stop = (): void => {
    stopped = true;
    epoch += 1;
    controller.abort();
    if (timer !== undefined) clearTimeout(timer);
    disconnect();
  };
  const lost = (error: unknown): void => {
    callbacks.reset();
    stop();
    callbacks.accessLost(error);
  };
  const resnapshot = (delay = 0): void => {
    epoch += 1;
    controller.abort();
    controller = new AbortController();
    disconnect();
    cursor = null;
    callbacks.reset();
    callbacks.status('loading');
    schedule(() => {
      void bootstrap();
    }, delay);
  };
  const recover = (error: unknown): void => {
    if (isAccessLoss(error)) {
      lost(error);
      return;
    }
    if (
      (error instanceof ApiError && error.code === 'RESYNC_REQUIRED') ||
      (error instanceof Error &&
        ['INCONSISTENT_VIEW', 'INVALID_SYNC_FRAME'].includes(error.message))
    ) {
      resnapshot(retryMilliseconds);
      return;
    }
    callbacks.status('reconnecting');
    schedule(() => {
      void (cursor === null ? bootstrap() : fallback());
    });
  };
  const consume = (envelope: ProjectionEnvelope): void => {
    const message = projectedMessage(envelope, options.view.scopeId, generation);
    if (message !== null) callbacks.apply(message);
    // The application updated its in-memory view synchronously before this cursor advances.
    cursor = envelope.cursor;
  };

  async function bootstrap(): Promise<void> {
    const activeEpoch = epoch;
    try {
      let next: string | undefined;
      let identity: { id: string; head: string; generation: string } | null = null;
      let snapshot: MessageSnapshot | null = null;
      let truncated = false;
      const visited = new Set<string>();
      do {
        const page = await api.streamSnapshot(options.view.scopeId, controller.signal, next);
        if (stopped || activeEpoch !== epoch) return;
        truncated ||= page.history_truncated === true;
        if (
          page.stream_id !== options.view.scopeId ||
          page.view_scope !== options.view.scopeId ||
          compareDecimal(page.authz_generation, options.view.authzGeneration) < 0
        )
          throw new Error('INCONSISTENT_VIEW');
        identity ??= { id: page.snapshot_id, head: page.cursor, generation: page.authz_generation };
        if (
          identity.id !== page.snapshot_id ||
          identity.head !== page.cursor ||
          identity.generation !== page.authz_generation
        )
          throw new Error('INCONSISTENT_VIEW');
        snapshot ??= {
          view: { ...options.view, authzGeneration: page.authz_generation },
          messages: [],
        };
        for (const envelope of page.items) {
          const message = projectedMessage(envelope, options.view.scopeId, page.authz_generation);
          if (message !== null) snapshot = applyMessageMutation(snapshot, message);
        }
        if (snapshot.messages.length > 1_000) {
          truncated = true;
          snapshot = { ...snapshot, messages: snapshot.messages.slice(-1_000) };
        }
        next = page.next_cursor;
        if (page.complete !== (next === undefined) || (next !== undefined && visited.has(next)))
          throw new Error('INVALID_SYNC_FRAME');
        if (next !== undefined) visited.add(next);
      } while (next !== undefined);
      if (identity === null || snapshot === null) throw new Error('INVALID_SYNC_FRAME');
      generation = identity.generation;
      callbacks.replace(snapshot.view, snapshot.messages, truncated);
      cursor = identity.head;
      connect();
    } catch (error: unknown) {
      if (!stopped && activeEpoch === epoch && !controller.signal.aborted) recover(error);
    }
  }

  async function fallback(): Promise<void> {
    if (stopped || cursor === null || socket !== null) return;
    const activeEpoch = epoch;
    try {
      // Fetch before trying WS again, so only one source can ever advance the opaque cursor.
      for (let batch = 0; batch < 20; batch += 1) {
        const page = await api.streamEvents(options.view.scopeId, cursor, controller.signal);
        if (stopped || activeEpoch !== epoch) return;
        if (
          page.stream_id !== options.view.scopeId ||
          page.view_scope !== options.view.scopeId ||
          page.authz_generation !== generation
        )
          throw new Error('INCONSISTENT_VIEW');
        for (const envelope of page.items) consume(envelope);
        cursor = page.cursor;
        if (!page.has_more) break;
      }
      callbacks.status('fallback');
      if (Date.now() >= nextSocketAttempt) connect();
      else
        schedule(() => {
          void fallback();
        });
    } catch (error: unknown) {
      if (!stopped && activeEpoch === epoch && !controller.signal.aborted) recover(error);
    }
  }

  function connect(): void {
    if (stopped || cursor === null || socket !== null) return;
    let connection: SyncSocket;
    try {
      connection = options.openSocket();
    } catch (error: unknown) {
      recover(error);
      return;
    }
    socket = connection;
    let welcomed = false;
    let subscribed = false;
    const send = (frame: WsClientFrame): void => {
      if (socket === connection && connection.readyState === 1)
        connection.send(JSON.stringify(frame));
    };
    const failed = (): void => {
      if (socket !== connection || stopped) return;
      disconnect();
      connectionFailures += 1;
      nextSocketAttempt =
        Date.now() + Math.min(30_000, retryMilliseconds * 2 ** Math.min(connectionFailures - 1, 4));
      callbacks.status('reconnecting');
      schedule(() => {
        void fallback();
      }, 0);
    };
    const armLiveness = (): void => {
      if (deadline !== undefined) clearTimeout(deadline);
      deadline = setTimeout(failed, 45_000);
    };
    deadline = setTimeout(failed, 8_000);
    connection.onopen = () =>
      send({ type: 'hello', protocol_version: 1, client_id: options.clientId });
    connection.onclose = failed;
    connection.onerror = failed;
    connection.onmessage = (event) => {
      if (stopped || socket !== connection) return;
      try {
        const frame = parseServerFrame(event.data);
        if (subscribed) armLiveness();
        if (frame.type === 'ping') {
          send({ type: 'pong', nonce: frame.nonce });
          return;
        }
        if (frame.type === 'pong') return;
        if (frame.type === 'welcome') {
          if (welcomed || cursor === null) throw new Error('INVALID_SYNC_FRAME');
          welcomed = true;
          send({ type: 'subscribe', stream_id: options.view.scopeId, cursor });
          return;
        }
        if (!welcomed || !('stream_id' in frame) || frame.stream_id !== options.view.scopeId)
          throw new Error('INCONSISTENT_VIEW');
        if (frame.type === 'access_revoked') {
          lost(new ApiError(403, 'FORBIDDEN', 'Access revoked'));
          return;
        }
        if (frame.type === 'resync_required') {
          resnapshot();
          return;
        }
        if (frame.type === 'subscribed') {
          if (frame.authz_generation !== generation || frame.cursor !== cursor)
            throw new Error('INCONSISTENT_VIEW');
          subscribed = true;
          connectionFailures = 0;
          armLiveness();
          callbacks.status('live');
          return;
        }
        if (
          !subscribed ||
          (frame.type !== 'projection.upsert' && frame.type !== 'projection.remove')
        )
          throw new Error('INVALID_SYNC_FRAME');
        consume(frame);
        send({ type: 'ack', stream_id: frame.stream_id, cursor: frame.cursor });
      } catch (error: unknown) {
        disconnect();
        recover(error);
      }
    };
  }

  callbacks.status('loading');
  void bootstrap();
  return stop;
}
