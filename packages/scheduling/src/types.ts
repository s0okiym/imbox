import type { CalendarSpec, ScheduleTrigger } from './calendar.js';
export interface CreateScheduleInput extends CalendarSpec {
  task_id: string;
  run_id: string;
  missed_policy: 'skip' | 'coalesce';
  maximum_wakeups: number;
}
export interface ReviseScheduleInput extends CreateScheduleInput {
  enabled: boolean;
}
export interface ScheduleRow {
  tenant_id: string;
  id: string;
  created_by: string;
  creator_authz_revision: string;
  creator_principal_version: string;
  task_id: string;
  run_id: string;
  root_task_id: string;
  timezone: string;
  trigger: ScheduleTrigger;
  start_at: Date;
  deadline: Date;
  missed_policy: 'skip' | 'coalesce';
  overlap_policy: 'forbid';
  maximum_wakeups: number;
  occurrences_created: number;
  missed_count: number;
  next_at: Date | null;
  status: 'enabled' | 'disabled' | 'completed' | 'expired';
  revision: string;
  version: string;
  created_at: Date;
  updated_at: Date;
}
export interface OccurrenceRow {
  tenant_id: string;
  id: string;
  schedule_id: string;
  schedule_revision: string;
  scheduled_instant: Date;
  timezone: string;
  status: 'pending' | 'dispatched' | 'skipped' | 'denied';
  reason: string | null;
  causal_root_id: string;
  trigger_id: string;
  depth: 0;
  created_at: Date;
  resolved_at: Date | null;
}
