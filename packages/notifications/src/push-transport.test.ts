import { EventEmitter } from 'node:events';
import { createECDH, randomBytes } from 'node:crypto';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { beforeEach, expect, it, vi } from 'vitest';
import { createPushTransport } from './push.js';
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:https', () => ({ request: mocks.request }));
function fixture() {
  const server = createECDH('prime256v1');
  server.generateKeys();
  const client = createECDH('prime256v1');
  client.generateKeys();
  return {
    config: {
      encryptionKey: randomBytes(32).toString('base64url'),
      publicKey: server.getPublicKey().toString('base64url'),
      privateKey: Buffer.concat([
        Buffer.alloc(32 - server.getPrivateKey().length),
        server.getPrivateKey(),
      ]).toString('base64url'),
      subject: 'mailto:ops@example.com',
      hosts: ['fcm.googleapis.com'],
    },
    subscription: {
      endpoint: 'https://fcm.googleapis.com/push/fixture',
      keys: {
        p256dh: client.getPublicKey().toString('base64url'),
        auth: randomBytes(16).toString('base64url'),
      },
    },
  };
}
beforeEach(() => {
  mocks.lookup.mockReset();
  mocks.request.mockReset();
  mocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
});
it.each([
  [201, 'sent'],
  [410, 'subscription_invalid'],
  [404, 'subscription_invalid'],
  [429, 'retry'],
  [503, 'retry'],
  [307, 'discard'],
  [401, 'discard'],
] as const)(
  'classifies provider HTTP %s without redirect or response-body processing',
  async (status, outcome) => {
    const { config, subscription } = fixture();
    let authorized = false;
    mocks.request.mockImplementation(
      (_url, options, callback: (response: IncomingMessage) => void) => {
        expect(authorized).toBe(true);
        expect(options.agent).toBe(false);
        const resolved = vi.fn();
        options.lookup('fcm.googleapis.com', { all: true }, resolved);
        expect(resolved).toHaveBeenCalledWith(null, [{ address: '8.8.8.8', family: 4 }]);
        const req = new EventEmitter() as ClientRequest;
        req.end = (() => {
          callback(
            Object.assign(new EventEmitter(), {
              statusCode: status,
              destroy: vi.fn(),
            }) as unknown as IncomingMessage,
          );
          req.emit('close');
          return req;
        }) as ClientRequest['end'];
        return req;
      },
    );
    const result = await createPushTransport(config)(
      subscription,
      'generic hint',
      'topic',
      async () => {
        authorized = true;
        return true;
      },
    );
    expect(result).toBe(outcome);
    expect(mocks.request).toHaveBeenCalledTimes(1);
  },
);
it('blocks mixed private DNS answers and revoked authority before starting HTTP', async () => {
  const { config, subscription } = fixture(),
    current = vi.fn(async () => true);
  mocks.lookup.mockResolvedValue([
    { address: '8.8.8.8', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ]);
  expect(await createPushTransport(config)(subscription, 'generic', 'topic', current)).toBe(
    'discard',
  );
  expect(current).not.toHaveBeenCalled();
  expect(mocks.request).not.toHaveBeenCalled();
  mocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  expect(
    await createPushTransport(config)(subscription, 'generic', 'topic', async () => false),
  ).toBe('discard');
  expect(mocks.request).not.toHaveBeenCalled();
});
