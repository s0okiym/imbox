export const messageResourcesSql=`
CREATE TABLE message_resources (
 tenant_id uuid NOT NULL,message_id uuid NOT NULL,resource_id uuid NOT NULL,resource_version bigint NOT NULL CHECK(resource_version>0),ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 10),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,message_id,ordinal),UNIQUE(tenant_id,message_id,resource_id),
 FOREIGN KEY(tenant_id,message_id) REFERENCES messages(tenant_id,id),FOREIGN KEY(tenant_id,resource_id) REFERENCES resources(tenant_id,id)
);
CREATE INDEX message_resources_source ON message_resources(tenant_id,resource_id);
ALTER TABLE message_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_resources FORCE ROW LEVEL SECURITY;
CREATE POLICY message_resources_tenant_isolation ON message_resources USING(tenant_id=NULLIF(current_setting('imbox.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting('imbox.tenant_id',true),'')::uuid);
`;
export const messageResourceTableNames:readonly string[]=['message_resources'];
