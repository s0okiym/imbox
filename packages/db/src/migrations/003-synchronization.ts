const syncTenantTables = [
  'projection_checkpoints',
  'sync_snapshot_sessions',
  'sync_snapshot_items',
] as const;
export const synchronizationSql = `
ALTER TABLE outbox ADD COLUMN lease_generation bigint NOT NULL DEFAULT 0 CHECK (lease_generation >= 0);
ALTER TABLE projections ADD COLUMN source_event_id uuid;
ALTER TABLE projections ADD COLUMN source_seq bigint CHECK (source_seq IS NULL OR source_seq > 0);
ALTER TABLE projections ADD FOREIGN KEY (tenant_id, source_event_id) REFERENCES domain_events(tenant_id, id);
ALTER TABLE projection_deliveries ADD COLUMN source_seq bigint CHECK (source_seq IS NULL OR source_seq > 0);
CREATE TABLE projection_checkpoints (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  consumer text NOT NULL,
  target_scope text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  last_event_version bigint NOT NULL DEFAULT 0 CHECK (last_event_version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, consumer, target_scope, aggregate_type, aggregate_id)
);
CREATE TABLE sync_snapshot_sessions (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  principal_id uuid NOT NULL,
  stream_id uuid NOT NULL,
  authz_revision bigint NOT NULL,
  authz_generation bigint NOT NULL,
  retention_generation bigint NOT NULL,
  head_seq bigint NOT NULL CHECK (head_seq >= 0),
  head_cursor text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, principal_id) REFERENCES tenant_principals(tenant_id, principal_id),
  FOREIGN KEY (tenant_id, stream_id) REFERENCES projection_streams(tenant_id, id)
);
CREATE INDEX sync_snapshot_sessions_expiry_idx ON sync_snapshot_sessions(tenant_id, expires_at);
CREATE TABLE sync_snapshot_items (
  tenant_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  ordinal bigint NOT NULL CHECK (ordinal > 0),
  projection_id uuid NOT NULL,
  projection_revision bigint NOT NULL CHECK (projection_revision > 0),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  entity_version bigint NOT NULL CHECK (entity_version > 0),
  event_id uuid NOT NULL,
  payload jsonb NOT NULL,
  retracted boolean NOT NULL,
  PRIMARY KEY (tenant_id, snapshot_id, ordinal),
  FOREIGN KEY (tenant_id, snapshot_id) REFERENCES sync_snapshot_sessions(tenant_id, id),
  FOREIGN KEY (tenant_id, event_id) REFERENCES domain_events(tenant_id, id)
);
${syncTenantTables
  .map(
    (table) => `
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
CREATE POLICY ${table}_tenant_isolation ON ${table}
  USING (tenant_id = NULLIF(current_setting('imbox.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('imbox.tenant_id', true), '')::uuid);
`,
  )
  .join('\n')}
`;
export const synchronizationTableNames: readonly string[] = [...syncTenantTables];
