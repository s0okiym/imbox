import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CollaborationRequest, RequestDecisionResult, Task } from '@imbox/contracts';
import { ApiClient, ApiError, describeError, isAccessLoss } from '../api.js';
import type { Session } from '../api.js';
import { Avatar, Brand, ErrorNotice, Icon, IdentityTag, Spinner } from '../components.js';
import { TaskApi } from './task-api.js';
import { TaskStatus, useWorkspaceMembers } from './task-common.js';
import { CreateTaskForm } from './task-forms.js';
import { TaskDetail } from './task-detail.js';
import { RequestDetail } from './request-detail.js';
import { TaskEscalations } from './task-escalations.js';
import { REQUEST_KINDS, REQUEST_LABELS, taskError, terminalTask } from './task-state.js';
import './tasks.css';

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
    if (cursor !== undefined) {
      if (visited.has(cursor)) throw new Error('Invalid pagination');
      visited.add(cursor);
    }
  } while (cursor !== undefined);
  return items;
}
export function TaskWorkspace({
  session,
  onLogout,
  onSessionLost,
  onSessionUpdated,
  initialTaskId,
  initialRequestId,
  onSelection,
  onOpenRun,
}: {
  readonly session: Session;
  readonly onLogout: () => void;
  readonly onSessionLost: (message: string | null) => void;
  readonly onSessionUpdated: (session: Session) => void;
  readonly initialTaskId?: string;
  readonly initialRequestId?: string;
  readonly onSelection?: (kind: 'task' | 'request', id: string | null) => void;
  readonly onOpenRun: (id: string) => void;
}) {
  const client = useMemo(
    () => new ApiClient(session.tenant_id, session.csrf_token),
    [session.tenant_id, session.csrf_token],
  );
  const api = useMemo(
    () => new TaskApi(session.tenant_id, session.csrf_token),
    [session.tenant_id, session.csrf_token],
  );
  const roster = useWorkspaceMembers(client, session.workspaces[0]?.id ?? '');
  const [mode, setMode] = useState<'tasks' | 'requests'>('tasks');
  const [tasks, setTasks] = useState<readonly Task[]>([]);
  const [requests, setRequests] = useState<readonly CollaborationRequest[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [acceptedTargets, setAcceptedTargets] = useState<ReadonlyMap<string, string>>(new Map());
  const [filter, setFilter] = useState('');
  const [taskFilter, setTaskFilter] = useState<'all' | 'mine' | 'review' | 'ended'>('all');
  const [direction, setDirection] = useState<'incoming' | 'outgoing'>('incoming');
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [escalationsOpen, setEscalationsOpen] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const selection = useRef<AbortController | null>(null);
  const viewGeneration = useRef(0);
  const refresh = useCallback(() => {
    // Invalidate older reads immediately, before React runs effect cleanup.
    viewGeneration.current += 1;
    setRefreshTick((value) => value + 1);
  }, []);
  useEffect(() => () => selection.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      const generation = viewGeneration.current;
      try {
        const me = await client.me(controller.signal);
        if (controller.signal.aborted || generation !== viewGeneration.current) return;
        if (me.principal.id !== session.principal.id || me.tenant_id !== session.tenant_id) {
          onSessionLost('登录身份已变化，请重新确认。');
          return;
        }
        if (me.authz_revision !== session.authz_revision) {
          onSessionUpdated(me);
          return;
        }
        const [taskItems, requestItems] = await Promise.all([
          pages((cursor) => api.tasks(controller.signal, cursor), controller.signal),
          pages((cursor) => api.requests(controller.signal, cursor), controller.signal),
        ]);
        if (controller.signal.aborted || generation !== viewGeneration.current) return;
        setTasks(taskItems);
        setRequests(requestItems);
        setSelectedTaskId((id) =>
          id !== null && taskItems.some((task) => task.id === id) ? id : null,
        );
        setSelectedRequestId((id) =>
          id !== null && requestItems.some((request) => request.id === id) ? id : null,
        );
        setError(null);
      } catch (failure: unknown) {
        if (controller.signal.aborted || generation !== viewGeneration.current) return;
        if (isAccessLoss(failure)) {
          setTasks([]);
          setRequests([]);
          onSessionLost(describeError(failure));
          return;
        }
        setError(taskError(failure));
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
    session.tenant_id,
    session.principal.id,
    session.authz_revision,
    refreshTick,
    onSessionLost,
    onSessionUpdated,
  ]);

  const accessLost = useCallback(
    (failure: unknown): void => {
      selection.current?.abort();
      setOpening(false);
      if (failure instanceof ApiError && failure.status === 401) {
        onSessionLost(describeError(failure));
        return;
      }
      setTasks((items) => items.filter((item) => item.id !== selectedTaskId));
      setRequests((items) => items.filter((item) => item.id !== selectedRequestId));
      setSelectedTaskId(null);
      setSelectedRequestId(null);
      setCreating(false);
      setEscalationsOpen(false);
      setError(taskError(failure));
    },
    [selectedTaskId, selectedRequestId, onSessionLost],
  );
  const selectTask = async (id?: string): Promise<void> => {
    setMode('tasks');
    setSelectedRequestId(null);
    setSelectedTaskId(null);
    selection.current?.abort();
    if (id === undefined) {
      refresh();
      return;
    }
    const controller = new AbortController();
    selection.current = controller;
    setOpening(true);
    try {
      const task = await api.task(id, controller.signal);
      if (controller.signal.aborted) return;
      refresh();
      setTasks((items) => [task, ...items.filter((item) => item.id !== task.id)]);
      setSelectedTaskId(task.id);
      onSelection?.('task', task.id);
      setError(null);
    } catch (failure: unknown) {
      if (!controller.signal.aborted) {
        if (isAccessLoss(failure)) accessLost(failure);
        else setError(taskError(failure));
      }
    } finally {
      if (!controller.signal.aborted) setOpening(false);
    }
  };
  const selectRequest = async (id: string): Promise<void> => {
    setMode('requests');
    setSelectedTaskId(null);
    setSelectedRequestId(null);
    selection.current?.abort();
    const controller = new AbortController();
    selection.current = controller;
    setOpening(true);
    try {
      const request = await api.requestById(id, controller.signal);
      if (controller.signal.aborted) return;
      refresh();
      setRequests((items) => [request, ...items.filter((item) => item.id !== request.id)]);
      setSelectedRequestId(request.id);
      onSelection?.('request', request.id);
      setError(null);
    } catch (failure: unknown) {
      if (!controller.signal.aborted) {
        if (isAccessLoss(failure)) accessLost(failure);
        else setError(taskError(failure));
      }
    } finally {
      if (!controller.signal.aborted) setOpening(false);
    }
  };
  useEffect(() => {
    if (initialTaskId) {
      if (selectedTaskId !== initialTaskId) void selectTask(initialTaskId);
    } else if (initialRequestId) {
      if (selectedRequestId !== initialRequestId) void selectRequest(initialRequestId);
    } else {
      setSelectedTaskId(null);
      setSelectedRequestId(null);
    }
  }, [initialTaskId, initialRequestId]);
  const changedRequest = (request: CollaborationRequest): void =>
    setRequests((items) => [request, ...items.filter((item) => item.id !== request.id)]);
  const decision = (result: RequestDecisionResult): void => {
    changedRequest(result.request);
    if (result.agreement !== undefined) {
      const target = result.agreement.child_task_id ?? result.agreement.task_id;
      setAcceptedTargets((items) => new Map([...items, [result.request.id, target]]));
    }
  };
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;
  const selectedRequest = requests.find((request) => request.id === selectedRequestId) ?? null;
  const selected = mode === 'tasks' ? selectedTask !== null : selectedRequest !== null;
  const visibleTasks = tasks
    .filter(
      (task) =>
        task.title.toLocaleLowerCase().includes(filter.toLocaleLowerCase()) &&
        (taskFilter === 'all' ||
          (taskFilter === 'mine' && task.owner_principal_id === session.principal.id) ||
          (taskFilter === 'review' &&
            task.status === 'in_review' &&
            task.reviewer_principal_ids.includes(session.principal.id)) ||
          (taskFilter === 'ended' && terminalTask(task))),
    )
    .toSorted((a, b) => b.created_at.localeCompare(a.created_at));
  const visibleRequests = requests
    .filter(
      (request) =>
        request.proposal.title.toLocaleLowerCase().includes(filter.toLocaleLowerCase()) &&
        (direction === 'incoming'
          ? request.recipient_id === session.principal.id
          : request.proposer_id === session.principal.id),
    )
    .toSorted((a, b) => b.created_at.localeCompare(a.created_at));
  const unreadProposals = requests.filter(
    (request) => request.recipient_id === session.principal.id && request.status === 'pending',
  ).length;
  const chooseMode = (next: typeof mode): void => {
    selection.current?.abort();
    setOpening(false);
    setMode(next);
    setSelectedTaskId(null);
    setSelectedRequestId(null);
    setFilter('');
  };
  return (
    <main className={`task-workspace ${selected ? 'has-selection' : ''}`}>
      <aside className="task-sidebar" aria-label="任务工作台导航">
        <header className="task-sidebar-header">
          <Brand />
          <button className="icon-button" onClick={() => setCreating(true)} aria-label="新建任务">
            <Icon name="plus" />
          </button>
        </header>
        {session.capabilities.includes('tasks.escalations') && (
          <button className="text-button execution-open" onClick={() => setEscalationsOpen(true)}>
            任务升级待处理
          </button>
        )}
        <div className="task-tabs" role="tablist" aria-label="任务与协作">
          <button role="tab" aria-selected={mode === 'tasks'} onClick={() => chooseMode('tasks')}>
            任务
          </button>
          <button
            role="tab"
            aria-selected={mode === 'requests'}
            onClick={() => chooseMode('requests')}
          >
            协作请求{unreadProposals > 0 && <span>{unreadProposals}</span>}
          </button>
        </div>
        <div className="search-field">
          <Icon name="search" size={17} />
          <input
            aria-label={mode === 'tasks' ? '筛选任务' : '筛选协作请求'}
            placeholder={mode === 'tasks' ? '搜索任务' : '搜索提案'}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
        {mode === 'tasks' ? (
          <select
            className="text-input task-list-filter"
            aria-label="任务范围"
            value={taskFilter}
            onChange={(event) => setTaskFilter(event.target.value as typeof taskFilter)}
          >
            <option value="all">我可查看的任务</option>
            <option value="mine">我负责的任务</option>
            <option value="review">等待我验收</option>
            <option value="ended">已经结束的任务</option>
          </select>
        ) : (
          <div className="segmented-control task-direction">
            <button
              className={direction === 'incoming' ? 'active' : ''}
              onClick={() => setDirection('incoming')}
            >
              收到的
            </button>
            <button
              className={direction === 'outgoing' ? 'active' : ''}
              onClick={() => setDirection('outgoing')}
            >
              发出的
            </button>
          </div>
        )}
        <nav className="task-list" aria-label={mode === 'tasks' ? '任务列表' : '协作请求列表'}>
          {loading ? (
            <Spinner />
          ) : mode === 'tasks' ? (
            visibleTasks.length === 0 ? (
              <div className="task-list-empty">
                <p>这里还没有任务。</p>
                <button className="text-button" onClick={() => setCreating(true)}>
                  创建第一个任务
                </button>
              </div>
            ) : (
              visibleTasks.map((task) => (
                <button
                  className={`task-list-item ${task.id === selectedTaskId ? 'selected' : ''}`}
                  key={task.id}
                  onClick={() => {
                    void selectTask(task.id);
                  }}
                >
                  <strong>{task.title}</strong>
                  <TaskStatus task={task} />
                  <p>{task.goal}</p>
                </button>
              ))
            )
          ) : visibleRequests.length === 0 ? (
            <div className="task-list-empty">
              <p>{direction === 'incoming' ? '暂时没有收到提案。' : '还没有发出提案。'}</p>
            </div>
          ) : (
            visibleRequests.map((request) => (
              <button
                className={`task-list-item ${request.id === selectedRequestId ? 'selected' : ''}`}
                key={request.id}
                onClick={() => {
                  void selectRequest(request.id);
                }}
              >
                <span className="task-request-kind">{REQUEST_KINDS[request.kind]}</span>
                <strong>{request.proposal.title}</strong>
                <span className={`task-status request-${request.status}`}>
                  {REQUEST_LABELS[request.status]}
                </span>
                <p>{request.proposal.disclosure.summary}</p>
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
          <button className="icon-button" onClick={onLogout} aria-label="退出登录">
            <Icon name="logout" size={18} />
          </button>
        </div>
      </aside>
      {opening ? (
        <section className="task-welcome">
          <Spinner label="正在确认当前访问权限…" />
        </section>
      ) : mode === 'tasks' && selectedTask !== null ? (
        <TaskDetail
          key={`${session.principal.id}:${session.tenant_id}:${selectedTask.view_scope}:${selectedTask.authz_generation}`}
          api={api}
          client={client}
          task={selectedTask}
          session={session}
          refresh={refresh}
          accessLost={accessLost}
          onOpenRun={onOpenRun}
          onBack={() => {
            setSelectedTaskId(null);
            onSelection?.('task', null);
          }}
        />
      ) : mode === 'requests' && selectedRequest !== null ? (
        <RequestDetail
          key={`${session.principal.id}:${session.tenant_id}:${selectedRequest.view_scope}:${selectedRequest.authz_generation}:${selectedRequest.proposal_version}`}
          api={api}
          request={selectedRequest}
          session={session}
          members={roster.members}
          refresh={refresh}
          accessLost={accessLost}
          onChanged={changedRequest}
          onDecision={decision}
          onOpenTask={(id) => {
            void selectTask(id);
          }}
          {...(acceptedTargets.has(selectedRequest.id)
            ? { acceptedTaskId: acceptedTargets.get(selectedRequest.id)! }
            : {})}
          onBack={() => {
            setSelectedRequestId(null);
            onSelection?.('request', null);
          }}
        />
      ) : (
        <section className="task-welcome">
          <span className="task-welcome-symbol" aria-hidden="true">
            ◇
          </span>
          <span className="eyebrow">CLEAR GOALS. EXPLICIT AGREEMENTS.</span>
          <h1>{mode === 'tasks' ? '让对话走向共同的成果' : '每一次协作，都从明确回应开始'}</h1>
          <p>
            {mode === 'tasks'
              ? '定义目标、邀请协作、提交证据，再由指定的人验收。'
              : '选择一份提案，阅读其目标、输入、预算和边界，再决定是否接受。'}
          </p>
          {mode === 'tasks' && (
            <button className="button primary" onClick={() => setCreating(true)}>
              新建任务
            </button>
          )}
        </section>
      )}
      {error !== null && (
        <div className="task-global-notice">
          <ErrorNotice>{error}</ErrorNotice>
          <button className="text-button" onClick={refresh}>
            重新同步
          </button>
        </div>
      )}
      {creating && (
        <CreateTaskForm
          api={api}
          client={client}
          session={session}
          onClose={() => setCreating(false)}
          refresh={refresh}
          accessLost={accessLost}
          onCreated={(task) => {
            setTasks((items) => [task, ...items.filter((item) => item.id !== task.id)]);
            setMode('tasks');
            setSelectedTaskId(task.id);
            setCreating(false);
            refresh();
            onSelection?.('task', task.id);
          }}
        />
      )}
      {escalationsOpen && (
        <TaskEscalations
          api={api}
          onClose={() => setEscalationsOpen(false)}
          accessLost={accessLost}
          onTakenOver={(task) => {
            setTasks((items) => [task, ...items.filter((item) => item.id !== task.id)]);
            setMode('tasks');
            setSelectedTaskId(task.id);
            setEscalationsOpen(false);
            refresh();
          }}
        />
      )}
    </main>
  );
}
