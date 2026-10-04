/** One explicitly authorized tool intention per Run. All links retain tenant identity. */
export const runtimeToolIntentsSql = `
ALTER TABLE agent_runs ADD COLUMN tool_grant_id uuid,
 ADD COLUMN tool_grant_revision bigint,
 ADD CONSTRAINT agent_runs_tool_grant_fk FOREIGN KEY(tenant_id,tool_grant_id) REFERENCES capability_grants(tenant_id,id),
 ADD CONSTRAINT agent_runs_tool_grant_pair CHECK((tool_grant_id IS NULL)=(tool_grant_revision IS NULL));
ALTER TABLE actions ADD COLUMN run_id uuid,
 ADD CONSTRAINT actions_run_fk FOREIGN KEY(tenant_id,run_id) REFERENCES agent_runs(tenant_id,id);
ALTER TABLE action_budget_reservations ADD COLUMN run_id uuid,
 ADD CONSTRAINT action_reservation_run_fk FOREIGN KEY(tenant_id,run_id) REFERENCES agent_runs(tenant_id,id);
ALTER TABLE action_recovery_tombstones ADD COLUMN run_id uuid,
 ADD CONSTRAINT recovery_tombstone_run_fk FOREIGN KEY(tenant_id,run_id) REFERENCES agent_runs(tenant_id,id);
CREATE TABLE run_tool_intents (
 tenant_id uuid NOT NULL,run_id uuid NOT NULL,action_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 lease_generation bigint NOT NULL CHECK(lease_generation>0),lease_holder text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,run_id),UNIQUE(tenant_id,action_id),
 FOREIGN KEY(tenant_id,run_id) REFERENCES agent_runs(tenant_id,id),
 FOREIGN KEY(tenant_id,action_id) REFERENCES actions(tenant_id,id)
);
CREATE INDEX actions_run ON actions(tenant_id,run_id) WHERE run_id IS NOT NULL;
ALTER TABLE run_tool_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_tool_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY run_tool_intents_tenant_isolation ON run_tool_intents
 USING(tenant_id=NULLIF(current_setting('imbox.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('imbox.tenant_id',true),'')::uuid);
`;
export const runtimeToolIntentTableNames: readonly string[] = ['run_tool_intents'];
