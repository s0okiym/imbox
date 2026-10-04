export const agentDeliverySql = `
CREATE TABLE agent_request_deliveries (
 tenant_id uuid NOT NULL,id uuid NOT NULL,request_id uuid NOT NULL,proposal_version bigint NOT NULL,recipient_id uuid NOT NULL,received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,request_id,proposal_version,recipient_id),
 FOREIGN KEY(tenant_id,request_id,proposal_version) REFERENCES request_proposals(tenant_id,request_id,proposal_version),
 FOREIGN KEY(tenant_id,recipient_id) REFERENCES tenant_principals(tenant_id,principal_id)
);
ALTER TABLE agent_request_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_request_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_request_deliveries_tenant_isolation ON agent_request_deliveries USING(tenant_id=NULLIF(current_setting('imbox.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting('imbox.tenant_id',true),'')::uuid);
`;
export const agentDeliveryTableNames = ['agent_request_deliveries'] as const;
