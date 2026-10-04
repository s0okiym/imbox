const tables = [
  'action_provider_receipt_bindings',
  'action_recovery_evidence',
  'action_recovery_tombstones',
  'action_recovery_operations',
] as const;
export const actionRecoverySql = `
ALTER TABLE action_reconciliation_cases ADD COLUMN version bigint NOT NULL DEFAULT 1 CHECK(version>0);
ALTER TABLE action_reconciliation_cases ADD COLUMN resolved_by uuid;
ALTER TABLE action_reconciliation_cases ADD FOREIGN KEY(tenant_id,resolved_by) REFERENCES tenant_principals(tenant_id,principal_id);
CREATE TABLE action_provider_receipt_bindings (
 tenant_id uuid NOT NULL,tool_id text NOT NULL,external_id text NOT NULL,action_id uuid NOT NULL,attempt_id uuid NOT NULL,
 fingerprint text NOT NULL,outcome text NOT NULL CHECK(outcome IN ('succeeded','no_effect')),actual_microunits bigint NOT NULL CHECK(actual_microunits>=0),
 PRIMARY KEY(tenant_id,tool_id,external_id)
);
INSERT INTO action_provider_receipt_bindings(tenant_id,tool_id,external_id,action_id,attempt_id,fingerprint,outcome,actual_microunits)
 SELECT tenant_id,tool_id,external_id,action_id,attempt_id,fingerprint,status,actual_microunits FROM action_receipts;
CREATE TABLE action_recovery_evidence (
 tenant_id uuid NOT NULL,id uuid NOT NULL,case_id uuid NOT NULL,intent_hash text NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('succeeded','no_effect','unknown')),observation jsonb NOT NULL,
 evidence_hash text NOT NULL,looked_up_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,case_id) REFERENCES action_reconciliation_cases(tenant_id,id),
 FOREIGN KEY(tenant_id,looked_up_by) REFERENCES tenant_principals(tenant_id,principal_id)
);
CREATE INDEX action_recovery_evidence_case_idx ON action_recovery_evidence(tenant_id,case_id,created_at,id);
CREATE TABLE action_recovery_tombstones (
 tenant_id uuid NOT NULL,attempt_id uuid NOT NULL,action_id uuid NOT NULL,business_key text NOT NULL,case_id uuid NOT NULL,evidence_id uuid NOT NULL,
 intent_hash text NOT NULL,tool_id text NOT NULL,receipt_id text NOT NULL,outcome text NOT NULL CHECK(outcome IN ('succeeded','no_effect')),
 currency text NOT NULL,actual_microunits bigint NOT NULL CHECK(actual_microunits>=0),budget_account_ids jsonb NOT NULL,confirmed_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,attempt_id),UNIQUE(tenant_id,case_id),
 FOREIGN KEY(tenant_id,case_id) REFERENCES action_reconciliation_cases(tenant_id,id),FOREIGN KEY(tenant_id,evidence_id) REFERENCES action_recovery_evidence(tenant_id,id),
 FOREIGN KEY(tenant_id,confirmed_by) REFERENCES tenant_principals(tenant_id,principal_id),
 FOREIGN KEY(tenant_id,tool_id,receipt_id) REFERENCES action_provider_receipt_bindings(tenant_id,tool_id,external_id)
);
CREATE INDEX action_recovery_tombstones_business_key_idx ON action_recovery_tombstones(tenant_id,business_key);
CREATE TABLE action_recovery_operations (
 tenant_id uuid NOT NULL,id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('freeze','confirm','unfreeze')),
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','completed')),authorized_by uuid NOT NULL,principal_version bigint NOT NULL,authz_revision bigint NOT NULL,
 reason text NOT NULL,journal_record jsonb NOT NULL,journal_digest text,freeze_digest text,fence_revision bigint,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz,
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,authorized_by) REFERENCES tenant_principals(tenant_id,principal_id)
);
${tables
  .map(
    (table) => `
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
CREATE POLICY ${table}_tenant_isolation ON ${table}
 USING(tenant_id=NULLIF(current_setting('imbox.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('imbox.tenant_id',true),'')::uuid);
`,
  )
  .join('\n')}
`;
export const actionRecoveryTableNames = [...tables];
