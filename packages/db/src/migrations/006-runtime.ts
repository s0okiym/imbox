const tables = ['agent_installations','agent_revisions','agent_runs','context_manifests','context_items','run_checkpoints','run_reports','runtime_reservations','runtime_usage_records'] as const;
export const runtimeSql = `
ALTER TABLE task_budgets DROP CONSTRAINT task_budgets_check;
ALTER TABLE task_budgets ADD COLUMN blocked boolean NOT NULL DEFAULT false;
ALTER TABLE task_budgets ADD COLUMN overrun_microunits bigint NOT NULL DEFAULT 0 CHECK (overrun_microunits >= 0);
CREATE TABLE agent_installations (
 tenant_id uuid NOT NULL, id uuid NOT NULL, agent_principal_id uuid NOT NULL,
 mode text NOT NULL CHECK(mode IN ('hosted','device','external')), status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
 authz_revision bigint NOT NULL DEFAULT 1 CHECK(authz_revision > 0), version bigint NOT NULL DEFAULT 1 CHECK(version > 0),
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,agent_principal_id),
 FOREIGN KEY(tenant_id,agent_principal_id) REFERENCES tenant_principals(tenant_id,principal_id),
 FOREIGN KEY(tenant_id,created_by) REFERENCES tenant_principals(tenant_id,principal_id)
);
CREATE TABLE agent_revisions (
 tenant_id uuid NOT NULL, agent_id uuid NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
 config jsonb NOT NULL, config_hash text NOT NULL, capabilities jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,agent_id,revision), FOREIGN KEY(tenant_id,agent_id) REFERENCES agent_installations(tenant_id,id)
);
CREATE TABLE agent_runs (
 tenant_id uuid NOT NULL, id uuid NOT NULL, agent_id uuid NOT NULL, agent_revision bigint NOT NULL,
 created_by uuid NOT NULL, creator_authz_revision bigint NOT NULL, agent_authz_revision bigint NOT NULL, installation_authz_revision bigint NOT NULL,
 task_id uuid, conversation_id uuid, origin_type text NOT NULL CHECK(origin_type IN ('task','conversation')),
 ancestor_fences jsonb NOT NULL DEFAULT '[]',
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','waiting_input','waiting_approval','waiting_dependency','paused','cancelling','completed','failed','cancelled','expired')),
 version bigint NOT NULL DEFAULT 1 CHECK(version > 0), cancellation_requested boolean NOT NULL DEFAULT false, pause_requested boolean NOT NULL DEFAULT false,
 lease_holder text, lease_generation bigint NOT NULL DEFAULT 0 CHECK(lease_generation >= 0), lease_expires_at timestamptz,
 checkpoint_seq bigint NOT NULL DEFAULT 0 CHECK(checkpoint_seq >= 0), summary text NOT NULL DEFAULT '', output text,
 budget_currency text NOT NULL CHECK(budget_currency ~ '^[A-Z]{3}$'), budget_limit_microunits bigint NOT NULL CHECK(budget_limit_microunits >= 0),
 budget_reserved_microunits bigint NOT NULL DEFAULT 0 CHECK(budget_reserved_microunits >= 0), budget_spent_microunits bigint NOT NULL DEFAULT 0 CHECK(budget_spent_microunits >= 0), budget_blocked boolean NOT NULL DEFAULT false,
 context_manifest_id uuid NOT NULL, previous_run_id uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,id,context_manifest_id),
 FOREIGN KEY(tenant_id,agent_id,agent_revision) REFERENCES agent_revisions(tenant_id,agent_id,revision),
 FOREIGN KEY(tenant_id,created_by) REFERENCES tenant_principals(tenant_id,principal_id),
 FOREIGN KEY(tenant_id,task_id) REFERENCES tasks(tenant_id,id), FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversations(tenant_id,id),
 FOREIGN KEY(tenant_id,previous_run_id) REFERENCES agent_runs(tenant_id,id),
 CHECK((origin_type='task' AND task_id IS NOT NULL AND conversation_id IS NULL) OR (origin_type='conversation' AND conversation_id IS NOT NULL AND task_id IS NULL))
);
CREATE INDEX agent_runs_queue_idx ON agent_runs(tenant_id,status,created_at);
CREATE TABLE context_manifests (
 tenant_id uuid NOT NULL, id uuid NOT NULL, run_id uuid NOT NULL, purpose text NOT NULL, destination text NOT NULL,
 content_hash text NOT NULL, total_bytes integer NOT NULL CHECK(total_bytes >= 0), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,run_id), FOREIGN KEY(tenant_id,run_id,id) REFERENCES agent_runs(tenant_id,id,context_manifest_id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE agent_runs ADD FOREIGN KEY(tenant_id,context_manifest_id) REFERENCES context_manifests(tenant_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE context_items (
 tenant_id uuid NOT NULL, manifest_id uuid NOT NULL, ordinal integer NOT NULL CHECK(ordinal > 0),
 source_type text NOT NULL CHECK(source_type IN ('message','task')), source_id uuid NOT NULL, source_version bigint NOT NULL CHECK(source_version > 0),
 content_hash text NOT NULL, required boolean NOT NULL, trust_level text NOT NULL CHECK(trust_level IN ('untrusted_user_content')),
 payload jsonb NOT NULL, authorization_snapshot jsonb NOT NULL,
 PRIMARY KEY(tenant_id,manifest_id,ordinal), FOREIGN KEY(tenant_id,manifest_id) REFERENCES context_manifests(tenant_id,id)
);
CREATE TABLE run_checkpoints (
 tenant_id uuid NOT NULL, run_id uuid NOT NULL, checkpoint_no bigint NOT NULL CHECK(checkpoint_no > 0),
 lease_generation bigint NOT NULL, status text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,run_id,checkpoint_no), FOREIGN KEY(tenant_id,run_id) REFERENCES agent_runs(tenant_id,id)
);
CREATE TABLE run_reports (
 tenant_id uuid NOT NULL, run_id uuid NOT NULL, report_key text NOT NULL, request_hash text NOT NULL,
 result_version bigint NOT NULL, lease_generation bigint NOT NULL, worker_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,run_id,report_key), FOREIGN KEY(tenant_id,run_id) REFERENCES agent_runs(tenant_id,id)
);
CREATE TABLE runtime_reservations (
 tenant_id uuid NOT NULL, id uuid NOT NULL, run_id uuid NOT NULL, task_id uuid, root_task_id uuid,
 reservation_key text NOT NULL, account_ids jsonb NOT NULL, currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 amount_microunits bigint NOT NULL CHECK(amount_microunits >= 0), actual_microunits bigint CHECK(actual_microunits >= 0),
 status text NOT NULL DEFAULT 'held' CHECK(status IN ('held','unknown','settled','released')), usage_key text, resolution_evidence jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,run_id,reservation_key),
 FOREIGN KEY(tenant_id,run_id) REFERENCES agent_runs(tenant_id,id), FOREIGN KEY(tenant_id,task_id) REFERENCES tasks(tenant_id,id), FOREIGN KEY(tenant_id,root_task_id) REFERENCES tasks(tenant_id,id)
);
CREATE TABLE runtime_usage_records (
 tenant_id uuid NOT NULL, id uuid NOT NULL, reservation_id uuid NOT NULL, usage_key text NOT NULL,
 actual_microunits bigint NOT NULL CHECK(actual_microunits >= 0), currency text NOT NULL,
 evidence jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,usage_key), UNIQUE(tenant_id,reservation_id),
 FOREIGN KEY(tenant_id,reservation_id) REFERENCES runtime_reservations(tenant_id,id)
);
${tables.map(table=>`
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
CREATE POLICY ${table}_tenant_isolation ON ${table}
 USING(tenant_id = NULLIF(current_setting('imbox.tenant_id', true), '')::uuid)
 WITH CHECK(tenant_id = NULLIF(current_setting('imbox.tenant_id', true), '')::uuid);
`).join('\n')}
`;
export const runtimeTableNames: readonly string[] = [...tables];
