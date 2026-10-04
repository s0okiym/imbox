import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export function opaqueToken(): string {
  return randomBytes(32).toString('base64url');
}
export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createSecrets(secret: string) {
  if (Buffer.byteLength(secret) < 32 || secret.startsWith('replace-with-'))
    throw new Error('Session secret must be a configured random value of at least 32 bytes');
  const hmacKey = Buffer.from(hkdfSync('sha256', secret, 'imbox-auth-v1', 'session-hashes', 32));
  const encryptionKey = Buffer.from(
    hkdfSync('sha256', secret, 'imbox-auth-v1', 'oidc-attempt-context', 32),
  );
  const keyedHash = (purpose: string, value: string) =>
    createHmac('sha256', hmacKey).update(`${purpose}\0${value}`).digest('hex');
  return {
    sessionHash: (value: string) => keyedHash('session', value),
    csrfToken: (value: string) => keyedHash('csrf', value),
    encrypt(value: unknown): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
      cipher.setAAD(Buffer.from('imbox:oidc-attempt:v1'));
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(value), 'utf8'),
        cipher.final(),
      ]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
    },
    decrypt(value: string): unknown {
      const encrypted = Buffer.from(value, 'base64url');
      if (encrypted.length < 29) throw new Error('Invalid encrypted context');
      const decipher = createDecipheriv('aes-256-gcm', encryptionKey, encrypted.subarray(0, 12));
      decipher.setAAD(Buffer.from('imbox:oidc-attempt:v1'));
      decipher.setAuthTag(encrypted.subarray(12, 28));
      return JSON.parse(
        Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString('utf8'),
      ) as unknown;
    },
  };
}
