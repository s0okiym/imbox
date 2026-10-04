import { Temporal } from '@js-temporal/polyfill';

export type ScheduleTrigger = { kind: 'once' } | { kind: 'daily'; local_time: string };
export interface CalendarSpec {
  timezone: string;
  trigger: ScheduleTrigger;
  start_at: string;
  deadline: string;
}

/** Named IANA zones only. Numeric offsets have no daylight-saving policy. */
export function assertTimeZone(timezone: string): void {
  if (!timezone || timezone.length > 100 || /^[+-]/.test(timezone))
    throw new RangeError('An IANA time zone is required');
  Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(timezone);
}

/** Gap: skip. Fold: the first actual instant only, never the second occurrence. */
export function localOccurrence(date: string, time: string, timezone: string): Date | null {
  assertTimeZone(timezone);
  if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(time)) throw new RangeError('Invalid local time');
  const local = Temporal.PlainDate.from(date).toPlainDateTime(Temporal.PlainTime.from(time));
  const zoned = local.toZonedDateTime(timezone, { disambiguation: 'earlier' });
  return zoned.toPlainDateTime().equals(local) ? new Date(zoned.epochMilliseconds) : null;
}

/** Inclusive lower bound; bounded plans never scan more than 368 local calendar dates. */
export function nextOccurrence(spec: CalendarSpec, lowerBound: Date): Date | null {
  assertTimeZone(spec.timezone);
  const start = Temporal.Instant.from(spec.start_at).epochMilliseconds;
  const deadline = Temporal.Instant.from(spec.deadline).epochMilliseconds;
  const lower = Math.max(lowerBound.getTime(), start);
  if (!Number.isFinite(lower) || deadline <= lower) return null;
  if (spec.trigger.kind === 'once') return start >= lower ? new Date(start) : null;
  let date = Temporal.Instant.fromEpochMilliseconds(lower)
    .toZonedDateTimeISO(spec.timezone)
    .toPlainDate();
  for (let i = 0; i < 368; i++, date = date.add({ days: 1 })) {
    const occurrence = localOccurrence(date.toString(), spec.trigger.local_time, spec.timezone);
    if (occurrence && occurrence.getTime() >= deadline) return null;
    if (occurrence && occurrence.getTime() >= lower) return occurrence;
  }
  throw new RangeError('Schedule horizon exceeded');
}

export interface DueOccurrences {
  selected: Date | null;
  next: Date | null;
  missed_count: number;
}

/** Coalesce selects the latest due slot. Skip allows only a 60-second dispatch grace. */
export function dueOccurrences(
  spec: CalendarSpec,
  next: Date,
  now: Date,
  policy: 'skip' | 'coalesce',
): DueOccurrences {
  let cursor: Date | null = next;
  let latest: Date | null = null;
  let count = 0;
  while (cursor && cursor <= now) {
    if (++count > 368) throw new RangeError('Schedule horizon exceeded');
    latest = cursor;
    cursor = nextOccurrence(spec, new Date(cursor.getTime() + 1));
  }
  const selected =
    latest && (policy === 'coalesce' || now.getTime() - latest.getTime() <= 60_000) ? latest : null;
  return { selected, next: cursor, missed_count: count - (selected ? 1 : 0) };
}
