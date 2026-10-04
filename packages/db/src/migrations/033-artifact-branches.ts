export const artifactBranchesSql = `
ALTER TABLE artifact_versions ADD UNIQUE(tenant_id,id,artifact_id);
CREATE TABLE artifact_branches (
 tenant_id uuid NOT NULL,id uuid NOT NULL,artifact_id uuid NOT NULL,base_version_id uuid NOT NULL,resource_id uuid NOT NULL,created_by uuid NOT NULL,
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','merged')),
 merged_version_id uuid,merged_against_version_id uuid,merged_by uuid,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,artifact_id) REFERENCES artifacts(tenant_id,id),
 FOREIGN KEY(tenant_id,base_version_id,artifact_id) REFERENCES artifact_versions(tenant_id,id,artifact_id),
 FOREIGN KEY(tenant_id,merged_version_id,artifact_id) REFERENCES artifact_versions(tenant_id,id,artifact_id),
 FOREIGN KEY(tenant_id,merged_against_version_id,artifact_id) REFERENCES artifact_versions(tenant_id,id,artifact_id),
 FOREIGN KEY(tenant_id,resource_id) REFERENCES resources(tenant_id,id),
 FOREIGN KEY(tenant_id,created_by) REFERENCES tenant_principals(tenant_id,principal_id),
 FOREIGN KEY(tenant_id,merged_by) REFERENCES tenant_principals(tenant_id,principal_id),
 CHECK((status='open' AND merged_version_id IS NULL AND merged_against_version_id IS NULL AND merged_by IS NULL) OR
       (status='merged' AND merged_version_id IS NOT NULL AND merged_against_version_id IS NOT NULL AND merged_by IS NOT NULL))
);
CREATE INDEX artifact_branches_listing ON artifact_branches(tenant_id,artifact_id,id);
ALTER TABLE artifact_branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_branches FORCE ROW LEVEL SECURITY;
CREATE POLICY artifact_branches_tenant ON artifact_branches USING(tenant_id=NULLIF(current_setting('imbox.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting('imbox.tenant_id',true),'')::uuid);
CREATE FUNCTION imbox_artifact_branch_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.status='merged' OR
 (NEW.tenant_id,NEW.id,NEW.artifact_id,NEW.base_version_id,NEW.resource_id,NEW.created_by,NEW.created_at) IS DISTINCT FROM
 (OLD.tenant_id,OLD.id,OLD.artifact_id,OLD.base_version_id,OLD.resource_id,OLD.created_by,OLD.created_at)
 THEN RAISE EXCEPTION 'Artifact branch content is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER artifact_branch_immutable BEFORE UPDATE OR DELETE ON artifact_branches FOR EACH ROW EXECUTE FUNCTION imbox_artifact_branch_immutable();
`;
export const artifactBranchTableNames = ['artifact_branches'] as const;
