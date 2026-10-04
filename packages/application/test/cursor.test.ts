import { describe, expect, it } from 'vitest';
import { CursorCodec } from '../src/common.js';

describe('opaque, authenticated cursor boundaries', () => {
  const codec = new CursorCodec('cursor-test-key-that-is-at-least-thirty-two-characters');
  it('round trips exact bigint positions without exposing position or authorization binding', () => {
    const position = '9007199254740993';
    const binding = 'tenant:alice:private-scope:epoch-4';
    const token = codec.encode(binding, position);
    expect(codec.decode(token, binding)).toBe(position);
    expect(Buffer.from(token.slice(3), 'base64url').toString()).not.toContain(binding);
    expect(Buffer.from(token.slice(3), 'base64url').toString()).not.toContain(position);
    expect(codec.encode(binding, position)).not.toBe(token);
  });
  it('rejects user/scope/generation changes, corruption and a different server secret', () => {
    const token = codec.encode('tenant:alice:scope:1', '12');
    for (const binding of ['tenant:bob:scope:1', 'tenant:alice:other:1', 'tenant:alice:scope:2'])
      expect(() => codec.decode(token, binding)).toThrow('RESYNC_REQUIRED');
    const bytes = Buffer.from(token.slice(3), 'base64url');
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    expect(() => codec.decode(`v1.${bytes.toString('base64url')}`, 'tenant:alice:scope:1')).toThrow(
      'RESYNC_REQUIRED',
    );
    const other = new CursorCodec('different-server-secret-for-cursor-tests-thirty-two');
    expect(() => other.decode(token, 'tenant:alice:scope:1')).toThrow('RESYNC_REQUIRED');
  });
});
