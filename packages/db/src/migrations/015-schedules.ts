const tables = ['schedules', 'schedule_occurrences'] as const;
export const schedulesSql = `
CREATE TABLE schedules (
 tenant_id uuid NOT NULL,id uuid NOT NULL,created_by uuid NOT NULL,creator_authz_revision bigint NOT NULL,creator_principal_version bigint NOT NULL,
 task_id uuid NOT NULL,run_id uuid NOT NULL,root_task_id uuid NOT NULL,
 timezone text NOT NULL CHECK(length(timezone) BETWEEN 1 AND 100),trigger jsonb NOT NULL CHECK(trigger->>'kind' IN ('once','daily')),
 start_at timestamptz NOT NULL,deadline timestamptz NOT NULL,
 missed_policy text NOT NULL CHECK(missed_policy IN ('skip','coalesce')),overlap_policy text NOT NULL DEFAULT 'forbid' CHECK(overlap_policy='forbid'),
 maximum_wakeups integer NOT NULL CHECK(maximum_wakeups BETWEEN 1 AND 1000),occurrences_created integer NOT NULL DEFAULT 0 CHECK(occurrences_created >= 0),
 missed_count integer NOT NULL DEFAULT 0 CHECK(missed_count >= 0),next_at timestamptz,
 status text NOT NULL DEFAULT 'enabled' CHECK(status IN ('enabled','disabled','completed','expired')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,created_by) REFERENCES tenant_principals(tenant_id,principal_id),
 FOREIGN KEY(tenant_id,task_id) REFERENCES tasks(tenant_id,id),FOREIGN KEY(tenant_id,root_task_id) REFERENCES tasks(tenant_id,id),
 FOREIGN KEY(tenant_id,run_id) REFERENCES agent_runs(tenant_id,id),
 CHECK(deadline>start_at AND deadline<=created_at+interval '366 days'),
 CHECK(next_at IS NULL OR (next_at>=start_at AND next_at<deadline)),CHECK(occurrences_created<=maximum_wakeups)
);
CREATE INDEX schedules_due_idx ON schedules(tenant_id,next_at,id) WHERE status='enabled' AND next_at IS NOT NULL;
CREATE TABLE schedule_occurrences (
 tenant_id uuid NOT NULL,id uuid NOT NULL,schedule_id uuid NOT NULL,schedule_revision bigint NOT NULL CHECK(schedule_revision>0),
 scheduled_instant timestamptz NOT NULL,timezone text NOT NULL,status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','dispatched','skipped','denied')),
 reason text,causal_root_id uuid NOT NULL,trigger_id uuid NOT NULL,depth integer NOT NULL DEFAULT 0 CHECK(depth=0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),resolved_at timestamptz,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,schedule_id,schedule_revision,scheduled_instant),
 FOREIGN KEY(tenant_id,schedule_id) REFERENCES schedules(tenant_id,id),FOREIGN KEY(tenant_id,causal_root_id) REFERENCES tasks(tenant_id,id),
 CHECK(trigger_id=schedule_id),CHECK((status='pending')=(resolved_at IS NULL))
);
CREATE INDEX schedule_occurrences_pending_idx ON schedule_occurrences(tenant_id,created_at,id) WHERE status='pending';
${tables
  .map(
    (table) => `
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
CREATE POLICY ${table}_tenant_isolation ON ${table}
 USING(tenant_id=NULLIF(current_setting('imbox.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('imbox.tenant_id',true),'')::uuid);
`,
  )
  .join('\n')}
`;
export const scheduleTableNames = [...tables];
