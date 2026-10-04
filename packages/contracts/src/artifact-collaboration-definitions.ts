const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
const str = (maxLength: number, minLength = 1) => ({ type: 'string', minLength, maxLength });
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const nullable = (schema: unknown) => ({ anyOf: [schema, { type: 'null' }] });
const hash = { ...str(64, 64), pattern: '^[a-f0-9]{64}$' };
const page = (name: string) =>
  obj({ items: { type: 'array', items: ref(name), maxItems: 100 }, next_cursor: ref('Cursor') }, [
    'items',
  ]);
export const artifactCollaborationDefinitions = {
  ArtifactCommentAnchor: {
    anyOf: [
      obj({ type: { type: 'string', const: 'whole' } }),
      obj({
        type: { type: 'string', const: 'text_range' },
        start: { type: 'integer', minimum: 0, maximum: 8388608 },
        end: { type: 'integer', minimum: 1, maximum: 8388608 },
      }),
    ],
  },
  CreateArtifactCommentInput: obj({
    version_id: ref('Identifier'),
    sha256: hash,
    anchor: ref('ArtifactCommentAnchor'),
    body: str(4000),
  }),
  EditArtifactCommentInput: obj({ body: str(4000) }),
  ArtifactComment: obj({
    id: ref('Identifier'),
    artifact_id: ref('Identifier'),
    version_id: ref('Identifier'),
    sha256: hash,
    anchor: ref('ArtifactCommentAnchor'),
    body: str(4000, 0),
    version: ref('Version'),
    created_by: ref('Identifier'),
    created_at: ref('UtcTimestamp'),
    updated_at: ref('UtcTimestamp'),
    deleted: { type: 'boolean' },
  }),
  ArtifactCommentPage: page('ArtifactComment'),
  CreateArtifactShareInput: obj(
    {
      version_id: ref('Identifier'),
      sha256: hash,
      recipient_principal_id: ref('Identifier'),
      conversation_id: ref('Identifier'),
      task_id: ref('Identifier'),
      expires_at: ref('UtcTimestamp'),
    },
    ['version_id', 'sha256', 'expires_at'],
  ),
  ArtifactShare: obj({
    id: ref('Identifier'),
    artifact_id: ref('Identifier'),
    version_id: ref('Identifier'),
    sha256: hash,
    title: str(200),
    filename: str(200),
    content_type: str(100),
    byte_size: { type: 'integer', minimum: 0, maximum: 8388608 },
    created_by: ref('Identifier'),
    recipient_principal_id: nullable(ref('Identifier')),
    conversation_id: nullable(ref('Identifier')),
    task_id: nullable(ref('Identifier')),
    version: ref('Version'),
    expires_at: ref('UtcTimestamp'),
    created_at: ref('UtcTimestamp'),
    download_path: str(150),
  }),
  ArtifactShareRevocation: obj({
    id: ref('Identifier'),
    revoked: { type: 'boolean', const: true },
  }),
  ArtifactShareSummary: obj({
    id: ref('Identifier'),
    artifact_id: ref('Identifier'),
    version_id: ref('Identifier'),
    version: ref('Version'),
    recipient_principal_id: nullable(ref('Identifier')),
    conversation_id: nullable(ref('Identifier')),
    task_id: nullable(ref('Identifier')),
    expires_at: ref('UtcTimestamp'),
    created_at: ref('UtcTimestamp'),
    status: { type: 'string', enum: ['active', 'revoked'] },
  }),
  ArtifactSharePage: page('ArtifactShareSummary'),
  ArtifactCommentDeletion: obj({
    id: ref('Identifier'),
    deleted: { type: 'boolean', const: true },
  }),
};
