export const taskMaintenanceSql=`
INSERT INTO principals(id,kind,display_name) VALUES('00000000-0000-4000-8000-000000000001','service','Imbox maintenance');
CREATE TABLE task_escalations (
 tenant_id uuid NOT NULL,id uuid NOT NULL,task_id uuid NOT NULL,workspace_id uuid NOT NULL,unavailable_owner_id uuid NOT NULL,assigned_to uuid,
 task_epoch bigint NOT NULL,reason text NOT NULL CHECK(reason IN ('owner_unavailable','execution_deadline')),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),resolved_at timestamptz,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,task_id,task_epoch,reason),
 FOREIGN KEY(tenant_id,task_id) REFERENCES tasks(tenant_id,id),FOREIGN KEY(tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id),
 FOREIGN KEY(tenant_id,unavailable_owner_id) REFERENCES tenant_principals(tenant_id,principal_id),FOREIGN KEY(tenant_id,assigned_to) REFERENCES tenant_principals(tenant_id,principal_id)
);
ALTER TABLE task_escalations ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_escalations FORCE ROW LEVEL SECURITY;
CREATE POLICY task_escalations_tenant_isolation ON task_escalations USING(tenant_id=NULLIF(current_setting('imbox.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting('imbox.tenant_id',true),'')::uuid);
`;
export const taskMaintenanceTableNames=['task_escalations'] as const;
