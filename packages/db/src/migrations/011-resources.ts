const tables=['resource_uploads','resources','artifacts','artifact_versions','resource_links','resource_cleanup_jobs'] as const;
export const resourcesSql=`
CREATE TABLE resource_uploads (
 tenant_id uuid NOT NULL,id uuid NOT NULL,resource_id uuid NOT NULL,created_by uuid NOT NULL,
 conversation_id uuid,task_id uuid,filename text NOT NULL,content_type text NOT NULL,byte_size integer NOT NULL CHECK(byte_size BETWEEN 0 AND 8388608),sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),
 staging_key text NOT NULL,object_key text NOT NULL,authorization_fence jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','verifying','ready','rejected','expired')),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),verification_generation bigint NOT NULL DEFAULT 0,verification_expires_at timestamptz,
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,resource_id),UNIQUE(tenant_id,staging_key),UNIQUE(tenant_id,object_key),
 FOREIGN KEY(tenant_id,created_by) REFERENCES tenant_principals(tenant_id,principal_id),
 FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversations(tenant_id,id),FOREIGN KEY(tenant_id,task_id) REFERENCES tasks(tenant_id,id),
 CHECK((conversation_id IS NOT NULL)::integer+(task_id IS NOT NULL)::integer=1)
);
CREATE TABLE resources (
 tenant_id uuid NOT NULL,id uuid NOT NULL,upload_id uuid NOT NULL,created_by uuid NOT NULL,conversation_id uuid,task_id uuid,
 filename text NOT NULL,content_type text NOT NULL,byte_size integer NOT NULL CHECK(byte_size BETWEEN 0 AND 8388608),sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),object_key text NOT NULL,
 scan_state text NOT NULL CHECK(scan_state='approved'),scan_evidence jsonb NOT NULL,
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),authz_generation bigint NOT NULL DEFAULT 1 CHECK(authz_generation>0),
 created_at timestamptz NOT NULL,deleted_at timestamptz,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,upload_id),UNIQUE(tenant_id,object_key),
 FOREIGN KEY(tenant_id,upload_id) REFERENCES resource_uploads(tenant_id,id),FOREIGN KEY(tenant_id,created_by) REFERENCES tenant_principals(tenant_id,principal_id),
 FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversations(tenant_id,id),FOREIGN KEY(tenant_id,task_id) REFERENCES tasks(tenant_id,id),
 CHECK((conversation_id IS NOT NULL)::integer+(task_id IS NOT NULL)::integer=1)
);
CREATE TABLE artifacts (
 tenant_id uuid NOT NULL,id uuid NOT NULL,created_by uuid NOT NULL,conversation_id uuid,task_id uuid,title text NOT NULL,kind text NOT NULL CHECK(kind IN ('text','markdown','file')),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),head_version bigint NOT NULL DEFAULT 1 CHECK(head_version>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,created_by) REFERENCES tenant_principals(tenant_id,principal_id),
 FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversations(tenant_id,id),FOREIGN KEY(tenant_id,task_id) REFERENCES tasks(tenant_id,id),
 CHECK((conversation_id IS NOT NULL)::integer+(task_id IS NOT NULL)::integer=1)
);
CREATE TABLE artifact_versions (
 tenant_id uuid NOT NULL,id uuid NOT NULL,artifact_id uuid NOT NULL,version bigint NOT NULL CHECK(version>0),resource_id uuid NOT NULL,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,artifact_id,version),
 FOREIGN KEY(tenant_id,artifact_id) REFERENCES artifacts(tenant_id,id),FOREIGN KEY(tenant_id,resource_id) REFERENCES resources(tenant_id,id),FOREIGN KEY(tenant_id,created_by) REFERENCES tenant_principals(tenant_id,principal_id)
);
CREATE INDEX artifact_versions_resource ON artifact_versions(tenant_id,resource_id);
CREATE FUNCTION imbox_artifact_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Artifact versions are immutable' USING ERRCODE='23514'; END;
$$;
CREATE TRIGGER artifact_version_immutable BEFORE UPDATE OR DELETE ON artifact_versions FOR EACH ROW EXECUTE FUNCTION imbox_artifact_version_immutable();

CREATE TABLE resource_links (
 tenant_id uuid NOT NULL,source_resource_id uuid NOT NULL,target_artifact_version_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,source_resource_id,target_artifact_version_id),FOREIGN KEY(tenant_id,source_resource_id) REFERENCES resources(tenant_id,id),FOREIGN KEY(tenant_id,target_artifact_version_id) REFERENCES artifact_versions(tenant_id,id)
);
CREATE TABLE resource_cleanup_jobs (
 tenant_id uuid NOT NULL,id uuid NOT NULL,object_key text NOT NULL,upload_id uuid,resource_id uuid,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done')),lease_generation bigint NOT NULL DEFAULT 0,lease_expires_at timestamptz,attempts integer NOT NULL DEFAULT 0,last_error text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,object_key),FOREIGN KEY(tenant_id,upload_id) REFERENCES resource_uploads(tenant_id,id),FOREIGN KEY(tenant_id,resource_id) REFERENCES resources(tenant_id,id)
);
${tables.map(table=>`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
CREATE POLICY ${table}_tenant_isolation ON ${table} USING(tenant_id=NULLIF(current_setting('imbox.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting('imbox.tenant_id',true),'')::uuid);`).join('\n')}
`;
export const resourceTableNames:readonly string[]=[...tables];
