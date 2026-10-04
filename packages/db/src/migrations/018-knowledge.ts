const tables = [
  'resource_text_documents',
  'memory_items',
  'memory_revisions',
  'memory_sources',
  'knowledge_deletion_receipts',
] as const;
export const knowledgeSql = `
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE FUNCTION imbox_search_normalize(value text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT lower(regexp_replace(normalize(value,NFKC),'[[:space:]]+',' ','g')) $$;
CREATE TABLE resource_text_documents (
 tenant_id uuid NOT NULL,resource_id uuid NOT NULL,resource_version bigint NOT NULL CHECK(resource_version>0),sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),
 body text NOT NULL CHECK(octet_length(body)<=8388608),normalized text GENERATED ALWAYS AS (imbox_search_normalize(body)) STORED,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,resource_id),FOREIGN KEY(tenant_id,resource_id) REFERENCES resources(tenant_id,id)
);
CREATE INDEX resource_text_search ON resource_text_documents USING gin(normalized gin_trgm_ops);
CREATE TABLE memory_items (
 tenant_id uuid NOT NULL,id uuid NOT NULL,created_by uuid NOT NULL,scope text NOT NULL CHECK(scope IN ('personal','conversation','task')),conversation_id uuid,task_id uuid,
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),status text NOT NULL CHECK(status IN ('active','disabled','restricted','deleted')),
 confirmation text NOT NULL CHECK(confirmation IN ('confirmed','needs_confirmation','conflicted')),confidence integer NOT NULL CHECK(confidence BETWEEN 0 AND 100),expires_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),deleted_at timestamptz,
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,created_by) REFERENCES tenant_principals(tenant_id,principal_id),
 FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversations(tenant_id,id),FOREIGN KEY(tenant_id,task_id) REFERENCES tasks(tenant_id,id),
 CHECK((scope='personal' AND conversation_id IS NULL AND task_id IS NULL) OR (scope='conversation' AND conversation_id IS NOT NULL AND task_id IS NULL) OR (scope='task' AND task_id IS NOT NULL AND conversation_id IS NULL))
);
CREATE TABLE memory_revisions (
 tenant_id uuid NOT NULL,memory_id uuid NOT NULL,version bigint NOT NULL CHECK(version>0),body text NOT NULL CHECK(length(body)<=32000),sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),
 normalized text GENERATED ALWAYS AS (imbox_search_normalize(body)) STORED,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),redacted_at timestamptz,
 PRIMARY KEY(tenant_id,memory_id,version),FOREIGN KEY(tenant_id,memory_id) REFERENCES memory_items(tenant_id,id),FOREIGN KEY(tenant_id,created_by) REFERENCES tenant_principals(tenant_id,principal_id)
);
CREATE INDEX memory_text_search ON memory_revisions USING gin(normalized gin_trgm_ops);
CREATE TABLE memory_sources (
 tenant_id uuid NOT NULL,memory_id uuid NOT NULL,memory_version bigint NOT NULL,ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 20),
 source_message_id uuid,source_task_id uuid,source_artifact_version_id uuid,source_version bigint NOT NULL CHECK(source_version>0),sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),authorization_fence jsonb NOT NULL,
 PRIMARY KEY(tenant_id,memory_id,memory_version,ordinal),FOREIGN KEY(tenant_id,memory_id,memory_version) REFERENCES memory_revisions(tenant_id,memory_id,version),
 FOREIGN KEY(tenant_id,source_message_id) REFERENCES messages(tenant_id,id),FOREIGN KEY(tenant_id,source_task_id) REFERENCES tasks(tenant_id,id),FOREIGN KEY(tenant_id,source_artifact_version_id) REFERENCES artifact_versions(tenant_id,id),
 CHECK((source_message_id IS NOT NULL)::integer+(source_task_id IS NOT NULL)::integer+(source_artifact_version_id IS NOT NULL)::integer=1)
);
CREATE INDEX memory_source_messages ON memory_sources(tenant_id,source_message_id);
CREATE INDEX memory_source_tasks ON memory_sources(tenant_id,source_task_id);
CREATE INDEX memory_source_artifacts ON memory_sources(tenant_id,source_artifact_version_id);
CREATE TABLE knowledge_deletion_receipts (
 tenant_id uuid NOT NULL,id uuid NOT NULL,memory_id uuid,resource_id uuid,reason text NOT NULL CHECK(reason IN ('explicit','source_unavailable','expired')),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,memory_id) REFERENCES memory_items(tenant_id,id),FOREIGN KEY(tenant_id,resource_id) REFERENCES resources(tenant_id,id),
 CHECK((memory_id IS NOT NULL)::integer+(resource_id IS NOT NULL)::integer=1)
);
CREATE INDEX message_body_search ON messages USING gin(imbox_search_normalize(body) gin_trgm_ops) WHERE deleted_at IS NULL;
CREATE INDEX task_text_search ON tasks USING gin(imbox_search_normalize(title||' '||goal||' '||acceptance_criteria::text) gin_trgm_ops);
${tables.map((table) => `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY; CREATE POLICY ${table}_tenant_isolation ON ${table} USING(tenant_id=NULLIF(current_setting('imbox.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting('imbox.tenant_id',true),'')::uuid);`).join('\n')}
`;
export const knowledgeTableNames: readonly string[] = [...tables];
