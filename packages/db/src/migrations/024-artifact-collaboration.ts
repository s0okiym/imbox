const tables = ['artifact_comments', 'artifact_shares'] as const;
export const artifactCollaborationSql = `
ALTER TABLE artifact_versions ADD CONSTRAINT artifact_versions_identity UNIQUE(tenant_id,id,artifact_id);
CREATE TABLE artifact_comments (
 tenant_id uuid NOT NULL,id uuid NOT NULL,artifact_id uuid NOT NULL,version_id uuid NOT NULL,resource_sha256 text NOT NULL CHECK(resource_sha256~'^[a-f0-9]{64}$'),created_by uuid NOT NULL,
 anchor jsonb NOT NULL,body text NOT NULL CHECK(length(body)<=4000),version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),deleted_at timestamptz,
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,version_id,artifact_id) REFERENCES artifact_versions(tenant_id,id,artifact_id),FOREIGN KEY(tenant_id,created_by) REFERENCES tenant_principals(tenant_id,principal_id)
);
CREATE INDEX artifact_comments_version ON artifact_comments(tenant_id,version_id,id);
CREATE FUNCTION imbox_comment_anchor_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (OLD.artifact_id,OLD.version_id,OLD.resource_sha256,OLD.created_by,OLD.anchor) IS DISTINCT FROM (NEW.artifact_id,NEW.version_id,NEW.resource_sha256,NEW.created_by,NEW.anchor) THEN RAISE EXCEPTION 'Comment anchors are immutable' USING ERRCODE='23514'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER artifact_comment_anchor_immutable BEFORE UPDATE ON artifact_comments FOR EACH ROW EXECUTE FUNCTION imbox_comment_anchor_immutable();
CREATE TABLE artifact_shares (
 tenant_id uuid NOT NULL,id uuid NOT NULL,artifact_id uuid NOT NULL,version_id uuid NOT NULL,resource_sha256 text NOT NULL CHECK(resource_sha256~'^[a-f0-9]{64}$'),created_by uuid NOT NULL,
 recipient_principal_id uuid,target_conversation_id uuid,target_task_id uuid,
 source_authorization jsonb NOT NULL,target_authorization jsonb NOT NULL,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),revoked_at timestamptz,
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,version_id,artifact_id) REFERENCES artifact_versions(tenant_id,id,artifact_id),FOREIGN KEY(tenant_id,created_by) REFERENCES tenant_principals(tenant_id,principal_id),
 FOREIGN KEY(tenant_id,recipient_principal_id) REFERENCES tenant_principals(tenant_id,principal_id),FOREIGN KEY(tenant_id,target_conversation_id) REFERENCES conversations(tenant_id,id),FOREIGN KEY(tenant_id,target_task_id) REFERENCES tasks(tenant_id,id),
 CHECK((recipient_principal_id IS NOT NULL)::integer+(target_conversation_id IS NOT NULL)::integer+(target_task_id IS NOT NULL)::integer=1),CHECK(expires_at>created_at AND expires_at<=created_at+interval '24 hours')
);
CREATE INDEX artifact_shares_recipient ON artifact_shares(tenant_id,recipient_principal_id,id) WHERE status='active';
CREATE FUNCTION imbox_share_scope_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (OLD.artifact_id,OLD.version_id,OLD.resource_sha256,OLD.created_by,OLD.recipient_principal_id,OLD.target_conversation_id,OLD.target_task_id,OLD.source_authorization,OLD.target_authorization,OLD.expires_at) IS DISTINCT FROM (NEW.artifact_id,NEW.version_id,NEW.resource_sha256,NEW.created_by,NEW.recipient_principal_id,NEW.target_conversation_id,NEW.target_task_id,NEW.source_authorization,NEW.target_authorization,NEW.expires_at) OR (OLD.status='revoked' AND NEW.status<>'revoked') THEN RAISE EXCEPTION 'Share scope and revocation are immutable' USING ERRCODE='23514'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER artifact_share_scope_immutable BEFORE UPDATE ON artifact_shares FOR EACH ROW EXECUTE FUNCTION imbox_share_scope_immutable();
${tables.map((table) => `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY; CREATE POLICY ${table}_tenant_isolation ON ${table} USING(tenant_id=NULLIF(current_setting('imbox.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting('imbox.tenant_id',true),'')::uuid);`).join('\n')}
`;
export const artifactCollaborationTableNames: readonly string[] = [...tables];
