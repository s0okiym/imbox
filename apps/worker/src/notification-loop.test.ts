import { describe, expect, it, vi } from 'vitest';
import { runNotificationDispatchLoop } from './notification-loop.js';

describe('notification dispatcher pacing', () => {
  it('visits every tenant before draining another full batch and waits only once idle', async () => {
    const controller = new AbortController();
    const seen: string[] = [],
      waits: number[] = [];
    const cleanup = vi.fn(async () => {});
    await runNotificationDispatchLoop({
      tenants: ['busy', 'quiet'],
      signal: controller.signal,
      dispatch: async (tenant) => {
        seen.push(tenant);
        return { batch_full: seen.length === 1 };
      },
      cleanup,
      failed: () => {
        throw new Error('Unexpected dispatch failure');
      },
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        if (waits.length === 2) controller.abort();
      },
    });
    expect(seen).toEqual(['busy', 'quiet', 'busy', 'quiet']);
    expect(waits).toEqual([0, 250]);
    expect(cleanup.mock.calls).toEqual([['busy'], ['quiet']]);
  });
  it('backs off a failed round while still giving another tenant its bounded batch', async () => {
    const controller = new AbortController();
    const seen: string[] = [],
      waits: number[] = [];
    const failed = vi.fn();
    await runNotificationDispatchLoop({
      tenants: ['unavailable', 'busy'],
      signal: controller.signal,
      dispatch: async (tenant) => {
        seen.push(tenant);
        if (tenant === 'unavailable') throw new Error('unavailable');
        return { batch_full: true };
      },
      failed,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        controller.abort();
      },
    });
    expect(seen).toEqual(['unavailable', 'busy']);
    expect(failed).toHaveBeenCalledExactlyOnceWith('unavailable');
    expect(waits).toEqual([250]);
  });
  it('stops at the in-flight batch boundary without scheduling another tenant or cleanup', async () => {
    const controller = new AbortController();
    const dispatch = vi.fn(async () => {
      controller.abort();
      return { batch_full: true };
    });
    const cleanup = vi.fn(async () => {}),
      wait = vi.fn(async () => {});
    await runNotificationDispatchLoop({
      tenants: ['first', 'second'],
      signal: controller.signal,
      dispatch,
      cleanup,
      wait,
      failed: vi.fn(),
    });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith('first');
    expect(cleanup).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
  });
});
