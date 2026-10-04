/** Durable Action authority. Independent journal is deliberately outside this database. */
const tables=['capability_grants','actions','action_attempts','action_approvals','action_budget_reservations','action_receipts','action_reconciliation_cases','action_safety_fences'] as const;
export const actionsSql=`
CREATE TABLE capability_grants (
 tenant_id uuid NOT NULL,id uuid NOT NULL,task_id uuid NOT NULL,executor_principal_id uuid NOT NULL,
 issued_by uuid NOT NULL,tool_id text NOT NULL,tool_version text NOT NULL,target_id text NOT NULL,
 allow_execute boolean NOT NULL,allow_disclosure boolean NOT NULL,resource_versions jsonb NOT NULL,
 approver_ids jsonb NOT NULL,currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),limit_microunits bigint NOT NULL CHECK(limit_microunits>=0),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),revoked_at timestamptz,
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,task_id) REFERENCES tasks(tenant_id,id),
 FOREIGN KEY(tenant_id,executor_principal_id) REFERENCES tenant_principals(tenant_id,principal_id),
 FOREIGN KEY(tenant_id,issued_by) REFERENCES tenant_principals(tenant_id,principal_id)
);
CREATE TABLE actions (
 tenant_id uuid NOT NULL,id uuid NOT NULL,task_id uuid NOT NULL,root_task_id uuid NOT NULL,
 requester_id uuid NOT NULL,requester_revision bigint NOT NULL,executor_id uuid NOT NULL,executor_revision bigint NOT NULL,
 executor_installation_id uuid,executor_installation_revision bigint,
 grant_id uuid NOT NULL,grant_revision bigint NOT NULL,ancestor_fences jsonb NOT NULL,resource_versions jsonb NOT NULL,
 tool_id text NOT NULL,tool_version text NOT NULL,target_id text NOT NULL,parameters jsonb NOT NULL,fingerprint text NOT NULL,
 business_key text NOT NULL,status text NOT NULL CHECK(status IN ('proposed','awaiting_approval','ready','executing','succeeded','failed','unknown','cancelled')),
 version bigint NOT NULL CHECK(version>0),approval_binding_version bigint NOT NULL,approval_required boolean NOT NULL,
 required boolean NOT NULL DEFAULT true,attempt_count integer NOT NULL DEFAULT 0,last_attempt_id uuid,next_attempt_at timestamptz,
 lease_holder text,lease_generation bigint NOT NULL DEFAULT 0,lease_expires_at timestamptz,
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),estimate_microunits bigint NOT NULL CHECK(estimate_microunits>=0),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,business_key),
 FOREIGN KEY(tenant_id,task_id) REFERENCES tasks(tenant_id,id),FOREIGN KEY(tenant_id,root_task_id) REFERENCES tasks(tenant_id,id),
 FOREIGN KEY(tenant_id,requester_id) REFERENCES tenant_principals(tenant_id,principal_id),FOREIGN KEY(tenant_id,executor_id) REFERENCES tenant_principals(tenant_id,principal_id),
 FOREIGN KEY(tenant_id,grant_id) REFERENCES capability_grants(tenant_id,id)
);
CREATE INDEX actions_ready_idx ON actions(tenant_id,status,next_attempt_at,created_at);
CREATE TABLE action_attempts (
 tenant_id uuid NOT NULL,id uuid NOT NULL,action_id uuid NOT NULL,attempt_no integer NOT NULL CHECK(attempt_no>0),
 version bigint NOT NULL DEFAULT 1,status text NOT NULL CHECK(status IN ('prepared','in_flight','succeeded','failed','unknown','cancelled')),
 side_effect text NOT NULL CHECK(side_effect IN ('not_attempted','none','possible','confirmed')),
 lease_generation bigint NOT NULL,fingerprint text NOT NULL,journal_intent_id uuid,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,action_id,attempt_no),FOREIGN KEY(tenant_id,action_id) REFERENCES actions(tenant_id,id)
);
CREATE TABLE action_approvals (
 tenant_id uuid NOT NULL,id uuid NOT NULL,action_id uuid NOT NULL,action_version bigint NOT NULL,fingerprint text NOT NULL,target_id text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','revoked')),
 expires_at timestamptz NOT NULL,decided_by uuid,decided_at timestamptz,comment text,consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,action_id,action_version),
 FOREIGN KEY(tenant_id,action_id) REFERENCES actions(tenant_id,id),FOREIGN KEY(tenant_id,decided_by) REFERENCES tenant_principals(tenant_id,principal_id)
);
CREATE TABLE action_budget_reservations (
 tenant_id uuid NOT NULL,id uuid NOT NULL,action_id uuid NOT NULL,attempt_id uuid NOT NULL,task_id uuid NOT NULL,account_ids jsonb NOT NULL,
 currency text NOT NULL,amount_microunits bigint NOT NULL CHECK(amount_microunits>=0),actual_microunits bigint CHECK(actual_microunits>=0),
 status text NOT NULL DEFAULT 'held' CHECK(status IN ('held','unknown','settled','released')),usage_key text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,attempt_id),
 FOREIGN KEY(tenant_id,action_id) REFERENCES actions(tenant_id,id),FOREIGN KEY(tenant_id,attempt_id) REFERENCES action_attempts(tenant_id,id),FOREIGN KEY(tenant_id,task_id) REFERENCES tasks(tenant_id,id)
);
CREATE TABLE action_receipts (
 tenant_id uuid NOT NULL,id uuid NOT NULL,action_id uuid NOT NULL,attempt_id uuid NOT NULL,tool_id text NOT NULL,external_id text NOT NULL,
 fingerprint text NOT NULL,status text NOT NULL CHECK(status IN ('succeeded','no_effect')),actual_microunits bigint NOT NULL CHECK(actual_microunits>=0),
 evidence_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,tool_id,external_id),
 FOREIGN KEY(tenant_id,action_id) REFERENCES actions(tenant_id,id),FOREIGN KEY(tenant_id,attempt_id) REFERENCES action_attempts(tenant_id,id)
);
CREATE TABLE action_reconciliation_cases (
 tenant_id uuid NOT NULL,id uuid NOT NULL,action_id uuid NOT NULL,attempt_id uuid NOT NULL,reason text NOT NULL,
 journal_record jsonb,status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
 created_at timestamptz NOT NULL DEFAULT now(),resolved_at timestamptz,PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,attempt_id)
 -- No Action FK: a database recovery may have lost the entire Action.
);
CREATE TABLE action_safety_fences (
 tenant_id uuid PRIMARY KEY REFERENCES tenants(id),frozen boolean NOT NULL DEFAULT false,revision bigint NOT NULL DEFAULT 1,
 reason text,updated_at timestamptz NOT NULL DEFAULT now()
);
${tables.map(table=>`
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
CREATE POLICY ${table}_tenant_isolation ON ${table}
 USING(tenant_id=NULLIF(current_setting('imbox.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('imbox.tenant_id',true),'')::uuid);
`).join('\n')}
`;
export const actionTableNames:readonly string[]=[...tables];
