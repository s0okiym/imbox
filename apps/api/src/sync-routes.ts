import { createHash, randomUUID } from 'node:crypto';
import { coalescedRead } from './coalesced-read.js';
import websocket from '@fastify/websocket';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticationInput, AuthError, type IdentityService } from '@imbox/auth';
import { assertContract, parseContract, schemas, type ContractTypes } from '@imbox/contracts';
import { ApplicationError, type SyncService } from '@imbox/application';

interface Subscription {
  cursor: string;
  pending: string[];
  lastAck?: string;
}
const querySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    cursor: { type: 'string', maxLength: 4096 },
    limit: { type: 'string', pattern: '^[1-9][0-9]{0,2}$' },
  },
};
function page(request: FastifyRequest) {
  const input = request.query as { cursor?: string; limit?: string };
  return assertContract('PaginationQuery', {
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(input.limit ? { limit: Number(input.limit) } : {}),
  });
}
function streamId(request: FastifyRequest) {
  return assertContract('Identifier', (request.params as { id: string }).id);
}

export async function registerSyncRoutes(
  app: FastifyInstance,
  options: {
    identity: IdentityService;
    sync: SyncService;
    pollIntervalMs?: number;
    maxBufferedBytes?: number;
    maxPendingAcks?: number;
  },
): Promise<void> {
  const { identity, sync } = options;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const maxBufferedBytes = options.maxBufferedBytes ?? 1_048_576;
  const maxPendingAcks = options.maxPendingAcks ?? 256;
  if (
    pollIntervalMs < 10 ||
    pollIntervalMs > 30_000 ||
    maxBufferedBytes < 1024 ||
    maxPendingAcks < 1
  )
    throw new Error('Invalid websocket bounds');
  const authenticateOnce = coalescedRead<Awaited<ReturnType<IdentityService['authenticate']>>>();
  const eventsOnce = coalescedRead<Awaited<ReturnType<SyncService['events']>>>();
  const pollers = new Set<() => Promise<void>>();
  // A common tick lets identical in-flight reads share work without caching an authorization result.
  const pollTimer = setInterval(() => {
    for (const poll of pollers) void poll();
  }, pollIntervalMs);
  pollTimer.unref();
  app.addHook('onClose', async () => {
    clearInterval(pollTimer);
    pollers.clear();
  });
  app.get(
    '/v1/streams/:id/snapshot',
    {
      schema: {
        params: schemas.ResourceParams,
        querystring: {
          ...querySchema,
          properties: { ...querySchema.properties, window: { type: 'string', const: 'recent' } },
        },
        response: { 200: schemas.StreamSnapshot },
      },
    },
    async (request) =>
      sync.snapshot(await identity.authenticate(authenticationInput(request)), streamId(request), {
        ...page(request),
        ...((request.query as { window?: string }).window === 'recent'
          ? { window: 'recent' as const }
          : {}),
      }),
  );
  app.get(
    '/v1/streams/:id/events',
    {
      schema: {
        params: schemas.ResourceParams,
        querystring: { ...querySchema, required: ['cursor'] },
        response: { 200: schemas.StreamEvents },
      },
    },
    async (request) => {
      const query = page(request);
      if (!query.cursor) throw new ApplicationError('VALIDATION_FAILED', 400);
      return sync.events(
        await identity.authenticate(authenticationInput(request)),
        streamId(request),
        { ...query, cursor: query.cursor },
      );
    },
  );
  await app.register(websocket, { options: { maxPayload: 65_536, perMessageDeflate: false } });
  app.get(
    '/v1/ws',
    {
      websocket: true,
      schema: {
        querystring: {
          type: 'object',
          required: ['tenant_id'],
          additionalProperties: false,
          properties: { tenant_id: { type: 'string', format: 'uuid' } },
        },
      },
      preValidation: async (request) => {
        if (request.headers.origin !== identity.publicOrigin)
          throw new AuthError('ORIGIN_REJECTED', 403, 'Request origin is not allowed');
        const tenantId = (request.query as { tenant_id: string }).tenant_id;
        await identity.authenticate({ ...authenticationInput(request), tenantId });
      },
    },
    (socket, request) => {
      const tenantId = (request.query as { tenant_id: string }).tenant_id;
      const subscriptions = new Map<string, Subscription>();
      let ready = false;
      let closed = false;
      let busy = false;
      let pendingFrames = 0;
      let inputChain = Promise.resolve();
      let lastHeartbeat = Date.now();
      const authInput = { ...authenticationInput(request), tenantId };
      const authKey = createHash('sha256').update(JSON.stringify(authInput)).digest('hex');
      const refreshAuth = () => authenticateOnce(authKey, () => identity.authenticate(authInput));
      function close(code: number, reason: string) {
        if (!closed) {
          closed = true;
          socket.close(code, reason);
        }
      }
      function control(
        id: string,
        type: 'access_revoked' | 'resync_required',
        reason: ContractTypes['WsControl']['reason'],
      ) {
        if (socket.readyState === 1)
          socket.send(JSON.stringify(assertContract('WsControl', { type, stream_id: id, reason })));
      }
      function send(frame: ContractTypes['WsServerFrame']): boolean {
        if (closed || socket.readyState !== 1) return false;
        const encoded = JSON.stringify(assertContract('WsServerFrame', frame));
        if (socket.bufferedAmount + Buffer.byteLength(encoded) > maxBufferedBytes) {
          for (const id of subscriptions.keys()) control(id, 'resync_required', 'slow_consumer');
          close(1013, 'Slow consumer');
          return false;
        }
        socket.send(encoded);
        return true;
      }
      async function tick(): Promise<void> {
        if (!ready || closed || busy) return;
        busy = true;
        try {
          const auth = await refreshAuth();
          for (const [id, subscription] of subscriptions) {
            if (closed) break;
            if (subscription.pending.length >= maxPendingAcks) {
              control(id, 'resync_required', 'slow_consumer');
              close(1013, 'Acknowledgement window exceeded');
              break;
            }
            try {
              const query = {
                cursor: subscription.cursor,
                limit: Math.min(100, maxPendingAcks - subscription.pending.length),
              };
              const result = await eventsOnce(JSON.stringify([auth, id, query]), () =>
                sync.events(auth, id, query),
              );
              for (const item of result.items) {
                if (!send(item)) break;
                subscription.pending.push(item.cursor);
              }
              if (!closed) subscription.cursor = result.cursor;
            } catch (error) {
              if (error instanceof ApplicationError && error.code === 'RESYNC_REQUIRED')
                control(id, 'resync_required', 'authorization_changed');
              else if (
                error instanceof ApplicationError &&
                ['NOT_FOUND', 'FORBIDDEN'].includes(error.code)
              )
                control(id, 'access_revoked', 'authorization_changed');
              else throw error;
              subscriptions.delete(id);
            }
          }
        } catch (error) {
          if (error instanceof AuthError)
            for (const id of subscriptions.keys())
              control(id, 'access_revoked', 'authorization_changed');
          close(
            error instanceof AuthError ? 1008 : 1011,
            error instanceof AuthError ? 'Session no longer valid' : 'Synchronization unavailable',
          );
        } finally {
          busy = false;
        }
      }
      const helloDeadline = setTimeout(() => {
        if (!ready) close(1008, 'hello required');
      }, 5000);
      pollers.add(tick);
      const heartbeat = setInterval(() => {
        if (Date.now() - lastHeartbeat > 45_000) {
          close(1008, 'Heartbeat timeout');
          return;
        }
        if (ready) send({ type: 'ping', nonce: randomUUID() });
      }, 15_000);
      socket.on('close', () => {
        closed = true;
        clearTimeout(helloDeadline);
        pollers.delete(tick);
        clearInterval(heartbeat);
        subscriptions.clear();
      });
      socket.on('error', () => close(1011, 'Websocket error'));
      // Install listeners synchronously; queued frame handlers are bounded and serialized.
      socket.on('message', (raw, binary) => {
        if (closed) return;
        if (binary || ++pendingFrames > 32) {
          close(1008, 'Invalid or excessive frames');
          return;
        }
        inputChain = inputChain
          .then(async () => {
            const parsed = parseContract('WsClientFrame', raw.toString());
            if (!parsed.ok) {
              close(1008, 'Invalid frame');
              return;
            }
            const frame = parsed.value;
            if (!ready) {
              if (frame.type !== 'hello') {
                close(1008, 'hello required');
                return;
              }
              ready = true;
              clearTimeout(helloDeadline);
              send({
                type: 'welcome',
                protocol_version: 1,
                connection_id: randomUUID(),
                heartbeat_seconds: 15,
              });
              return;
            }
            if (frame.type === 'hello') {
              close(1008, 'Duplicate hello');
              return;
            }
            if (frame.type === 'ping' || frame.type === 'pong') {
              lastHeartbeat = Date.now();
              if (frame.type === 'ping') send({ type: 'pong', nonce: frame.nonce });
              return;
            }
            if (frame.type === 'subscribe') {
              const auth = await refreshAuth();
              if (!frame.cursor) {
                control(frame.stream_id, 'resync_required', 'cursor_expired');
                return;
              }
              if (subscriptions.size >= 32 && !subscriptions.has(frame.stream_id)) {
                close(1008, 'Subscription limit exceeded');
                return;
              }
              try {
                const response = await sync.subscribe(auth, frame.stream_id, frame.cursor);
                subscriptions.set(frame.stream_id, {
                  cursor: frame.cursor,
                  pending: [],
                  lastAck: frame.cursor,
                });
                send(response);
              } catch (error) {
                if (
                  error instanceof ApplicationError &&
                  ['RESYNC_REQUIRED', 'NOT_FOUND', 'FORBIDDEN'].includes(error.code)
                ) {
                  control(
                    frame.stream_id,
                    error.code === 'RESYNC_REQUIRED' ? 'resync_required' : 'access_revoked',
                    'authorization_changed',
                  );
                  return;
                }
                throw error;
              }
            } else if (frame.type === 'ack') {
              const subscription = subscriptions.get(frame.stream_id);
              if (!subscription) {
                close(1008, 'Unknown subscription');
                return;
              }
              // ACK only releases this socket's already-delivered transport window.
              // It grants no read permission and never advances a user's read cursor.
              // Fresh authorization remains mandatory on every subscribe and delivery tick.
              if (frame.cursor === subscription.lastAck) return;
              const index = subscription.pending.indexOf(frame.cursor);
              if (index === -1) {
                close(1008, 'ACK must refer to a delivered cursor');
                return;
              }
              subscription.pending.splice(0, index + 1);
              subscription.lastAck = frame.cursor;
              // Transport acknowledgement deliberately never modifies read_cursors.
            }
          })
          .catch((error: unknown) => {
            const denied =
              error instanceof AuthError ||
              (error instanceof ApplicationError &&
                ['RESYNC_REQUIRED', 'NOT_FOUND', 'FORBIDDEN'].includes(error.code));
            close(
              denied ? 1008 : 1011,
              denied ? 'Invalid or unauthorized frame' : 'Synchronization unavailable',
            );
          })
          .finally(() => {
            pendingFrames--;
          });
      });
    },
  );
}
