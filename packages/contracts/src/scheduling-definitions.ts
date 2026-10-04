const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const text = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
const en = (...values: string[]) => ({ type: 'string', enum: values });
const nullable = (schema: unknown) => ({ anyOf: [schema, { type: 'null' }] });
const trigger = {
  oneOf: [
    obj({ kind: { const: 'once' } }),
    obj({
      kind: { const: 'daily' },
      local_time: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' },
    }),
  ],
};
const configuration = {
  task_id: ref('Identifier'),
  run_id: ref('Identifier'),
  timezone: text(100),
  trigger,
  start_at: ref('UtcTimestamp'),
  deadline: ref('UtcTimestamp'),
  missed_policy: en('skip', 'coalesce'),
  maximum_wakeups: { type: 'integer', minimum: 1, maximum: 1000 },
};
export const schedulingDefinitions = {
  CreateScheduleInput: obj(configuration),
  ReviseScheduleInput: obj({ ...configuration, enabled: { type: 'boolean' } }),
  Schedule: obj({
    id: ref('Identifier'),
    created_by: ref('Identifier'),
    ...configuration,
    overlap_policy: { const: 'forbid' },
    status: en('enabled', 'disabled', 'completed', 'expired'),
    revision: ref('Version'),
    version: ref('Version'),
    occurrences_created: { type: 'integer', minimum: 0, maximum: 1000 },
    missed_count: { type: 'integer', minimum: 0 },
    next_at: nullable(ref('UtcTimestamp')),
    created_at: ref('UtcTimestamp'),
    updated_at: ref('UtcTimestamp'),
  }),
  ScheduleList: obj(
    { items: { type: 'array', items: ref('Schedule'), maxItems: 100 }, next_cursor: ref('Cursor') },
    ['items'],
  ),
  ScheduleOccurrence: obj({
    id: ref('Identifier'),
    schedule_id: ref('Identifier'),
    schedule_revision: ref('Version'),
    scheduled_instant: ref('UtcTimestamp'),
    timezone: text(100),
    status: en('pending', 'dispatched', 'skipped', 'denied'),
    reason: nullable(text(100)),
    causal_root_id: ref('Identifier'),
    trigger_id: ref('Identifier'),
    depth: { const: 0 },
    created_at: ref('UtcTimestamp'),
    resolved_at: nullable(ref('UtcTimestamp')),
  }),
  ScheduleOccurrenceList: obj(
    {
      items: { type: 'array', items: ref('ScheduleOccurrence'), maxItems: 100 },
      next_cursor: ref('Cursor'),
    },
    ['items'],
  ),
};
