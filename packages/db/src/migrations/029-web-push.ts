export const webPushSql = `
ALTER TABLE notification_devices ADD COLUMN subscription_ciphertext text, ADD COLUMN endpoint_fingerprint text, ADD COLUMN push_checked_at timestamptz NOT NULL DEFAULT '-infinity';
CREATE UNIQUE INDEX notification_endpoint_binding ON notification_devices(tenant_id,endpoint_fingerprint) WHERE endpoint_fingerprint IS NOT NULL;
ALTER TABLE notification_deliveries ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5), ADD COLUMN device_version bigint;
CREATE INDEX notification_push_scan ON notification_devices(tenant_id,push_checked_at,id) WHERE enabled AND subscription_ciphertext IS NOT NULL;
`;
