/** Block legacy execution writers without rewriting historical authority or outcomes. */
export const connectorBindingFenceSql = `
CREATE FUNCTION enforce_action_connector_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE binding text; attempt_status text;
BEGIN
  IF TG_TABLE_NAME = 'capability_grants' THEN
    SELECT authority_snapshot->>'tool_binding' INTO binding
      FROM capability_grants WHERE tenant_id=NEW.tenant_id AND id=NEW.id;
    IF NOT FOUND THEN RETURN NULL; END IF;
  ELSE
    SELECT g.authority_snapshot->>'tool_binding', p.status INTO binding, attempt_status
      FROM action_attempts p
      JOIN actions a ON a.tenant_id=p.tenant_id AND a.id=p.action_id
      JOIN capability_grants g ON g.tenant_id=a.tenant_id AND g.id=a.grant_id
      WHERE p.tenant_id=NEW.tenant_id AND p.id=NEW.id;
    IF NOT FOUND OR attempt_status NOT IN ('prepared','in_flight') THEN RETURN NULL; END IF;
  END IF;
  IF binding IS NULL OR binding !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Action connector binding required'
      USING ERRCODE='23514', CONSTRAINT='action_connector_binding_required';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER capability_grants_connector_binding
  AFTER INSERT ON capability_grants DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_action_connector_binding();
CREATE CONSTRAINT TRIGGER action_attempts_connector_binding
  AFTER INSERT OR UPDATE ON action_attempts DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_action_connector_binding();
`;
