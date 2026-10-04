import { describe, expect, it } from 'vitest';
import { quietAt, validateTimeZone } from './service.js';
describe('IANA do-not-disturb wall clock windows', () => {
  it('covers both fall-back hours and skips nonexistent spring wall times', () => {
    const dnd = { enabled: true, time_zone: 'America/New_York', start: '01:00', end: '03:00' };
    expect(quietAt(dnd, new Date('2026-11-01T05:30:00Z'))).toBe(true);
    expect(quietAt(dnd, new Date('2026-11-01T06:30:00Z'))).toBe(true);
    expect(quietAt(dnd, new Date('2026-03-08T06:30:00Z'))).toBe(true);
    expect(quietAt(dnd, new Date('2026-03-08T07:30:00Z'))).toBe(false);
  });
  it('defines overnight, end-exclusive, all-day and disabled windows', () => {
    const dnd = { enabled: true, time_zone: 'UTC', start: '22:00', end: '08:00' };
    expect(quietAt(dnd, new Date('2026-01-01T23:00:00Z'))).toBe(true);
    expect(quietAt(dnd, new Date('2026-01-01T08:00:00Z'))).toBe(false);
    expect(quietAt({ ...dnd, end: '22:00' }, new Date())).toBe(true);
    expect(quietAt({ ...dnd, enabled: false }, new Date('2026-01-01T23:00:00Z'))).toBe(false);
  });
  it('rejects unknown zones and malformed clocks', () => {
    expect(() => validateTimeZone('Planet/Not-A-Zone')).toThrow();
    expect(() =>
      quietAt({ enabled: true, time_zone: 'UTC', start: '24:01', end: '08:00' }, new Date()),
    ).toThrow();
  });
});
