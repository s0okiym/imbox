import { createCipheriv, createDecipheriv, createHmac, randomBytes, ECDH } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request } from 'node:https';
import webpush from 'web-push';
export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
export interface PushConfiguration {
  encryptionKey: string;
  publicKey: string;
  privateKey: string;
  subject: string;
  hosts: readonly string[];
}
export function pushConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): PushConfiguration | undefined {
  const names = [
    'PUSH_ENCRYPTION_KEY',
    'PUSH_VAPID_PUBLIC_KEY',
    'PUSH_VAPID_PRIVATE_KEY',
    'PUSH_VAPID_SUBJECT',
  ] as const;
  if (names.every((name) => !env[name])) return undefined;
  if (names.some((name) => !env[name]))
    throw new Error('All PUSH configuration values are required');
  const result = {
    encryptionKey: env['PUSH_ENCRYPTION_KEY']!,
    publicKey: env['PUSH_VAPID_PUBLIC_KEY']!,
    privateKey: env['PUSH_VAPID_PRIVATE_KEY']!,
    subject: env['PUSH_VAPID_SUBJECT']!,
    hosts: (
      env['PUSH_ALLOWED_HOSTS'] ??
      'fcm.googleapis.com,updates.push.services.mozilla.com,web.push.apple.com'
    ).split(','),
  };
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(result.encryptionKey) ||
    Buffer.from(result.encryptionKey, 'base64url').length !== 32
  )
    throw new Error('PUSH_ENCRYPTION_KEY must be a 32-byte base64url key');
  if (
    !result.hosts.length ||
    result.hosts.some((host) => !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(host))
  )
    throw new Error('PUSH_ALLOWED_HOSTS must contain exact DNS names');
  webpush.getVapidHeaders(
    'https://push.example',
    result.subject,
    result.publicKey,
    result.privateKey,
    'aes128gcm',
  );
  return result;
}
export function validateSubscription(
  input: PushSubscriptionInput,
  config: Pick<PushConfiguration, 'hosts'>,
) {
  const endpoint = new URL(input.endpoint);
  if (
    input.endpoint.length > 2048 ||
    endpoint.protocol !== 'https:' ||
    endpoint.port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    !config.hosts.includes(endpoint.hostname)
  )
    throw new Error('Invalid push endpoint');
  if (
    !/^[A-Za-z0-9_-]{87}$/.test(input.keys.p256dh) ||
    Buffer.from(input.keys.p256dh, 'base64url').length !== 65 ||
    Buffer.from(input.keys.p256dh, 'base64url')[0] !== 4 ||
    !/^[A-Za-z0-9_-]{22}$/.test(input.keys.auth)
  )
    throw new Error('Invalid push keys');
  ECDH.convertKey(Buffer.from(input.keys.p256dh, 'base64url'), 'prime256v1');
}
export function subscriptionCipher(config: Pick<PushConfiguration, 'encryptionKey'>) {
  const key = Buffer.from(config.encryptionKey, 'base64url');
  if (key.length !== 32) throw new Error('Invalid push encryption key');
  return {
    fingerprint: (endpoint: string) => createHmac('sha256', key).update(endpoint).digest('hex'),
    seal(subscription: PushSubscriptionInput, binding: string) {
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(binding));
      const bytes = Buffer.concat([cipher.update(JSON.stringify(subscription)), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64url');
    },
    open(value: string, binding: string): PushSubscriptionInput {
      const bytes = Buffer.from(value, 'base64url'),
        decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(binding));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(
        Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(),
      ) as PushSubscriptionInput;
    },
  };
}
const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(network, prefix, 'ipv4');
export function publicPushAddress(address: string) {
  return isIP(address) === 4 && !blocked.check(address, 'ipv4');
}
export type PushOutcome = 'sent' | 'retry' | 'subscription_invalid' | 'discard';
export type PushTransport = (
  subscription: PushSubscriptionInput,
  payload: string,
  topic: string,
  current: () => Promise<boolean>,
) => Promise<PushOutcome>;
/** Exact provider allowlist, public IPv4 resolution pinned to the TLS connection, no redirect or response logging. */
export function createPushTransport(config: PushConfiguration): PushTransport {
  return async (subscription, payload, topic, current) => {
    validateSubscription(subscription, config);
    const endpoint = new URL(subscription.endpoint);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const records = await Promise.race([
        lookup(endpoint.hostname, { all: true, family: 4 }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Push DNS deadline')), 2000);
        }),
      ]);
      if (!records.length || records.some((row) => !publicPushAddress(row.address)))
        return 'discard';
      const details = webpush.generateRequestDetails(subscription, payload, {
        vapidDetails: {
          subject: config.subject,
          publicKey: config.publicKey,
          privateKey: config.privateKey,
        },
        TTL: 60,
        urgency: 'normal',
        topic,
        contentEncoding: 'aes128gcm',
      });
      if (!(await current())) return 'discard';
      return await new Promise<PushOutcome>((resolve) => {
        const req = request(
          endpoint,
          {
            method: 'POST',
            headers: details.headers,
            agent: false,
            lookup: (_hostname, options, callback) => {
              if (options.all) callback(null, [{ address: records[0]!.address, family: 4 }]);
              else callback(null, records[0]!.address, 4);
            },
          },
          (res) => {
            const status = res.statusCode ?? 0;
            res.destroy();
            resolve(
              status >= 200 && status < 300
                ? 'sent'
                : status === 404 || status === 410
                  ? 'subscription_invalid'
                  : status === 429 || status >= 500
                    ? 'retry'
                    : 'discard',
            );
          },
        );
        const deadline = setTimeout(() => req.destroy(new Error('Push deadline')), 5000);
        req.on('error', () => resolve('retry'));
        req.on('close', () => clearTimeout(deadline));
        req.end(details.body);
      });
    } catch {
      return 'retry';
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
