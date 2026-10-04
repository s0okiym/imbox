// This migration intentionally needs the migration owner; application startup never runs DDL.
const tenantTables = [
  'tenant_principals', 'workspaces', 'memberships', 'conversations', 'conversation_members',
  'messages', 'message_revisions', 'reactions', 'read_cursors', 'command_receipts',
  'tasks', 'task_participants', 'task_conversation_links', 'task_dependencies',
  'collaboration_requests', 'agreements', 'domain_events', 'outbox', 'consumer_receipts',
  'projection_streams', 'projections', 'projection_deliveries',
] as const;

export const foundationSql = `
CREATE TABLE principals (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('human', 'agent', 'service')),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE external_identities (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL REFERENCES principals(id),
  issuer text NOT NULL,
  subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject)
);
CREATE TABLE tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE tenant_principals (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  principal_id uuid NOT NULL REFERENCES principals(id),
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'agent', 'guest')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'historical')),
  authz_revision bigint NOT NULL DEFAULT 1 CHECK (authz_revision > 0),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, principal_id)
);
CREATE TABLE workspaces (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE memberships (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'member', 'guest')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, workspace_id, principal_id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id),
  FOREIGN KEY (tenant_id, principal_id) REFERENCES tenant_principals(tenant_id, principal_id)
);
-- Authentication data is global and is granted only to the separate identity role.
CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL REFERENCES principals(id),
  token_hash text NOT NULL UNIQUE,
  csrf_token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_principal_idx ON sessions(principal_id);
CREATE TABLE conversations (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL,
  workspace_id uuid,
  kind text NOT NULL CHECK (kind IN ('direct', 'group')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  created_by uuid NOT NULL,
  history_policy text NOT NULL DEFAULT 'all' CHECK (history_policy IN ('all', 'since_join')),
  message_head_seq bigint NOT NULL DEFAULT 0 CHECK (message_head_seq >= 0),
  authz_generation bigint NOT NULL DEFAULT 1 CHECK (authz_generation > 0),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_principals(tenant_id, principal_id)
);
CREATE TABLE conversation_members (
  tenant_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'left', 'removed')),
  visible_from_seq bigint NOT NULL DEFAULT 0 CHECK (visible_from_seq >= 0),
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, conversation_id, principal_id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations(tenant_id, id),
  FOREIGN KEY (tenant_id, principal_id) REFERENCES tenant_principals(tenant_id, principal_id)
);
CREATE INDEX conversation_members_principal_idx ON conversation_members(tenant_id, principal_id, status);
CREATE TABLE messages (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  sender_principal_id uuid NOT NULL,
  seq bigint NOT NULL CHECK (seq > 0),
  body text NOT NULL CHECK (length(body) <= 32000),
  client_message_id uuid,
  reply_to_id uuid,
  thread_root_id uuid,
  deleted_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, conversation_id, id),
  UNIQUE (tenant_id, conversation_id, seq),
  UNIQUE (tenant_id, sender_principal_id, client_message_id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations(tenant_id, id),
  FOREIGN KEY (tenant_id, sender_principal_id) REFERENCES tenant_principals(tenant_id, principal_id),
  FOREIGN KEY (tenant_id, conversation_id, reply_to_id) REFERENCES messages(tenant_id, conversation_id, id),
  FOREIGN KEY (tenant_id, conversation_id, thread_root_id) REFERENCES messages(tenant_id, conversation_id, id)
);
CREATE TABLE message_revisions (
  tenant_id uuid NOT NULL,
  message_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  body text NOT NULL CHECK (length(body) <= 32000),
  edited_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, message_id, revision),
  FOREIGN KEY (tenant_id, message_id) REFERENCES messages(tenant_id, id),
  FOREIGN KEY (tenant_id, edited_by) REFERENCES tenant_principals(tenant_id, principal_id)
);
CREATE TABLE reactions (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  message_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  emoji text NOT NULL CHECK (length(emoji) BETWEEN 1 AND 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, message_id, principal_id, emoji),
  FOREIGN KEY (tenant_id, message_id) REFERENCES messages(tenant_id, id),
  FOREIGN KEY (tenant_id, principal_id) REFERENCES tenant_principals(tenant_id, principal_id)
);
CREATE TABLE read_cursors (
  tenant_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  last_read_seq bigint NOT NULL DEFAULT 0 CHECK (last_read_seq >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, conversation_id, principal_id),
  FOREIGN KEY (tenant_id, conversation_id, principal_id) REFERENCES conversation_members(tenant_id, conversation_id, principal_id)
);
CREATE TABLE command_receipts (
  tenant_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  operation text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
  result_ref jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, principal_id, operation, idempotency_key),
  FOREIGN KEY (tenant_id, principal_id) REFERENCES tenant_principals(tenant_id, principal_id)
);
CREATE TABLE tasks (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL,
  root_task_id uuid NOT NULL,
  parent_task_id uuid,
  owner_principal_id uuid NOT NULL,
  accountable_principal_id uuid NOT NULL,
  created_by uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  goal text NOT NULL CHECK (length(goal) BETWEEN 1 AND 32000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','active','blocked','in_review','completed','failed','cancelled')),
  acceptance_criteria jsonb NOT NULL DEFAULT '{}',
  due_at timestamptz,
  execution_epoch bigint NOT NULL DEFAULT 1 CHECK (execution_epoch > 0),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, root_task_id) REFERENCES tasks(tenant_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, parent_task_id) REFERENCES tasks(tenant_id, id),
  FOREIGN KEY (tenant_id, owner_principal_id) REFERENCES tenant_principals(tenant_id, principal_id),
  FOREIGN KEY (tenant_id, accountable_principal_id) REFERENCES tenant_principals(tenant_id, principal_id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_principals(tenant_id, principal_id),
  CHECK ((parent_task_id IS NULL AND root_task_id = id) OR (parent_task_id IS NOT NULL AND parent_task_id <> id AND root_task_id <> id))
);
CREATE FUNCTION imbox_validate_task_tree() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_root uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.parent_task_id IS DISTINCT FROM OLD.parent_task_id OR NEW.root_task_id <> OLD.root_task_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id THEN
      RAISE EXCEPTION 'task ancestry is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.parent_task_id IS NOT NULL THEN
    SELECT root_task_id INTO parent_root FROM tasks WHERE tenant_id = NEW.tenant_id AND id = NEW.parent_task_id;
    IF parent_root IS NULL OR parent_root <> NEW.root_task_id THEN
      RAISE EXCEPTION 'task root must match parent root' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tasks_validate_tree BEFORE INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION imbox_validate_task_tree();
CREATE INDEX tasks_owner_status_idx ON tasks(tenant_id, owner_principal_id, status);
CREATE INDEX tasks_root_idx ON tasks(tenant_id, root_task_id);
CREATE INDEX tasks_parent_idx ON tasks(tenant_id, parent_task_id);
CREATE TABLE task_participants (
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','contributor','reviewer','observer')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, task_id, principal_id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks(tenant_id, id),
  FOREIGN KEY (tenant_id, principal_id) REFERENCES tenant_principals(tenant_id, principal_id)
);
CREATE TABLE task_conversation_links (
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  disclosure_scope_ref uuid NOT NULL,
  public_summary text NOT NULL DEFAULT '',
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, task_id, conversation_id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks(tenant_id, id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations(tenant_id, id)
);
CREATE TABLE task_dependencies (
  tenant_id uuid NOT NULL,
  dependent_task_id uuid NOT NULL,
  prerequisite_task_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, dependent_task_id, prerequisite_task_id),
  FOREIGN KEY (tenant_id, dependent_task_id) REFERENCES tasks(tenant_id, id),
  FOREIGN KEY (tenant_id, prerequisite_task_id) REFERENCES tasks(tenant_id, id),
  CHECK (dependent_task_id <> prerequisite_task_id)
);
CREATE TABLE collaboration_requests (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  task_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('consult','review','delegate','handoff')),
  requester_principal_id uuid NOT NULL,
  recipient_principal_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','clarification_requested','expired','cancelled','superseded')),
  proposal jsonb NOT NULL,
  proposal_version bigint NOT NULL DEFAULT 1 CHECK (proposal_version > 0),
  expected_task_version bigint NOT NULL CHECK (expected_task_version > 0),
  expires_at timestamptz NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, id, task_id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks(tenant_id, id),
  FOREIGN KEY (tenant_id, requester_principal_id) REFERENCES tenant_principals(tenant_id, principal_id),
  FOREIGN KEY (tenant_id, recipient_principal_id) REFERENCES tenant_principals(tenant_id, principal_id)
);
CREATE INDEX requests_recipient_pending_idx ON collaboration_requests(tenant_id, recipient_principal_id, created_at) WHERE status = 'pending';
CREATE TABLE agreements (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  request_id uuid NOT NULL,
  task_id uuid NOT NULL,
  accepted_by uuid NOT NULL,
  accepted_version bigint NOT NULL CHECK (accepted_version > 0),
  terms jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, request_id),
  FOREIGN KEY (tenant_id, request_id, task_id) REFERENCES collaboration_requests(tenant_id, id, task_id),
  FOREIGN KEY (tenant_id, accepted_by) REFERENCES tenant_principals(tenant_id, principal_id)
);
CREATE TABLE domain_events (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  event_type text NOT NULL,
  actor_principal_id uuid NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, aggregate_type, aggregate_id, aggregate_version),
  FOREIGN KEY (tenant_id, actor_principal_id) REFERENCES tenant_principals(tenant_id, principal_id)
);
CREATE TABLE outbox (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  event_id uuid NOT NULL,
  target text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','leased','completed','dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_holder text,
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, event_id, target),
  FOREIGN KEY (tenant_id, event_id) REFERENCES domain_events(tenant_id, id)
);
CREATE INDEX outbox_pending_idx ON outbox(tenant_id, available_at) WHERE status IN ('pending', 'leased');
CREATE TABLE consumer_receipts (
  tenant_id uuid NOT NULL,
  consumer text NOT NULL,
  event_id uuid NOT NULL,
  target_scope text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, consumer, event_id, target_scope),
  FOREIGN KEY (tenant_id, event_id) REFERENCES domain_events(tenant_id, id)
);
CREATE TABLE projection_streams (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL,
  scope_type text NOT NULL CHECK (scope_type IN ('conversation','task','inbox')),
  scope_id uuid NOT NULL,
  head_seq bigint NOT NULL DEFAULT 0 CHECK (head_seq >= 0),
  authz_generation bigint NOT NULL DEFAULT 1 CHECK (authz_generation > 0),
  retention_generation bigint NOT NULL DEFAULT 1 CHECK (retention_generation > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, scope_type, scope_id)
);
CREATE TABLE projections (
  tenant_id uuid NOT NULL,
  stream_id uuid NOT NULL,
  id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  entity_version bigint NOT NULL CHECK (entity_version > 0),
  authz_generation bigint NOT NULL CHECK (authz_generation > 0),
  dto jsonb NOT NULL,
  retracted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, stream_id, id),
  FOREIGN KEY (tenant_id, stream_id) REFERENCES projection_streams(tenant_id, id)
);
CREATE TABLE projection_deliveries (
  tenant_id uuid NOT NULL,
  stream_id uuid NOT NULL,
  delivery_seq bigint NOT NULL CHECK (delivery_seq > 0),
  projection_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  event_id uuid NOT NULL,
  authz_generation bigint NOT NULL CHECK (authz_generation > 0),
  dto jsonb NOT NULL,
  retracted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, stream_id, delivery_seq),
  UNIQUE (tenant_id, stream_id, projection_id, revision),
  FOREIGN KEY (tenant_id, stream_id, projection_id) REFERENCES projections(tenant_id, stream_id, id),
  FOREIGN KEY (tenant_id, event_id) REFERENCES domain_events(tenant_id, id)
);
${tenantTables.map((table) => `
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
CREATE POLICY ${table}_tenant_isolation ON ${table}
  USING (tenant_id = NULLIF(current_setting('imbox.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('imbox.tenant_id', true), '')::uuid);
`).join('\n')}
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenants_tenant_isolation ON tenants
  USING (id = NULLIF(current_setting('imbox.tenant_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('imbox.tenant_id', true), '')::uuid);
`;

export const tenantTableNames: readonly string[] = ['tenants', ...tenantTables];
export const identityTableNames: readonly string[] = ['principals', 'external_identities', 'sessions'];
