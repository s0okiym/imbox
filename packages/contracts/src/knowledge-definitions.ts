const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
const str = (maxLength: number, minLength = 1) => ({ type: 'string', minLength, maxLength });
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const nullable = (schema: unknown) => ({ anyOf: [schema, { type: 'null' }] });
const enumeration = (...values: string[]) => ({ type: 'string', enum: values });
const hash = { ...str(64, 64), pattern: '^[a-f0-9]{64}$' };
const source = obj({
  kind: enumeration('message', 'task', 'artifact_version'),
  id: ref('Identifier'),
  version: ref('Version'),
  sha256: hash,
});
const memoryFields = {
  scope: enumeration('personal', 'conversation', 'task'),
  conversation_id: ref('Identifier'),
  task_id: ref('Identifier'),
  body: str(32000),
  source_refs: { type: 'array', items: ref('MemorySourceRef'), maxItems: 20 },
  confirmation: enumeration('confirmed', 'needs_confirmation', 'conflicted'),
  confidence: { type: 'integer', minimum: 0, maximum: 100 },
  expires_at: nullable(ref('UtcTimestamp')),
  status: enumeration('active', 'disabled'),
};
export const knowledgeDefinitions = {
  MemorySourceRef: source,
  CreateMemoryInput: obj(memoryFields, [
    'scope',
    'body',
    'source_refs',
    'confirmation',
    'confidence',
  ]),
  UpdateMemoryInput: obj(memoryFields, [
    'scope',
    'body',
    'source_refs',
    'confirmation',
    'confidence',
    'status',
  ]),
  ExplicitMemory: obj({
    id: ref('Identifier'),
    created_by: ref('Identifier'),
    scope: memoryFields.scope,
    conversation_id: nullable(ref('Identifier')),
    task_id: nullable(ref('Identifier')),
    version: ref('Version'),
    body: str(32000),
    sha256: hash,
    source_refs: memoryFields.source_refs,
    confirmation: memoryFields.confirmation,
    confidence: memoryFields.confidence,
    status: enumeration('active', 'disabled'),
    expires_at: nullable(ref('UtcTimestamp')),
    created_at: ref('UtcTimestamp'),
    updated_at: ref('UtcTimestamp'),
    trust_level: { const: 'user_content', type: 'string' },
    instruction_authority: { const: 'none', type: 'string' },
  }),
  ExplicitMemoryPage: obj(
    {
      items: { type: 'array', items: ref('ExplicitMemory'), maxItems: 50 },
      next_cursor: ref('Cursor'),
    },
    ['items'],
  ),
  MemoryDeletion: obj({ id: ref('Identifier'), deleted: { type: 'boolean', const: true } }),
  KnowledgeSearchHit: obj(
    {
      kind: enumeration('message', 'task', 'artifact_version', 'memory'),
      id: ref('Identifier'),
      version: ref('Version'),
      sha256: hash,
      title: str(400, 0),
      snippet: str(600, 0),
      conversation_id: nullable(ref('Identifier')),
      task_id: nullable(ref('Identifier')),
      artifact_id: ref('Identifier'),
      trust_level: { const: 'user_content', type: 'string' },
      instruction_authority: { const: 'none', type: 'string' },
    },
    [
      'kind',
      'id',
      'version',
      'sha256',
      'title',
      'snippet',
      'conversation_id',
      'task_id',
      'trust_level',
      'instruction_authority',
    ],
  ),
  KnowledgeSearchPage: obj(
    {
      items: { type: 'array', items: ref('KnowledgeSearchHit'), maxItems: 50 },
      next_cursor: ref('Cursor'),
    },
    ['items'],
  ),
  KnowledgeSearchQuery: obj(
    {
      q: str(200, 2),
      kind: enumeration('message', 'task', 'artifact_version', 'memory'),
      workspace_id: ref('Identifier'),
      conversation_id: ref('Identifier'),
      task_id: ref('Identifier'),
      cursor: ref('Cursor'),
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
    ['q'],
  ),
};
