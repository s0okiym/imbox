import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  CreateScheduleInput,
  RuntimeRun,
  Schedule,
  ScheduleOccurrence,
  Task,
} from '@imbox/contracts';
import { ApiClient, ApiError, describeError, isAccessLoss } from '../api.js';
import type { Session } from '../api.js';
import { Brand, ErrorNotice, fullTime, Icon, Modal, Spinner } from '../components.js';
import { TaskApi } from '../tasks/task-api.js';
import { Field } from '../tasks/task-common.js';
import { futureLocalDate, localDeadline } from '../tasks/task-state.js';
import { ExecutionApi } from './execution-api.js';
import { Fact, Facts, SubmitActions, useExecutionCommand } from './execution-common.js';
import { executionError } from './execution-state.js';

const STATUS: Record<Schedule['status'], string> = {
  enabled: '已启用',
  disabled: '已停用',
  completed: '额度已用完',
  expired: '已到期',
};
async function pages<T>(
  read: (cursor?: string) => Promise<{ items: T[]; next_cursor?: string }>,
  signal: AbortSignal,
) {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await read(cursor);
    if (signal.aborted) return [];
    items.push(...page.items);
    cursor = page.next_cursor;
    if (cursor) {
      if (seen.has(cursor)) throw new Error('Invalid pagination');
      seen.add(cursor);
    }
  } while (cursor);
  return items;
}
export function ScheduleWorkspace({
  session,
  initialRun,
  onBack,
  onSessionLost,
  onSessionUpdated,
}: {
  readonly session: Session;
  readonly initialRun?: RuntimeRun;
  readonly onBack: () => void;
  readonly onSessionLost: (message: string | null) => void;
  readonly onSessionUpdated: (session: Session) => void;
}) {
  const api = useMemo(
    () => new ExecutionApi(session.tenant_id, session.csrf_token),
    [session.tenant_id, session.csrf_token],
  );
  const client = useMemo(
    () => new ApiClient(session.tenant_id, session.csrf_token),
    [session.tenant_id, session.csrf_token],
  );
  const taskApi = useMemo(
    () => new TaskApi(session.tenant_id, session.csrf_token),
    [session.tenant_id, session.csrf_token],
  );
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(!!initialRun);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((value) => value + 1), []);
  const accessLost = useCallback(
    (failure: unknown) => {
      setSchedules([]);
      setTasks([]);
      setSelectedId(null);
      setCreating(false);
      setError(executionError(failure));
      if (failure instanceof ApiError && failure.status === 401)
        onSessionLost(describeError(failure));
    },
    [onSessionLost],
  );
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const me = await client.me(controller.signal);
        if (controller.signal.aborted) return;
        if (me.principal.id !== session.principal.id || me.tenant_id !== session.tenant_id) {
          onSessionLost('登录身份已变化，请重新确认。');
          return;
        }
        if (me.authz_revision !== session.authz_revision) {
          onSessionUpdated(me);
          return;
        }
        const [plans, taskItems] = await Promise.all([
          pages((cursor) => api.schedules(controller.signal, cursor), controller.signal),
          pages((cursor) => taskApi.tasks(controller.signal, cursor), controller.signal),
        ]);
        if (!controller.signal.aborted) {
          setSchedules(plans);
          setTasks(taskItems);
          setError(null);
        }
      } catch (failure: unknown) {
        if (!controller.signal.aborted) {
          if (isAccessLoss(failure)) accessLost(failure);
          else setError(executionError(failure));
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          timer = setTimeout(() => {
            void poll();
          }, 3_000);
        }
      }
    };
    void poll();
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [api, client, taskApi, session, tick, accessLost, onSessionLost, onSessionUpdated]);
  const selected = schedules.find((item) => item.id === selectedId);
  const changed = (schedule: Schedule) => {
    setSchedules((items) => [schedule, ...items.filter((item) => item.id !== schedule.id)]);
    setSelectedId(schedule.id);
    setCreating(false);
    refresh();
  };
  return (
    <main className={`task-workspace execution-workspace ${selected ? 'has-selection' : ''}`}>
      <aside className="task-sidebar" aria-label="定时唤醒导航">
        <header className="task-sidebar-header">
          <Brand />
          <button
            className="icon-button"
            aria-label="新建唤醒计划"
            onClick={() => setCreating(true)}
          >
            <Icon name="plus" />
          </button>
        </header>
        <button className="text-button" onClick={onBack}>
          ← 返回运行与行动
        </button>
        <h2 className="execution-note">有限的定时唤醒</h2>
        <nav className="task-list" aria-label="唤醒计划列表">
          {loading ? (
            <Spinner />
          ) : (
            schedules.map((schedule) => (
              <button
                key={schedule.id}
                className={`task-list-item ${schedule.id === selectedId ? 'selected' : ''}`}
                onClick={() => setSelectedId(schedule.id)}
              >
                <strong>
                  {tasks.find((task) => task.id === schedule.task_id)?.title ?? '任务运行'}
                </strong>
                <span className="task-status">{STATUS[schedule.status]}</span>
                <p>
                  {schedule.trigger.kind === 'once'
                    ? '一次唤醒'
                    : `每天 ${schedule.trigger.local_time} · ${schedule.timezone}`}
                  <br />
                  {schedule.next_at ? `下一次：${fullTime(schedule.next_at)}` : '没有下一次触发'}
                </p>
              </button>
            ))
          )}
        </nav>
      </aside>
      {selected ? (
        <ScheduleDetail
          key={selected.id}
          api={api}
          schedule={selected}
          tasks={tasks}
          onChanged={changed}
          onBack={() => setSelectedId(null)}
          refresh={refresh}
          accessLost={accessLost}
        />
      ) : (
        <section className="task-welcome">
          <span className="task-welcome-symbol" aria-hidden="true">
            ◷
          </span>
          <h1>到时唤醒已暂停的工作</h1>
          <p>
            只恢复你明确选择的现有任务运行；沿用原上下文、权限、步骤额度和预算，不会自动创建新的运行或接受协作。
          </p>
          <button className="button primary" onClick={() => setCreating(true)}>
            新建唤醒计划
          </button>
        </section>
      )}
      {error && (
        <div className="task-global-notice">
          <ErrorNotice>{error}</ErrorNotice>
          <button className="text-button" onClick={refresh}>
            重新同步
          </button>
        </div>
      )}
      {creating && (
        <ScheduleForm
          api={api}
          tasks={tasks}
          {...(initialRun ? { initialRun } : {})}
          onClose={() => setCreating(false)}
          onChanged={changed}
          refresh={refresh}
          accessLost={accessLost}
        />
      )}
    </main>
  );
}
function ScheduleForm({
  api,
  tasks,
  schedule,
  initialRun,
  onClose,
  onChanged,
  refresh,
  accessLost,
}: {
  readonly api: ExecutionApi;
  readonly tasks: readonly Task[];
  readonly schedule?: Schedule;
  readonly initialRun?: RuntimeRun;
  readonly onClose: () => void;
  readonly onChanged: (schedule: Schedule) => void;
  readonly refresh: () => void;
  readonly accessLost: (error: unknown) => void;
}) {
  const toLocal = (value: string) => {
    const d = new Date(value);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  };
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [taskId, setTaskId] = useState(schedule?.task_id ?? initialRun?.task_id ?? '');
  const [runId, setRunId] = useState(schedule?.run_id ?? initialRun?.id ?? '');
  const [runs, setRuns] = useState<RuntimeRun[]>([]);
  const [timezone, setTimezone] = useState(schedule?.timezone ?? browserZone);
  const [kind, setKind] = useState<'once' | 'daily'>(schedule?.trigger.kind ?? 'once');
  const [time, setTime] = useState(
    schedule?.trigger.kind === 'daily' ? schedule.trigger.local_time : '09:00',
  );
  const [start, setStart] = useState(schedule ? toLocal(schedule.start_at) : futureLocalDate(1));
  const [deadline, setDeadline] = useState(
    schedule ? toLocal(schedule.deadline) : futureLocalDate(12),
  );
  const [missed, setMissed] = useState<'skip' | 'coalesce'>(schedule?.missed_policy ?? 'skip');
  const [maximum, setMaximum] = useState(String(schedule?.maximum_wakeups ?? 1));
  const [enabled, setEnabled] = useState(schedule?.status !== 'disabled');
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const command = useExecutionCommand(schedule?.version ?? 'new-schedule', refresh, accessLost);
  useEffect(() => {
    const controller = new AbortController();
    setRuns([]);
    setConfirmed(false);
    if (!taskId) return () => controller.abort();
    setLoading(true);
    void pages(
      (cursor) => api.runs({ type: 'task', id: taskId }, controller.signal, cursor),
      controller.signal,
    )
      .then((items) => {
        if (!controller.signal.aborted) setRuns(items.filter((item) => item.status === 'paused'));
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) {
          if (isAccessLoss(failure)) accessLost(failure);
          else command.setError(executionError(failure));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, taskId, accessLost]);
  const run = runs.find((item) => item.id === runId);
  return (
    <Modal title={schedule ? '修订唤醒计划' : '新建唤醒计划'} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!confirmed || !run) return;
          try {
            new Intl.DateTimeFormat('zh-CN', { timeZone: timezone }).format(new Date());
            const input: CreateScheduleInput = {
              task_id: taskId,
              run_id: runId,
              timezone,
              trigger: kind === 'once' ? { kind: 'once' } : { kind: 'daily', local_time: time },
              start_at: localDeadline(start)!,
              deadline: localDeadline(deadline)!,
              missed_policy: missed,
              maximum_wakeups: Number(maximum),
            };
            const payload = { ...input, enabled };
            void command.run(schedule ? payload : input, async (key, signal) => {
              const next = schedule
                ? await api.reviseSchedule(schedule, payload, key, signal)
                : await api.createSchedule(input, key, signal);
              if (!signal.aborted) onChanged(next);
            });
          } catch {
            command.setError('请核对时间、有效的 IANA 时区和唤醒额度。');
          }
        }}
      >
        <p className="execution-warning">
          计划只恢复同一次运行。当前每次运行自创建起最多 24 小时、20
          个步骤；预算和已用步骤不会重置，结束的运行不会复活。每日规则不代表每天新建运行。
        </p>
        <Field label="唤醒所属任务">
          <select
            className="text-input"
            required
            value={taskId}
            onChange={(event) => {
              setTaskId(event.target.value);
              setRunId('');
            }}
          >
            <option value="">选择任务</option>
            {tasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="要恢复的暂停运行">
          <select
            className="text-input"
            required
            disabled={loading}
            value={runId}
            onChange={(event) => {
              setRunId(event.target.value);
              setConfirmed(false);
            }}
          >
            <option value="">{loading ? '正在读取运行…' : '明确选择已暂停的运行'}</option>
            {runs.map((item) => (
              <option key={item.id} value={item.id}>
                {item.summary || item.id} · 已暂停
              </option>
            ))}
          </select>
        </Field>
        {run && (
          <p className="execution-note">
            原运行创建于 {fullTime(run.created_at)}；最晚有效至{' '}
            {fullTime(new Date(Date.parse(run.created_at) + 24 * 3_600_000).toISOString())}。
          </p>
        )}
        <div className="execution-form-grid">
          <Field label="触发方式">
            <select
              className="text-input"
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as typeof kind);
                setConfirmed(false);
              }}
            >
              <option value="once">一次唤醒</option>
              <option value="daily">每日尝试唤醒</option>
            </select>
          </Field>
          <Field label="每日规则时区">
            <input
              className="text-input"
              required
              value={timezone}
              onChange={(event) => {
                setTimezone(event.target.value);
                setConfirmed(false);
              }}
            />
          </Field>
        </div>
        {kind === 'daily' && (
          <Field label="每日当地时间" hint="时区跳过的时刻不触发；重复时刻只取第一次。">
            <input
              className="text-input"
              type="time"
              required
              value={time}
              onChange={(event) => {
                setTime(event.target.value);
                setConfirmed(false);
              }}
            />
          </Field>
        )}
        <Field label={`开始时间（本机时区 ${browserZone}）`}>
          <input
            className="text-input"
            type="datetime-local"
            required
            value={start}
            onChange={(event) => {
              setStart(event.target.value);
              setConfirmed(false);
            }}
          />
        </Field>
        <Field label={`停止触发时间（本机时区 ${browserZone}）`}>
          <input
            className="text-input"
            type="datetime-local"
            required
            value={deadline}
            onChange={(event) => {
              setDeadline(event.target.value);
              setConfirmed(false);
            }}
          />
        </Field>
        <Field label="错过时间的处理">
          <select
            className="text-input"
            value={missed}
            onChange={(event) => {
              setMissed(event.target.value as typeof missed);
              setConfirmed(false);
            }}
          >
            <option value="skip">跳过（只容忍 60 秒派发延迟）</option>
            <option value="coalesce">合并为最近一次</option>
          </select>
        </Field>
        <Field label="累计触发额度" hint="待派发、跳过、拒绝都会占用额度；修订不会重置已用额度。">
          <input
            className="text-input"
            type="number"
            required
            min={1}
            max={1000}
            value={maximum}
            onChange={(event) => {
              setMaximum(event.target.value);
              setConfirmed(false);
            }}
          />
        </Field>
        {schedule && (
          <label className="execution-confirm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => {
                setEnabled(event.target.checked);
                setConfirmed(false);
              }}
            />
            启用这一修订。
          </label>
        )}
        <label className="execution-confirm">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          我确认仅在原权限与运行期限内恢复所选运行；不自动接受协作、不扩大权限或预算。
        </label>
        <SubmitActions
          command={command}
          label={schedule ? '提交计划修订' : '创建有限唤醒计划'}
          disabled={!confirmed || !run || loading}
          onClose={onClose}
          onAdopt={() => setConfirmed(false)}
        />
      </form>
    </Modal>
  );
}
function ScheduleDetail({
  api,
  schedule,
  tasks,
  onChanged,
  onBack,
  refresh,
  accessLost,
}: {
  readonly api: ExecutionApi;
  readonly schedule: Schedule;
  readonly tasks: readonly Task[];
  readonly onChanged: (schedule: Schedule) => void;
  readonly onBack: () => void;
  readonly refresh: () => void;
  readonly accessLost: (error: unknown) => void;
}) {
  const [items, setItems] = useState<ScheduleOccurrence[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<'edit' | 'disable' | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const command = useExecutionCommand(schedule.version, refresh, accessLost);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const occurrences = await pages(
          (cursor) => api.occurrences(schedule.id, controller.signal, cursor),
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setItems(occurrences);
          setError(null);
        }
      } catch (failure: unknown) {
        if (!controller.signal.aborted) {
          if (isAccessLoss(failure)) accessLost(failure);
          else setError(executionError(failure));
        }
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => {
            void poll();
          }, 3_000);
      }
    };
    void poll();
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [api, schedule.id, schedule.version, accessLost]);
  return (
    <section className="task-detail" aria-label="唤醒计划详情">
      <header className="task-detail-header">
        <button className="icon-button" aria-label="返回计划列表" onClick={onBack}>
          <Icon name="back" />
        </button>
        <div>
          <span className="eyebrow">BOUNDED WAKEUP · {STATUS[schedule.status]}</span>
          <h1>
            {schedule.trigger.kind === 'once' ? '一次唤醒' : `每天 ${schedule.trigger.local_time}`}
          </h1>
        </div>
      </header>
      <div className="task-detail-scroll">
        <p className="execution-note">
          只唤醒原有的暂停运行，任务结果仍需独立验收。等待审批、输入或依赖时，不会代替任何人作出决定。
        </p>
        <Facts>
          <Fact label="当前状态">{STATUS[schedule.status]}</Fact>
          <Fact label="规则时区">{schedule.timezone}</Fact>
          <Fact label="下一次实际触发">{schedule.next_at ? fullTime(schedule.next_at) : '无'}</Fact>
          <Fact label="已消耗额度">
            {schedule.occurrences_created} / {schedule.maximum_wakeups}
          </Fact>
          <Fact label="错过策略">
            {schedule.missed_policy === 'skip' ? '跳过' : '合并最近一次'}
          </Fact>
          <Fact label="重叠策略">禁止同时执行</Fact>
          <Fact label="运行 ID">{schedule.run_id}</Fact>
          <Fact label="停止触发时间">{fullTime(schedule.deadline)}</Fact>
        </Facts>
        <div className="task-action-row">
          <button className="button subtle" onClick={() => setForm('edit')}>
            修订计划
          </button>
          {schedule.status === 'enabled' && (
            <button
              className="button subtle"
              onClick={() => {
                command.adoptLatest();
                setConfirmed(false);
                setForm('disable');
              }}
            >
              停用计划
            </button>
          )}
        </div>
        <section className="task-section">
          <h2>实际唤醒记录</h2>
          {!items.length && <p className="execution-note">尚无触发记录。</p>}
          {items.map((item) => (
            <article className="execution-context" key={item.id}>
              <h3>
                {
                  {
                    pending: '等待派发',
                    dispatched: '已恢复原运行',
                    skipped: '已跳过',
                    denied: '未获执行准入',
                  }[item.status]
                }
              </h3>
              <p>
                {fullTime(item.scheduled_instant)} · 计划修订 {item.schedule_revision}
              </p>
              {item.reason && (
                <p className="execution-note">
                  {item.reason === 'overlap'
                    ? '原运行并非可恢复的暂停状态。'
                    : '触发时未满足计划、权限、预算或运行期限条件；没有开启新的执行。'}
                </p>
              )}
            </article>
          ))}
        </section>
        {error && <ErrorNotice>{error}</ErrorNotice>}
      </div>
      {form === 'edit' && (
        <ScheduleForm
          api={api}
          tasks={tasks}
          schedule={schedule}
          onClose={() => setForm(null)}
          onChanged={(value) => {
            onChanged(value);
            setForm(null);
          }}
          refresh={refresh}
          accessLost={accessLost}
        />
      )}
      {form === 'disable' && (
        <Modal title="停用唤醒计划" onClose={() => setForm(null)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (confirmed)
                void command.run({ disable: schedule.id }, async (key, signal) => {
                  const value = await api.disableSchedule(schedule, key, signal);
                  if (!signal.aborted) {
                    onChanged(value);
                    setForm(null);
                  }
                });
            }}
          >
            <p className="execution-note">
              停用会使尚未生效的旧修订失效；已经恢复的运行需要单独暂停或取消。
            </p>
            <label className="execution-confirm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              确认停用后续唤醒。
            </label>
            <SubmitActions
              command={command}
              label="确认停用计划"
              disabled={!confirmed}
              onClose={() => setForm(null)}
              onAdopt={() => setConfirmed(false)}
            />
          </form>
        </Modal>
      )}
    </section>
  );
}
