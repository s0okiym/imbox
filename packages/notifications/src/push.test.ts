import { createECDH, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import webpush from 'web-push';
import {
  publicPushAddress,
  subscriptionCipher,
  validateSubscription,
  pushConfiguration,
} from './push.js';
const keys = () => {
  const pair = createECDH('prime256v1');
  pair.generateKeys();
  return {
    p256dh: pair.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  };
};
describe('Web Push subscription secrecy and endpoint policy', () => {
  it('encrypts at rest with randomized ciphertext and authenticates the complete device binding', () => {
    const cipher = subscriptionCipher({ encryptionKey: randomBytes(32).toString('base64url') }),
      subscription = { endpoint: 'https://fcm.googleapis.com/secret-subscription', keys: keys() };
    const sealed = cipher.seal(subscription, 'tenant/actor/session/device');
    expect(sealed).not.toContain('secret-subscription');
    expect(cipher.seal(subscription, 'tenant/actor/session/device')).not.toBe(sealed);
    expect(cipher.open(sealed, 'tenant/actor/session/device')).toEqual(subscription);
    expect(() => cipher.open(sealed, 'other/actor/session/device')).toThrow();
    const bytes = Buffer.from(sealed, 'base64url');
    bytes[29] = bytes[29]! ^ 1;
    expect(() => cipher.open(bytes.toString('base64url'), 'tenant/actor/session/device')).toThrow();
  });
  it('rejects unsafe endpoint forms and non-public DNS results', () => {
    const config = { hosts: ['fcm.googleapis.com'] },
      input = { endpoint: 'https://fcm.googleapis.com/push/id', keys: keys() };
    expect(() => validateSubscription(input, config)).not.toThrow();
    for (const endpoint of [
      'http://fcm.googleapis.com/x',
      'https://fcm.googleapis.com.evil.test/x',
      'https://fcm.googleapis.com:8443/x',
      'https://user@fcm.googleapis.com/x',
      'https://fcm.googleapis.com/x#fragment',
      'https://127.0.0.1/x',
    ])
      expect(() => validateSubscription({ ...input, endpoint }, config)).toThrow();
    for (const address of [
      '127.0.0.1',
      '10.1.1.1',
      '169.254.169.254',
      '100.64.1.2',
      '192.168.1.1',
      '172.16.1.1',
      '0.0.0.0',
      '224.1.1.1',
      '::ffff:127.0.0.1',
      'not-an-address',
    ])
      expect(publicPushAddress(address)).toBe(false);
    expect(publicPushAddress('8.8.8.8')).toBe(true);
  });
  it('requires complete configuration and generates encrypted VAPID protocol requests without disclosing plaintext', () => {
    expect(pushConfiguration({})).toBeUndefined();
    expect(() => pushConfiguration({ PUSH_VAPID_SUBJECT: 'mailto:ops@example.com' })).toThrow();
    const vapid = webpush.generateVAPIDKeys();
    const config = pushConfiguration({
      PUSH_ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
      PUSH_VAPID_PUBLIC_KEY: vapid.publicKey,
      PUSH_VAPID_PRIVATE_KEY: vapid.privateKey,
      PUSH_VAPID_SUBJECT: 'mailto:ops@example.com',
    })!;
    const request = webpush.generateRequestDetails(
      { endpoint: 'https://fcm.googleapis.com/push/fixture', keys: keys() },
      '你有新的待查看事项',
      {
        vapidDetails: {
          publicKey: config.publicKey,
          privateKey: config.privateKey,
          subject: config.subject,
        },
        TTL: 60,
        contentEncoding: 'aes128gcm',
      },
    );
    expect(request.method).toBe('POST');
    expect(request.headers['Content-Encoding']).toBe('aes128gcm');
    expect(request.body?.toString()).not.toContain('你有新的待查看事项');
    expect(request.headers['Authorization']).toMatch(/^vapid /);
  });
});
