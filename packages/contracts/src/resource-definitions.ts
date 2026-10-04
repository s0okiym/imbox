const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
const str = (maxLength: number, minLength = 1) => ({ type: 'string', minLength, maxLength });
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const arr = (items: unknown, maxItems: number) => ({ type: 'array', items, maxItems });
const nullable = (schema: unknown) => ({ anyOf: [schema, { type: 'null' }] });
const checksum = { ...str(64, 64), pattern: '^[a-f0-9]{64}$' };
export const resourceDefinitions = {
  ResourceScopeQuery: obj(
    {
      task_id: ref('Identifier'),
      conversation_id: ref('Identifier'),
      cursor: ref('Cursor'),
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    },
    [],
  ),
  StoredResourcePage: obj({ items: arr(ref('StoredResource'), 200), next_cursor: ref('Cursor') }, [
    'items',
  ]),
  StoredArtifactPage: obj({ items: arr(ref('StoredArtifact'), 200), next_cursor: ref('Cursor') }, [
    'items',
  ]),
  CreateUploadInput: obj(
    {
      conversation_id: ref('Identifier'),
      task_id: ref('Identifier'),
      filename: str(200),
      content_type: { type: 'string', enum: ['text/plain', 'text/markdown', 'application/json'] },
      byte_size: { type: 'integer', minimum: 0, maximum: 8388608 },
      sha256: checksum,
    },
    ['filename', 'content_type', 'byte_size', 'sha256'],
  ),
  UploadTicket: obj({
    id: ref('Identifier'),
    resource_id: ref('Identifier'),
    upload_url: { ...str(8192), format: 'uri' },
    upload_headers: {
      type: 'object',
      maxProperties: 16,
      propertyNames: { pattern: '^[a-z0-9-]{1,64}$' },
      additionalProperties: { type: 'string', maxLength: 1024 },
    },
    expires_at: ref('UtcTimestamp'),
    max_bytes: { type: 'integer', minimum: 1, maximum: 8388608 },
  }),
  StoredResource: obj({
    id: ref('Identifier'),
    filename: str(200),
    content_type: str(100),
    byte_size: { type: 'integer', minimum: 0, maximum: 8388608 },
    sha256: checksum,
    version: ref('Version'),
    conversation_id: nullable(ref('Identifier')),
    task_id: nullable(ref('Identifier')),
    created_by: ref('Identifier'),
    created_at: ref('UtcTimestamp'),
    download_path: str(120),
  }),
  CreateStoredArtifactInput: obj({ resource_id: ref('Identifier'), title: str(200) }),
  CreateStoredArtifactVersionInput: obj({ resource_id: ref('Identifier') }),
  StoredArtifact: obj(
    {
      can_append_version: { type: 'boolean' },
      id: ref('Identifier'),
      title: str(200),
      kind: { type: 'string', enum: ['text', 'markdown', 'file'] },
      version: ref('Version'),
      head_version: ref('Version'),
      version_id: ref('Identifier'),
      resource: ref('StoredResource'),
      created_by: ref('Identifier'),
      created_at: ref('UtcTimestamp'),
    },
    [
      'id',
      'title',
      'kind',
      'version',
      'head_version',
      'version_id',
      'resource',
      'created_by',
      'created_at',
    ],
  ),
  StoredArtifactVersion: obj({
    id: ref('Identifier'),
    artifact_id: ref('Identifier'),
    version: ref('Version'),
    resource: ref('StoredResource'),
    created_by: ref('Identifier'),
    created_at: ref('UtcTimestamp'),
  }),
  StoredArtifactVersionPage: obj(
    { items: arr(ref('StoredArtifactVersion'), 200), next_cursor: ref('Cursor') },
    ['items'],
  ),
  ResourceDeletion: obj({ id: ref('Identifier'), deleted: { type: 'boolean', const: true } }),
};
