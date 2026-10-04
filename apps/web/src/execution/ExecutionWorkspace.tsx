import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Action, CapabilityGrant, Conversation, RuntimeRun, Task } from '@imbox/contracts';
import { ApiClient, ApiError, describeError, isAccessLoss } from '../api.js';
import type { Session } from '../api.js';
import { Avatar, Brand, ErrorNotice, Icon, IdentityTag, Modal, Spinner } from '../components.js';
import { TaskApi } from '../tasks/task-api.js';
import { Field } from '../tasks/task-common.js';
import { ExecutionApi } from './execution-api.js';
import { ACTION_LABELS, executionError, RUN_LABELS } from './execution-state.js';
import { CreateRunForm } from './run-forms.js';
import { CreateActionForm, CreateGrantForm } from './action-forms.js';
import { ActionDetail, GrantDetail, RunDetail } from './execution-details.js';
import { ScheduleWorkspace } from './ScheduleWorkspace.js';
import { CreateTaskForm } from '../tasks/task-forms.js';
import './execution.css';

type Mode = 'runs' | 'actions' | 'grants';
async function pages<T>(
  read: (cursor?: string) => Promise<{ items: T[]; next_cursor?: string }>,
  signal: AbortSignal,
): Promise<T[]> {
  const items: T[] = [];
  const visited = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await read(cursor);
    if (signal.aborted) return [];
    items.push(...page.items);
    cursor = page.next_cursor;
    if (cursor) {
      if (visited.has(cursor)) throw new Error('Invalid pagination');
      visited.add(cursor);
    }
  } while (cursor);
  return items;
}
export function ExecutionWorkspace({
  session,
  onLogout,
  onSessionLost,
  onSessionUpdated,
  onOpenTask,
  initialRunId,
  initialActionId,
  initialGrantId,
  onSelection,
}: {
  readonly session: Session;
  readonly onLogout: () => void;
  readonly onSessionLost: (message: string | null) => void;
  readonly onSessionUpdated: (session: Session) => void;
  readonly onOpenTask: (taskId: string) => void;
  readonly initialRunId?: string;
  readonly initialActionId?: string;
  readonly initialGrantId?: string;
  readonly onSelection?: (kind: Mode, id: string | null) => void;
}) {
  const client = useMemo(
    () => new ApiClient(session.tenant_id, session.csrf_token),
    [session.tenant_id, session.csrf_token],
  );
  const api = useMemo(
    () => new ExecutionApi(session.tenant_id, session.csrf_token),
    [session.tenant_id, session.csrf_token],
  );
  const taskApi = useMemo(
    () => new TaskApi(session.tenant_id, session.csrf_token),
    [session.tenant_id, session.csrf_token],
  );
  const runsEnabled = session.capabilities.includes('agents.runs');
  const actionsEnabled = session.capabilities.includes('actions.approvals');
  const grantsEnabled = session.capabilities.includes('actions.grants');
  const [mode, setMode] = useState<Mode>(runsEnabled ? 'runs' : 'actions');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [actions, setActions] = useState<Action[]>([]);
  const [grants, setGrants] = useState<CapabilityGrant[]>([]);
  const [runs, setRuns] = useState<RuntimeRun[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [runScope, setRunScope] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Mode | 'open' | 'promote' | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [scheduleRun, setScheduleRun] = useState<RuntimeRun | undefined>();
  const [initialGrant, setInitialGrant] = useState<string | undefined>();
  const [runId, setRunId] = useState('');
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((value) => value + 1), []);
  const selection = useRef<AbortController | null>(null);
  const openedRunIds = useRef(new Set<string>());
  useEffect(() => () => selection.current?.abort(), []);
  const accessLost = useCallback(
    (failure: unknown) => {
      selection.current?.abort();
      setOpening(false);
      setSelectedId(null);
      setForm(null);
      setRuns([]);
      setActions([]);
      setGrants([]);
      setTasks([]);
      setConversations([]);
      setRunScope('');
      openedRunIds.current.clear();
      if (failure instanceof ApiError && failure.status === 401)
        onSessionLost(describeError(failure));
      else {
        setError(executionError(failure));
        refresh();
      }
    },
    [onSessionLost, refresh],
  );
  useEffect(() => {
    if (scheduling) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
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
        const [taskItems, actionItems, grantPage, conversationItems] = await Promise.all([
          session.capabilities.includes('tasks.collaboration')
            ? pages((cursor) => taskApi.tasks(controller.signal, cursor), controller.signal)
            : Promise.resolve([]),
          actionsEnabled
            ? pages((cursor) => api.actions(controller.signal, cursor), controller.signal)
            : Promise.resolve([]),
          grantsEnabled ? api.grants(controller.signal) : Promise.resolve({ items: [] }),
          session.capabilities.includes('messaging.text')
            ? pages((cursor) => client.conversations(controller.signal, cursor), controller.signal)
            : Promise.resolve([]),
        ]);
        const currentRuns: RuntimeRun[] = runScope
          ? await pages(
              (cursor) =>
                api.runs(
                  {
                    type: runScope.startsWith('task:') ? 'task' : 'conversation',
                    id: runScope.slice(runScope.indexOf(':') + 1),
                  },
                  controller.signal,
                  cursor,
                ),
              controller.signal,
            )
          : [];
        if (!runScope)
          for (const id of [...openedRunIds.current]) {
            try {
              currentRuns.push(await api.run(id, controller.signal));
            } catch (failure: unknown) {
              if (failure instanceof ApiError && [403, 404].includes(failure.status)) {
                openedRunIds.current.delete(id);
                if (!controller.signal.aborted) {
                  setRuns((items) => items.filter((item) => item.id !== id));
                  setSelectedId((value) => (value === id ? null : value));
                  setForm(null);
                }
              } else throw failure;
            }
          }
        if (controller.signal.aborted) return;
        setTasks(taskItems);
        setActions(actionItems);
        setGrants(grantPage.items);
        setRuns(currentRuns);
        setConversations(conversationItems);
        setError(null);
      } catch (failure: unknown) {
        if (controller.signal.aborted) return;
        if (isAccessLoss(failure)) {
          accessLost(failure);
          return;
        }
        setError(executionError(failure));
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
  }, [
    api,
    client,
    taskApi,
    session,
    actionsEnabled,
    grantsEnabled,
    runScope,
    tick,
    accessLost,
    onSessionLost,
    onSessionUpdated,
    scheduling,
  ]);
  const chooseMode = (next: Mode) => {
    selection.current?.abort();
    setOpening(false);
    setMode(next);
    setSelectedId(null);
    setFilter('');
  };
  const changedRun = (run: RuntimeRun) => {
    openedRunIds.current.add(run.id);
    setRuns((items) => [run, ...items.filter((item) => item.id !== run.id)]);
    setSelectedId(run.id);
    setMode('runs');
    onSelection?.('runs', run.id);
  };
  const changedAction = (action: Action) => {
    setActions((items) => [action, ...items.filter((item) => item.id !== action.id)]);
    setSelectedId(action.id);
    setMode('actions');
    onSelection?.('actions', action.id);
  };
  const changedGrant = (grant: CapabilityGrant) => {
    setGrants((items) => [grant, ...items.filter((item) => item.id !== grant.id)]);
    setSelectedId(grant.id);
    setMode('grants');
    onSelection?.('grants', grant.id);
  };
  const open = async (id: string, next: Mode): Promise<void> => {
    selection.current?.abort();
    const controller = new AbortController();
    selection.current = controller;
    setSelectedId(null);
    setOpening(true);
    setError(null);
    try {
      if (next === 'runs') {
        const value = await api.run(id, controller.signal);
        if (!controller.signal.aborted) changedRun(value);
      } else if (next === 'actions') {
        const value = await api.action(id, controller.signal);
        if (!controller.signal.aborted) changedAction(value);
      } else {
        const value = await api.grant(id, controller.signal);
        if (!controller.signal.aborted) changedGrant(value);
      }
      if (!controller.signal.aborted) setForm(null);
    } catch (failure: unknown) {
      if (!controller.signal.aborted) {
        if (isAccessLoss(failure)) accessLost(failure);
        else setError(executionError(failure));
      }
    } finally {
      if (!controller.signal.aborted) setOpening(false);
    }
  };
  const selectedRun = runs.find((item) => item.id === selectedId);
  useEffect(() => {
    if (initialRunId) {
      if (selectedId !== initialRunId) void open(initialRunId, 'runs');
    } else if (initialActionId) {
      if (selectedId !== initialActionId) void open(initialActionId, 'actions');
    } else if (initialGrantId) {
      if (selectedId !== initialGrantId) void open(initialGrantId, 'grants');
    } else setSelectedId(null);
  }, [initialRunId, initialActionId, initialGrantId]);
  const selectedAction = actions.find((item) => item.id === selectedId);
  const selectedGrant = grants.find((item) => item.id === selectedId);
  const selected =
    mode === 'runs' ? selectedRun : mode === 'actions' ? selectedAction : selectedGrant;
  const labels = { runs: '运行', actions: '行动', grants: '授权' };
  if (scheduling)
    return (
      <ScheduleWorkspace
        session={session}
        {...(scheduleRun ? { initialRun: scheduleRun } : {})}
        onBack={() => setScheduling(false)}
        onSessionLost={onSessionLost}
        onSessionUpdated={onSessionUpdated}
      />
    );
  return (
    <main className={`task-workspace execution-workspace ${selected ? 'has-selection' : ''}`}>
      <aside className="task-sidebar" aria-label="运行与行动导航">
        <header className="task-sidebar-header">
          <Brand />
          <button
            className="icon-button"
            aria-label={`新建${labels[mode]}`}
            onClick={() => {
              setInitialGrant(undefined);
              setForm(mode);
            }}
          >
            <Icon name="plus" />
          </button>
        </header>
        {session.capabilities.includes('agents.schedules') && (
          <button
            className="text-button execution-open"
            onClick={() => {
              setScheduleRun(undefined);
              setScheduling(true);
            }}
          >
            管理定时唤醒
          </button>
        )}
        <div className="task-tabs" role="tablist" aria-label="运行、行动与授权">
          {(
            [
              ['runs', runsEnabled],
              ['actions', actionsEnabled],
              ['grants', grantsEnabled],
            ] as const
          )
            .filter(([, enabled]) => enabled)
            .map(([tab]) => (
              <button
                key={tab}
                role="tab"
                aria-selected={mode === tab}
                onClick={() => chooseMode(tab)}
              >
                {labels[tab]}
              </button>
            ))}
        </div>
        <div className="search-field">
          <Icon name="search" size={17} />
          <input
            aria-label={`筛选${labels[mode]}`}
            placeholder={`筛选${labels[mode]}`}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
        {mode === 'runs' && (
          <>
            <select
              className="text-input task-list-filter"
              aria-label="运行记录范围"
              value={runScope}
              onChange={(event) => {
                setRunScope(event.target.value);
                setRuns([]);
                setSelectedId(null);
              }}
            >
              <option value="">本次会话打开的运行</option>
              <optgroup label="任务历史">
                {tasks.map((task) => (
                  <option key={task.id} value={`task:${task.id}`}>
                    {task.title}
                  </option>
                ))}
              </optgroup>
              <optgroup label="会话历史">
                {conversations.map((item) => (
                  <option key={item.id} value={`conversation:${item.id}`}>
                    {item.title}
                  </option>
                ))}
              </optgroup>
            </select>
            <div className="execution-open">
              <small>仅显示当前有权读取的运行</small>
              <button
                className="text-button"
                onClick={() => {
                  setRunId('');
                  setForm('open');
                }}
              >
                按运行 ID 打开
              </button>
            </div>
          </>
        )}
        <nav className="task-list" aria-label={`${labels[mode]}列表`}>
          {loading ? (
            <Spinner />
          ) : mode === 'runs' ? (
            runs
              .filter((item) =>
                `${item.summary} ${item.id} ${RUN_LABELS[item.status]}`.includes(filter),
              )
              .map((run) => (
                <button
                  key={run.id}
                  className={`task-list-item ${run.id === selectedId ? 'selected' : ''}`}
                  onClick={() => {
                    void open(run.id, 'runs');
                  }}
                >
                  <strong>{run.summary || `运行 ${run.id.slice(0, 8)}`}</strong>
                  <span className="task-status">{RUN_LABELS[run.status]}</span>
                  <p>
                    {tasks.find((item) => item.id === run.task_id)?.title ??
                      (run.task_id ? '任务运行' : '会话运行')}
                  </p>
                </button>
              ))
          ) : mode === 'actions' ? (
            actions
              .filter((item) =>
                `${item.parameters.text} ${item.target_id} ${ACTION_LABELS[item.status]}`.includes(
                  filter,
                ),
              )
              .map((action) => (
                <button
                  key={action.id}
                  className={`task-list-item ${action.id === selectedId ? 'selected' : ''}`}
                  onClick={() => {
                    void open(action.id, 'actions');
                  }}
                >
                  <strong>{action.target_id}</strong>
                  <span
                    className={`task-status ${action.status === 'unknown' ? 'status-blocked' : ''}`}
                  >
                    {ACTION_LABELS[action.status]}
                  </span>
                  <p>{action.parameters.text}</p>
                </button>
              ))
          ) : (
            grants
              .filter((item) => `${item.tool_id} ${item.target_id}`.includes(filter))
              .map((grant) => (
                <button
                  key={grant.id}
                  className={`task-list-item ${grant.id === selectedId ? 'selected' : ''}`}
                  onClick={() => {
                    void open(grant.id, 'grants');
                  }}
                >
                  <strong>
                    {grant.tool_id} → {grant.target_id}
                  </strong>
                  <span className="task-status">
                    {grant.status === 'revoked'
                      ? '已撤销'
                      : new Date(grant.expires_at).getTime() > Date.now()
                        ? '有效期内'
                        : '已过期'}
                  </span>
                  <p>{tasks.find((item) => item.id === grant.task_id)?.title ?? grant.task_id}</p>
                </button>
              ))
          )}
        </nav>
        <div className="sidebar-footer">
          <Avatar name={session.principal.display_name} size="small" />
          <div className="profile-copy">
            <strong>{session.principal.display_name}</strong>
            <IdentityTag principal={session.principal} />
          </div>
          <button className="icon-button" aria-label="退出登录" onClick={onLogout}>
            <Icon name="logout" size={18} />
          </button>
        </div>
      </aside>
      {opening ? (
        <section className="task-welcome">
          <Spinner label="正在确认当前访问权限…" />
        </section>
      ) : mode === 'runs' && selectedRun ? (
        <RunDetail
          key={selectedRun.id}
          api={api}
          run={selectedRun}
          session={session}
          onOpenAction={(id) => {
            setMode('actions');
            setSelectedId(id);
            onSelection?.('actions', id);
          }}
          onPromote={() => setForm('promote')}
          onSchedule={() => {
            setScheduleRun(selectedRun);
            setScheduling(true);
          }}
          onChanged={changedRun}
          onBack={() => {
            setSelectedId(null);
            onSelection?.('runs', null);
          }}
          refresh={refresh}
          accessLost={accessLost}
        />
      ) : mode === 'actions' && selectedAction ? (
        <ActionDetail
          key={`${selectedAction.id}:${selectedAction.view_scope}:${selectedAction.authz_generation}`}
          api={api}
          action={selectedAction}
          grant={grants.find((item) => item.id === selectedAction.grant_id)}
          task={tasks.find((item) => item.id === selectedAction.task_id)}
          session={session}
          onChanged={changedAction}
          onBack={() => {
            setSelectedId(null);
            onSelection?.('actions', null);
          }}
          refresh={refresh}
          accessLost={accessLost}
        />
      ) : mode === 'grants' && selectedGrant ? (
        <GrantDetail
          key={selectedGrant.id}
          api={api}
          grant={selectedGrant}
          session={session}
          onChanged={changedGrant}
          onBack={() => {
            setSelectedId(null);
            onSelection?.('grants', null);
          }}
          onPropose={() => {
            setInitialGrant(selectedGrant.id);
            setForm('actions');
          }}
          refresh={refresh}
          accessLost={accessLost}
        />
      ) : (
        <section className="task-welcome">
          <span className="task-welcome-symbol" aria-hidden="true">
            ◎
          </span>
          <span className="eyebrow">CLEAR CONTEXT. EXPLICIT AUTHORITY.</span>
          <h1>
            {mode === 'runs'
              ? '每次运行，都有清楚的边界'
              : mode === 'actions'
                ? '每个外部行动，都有明确的依据'
                : '把权限授予具体的工作'}
          </h1>
          <p>
            {mode === 'runs'
              ? '选择 Agent 与明确输入，查看预算和进展。运行结果由人独立验收。'
              : mode === 'actions'
                ? '先核对参数、授权与目标，再明确批准。结果未知时只查询已有回执。'
                : '限定执行者、工具、目标、资源版本、审批人和预算，随时撤销后续权限。'}
          </p>
          <button
            className="button primary"
            onClick={() => {
              setInitialGrant(undefined);
              setForm(mode);
            }}
          >
            新建{labels[mode]}
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
      {form === 'runs' && (
        <CreateRunForm
          api={api}
          client={client}
          session={session}
          tasks={tasks}
          grants={grants}
          onClose={() => setForm(null)}
          onCreated={(run) => {
            setRunScope('');
            changedRun(run);
            setForm(null);
            refresh();
          }}
          refresh={refresh}
          accessLost={accessLost}
        />
      )}
      {form === 'promote' && selectedRun && (
        <CreateTaskForm
          api={taskApi}
          client={client}
          session={session}
          promotion={selectedRun}
          onClose={() => setForm(null)}
          onCreated={(task) => {
            setForm(null);
            onOpenTask(task.id);
          }}
          refresh={refresh}
          accessLost={accessLost}
        />
      )}
      {form === 'grants' && (
        <CreateGrantForm
          api={api}
          taskApi={taskApi}
          client={client}
          session={session}
          tasks={tasks}
          onClose={() => setForm(null)}
          onCreated={(grant) => {
            changedGrant(grant);
            setForm(null);
            refresh();
          }}
          refresh={refresh}
          accessLost={accessLost}
        />
      )}
      {form === 'actions' && (
        <CreateActionForm
          api={api}
          grants={grants}
          tasks={tasks}
          {...(initialGrant ? { initialGrant } : {})}
          onClose={() => setForm(null)}
          onCreated={(action) => {
            changedAction(action);
            setForm(null);
            refresh();
          }}
          refresh={refresh}
          accessLost={accessLost}
        />
      )}
      {form === 'open' && (
        <Modal title="按运行 ID 打开" onClose={() => setForm(null)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setRunScope('');
              void open(runId, 'runs');
            }}
          >
            <Field label="运行 ID">
              <input
                className="text-input"
                required
                pattern="[0-9a-fA-F-]{36}"
                value={runId}
                onChange={(event) => setRunId(event.target.value)}
              />
            </Field>
            <p className="execution-note">仅能打开你当前具有运行读取权限的记录。</p>
            <div className="dialog-actions">
              <button className="button primary" disabled={opening}>
                打开运行
              </button>
            </div>
          </form>
        </Modal>
      )}
    </main>
  );
}
