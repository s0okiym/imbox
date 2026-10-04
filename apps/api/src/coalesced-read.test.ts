import { expect, it, vi } from 'vitest';
import { coalescedRead } from './coalesced-read.js';
it('shares overlapping reads but rechecks authority on the next completed read', async () => {
  const read = coalescedRead<number>();
  let release!: (n: number) => void;
  const check = vi.fn(
    () =>
      new Promise<number>((resolve) => {
        release = resolve;
      }),
  );
  const first = read('same-session-stream-cursor', check),
    second = read('same-session-stream-cursor', check);
  await Promise.resolve();
  expect(check).toHaveBeenCalledTimes(1);
  release(1);
  expect(await Promise.all([first, second])).toEqual([1, 1]);
  await expect(
    read('same-session-stream-cursor', async () => {
      throw new Error('revoked');
    }),
  ).rejects.toThrow('revoked');
  expect(await read('same-session-stream-cursor', async () => 2)).toBe(2);
});
it('separates identities and bounds retained in-flight keys', async () => {
  const read = coalescedRead<number>(1);
  let release!: (n: number) => void;
  const first = read(
    'alice',
    () =>
      new Promise<number>((resolve) => {
        release = resolve;
      }),
  );
  expect(await read('bob', async () => 2)).toBe(2);
  expect(await read('bob', async () => 3)).toBe(3);
  release(1);
  expect(await first).toBe(1);
});
