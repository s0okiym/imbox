const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
const text = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const nullable = (schema: unknown) => ({ anyOf: [schema, { type: 'null' }] });
const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const outcome = { enum: ['succeeded', 'no_effect', 'unknown'] };
export const recoveryDefinitions = {
  RecoveryReasonInput: obj({ reason: text(2000) }),
  RecoveryLookupInput: obj({}),
  RecoveryConfirmInput: obj({
    evidence_id: ref('Identifier'),
    confirmed: { const: true },
    reason: text(2000),
  }),
  RecoveryUnfreezeInput: obj({
    confirmed: { const: true },
    reason: text(2000),
    freeze_digest: hash,
    journal_digest: hash,
  }),
  RecoveryStatus: obj({
    frozen: { type: 'boolean' },
    journal_frozen: { type: 'boolean' },
    database_frozen: { type: 'boolean' },
    revision: ref('Version'),
    open_cases: { type: 'integer', minimum: 0 },
    pending_operations: { type: 'integer', minimum: 0 },
    freeze_digest: hash,
    journal_digest: hash,
  }),
  RecoveryIntent: obj({
    task_id: ref('Identifier'),
    fingerprint: hash,
    business_key: ref('IdempotencyKey'),
    tool_id: text(100),
    tool_version: nullable(ref('Version')),
    target_id: text(100),
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    estimate_microunits: ref('Counter'),
    budget_account_ids: nullable({
      type: 'array',
      items: ref('Identifier'),
      minItems: 1,
      maxItems: 100,
    }),
    created_at: ref('UtcTimestamp'),
  }),
  RecoveryEvidence: obj({
    id: ref('Identifier'),
    case_id: ref('Identifier'),
    intent_hash: hash,
    evidence_hash: hash,
    outcome,
    receipt_id: nullable(text(128)),
    actual_microunits: nullable(ref('Counter')),
    reason: nullable(text(100)),
    created_at: ref('UtcTimestamp'),
  }),
  RecoveryCase: obj({
    id: ref('Identifier'),
    action_id: ref('Identifier'),
    attempt_id: ref('Identifier'),
    reason: text(200),
    status: { enum: ['open', 'resolved'] },
    version: ref('Version'),
    intent: nullable(ref('RecoveryIntent')),
    evidence: { type: 'array', items: ref('RecoveryEvidence'), maxItems: 20 },
    created_at: ref('UtcTimestamp'),
    resolved_at: nullable(ref('UtcTimestamp')),
    resolved_by: nullable(ref('Identifier')),
  }),
  RecoveryCasePage: obj(
    {
      items: { type: 'array', items: ref('RecoveryCase'), maxItems: 100 },
      next_cursor: ref('Cursor'),
    },
    ['items'],
  ),
};
