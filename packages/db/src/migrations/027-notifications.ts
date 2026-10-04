const tables = [
  'notification_event_queue',
  'notification_intents',
  'notification_preferences',
  'notification_mutes',
  'notification_devices',
  'notification_deliveries',
] as const;
export const notificationsSql = `
CREATE TABLE notification_event_queue (
 tenant_id uuid NOT NULL,event_id uuid NOT NULL,after_recipient uuid,status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz,
 PRIMARY KEY(tenant_id,event_id),FOREIGN KEY(tenant_id,event_id) REFERENCES domain_events(tenant_id,id)
);
CREATE INDEX notification_events_pending ON notification_event_queue(tenant_id,created_at,event_id) WHERE status='pending';
CREATE TABLE notification_intents (
 tenant_id uuid NOT NULL,id uuid NOT NULL,recipient_id uuid NOT NULL,topic_key text NOT NULL,
 category text NOT NULL CHECK(category IN ('message','task','request','action','run')),
 source_kind text NOT NULL CHECK(source_kind IN ('message','task','request','action','run')),source_id uuid NOT NULL,source_version bigint NOT NULL CHECK(source_version>0),ordering_version bigint NOT NULL CHECK(ordering_version>0),
 authorization_fence jsonb NOT NULL,version bigint NOT NULL DEFAULT 1 CHECK(version>0),read_version bigint NOT NULL DEFAULT 0 CHECK(read_version>=0 AND read_version<=version),
 event_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,recipient_id,topic_key),
 FOREIGN KEY(tenant_id,recipient_id) REFERENCES tenant_principals(tenant_id,principal_id),FOREIGN KEY(tenant_id,event_id) REFERENCES domain_events(tenant_id,id)
);
CREATE INDEX notification_recipient_page ON notification_intents(tenant_id,recipient_id,id);
CREATE TABLE notification_preferences (
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,version bigint NOT NULL DEFAULT 1,
 categories jsonb NOT NULL DEFAULT '{"message":true,"task":true,"request":true,"action":true,"run":true}',
 dnd_enabled boolean NOT NULL DEFAULT false,dnd_timezone text NOT NULL DEFAULT 'UTC',dnd_start integer NOT NULL DEFAULT 1320 CHECK(dnd_start BETWEEN 0 AND 1439),dnd_end integer NOT NULL DEFAULT 480 CHECK(dnd_end BETWEEN 0 AND 1439),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,principal_id),FOREIGN KEY(tenant_id,principal_id) REFERENCES tenant_principals(tenant_id,principal_id)
);
CREATE TABLE notification_mutes (
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,conversation_id uuid NOT NULL,muted boolean NOT NULL DEFAULT true,
 PRIMARY KEY(tenant_id,principal_id,conversation_id),FOREIGN KEY(tenant_id,principal_id) REFERENCES tenant_principals(tenant_id,principal_id),FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversations(tenant_id,id)
);
CREATE TABLE notification_devices (
 tenant_id uuid NOT NULL,id uuid NOT NULL,principal_id uuid NOT NULL,session_id uuid NOT NULL,enabled boolean NOT NULL DEFAULT false,version bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,principal_id,session_id),FOREIGN KEY(tenant_id,principal_id) REFERENCES tenant_principals(tenant_id,principal_id)
 -- Global identity sessions are intentionally not granted to application role; a session port validates the binding.
);
CREATE TABLE notification_deliveries (
 tenant_id uuid NOT NULL,id uuid NOT NULL,device_id uuid NOT NULL,notification_id uuid NOT NULL,notification_version bigint NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','delivered','invalid')),lease_token uuid,lease_expires_at timestamptz,
 available_at timestamptz NOT NULL DEFAULT clock_timestamp(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),delivered_at timestamptz,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,device_id,notification_id,notification_version),FOREIGN KEY(tenant_id,device_id) REFERENCES notification_devices(tenant_id,id),FOREIGN KEY(tenant_id,notification_id) REFERENCES notification_intents(tenant_id,id)
);
CREATE INDEX notification_delivery_queue ON notification_deliveries(tenant_id,device_id,available_at) WHERE status IN ('pending','leased');
${tables.map((table) => `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY; CREATE POLICY ${table}_tenant_isolation ON ${table} USING(tenant_id=NULLIF(current_setting('imbox.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting('imbox.tenant_id',true),'')::uuid);`).join('\n')}
CREATE FUNCTION imbox_enqueue_notification_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO notification_event_queue(tenant_id,event_id) VALUES(NEW.tenant_id,NEW.id) ON CONFLICT DO NOTHING; RETURN NEW; END; $$;
CREATE TRIGGER domain_event_notification_queue AFTER INSERT ON domain_events FOR EACH ROW EXECUTE FUNCTION imbox_enqueue_notification_event();
`;
export const notificationTableNames: readonly string[] = [...tables];
