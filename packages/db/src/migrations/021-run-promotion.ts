export const runPromotionSql=`
CREATE TABLE task_run_origins (
 tenant_id uuid NOT NULL,task_id uuid NOT NULL,run_id uuid NOT NULL,run_version bigint NOT NULL CHECK(run_version>0),
 conversation_id uuid NOT NULL,context_manifest_id uuid NOT NULL,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,task_id),UNIQUE(tenant_id,run_id),
 FOREIGN KEY(tenant_id,task_id) REFERENCES tasks(tenant_id,id),FOREIGN KEY(tenant_id,run_id) REFERENCES agent_runs(tenant_id,id),
 FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversations(tenant_id,id),FOREIGN KEY(tenant_id,context_manifest_id) REFERENCES context_manifests(tenant_id,id),
 FOREIGN KEY(tenant_id,created_by) REFERENCES tenant_principals(tenant_id,principal_id)
);
ALTER TABLE task_run_origins ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_run_origins FORCE ROW LEVEL SECURITY;
CREATE POLICY task_run_origins_tenant_isolation ON task_run_origins USING(tenant_id=NULLIF(current_setting('imbox.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting('imbox.tenant_id',true),'')::uuid);
`;
export const runPromotionTableNames=['task_run_origins'] as const;
