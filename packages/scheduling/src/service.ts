import type { RuntimeSourcePort } from '@imbox/application';
import { randomUUID } from 'node:crypto';
import {
  ApplicationError,
  appendEvent,
  authorizeTenant,
  authorizeWorkspace,
  command,
  CursorCodec,
  fail,
  type AuthContext,
} from '@imbox/application';
import { assertContract } from '@imbox/contracts';
import { lockPrincipal, sql, type Db, type TenantTransaction as Tx } from '@imbox/db';
import { scheduledWake, validateScheduledRun, withRuntimeTransaction } from '@imbox/runtime';
import { assertTimeZone, dueOccurrences, nextOccurrence, type CalendarSpec } from './calendar.js';
import type {
  CreateScheduleInput,
  ReviseScheduleInput,
  ScheduleRow,
  OccurrenceRow,
} from './types.js';

const spec = (r: ScheduleRow): CalendarSpec => ({
  timezone: r.timezone,
  trigger: r.trigger,
  start_at: r.start_at.toISOString(),
  deadline: r.deadline.toISOString(),
});
const dto = (r: ScheduleRow) => ({
  id: r.id,
  created_by: r.created_by,
  task_id: r.task_id,
  run_id: r.run_id,
  ...spec(r),
  missed_policy: r.missed_policy,
  overlap_policy: r.overlap_policy,
  maximum_wakeups: r.maximum_wakeups,
  occurrences_created: r.occurrences_created,
  missed_count: r.missed_count,
  next_at: r.next_at?.toISOString() ?? null,
  status: r.status,
  revision: r.revision,
  version: r.version,
  created_at: r.created_at.toISOString(),
  updated_at: r.updated_at.toISOString(),
});
const occurrenceDto = (r: OccurrenceRow) => ({
  id: r.id,
  schedule_id: r.schedule_id,
  schedule_revision: r.schedule_revision,
  scheduled_instant: r.scheduled_instant.toISOString(),
  timezone: r.timezone,
  status: r.status,
  reason: r.reason,
  causal_root_id: r.causal_root_id,
  trigger_id: r.trigger_id,
  depth: r.depth,
  created_at: r.created_at.toISOString(),
  resolved_at: r.resolved_at?.toISOString() ?? null,
});
const actor = (row: ScheduleRow): AuthContext => ({
  tenantId: row.tenant_id,
  principalId: row.created_by,
  kind: 'human',
  authzRevision: row.creator_authz_revision,
});
const now = async (tx: Tx): Promise<Date> =>
  (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(tx)).rows[0]!.now;
const row = async (tx: Tx, id: string, lock = false): Promise<ScheduleRow> =>
  (
    await sql<ScheduleRow>`select * from schedules where id=${id} ${lock ? sql`for update` : sql``}`.execute(
      tx,
    )
  ).rows[0] ?? fail('NOT_FOUND', 404);

