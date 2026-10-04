const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
export const maintenanceDefinitions = {
  CursorOnlyQuery: obj({ cursor: ref('Cursor') }, []),
  TaskEscalation: obj({
    id: ref('Identifier'),
    task_id: ref('Identifier'),
    task_version: ref('Version'),
    can_takeover: { type: 'boolean' },
    reason: { enum: ['owner_unavailable', 'execution_deadline'] },
    assigned_to: { anyOf: [ref('Identifier'), { type: 'null' }] },
    created_at: ref('UtcTimestamp'),
  }),
  TaskEscalationPage: obj(
    {
      items: { type: 'array', items: ref('TaskEscalation'), maxItems: 100 },
      next_cursor: ref('Cursor'),
    },
    ['items'],
  ),
};
