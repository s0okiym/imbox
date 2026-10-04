import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Conversation,
  ExplicitMemory,
  KnowledgeSearchHit,
  KnowledgeSearchQuery,
  Task,
} from '@imbox/contracts';
import { ApiClient, ApiError, describeError, isAccessLoss, type Session } from '../api.js';
import { Avatar, Brand, ErrorNotice, fullTime, Icon, IdentityTag, Spinner } from '../components.js';
import { TaskApi } from '../tasks/task-api.js';
import { Field } from '../tasks/task-common.js';
import { Fact, Facts } from '../execution/execution-common.js';
import { KnowledgeApi, knowledgeError, MEMORY_CONFIRMATION, SOURCE_KIND } from './knowledge-api.js';
import { DeleteMemoryForm, MemoryForm, SourceReferences } from './memory-forms.js';
import '../execution/execution.css';
import './knowledge.css';

async function windowPages<T>(
  read: (cursor?: string) => Promise<{ items: T[]; next_cursor?: string }>,
  count: number,
  signal: AbortSignal,
) {
  const items: T[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < count; page++) {
    const next = await read(cursor);
    if (signal.aborted) return { items: [] as T[], more: false };
    items.push(...next.items);
    cursor = next.next_cursor;
    if (!cursor) break;
    if (seen.has(cursor)) throw new Error('Invalid pagination');
    seen.add(cursor);
  }
  return { items, more: cursor !== undefined };
}
function scopeQuery(value: string) {
  return value.startsWith('task:')
    ? { task_id: value.slice(5) }
    : value.startsWith('conversation:')
      ? { conversation_id: value.slice(13) }
      : {};
}
export function KnowledgeWorkspace({
  session,
  onLogout,
  onSessionLost,
  onSessionUpdated,
  onOpenTask,
}: {
  readonly session: Session;
  readonly onLogout: () => void;
  readonly onSessionLost: (message: string | null) => void;
  readonly onSessionUpdated: (session: Session) => void;
  readonly onOpenTask: (id: string) => void;
}) {
  const api = useMemo(
    () => new KnowledgeApi(session.tenant_id, session.csrf_token),
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
  const [mode, setMode] = useState<'search' | 'memories'>(
    session.capabilities.includes('knowledge.search') ? 'search' : 'memories',
  );
  const [tasks, setTasks] = useState<Task[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [text, setText] = useState('');
  const [kind, setKind] = useState<'' | KnowledgeSearchQuery['kind']>('');
  const [scope, setScope] = useState('');
  const [query, setQuery] = useState<KnowledgeSearchQuery | null>(null);
  const [hits, setHits] = useState<KnowledgeSearchHit[]>([]);
  const [memories, setMemories] = useState<ExplicitMemory[]>([]);
  const [more, setMore] = useState(false);
  const [count, setCount] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ExplicitMemory | null>(null);
  const [form, setForm] = useState<'create' | 'edit' | 'delete' | null>(null);
  const [initialSource, setInitialSource] = useState<KnowledgeSearchHit | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((value) => value + 1), []);
  const selectedSource = useRef(initialSource);
  selectedSource.current = initialSource;
  const forget = useCallback(() => {
    setHits([]);
    setMemories([]);
    setSelected(null);
    setSelectedId(null);
    setInitialSource(undefined);
    setForm(null);
    setMore(false);
  }, []);
  const accessLost = useCallback(
    (failure: unknown) => {
      forget();
      setTasks([]);
      setConversations([]);
      setQuery(null);
      setText('');
      setScope('');
      setCount(1);
      setError(knowledgeError(failure));
      if (failure instanceof ApiError && failure.status === 401)
        onSessionLost(describeError(failure));
    },
    [forget, onSessionLost],
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
        const [taskPage, conversationPage] = await Promise.all([
          session.capabilities.includes('tasks.collaboration')
            ? windowPages(
                (cursor) => taskApi.tasks(controller.signal, cursor),
                100,
                controller.signal,
              )
            : Promise.resolve({ items: [] as Task[] }),
          session.capabilities.includes('messaging.text')
            ? windowPages(
                (cursor) => client.conversations(controller.signal, cursor),
                100,
                controller.signal,
              )
            : Promise.resolve({ items: [] as Conversation[] }),
        ]);
        if (controller.signal.aborted) return;
        setTasks(taskPage.items);
        setConversations(conversationPage.items);
        if (mode === 'search') {
          if (query) {
            const result = await windowPages(
              (cursor) =>
                api.search({ ...query, ...(cursor ? { cursor } : {}) }, controller.signal),
              count,
              controller.signal,
            );
            if (controller.signal.aborted) return;
            setHits(result.items);
            setMore(result.more);
            const chosen = selectedSource.current;
            if (
              chosen &&
              !result.items.some(
                (item) =>
                  item.kind === chosen.kind &&
                  item.id === chosen.id &&
                  item.version === chosen.version &&
                  item.sha256 === chosen.sha256,
              )
            ) {
              setForm(null);
              setInitialSource(undefined);
              setError('已选来源发生变化或不再可见，请重新搜索和核对。');
              return;
            }
          }
        } else {
          const result = await windowPages(
            (cursor) =>
              api.memories(
                { ...scopeQuery(scope), limit: 50, ...(cursor ? { cursor } : {}) },
                controller.signal,
              ),
            count,
            controller.signal,
          );
          const current = selectedId ? await api.memory(selectedId, controller.signal) : null;
          if (controller.signal.aborted) return;
          setMemories(
            scope === 'personal'
              ? result.items.filter((item) => item.scope === 'personal')
              : result.items,
          );
          setMore(result.more);
          setSelected(current);
        }
        setError(null);
      } catch (failure: unknown) {
        if (!controller.signal.aborted) {
          if (isAccessLoss(failure)) accessLost(failure);
          else {
            forget();
            setError(knowledgeError(failure));
            if (failure instanceof ApiError && failure.status === 409) {
              setCount(1);
              refresh();
            }
          }
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
  }, [
    api,
    client,
    taskApi,
    session,
    mode,
    scope,
    query,
    count,
    selectedId,
    tick,
    accessLost,
    forget,
    refresh,
    onSessionLost,
    onSessionUpdated,
  ]);
  const switchMode = (value: typeof mode) => {
    forget();
    setMode(value);
    setScope('');
    setQuery(null);
    setCount(1);
    setLoading(true);
    setError(null);
  };
  const changed = (memory: ExplicitMemory) => {
    setForm(null);
    setInitialSource(undefined);
    setMode('memories');
    setScope(
      memory.scope === 'personal'
        ? 'personal'
        : `${memory.scope}:${memory.task_id ?? memory.conversation_id}`,
    );
    setSelectedId(memory.id);
    setSelected(memory);
    setCount(1);
    refresh();
  };
  const chooseScope = (value: string) => {
    forget();
    setScope(value);
    setQuery(null);
    setCount(1);
    setLoading(true);
  };
  const canWrite =
    session.principal.kind === 'human' && session.capabilities.includes('knowledge.memory');
  const canManage = canWrite && selected?.created_by === session.principal.id;
  return (
    <main className={`task-workspace knowledge-workspace ${selected ? 'has-selection' : ''}`}>
      <aside className="task-sidebar" aria-label="搜索与记忆导航">
        <header className="task-sidebar-header">
          <Brand />
          {canWrite && (
            <button
              className="icon-button"
              aria-label="建立显式记忆"
              onClick={() => {
                setInitialSource(undefined);
                setForm('create');
              }}
            >
              <Icon name="plus" />
            </button>
          )}
        </header>
        <div className="task-tabs" role="tablist" aria-label="搜索与记忆">
          {session.capabilities.includes('knowledge.search') && (
            <button
              role="tab"
              aria-selected={mode === 'search'}
              onClick={() => switchMode('search')}
            >
              搜索
            </button>
          )}
          {session.capabilities.includes('knowledge.memory') && (
            <button
              role="tab"
              aria-selected={mode === 'memories'}
              onClick={() => switchMode('memories')}
            >
              显式记忆
            </button>
          )}
        </div>
        <div className="knowledge-sidebar-form">
          <Field label={mode === 'search' ? '搜索范围' : '记忆筛选范围'}>
            <select
              className="text-input"
              value={scope}
              onChange={(event) => chooseScope(event.target.value)}
            >
              <option value="">全部当前可读内容</option>
              {mode === 'memories' && <option value="personal">仅个人记忆</option>}
              {mode === 'search' &&
                session.workspaces.map((item) => (
                  <option key={item.id} value={`workspace:${item.id}`}>
                    工作空间 · {item.name}
                  </option>
                ))}
              {conversations.map((item) => (
                <option key={item.id} value={`conversation:${item.id}`}>
                  会话 · {item.title}
                </option>
              ))}
              {tasks.map((item) => (
                <option key={item.id} value={`task:${item.id}`}>
                  任务 · {item.title}
                </option>
              ))}
            </select>
          </Field>
          {mode === 'search' && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (text.trim().length < 2) return;
                forget();
                setCount(1);
                setLoading(true);
                setQuery({
                  q: text.trim(),
                  limit: 50,
                  ...(kind ? { kind } : {}),
                  ...scopeQuery(scope),
                  ...(scope.startsWith('workspace:') ? { workspace_id: scope.slice(10) } : {}),
                });
              }}
            >
              <Field label="搜索关键词">
                <input
                  className="text-input"
                  required
                  minLength={2}
                  maxLength={200}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                />
              </Field>
              <Field label="内容类型">
                <select
                  className="text-input"
                  value={kind}
                  onChange={(event) => setKind(event.target.value as typeof kind)}
                >
                  <option value="">所有支持类型</option>
                  {Object.entries(SOURCE_KIND).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <button className="button primary" disabled={text.trim().length < 2}>
                搜索当前可读内容
              </button>
            </form>
          )}
        </div>
        {mode === 'memories' && (
          <nav className="task-list" aria-label="显式记忆列表">
            {loading ? (
              <Spinner />
            ) : (
              memories.map((memory) => (
                <button
                  key={memory.id}
                  className={`task-list-item ${memory.id === selectedId ? 'selected' : ''}`}
                  onClick={() => {
                    setSelected(null);
                    setSelectedId(memory.id);
                    setForm(null);
                  }}
                >
                  <strong>{memory.body.slice(0, 80)}</strong>
                  <span className="task-status">
                    {memory.status === 'disabled'
                      ? '已停用'
                      : MEMORY_CONFIRMATION[memory.confirmation]}
                  </span>
                  <p>
                    {memory.scope === 'personal'
                      ? '个人'
                      : memory.scope === 'conversation'
                        ? '会话共享'
                        : '任务共享'}{' '}
                    · 版本 {memory.version}
                  </p>
                </button>
              ))
            )}
            {more && (
              <button className="text-button" onClick={() => setCount((value) => value + 1)}>
                读取更多记忆
              </button>
            )}
          </nav>
        )}
        <div className="sidebar-footer">
          <Avatar name={session.principal.display_name} size="small" />
          <div className="profile-copy">
            <strong>{session.principal.display_name}</strong>
            <IdentityTag principal={session.principal} />
          </div>
          <button className="icon-button" aria-label="退出登录" onClick={onLogout}>
            <Icon name="logout" />
          </button>
        </div>
      </aside>
      {mode === 'search' ? (
        <section className="task-detail" aria-label="搜索结果">
          <header className="task-detail-header">
            <div>
              <span className="eyebrow">PERMISSION-AWARE SEARCH</span>
              <h1>从当前有权访问的内容中查找</h1>
            </div>
          </header>
          <div className="task-detail-scroll">
            <p className="execution-note">
              结果会重新检查来源权限；摘要属于用户内容，不是执行指令。搜索不会授予任务或工具权限。
            </p>
            {loading ? (
              <Spinner />
            ) : !query ? (
              <p className="execution-note">输入至少 2 个字符，并选择需要的范围。</p>
            ) : !hits.length ? (
              <p className="execution-note">当前条件下没有可显示的结果。</p>
            ) : (
              <>
                <p className="execution-note">当前查询：{query.q}</p>
                {hits.map((hit) => (
                  <article className="execution-context" key={`${hit.kind}:${hit.id}`}>
                    <h2>{hit.title || SOURCE_KIND[hit.kind]}</h2>
                    <p className="execution-note">
                      {SOURCE_KIND[hit.kind]} · 固定版本 {hit.version}
                    </p>
                    <p className="task-prose">{hit.snippet}</p>
                    <details>
                      <summary>查看来源标识和校验值</summary>
                      <code className="knowledge-code">
                        {hit.id}
                        <br />
                        {hit.sha256}
                      </code>
                    </details>
                    <div className="task-action-row">
                      {hit.kind === 'memory' ? (
                        <button
                          className="button subtle"
                          onClick={() => {
                            setMode('memories');
                            setScope('');
                            setSelectedId(hit.id);
                            setSelected(null);
                            setHits([]);
                            setCount(1);
                          }}
                        >
                          读取当前记忆详情
                        </button>
                      ) : (
                        canWrite && (
                          <button
                            className="button subtle"
                            onClick={() => {
                              setInitialSource(hit);
                              setForm('create');
                            }}
                          >
                            以此为来源建立记忆
                          </button>
                        )
                      )}
                      {hit.kind === 'task' && (
                        <button className="text-button" onClick={() => onOpenTask(hit.id)}>
                          打开当前有权访问的任务
                        </button>
                      )}
                    </div>
                  </article>
                ))}
                {more && (
                  <button className="button subtle" onClick={() => setCount((value) => value + 1)}>
                    读取更多搜索结果
                  </button>
                )}
              </>
            )}
          </div>
        </section>
      ) : selected ? (
        <section className="task-detail" aria-label="记忆详情">
          <header className="task-detail-header">
            <button
              className="icon-button task-mobile-back"
              aria-label="返回记忆列表"
              onClick={() => {
                setSelected(null);
                setSelectedId(null);
              }}
            >
              <Icon name="back" />
            </button>
            <div>
              <span className="eyebrow">EXPLICIT MEMORY · 用户内容</span>
              <h1>
                {selected.status === 'disabled'
                  ? '已停用的记忆'
                  : MEMORY_CONFIRMATION[selected.confirmation]}
              </h1>
            </div>
          </header>
          <div className="task-detail-scroll">
            <p className="task-prose">{selected.body}</p>
            <Facts>
              <Fact label="可见范围">
                {selected.scope === 'personal'
                  ? '仅个人'
                  : selected.scope === 'conversation'
                    ? '会话共享'
                    : '任务共享'}
              </Fact>
              <Fact label="确认状态">{MEMORY_CONFIRMATION[selected.confirmation]}</Fact>
              <Fact label="人工评估可信程度">{selected.confidence} / 100</Fact>
              <Fact label="有效期">
                {selected.expires_at ? fullTime(selected.expires_at) : '未设置'}
              </Fact>
              <Fact label="固定版本">{selected.version}</Fact>
              <Fact label="是否具有指令权限">没有</Fact>
            </Facts>
            <p className="execution-note">
              待确认、冲突、停用、过期或来源失效的记忆不会用于搜索与运行上下文。读取内容不会改变执行授权。
            </p>
            {canManage && (
              <div className="task-action-row">
                <button className="button subtle" onClick={() => setForm('edit')}>
                  修订内容、状态与有效期
                </button>
                <button className="button subtle" onClick={() => setForm('delete')}>
                  删除此记忆
                </button>
              </div>
            )}
            <section className="task-section">
              <h2>固定来源</h2>
              {selected.source_refs.length ? (
                <SourceReferences sources={selected.source_refs} />
              ) : (
                <p className="execution-note">由创建者明确填写，没有关联来源。</p>
              )}
            </section>
          </div>
        </section>
      ) : (
        <section className="task-welcome">
          <span className="task-welcome-symbol">◈</span>
          <h1>明确保存，随时核对</h1>
          <p>记忆有明确的可见范围、来源版本、确认状态和有效期。没有自动保存的隐含结论。</p>
          {canWrite && (
            <button
              className="button primary"
              onClick={() => {
                setInitialSource(undefined);
                setForm('create');
              }}
            >
              建立显式记忆
            </button>
          )}
        </section>
      )}
      {error && (
        <div className="task-global-notice">
          <ErrorNotice>{error}</ErrorNotice>
          <button className="text-button" onClick={refresh}>
            重新读取
          </button>
        </div>
      )}
      {form === 'create' && (
        <MemoryForm
          api={api}
          tasks={tasks}
          conversations={conversations}
          {...(initialSource ? { initialSource } : {})}
          onClose={() => {
            setForm(null);
            setInitialSource(undefined);
          }}
          onChanged={changed}
          refresh={refresh}
          accessLost={accessLost}
        />
      )}
      {form === 'edit' && selected && (
        <MemoryForm
          api={api}
          tasks={tasks}
          conversations={conversations}
          memory={selected}
          onClose={() => setForm(null)}
          onChanged={changed}
          refresh={refresh}
          accessLost={accessLost}
        />
      )}
      {form === 'delete' && selected && (
        <DeleteMemoryForm
          api={api}
          memory={selected}
          onClose={() => setForm(null)}
          onDeleted={() => {
            forget();
            refresh();
          }}
          refresh={refresh}
          accessLost={accessLost}
        />
      )}
    </main>
  );
}
