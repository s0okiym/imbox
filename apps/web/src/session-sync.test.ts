import { describe, expect, it } from 'vitest';
import { isExternalSessionChange, sessionChange } from './session-sync.js';

describe('cross-tab session ownership', () => {
  it('ignores its own publication even after BroadcastChannel structured cloning', () => {
    const sourceId = 'current-tab';
    const deliveredMessage: unknown = structuredClone(sessionChange(sourceId));
    expect(isExternalSessionChange(deliveredMessage, sourceId)).toBe(false);
  });

  it('invalidates other tabs on the same login or logout publication', () => {
    const deliveredMessage: unknown = structuredClone(sessionChange('changing-tab'));
    expect(isExternalSessionChange(deliveredMessage, 'other-tab')).toBe(true);
  });

  it('ignores notifications without a valid session type and source ownership', () => {
    for (const value of [
      null,
      'invalidate',
      {},
      { type: 'session.invalidate' },
      { type: 'session.invalidate', sourceId: '' },
      { type: 'session.invalidate', sourceId: 123 },
      { type: 'unrelated', sourceId: 'other-tab' },
    ]) {
      expect(isExternalSessionChange(value, 'current-tab')).toBe(false);
    }
  });
});
