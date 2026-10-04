/** M2 collaboration persistence. Execution reservations/grants arrive in M3. */
const tables = ['task_budgets', 'request_proposals', 'request_decisions', 'task_submissions', 'task_reviews'] as const;
export const tasksSql = `
ALTER TABLE tasks ADD COLUMN workspace_id uuid;
ALTER TABLE tasks ADD FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id);
ALTER TABLE tasks ADD COLUMN archived boolean NOT NULL DEFAULT false;
ALTER TABLE tasks ADD COLUMN goal_version bigint NOT NULL DEFAULT 1 CHECK (goal_version > 0);
ALTER TABLE tasks ADD COLUMN authz_generation bigint NOT NULL DEFAULT 1 CHECK (authz_generation > 0);
ALTER TABLE tasks ADD COLUMN blocked_from text CHECK (blocked_from IN ('open','active','in_review'));
ALTER TABLE tasks ADD COLUMN state_reason text;
ALTER TABLE tasks ADD COLUMN execution_deadline timestamptz;
ALTER TABLE tasks ADD COLUMN reviewer_ids jsonb NOT NULL DEFAULT '[]';
ALTER TABLE collaboration_requests ADD COLUMN task_epoch bigint NOT NULL DEFAULT 1 CHECK (task_epoch > 0);
ALTER TABLE collaboration_requests ADD COLUMN goal_version bigint NOT NULL DEFAULT 1 CHECK (goal_version > 0);
ALTER TABLE agreements ADD COLUMN child_task_id uuid;
ALTER TABLE agreements ADD FOREIGN KEY (tenant_id, child_task_id) REFERENCES tasks(tenant_id, id);
CREATE UNIQUE INDEX task_single_active_owner_idx ON task_participants(tenant_id, task_id) WHERE role = 'owner' AND status = 'active';
CREATE INDEX task_workspace_idx ON tasks(tenant_id, workspace_id, id);
CREATE TABLE task_budgets (
  tenant_id uuid NOT NULL, task_id uuid NOT NULL, currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  limit_microunits bigint NOT NULL CHECK (limit_microunits >= 0),
  reserved_microunits bigint NOT NULL DEFAULT 0 CHECK (reserved_microunits >= 0),
  spent_microunits bigint NOT NULL DEFAULT 0 CHECK (spent_microunits >= 0),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY(tenant_id, task_id), FOREIGN KEY(tenant_id, task_id) REFERENCES tasks(tenant_id, id),
  CHECK (reserved_microunits + spent_microunits <= limit_microunits)
);
CREATE TABLE request_proposals (
  tenant_id uuid NOT NULL, request_id uuid NOT NULL, proposal_version bigint NOT NULL CHECK (proposal_version > 0),
  proposal jsonb NOT NULL, task_version bigint NOT NULL, task_epoch bigint NOT NULL, goal_version bigint NOT NULL,
  created_by uuid NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id, request_id, proposal_version),
  FOREIGN KEY(tenant_id, request_id) REFERENCES collaboration_requests(tenant_id, id),
  FOREIGN KEY(tenant_id, created_by) REFERENCES tenant_principals(tenant_id, principal_id)
);
CREATE TABLE request_decisions (
  tenant_id uuid NOT NULL, id uuid NOT NULL, request_id uuid NOT NULL, proposal_version bigint NOT NULL,
  actor_principal_id uuid NOT NULL, decision text NOT NULL CHECK(decision IN ('accept','reject','clarify','withdraw','supersede')),
  comment text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id, id),
  FOREIGN KEY(tenant_id, request_id, proposal_version) REFERENCES request_proposals(tenant_id, request_id, proposal_version),
  FOREIGN KEY(tenant_id, actor_principal_id) REFERENCES tenant_principals(tenant_id, principal_id)
);
CREATE UNIQUE INDEX request_one_accept_idx ON request_decisions(tenant_id, request_id) WHERE decision = 'accept';
CREATE TABLE task_submissions (
  tenant_id uuid NOT NULL, id uuid NOT NULL, task_id uuid NOT NULL, submitted_by uuid NOT NULL,
  goal_version bigint NOT NULL CHECK(goal_version > 0), task_epoch bigint NOT NULL CHECK(task_epoch > 0),
  evidence jsonb NOT NULL, summary text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id, id), UNIQUE(tenant_id, id, task_id),
  FOREIGN KEY(tenant_id, task_id) REFERENCES tasks(tenant_id, id),
  FOREIGN KEY(tenant_id, submitted_by) REFERENCES tenant_principals(tenant_id, principal_id)
);
CREATE TABLE task_reviews (
  tenant_id uuid NOT NULL, id uuid NOT NULL, task_id uuid NOT NULL, submission_id uuid NOT NULL,
  reviewer_id uuid NOT NULL, decision text NOT NULL CHECK(decision IN ('accept','return')),
  comment text NOT NULL, goal_version bigint NOT NULL, task_epoch bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id, id),
  UNIQUE(tenant_id, submission_id),
  FOREIGN KEY(tenant_id, submission_id, task_id) REFERENCES task_submissions(tenant_id, id, task_id),
  FOREIGN KEY(tenant_id, reviewer_id) REFERENCES tenant_principals(tenant_id, principal_id)
);
${tables.map((table) => `
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
CREATE POLICY ${table}_tenant_isolation ON ${table}
 USING(tenant_id = NULLIF(current_setting('imbox.tenant_id', true), '')::uuid)
 WITH CHECK(tenant_id = NULLIF(current_setting('imbox.tenant_id', true), '')::uuid);
`).join('\n')}
`;
export const taskTableNames: readonly string[] = [...tables];
