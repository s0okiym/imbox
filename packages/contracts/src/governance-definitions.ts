const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const scope = { type: 'string', enum: ['conversation', 'task', 'personal'] };
export const governanceDefinitions = {
  CreateExportInput: obj({ scope, scope_id: ref('Identifier') }, ['scope']),
  ExportJob: obj({
    id: ref('Identifier'),
    scope,
    scope_id: { anyOf: [ref('Identifier'), { type: 'null' }] },
    created_at: ref('UtcTimestamp'),
    expires_at: ref('UtcTimestamp'),
    format: { type: 'string', const: 'imbox.ndjson.v1' },
    consistency: { type: 'string', const: 'live_authorized_reads' },
    content_url: { type: 'string', maxLength: 200 },
  }),
  GovernancePolicy: obj({
    message_days: { type: 'integer', minimum: 1 },
    resource_days: { type: 'integer', minimum: 1 },
    run_content_days: { type: 'integer', minimum: 1 },
    export_hours: { type: 'integer', const: 24 },
    independent_ledger: { type: 'boolean' },
    scope: { type: 'string', const: 'deployment' },
    external_copies: { type: 'string', const: 'not_recallable' },
    offline_message_cache_allowed: { type: 'boolean' },
    offline_queue_allowed: { type: 'boolean' },
    offline_queue_max_days: { type: 'integer', const: 7 },
    workspace_policy: { type: 'string', const: 'inherits_deployment' },
  }),
};