export function createSchedulingService(options: {
  db: Db;
  cursorSecret: string;
  sources?: RuntimeSourcePort;
}) {
  const cursors = new CursorCodec(options.cursorSecret);
  const transact = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) =>
    withRuntimeTransaction(options.db, tenantId, fn);
  async function identity(tx: Tx, auth: AuthContext): Promise<string> {
    await authorizeTenant(tx, auth);
    const principal = await lockPrincipal(tx, auth.principalId);
    if (auth.kind !== 'human' || principal?.kind !== 'human' || principal.status !== 'active')
      fail('FORBIDDEN', 403);
    return principal.version;
  }
  async function owned(tx: Tx, auth: AuthContext, id: string, lock = false): Promise<ScheduleRow> {
    await identity(tx, auth);
    const result = await row(tx, assertContract('Identifier', id), lock);
    if (result.created_by !== auth.principalId) fail('NOT_FOUND', 404);
    await readAccess(tx, auth, result);
    return result;
  }
  async function readAccess(tx: Tx, auth: AuthContext, schedule: ScheduleRow): Promise<void> {
    const target = (
      await sql<{
        workspace_id: string;
      }>`select t.workspace_id from agent_runs r join tasks t on t.tenant_id=r.tenant_id and t.id=r.task_id where r.id=${schedule.run_id} and r.task_id=${schedule.task_id} and r.created_by=${auth.principalId}`.execute(
        tx,
      )
    ).rows[0];
    if (!target) fail('NOT_FOUND', 404);
    await authorizeWorkspace(tx, auth, target.workspace_id);
    const member = (
      await sql`select 1 from task_participants where task_id=${schedule.task_id} and principal_id=${auth.principalId} and status='active' for share`.execute(
        tx,
      )
    ).rows[0];
    if (!member) fail('NOT_FOUND', 404);
  }
  function validate(input: CreateScheduleInput, time: Date, createdAt = time): Date {
    try {
      assertTimeZone(input.timezone);
      const start = new Date(input.start_at),
        deadline = new Date(input.deadline);
      if (
        start < time ||
        deadline <= start ||
        deadline.getTime() > createdAt.getTime() + 366 * 86_400_000
      )
        fail('VALIDATION_FAILED', 400);
      const next = nextOccurrence(input, start);
      if (!next) fail('VALIDATION_FAILED', 400);
      return next;
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      fail('VALIDATION_FAILED', 400);
    }
  }
  async function record(tx: Tx, r: ScheduleRow, type: string, payload: unknown = {}) {
    await appendEvent(tx, actor(r), {
      aggregateType: 'schedule',
      aggregateId: r.id,
      version: r.version,
      type,
      payload,
      target: `schedule:${r.id}`,
    });
  }
  async function result(tx: Tx, auth: AuthContext, id: string) {
    return dto(await owned(tx, auth, id));
  }
  return {
    async create(auth: AuthContext, raw: CreateScheduleInput, key: string) {
      const input = assertContract('CreateScheduleInput', raw);
      return transact(auth.tenantId, async (tx) => {
        const principalVersion = await identity(tx, auth);
        const id = await command(tx, auth, 'schedule.create', key, input, async () => {
          const next = validate(input, await now(tx));
          const binding = await validateScheduledRun(
            tx,
            {
              auth,
              taskId: input.task_id,
              runId: input.run_id,
            },
            true,
            options.sources,
          );
          if (new Date(input.deadline) > binding.lifetimeDeadline) fail('VALIDATION_FAILED', 400);
          const id = randomUUID();
          await sql`insert into schedules(tenant_id,id,created_by,creator_authz_revision,creator_principal_version,task_id,run_id,root_task_id,timezone,trigger,start_at,deadline,missed_policy,maximum_wakeups,next_at)
            values(${auth.tenantId},${id},${auth.principalId},${auth.authzRevision},${principalVersion},${input.task_id},${input.run_id},${binding.rootTaskId},${input.timezone},${JSON.stringify(input.trigger)}::jsonb,${input.start_at},${input.deadline},${input.missed_policy},${input.maximum_wakeups},${next})`.execute(
            tx,
          );
          await record(tx, await row(tx, id), 'schedule.created');
          return id;
        });
        return result(tx, auth, id);
      });
    },
    async get(auth: AuthContext, id: string) {
      return transact(auth.tenantId, async (tx) => dto(await owned(tx, auth, id)));
    },
    async list(auth: AuthContext, cursor?: string) {
      return transact(auth.tenantId, async (tx) => {
        const principalVersion = await identity(tx, auth);
        const binding = `schedules:${auth.tenantId}:${auth.principalId}:${auth.authzRevision}:${principalVersion}`;
        const position = cursor
          ? assertContract('Identifier', cursors.decode(cursor, binding))
          : null;
        const rows = (
          await sql<ScheduleRow>`select * from schedules where created_by=${auth.principalId} and (${position}::uuid is null or id>${position}::uuid) order by id limit 101`.execute(
            tx,
          )
        ).rows;
        const visible: ReturnType<typeof dto>[] = [];
        for (const schedule of rows.slice(0, 100)) {
          try {
            await readAccess(tx, auth, schedule);
            visible.push(dto(schedule));
          } catch (error) {
            if (!(error instanceof ApplicationError) || error.status !== 404) throw error;
          }
        }
        return {
          items: visible,
          ...(rows.length > 100 ? { next_cursor: cursors.encode(binding, rows[99]!.id) } : {}),
        };
      });
    },
    async revise(
      auth: AuthContext,
      id: string,
      raw: ReviseScheduleInput,
      version: string,
      key: string,
    ) {
      const input = assertContract('ReviseScheduleInput', raw);
      assertContract('Version', version);
      return transact(auth.tenantId, async (tx) => {
        const principalVersion = await identity(tx, auth);
        await command(tx, auth, 'schedule.revise', key, { id, input, version }, async () => {
          const old = await owned(tx, auth, id, true);
          if (old.version !== version) fail('VERSION_CONFLICT', 409);
          const candidate = validate(input, await now(tx), old.created_at);
          if (input.maximum_wakeups < old.occurrences_created) fail('VALIDATION_FAILED', 400);
          const exhausted = input.maximum_wakeups === old.occurrences_created;
          const next = exhausted ? null : candidate;
          const binding = await validateScheduledRun(
            tx,
            {
              auth,
              taskId: input.task_id,
              runId: input.run_id,
            },
            true,
            options.sources,
          );
          if (new Date(input.deadline) > binding.lifetimeDeadline) fail('VALIDATION_FAILED', 400);
          await sql`update schedules set task_id=${input.task_id},run_id=${input.run_id},root_task_id=${binding.rootTaskId},creator_authz_revision=${auth.authzRevision},creator_principal_version=${principalVersion},timezone=${input.timezone},trigger=${JSON.stringify(input.trigger)}::jsonb,start_at=${input.start_at},deadline=${input.deadline},missed_policy=${input.missed_policy},maximum_wakeups=${input.maximum_wakeups},next_at=${next},status=${input.enabled ? (exhausted ? 'completed' : 'enabled') : 'disabled'},revision=revision+1,version=version+1,updated_at=clock_timestamp() where id=${id}`.execute(
            tx,
          );
          await record(tx, await row(tx, id), 'schedule.revised');
          return id;
        });
        return result(tx, auth, id);
      });
    },
    async disable(auth: AuthContext, id: string, version: string, key: string) {
      assertContract('Version', version);
      return transact(auth.tenantId, async (tx) => {
        await identity(tx, auth);
        await command(tx, auth, 'schedule.disable', key, { id, version }, async () => {
          const old = await owned(tx, auth, id, true);
          if (old.version !== version) fail('VERSION_CONFLICT', 409);
          await sql`update schedules set status='disabled',revision=revision+1,version=version+1,next_at=null,updated_at=clock_timestamp() where id=${id}`.execute(
            tx,
          );
          await record(tx, await row(tx, id), 'schedule.disabled');
          return id;
        });
        return result(tx, auth, id);
      });
    },
    async occurrences(auth: AuthContext, id: string, cursor?: string) {
      return transact(auth.tenantId, async (tx) => {
        const schedule = await owned(tx, auth, id);
        const binding = `schedule-occurrences:${auth.tenantId}:${auth.principalId}:${auth.authzRevision}:${schedule.id}:${schedule.revision}`;
        const position = cursor
          ? assertContract('Identifier', cursors.decode(cursor, binding))
          : null;
        const rows = (
          await sql<OccurrenceRow>`select * from schedule_occurrences where schedule_id=${id} and (${position}::uuid is null or id>${position}::uuid) order by id limit 101`.execute(
            tx,
          )
        ).rows;
        return {
          items: rows.slice(0, 100).map(occurrenceDto),
          ...(rows.length > 100 ? { next_cursor: cursors.encode(binding, rows[99]!.id) } : {}),
        };
      });
    },
    /** Internal tenant-scoped scanner; PostgreSQL time is authoritative for eligibility. */
    async collectDue(tenantId: string, limit = 100): Promise<number> {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('VALIDATION_FAILED', 400);
      return transact(tenantId, async (tx) => {
        const due = (
          await sql<ScheduleRow>`select * from schedules where status='enabled' and (deadline<=clock_timestamp() or (next_at<=clock_timestamp() and occurrences_created<maximum_wakeups)) order by next_at nulls first,id for update skip locked limit ${limit}`.execute(
            tx,
          )
        ).rows;
        let emitted = 0;
        for (const r of due) {
          const time = await now(tx);
          if (r.deadline <= time) {
            await sql`update schedules set status='expired',next_at=null,version=version+1,updated_at=clock_timestamp() where id=${r.id}`.execute(
              tx,
            );
            await record(tx, await row(tx, r.id), 'schedule.expired');
            continue;
          }
          if (!r.next_at || r.next_at > time) continue;
          const due = dueOccurrences(spec(r), r.next_at, time, r.missed_policy);
          let created = 0;
          if (due.selected) {
            const inserted =
              await sql`insert into schedule_occurrences(tenant_id,id,schedule_id,schedule_revision,scheduled_instant,timezone,causal_root_id,trigger_id) values(${tenantId},${randomUUID()},${r.id},${r.revision},${due.selected},${r.timezone},${r.root_task_id},${r.id}) on conflict(tenant_id,schedule_id,schedule_revision,scheduled_instant) do nothing returning id`.execute(
                tx,
              );
            created = inserted.rows.length;
          }
          const next = r.occurrences_created + created >= r.maximum_wakeups ? null : due.next;
          // Keep the last pending occurrence dispatchable; complete only after it resolves.
          await sql`update schedules set next_at=${next},occurrences_created=occurrences_created+${created},missed_count=missed_count+${due.missed_count},version=version+1,updated_at=clock_timestamp() where id=${r.id}`.execute(
            tx,
          );
          const updated = await row(tx, r.id);
          if (created) {
            await record(tx, updated, 'schedule.occurrence_ready', {
              revision: r.revision,
              scheduled_instant: due.selected!.toISOString(),
            });
            emitted++;
          } else if (!next)
            await sql`update schedules set status='completed' where id=${r.id} and not exists(select 1 from schedule_occurrences where schedule_id=${r.id} and status='pending')`.execute(
              tx,
            );
        }
        return emitted;
      });
    },
    /** Durable pending occurrences are the queue. Broker delivery is only an optional wakeup. */
    async dispatchPending(tenantId: string, limit = 100): Promise<number> {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('VALIDATION_FAILED', 400);
      const ids = await transact(
        tenantId,
        async (tx) =>
          (
            await sql<{
              id: string;
              schedule_id: string;
            }>`select id,schedule_id from schedule_occurrences where status='pending' order by created_at,id limit ${limit}`.execute(
              tx,
            )
          ).rows,
      );
      let dispatched = 0;
      for (const item of ids)
        dispatched += await transact(tenantId, async (tx) => {
          // Uniform lock order: schedule, occurrence, task ancestry / Run. No reverse path exists.
          const r = await row(tx, item.schedule_id, true);
          const occurrence = (
            await sql<OccurrenceRow>`select * from schedule_occurrences where id=${item.id} for update`.execute(
              tx,
            )
          ).rows[0];
          if (!occurrence || occurrence.status !== 'pending') return 0;
          const time = await now(tx);
          let status: 'dispatched' | 'skipped' | 'denied' = 'skipped';
          let reason: string | null;
          if (r.status !== 'enabled' || r.revision !== occurrence.schedule_revision)
            reason = 'schedule_changed';
          else if (r.deadline <= time) reason = 'deadline_expired';
          else if (occurrence.scheduled_instant > time) return 0;
          else if (
            r.missed_policy === 'skip' &&
            time.getTime() - occurrence.scheduled_instant.getTime() > 60_000
          )
            reason = 'missed';
          else {
            try {
              const auth = actor(r);
              const principalVersion = await identity(tx, auth);
              if (principalVersion !== r.creator_principal_version) fail('FORBIDDEN', 403);
              const outcome = await scheduledWake(
                tx,
                {
                  auth,
                  taskId: r.task_id,
                  runId: r.run_id,
                  occurrenceId: occurrence.id,
                  scheduleId: r.id,
                  scheduledInstant: occurrence.scheduled_instant,
                  deadline: r.deadline,
                  latestDispatchAt:
                    r.missed_policy === 'skip'
                      ? new Date(occurrence.scheduled_instant.getTime() + 60_000)
                      : null,
                },
                options.sources,
              );
              status = outcome === 'dispatched' ? 'dispatched' : 'skipped';
              reason = outcome === 'overlap' ? 'overlap' : null;
            } catch (error) {
              if (!(error instanceof ApplicationError)) throw error;
              status = 'denied';
              reason = error.code;
            }
          }
          await sql`update schedule_occurrences set status=${status},reason=${reason},resolved_at=clock_timestamp() where id=${occurrence.id}`.execute(
            tx,
          );
          await sql`update schedules set status=case when status='enabled' and ${!r.next_at || r.deadline <= time} and not exists(select 1 from schedule_occurrences where schedule_id=${r.id} and status='pending') then ${r.deadline <= time ? 'expired' : 'completed'} else status end,version=version+1,updated_at=clock_timestamp() where id=${r.id}`.execute(
            tx,
          );
          await record(tx, await row(tx, r.id), 'schedule.occurrence_resolved', {
            occurrence_id: occurrence.id,
            status,
            reason,
          });
          return status === 'dispatched' ? 1 : 0;
        });
      return dispatched;
    },
  };
}
export type SchedulingService = ReturnType<typeof createSchedulingService>;
