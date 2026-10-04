/** Recent snapshots keep the same fixed head/ACL semantics with bounded initial materialization. */
export const recentSnapshotsSql = `
ALTER TABLE sync_snapshot_sessions ADD COLUMN window_mode text NOT NULL DEFAULT 'all' CHECK(window_mode IN ('all','recent')),
 ADD COLUMN history_truncated boolean NOT NULL DEFAULT false;
CREATE INDEX projections_recent_messages ON projections(tenant_id,stream_id,source_seq DESC,id DESC) WHERE entity_type='message' AND source_event_id IS NOT NULL;
`;
