import { describe, expect, it } from 'vitest';
import {
  assertTimeZone,
  dueOccurrences,
  localOccurrence,
  nextOccurrence,
  type CalendarSpec,
} from './calendar.js';

describe('IANA daily calendar', () => {
  it('skips the New York spring gap and selects only the first fall-fold instant', () => {
    expect(localOccurrence('2026-03-08', '02:30', 'America/New_York')).toBeNull();
    expect(localOccurrence('2026-11-01', '01:30', 'America/New_York')?.toISOString()).toBe(
      '2026-11-01T05:30:00.000Z',
    );
    const spec: CalendarSpec = {
      timezone: 'America/New_York',
      trigger: { kind: 'daily', local_time: '01:30' },
      start_at: '2026-11-01T00:00:00Z',
      deadline: '2026-11-04T00:00:00Z',
    };
    expect(nextOccurrence(spec, new Date('2026-11-01T05:30:00.001Z'))?.toISOString()).toBe(
      '2026-11-02T06:30:00.000Z',
    );
  });
  it('handles half-hour DST and a skipped civil date without coercing nonexistent wall times', () => {
    expect(localOccurrence('2026-10-04', '02:15', 'Australia/Lord_Howe')).toBeNull();
    expect(localOccurrence('2026-04-05', '01:45', 'Australia/Lord_Howe')?.toISOString()).toBe(
      '2026-04-04T14:45:00.000Z',
    );
    expect(localOccurrence('2011-12-30', '09:00', 'Pacific/Apia')).toBeNull();
  });
  it('coalesces several due days once, while skip advances the persisted cursor without catch-up', () => {
    const spec: CalendarSpec = {
      timezone: 'Asia/Shanghai',
      trigger: { kind: 'daily', local_time: '09:00' },
      start_at: '2026-03-06T00:00:00Z',
      deadline: '2026-03-10T00:00:00Z',
    };
    const start = new Date('2026-03-06T01:00:00Z'),
      now = new Date('2026-03-08T01:01:01Z');
    expect(dueOccurrences(spec, start, now, 'coalesce')).toEqual({
      selected: new Date('2026-03-08T01:00:00Z'),
      next: new Date('2026-03-09T01:00:00Z'),
      missed_count: 2,
    });
    expect(dueOccurrences(spec, start, now, 'skip')).toEqual({
      selected: null,
      next: new Date('2026-03-09T01:00:00Z'),
      missed_count: 3,
    });
  });
  it('uses inclusive start and an exclusive absolute deadline for one-off and daily schedules', () => {
    const spec: CalendarSpec = {
      timezone: 'UTC',
      trigger: { kind: 'once' },
      start_at: '2026-04-01T01:00:00Z',
      deadline: '2026-04-01T02:00:00Z',
    };
    expect(nextOccurrence(spec, new Date(spec.start_at))?.toISOString()).toBe(
      '2026-04-01T01:00:00.000Z',
    );
    expect(nextOccurrence(spec, new Date('2026-04-01T01:00:00.001Z'))).toBeNull();
    expect(
      nextOccurrence(
        { ...spec, trigger: { kind: 'daily', local_time: '02:00' } },
        new Date(spec.start_at),
      ),
    ).toBeNull();
  });
  it('rejects numeric offsets and invalid zones or local times', () => {
    for (const zone of ['+08:00', 'Invalid/Timezone', ''])
      expect(() => assertTimeZone(zone)).toThrow();
    expect(() => localOccurrence('2026-04-01', '24:00', 'UTC')).toThrow();
  });
});
