import { VirtualMessages } from './messages/virtual-messages.js';
import { AgentWorkspace } from './agents/AgentWorkspace.js';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Conversation, CreateConversationInput, StoredResource } from '@imbox/contracts';
import { ApiClient, ApiError, describeError, isAccessLoss } from './api.js';
import type { ChatMessage, Member, Session } from './api.js';
import {
  Avatar,
  Brand,
  ErrorNotice,
  fullTime,
  Icon,
  IdentityTag,
  Modal,
  relativeTime,
  Spinner,
} from './components.js';
import {
  applyMessageMutation,
  failPending,
  remainingPending,
  shouldSendOnEnter,
  viewKey,
} from './message-state.js';
import type { MessageSnapshot, PendingMessage } from './message-state.js';
import { isExternalSessionChange, sessionChange } from './session-sync.js';
import { startConversationSync } from './conversation-sync.js';
import type { SyncStatus } from './conversation-sync.js';
import { BrowserSyncSocket } from './browser-socket.js';
import { useReadCursor } from './use-read-cursor.js';
import { TaskWorkspace } from './tasks/TaskWorkspace.js';
import { ExecutionWorkspace } from './execution/ExecutionWorkspace.js';
import { useAppLocation, type AppSection } from './app-location.js';
import { ResourceWorkspace } from './resources/ResourceWorkspace.js';
import { KnowledgeWorkspace } from './knowledge/KnowledgeWorkspace.js';
import { RecoveryWorkspace } from './recovery/RecoveryWorkspace.js';
import { NotificationWorkspace } from './notifications/NotificationWorkspace.js';
import { GovernanceWorkspace } from './governance/GovernanceWorkspace.js';
import { DeviceWorkspace } from './offline/DeviceWorkspace.js';
import { useConversationDevice, useDeviceSession } from './offline/device-hooks.js';
import { useDeviceDraft } from './offline/use-device-draft.js';
import { clearDeviceData, deviceChanged, deviceStore } from './offline/device-store.js';
import { conversationScope } from './offline/offline-store.js';
import { LinkedMessage } from './messages/linked-message.js';
import { ResourceApi } from './resources/resource-api.js';
import { AttachmentLinks, UploadForm } from './resources/resource-components.js';
import {
  MessageActions,
  Quote,
  ReactionsDialog,
  ThreadDialog,
} from './messages/message-interactions.js';

const DEFAULT_TENANT = String(
  import.meta.env['VITE_DEFAULT_TENANT_ID'] ?? '10000000-0000-4000-8000-000000000001',
);
const DEV_LOGIN = import.meta.env.DEV && import.meta.env['VITE_ENABLE_DEV_LOGIN'] === 'true';
const DEV_PEOPLE = [
  { id: '30000000-0000-4000-8000-000000000001', name: 'Alice' },
  { id: '30000000-0000-4000-8000-000000000002', name: 'Bob' },
  { id: '30000000-0000-4000-8000-000000000003', name: 'Charlie' },
] as const;

function savedTenant(): string {
  try {
    return localStorage.getItem('imbox.tenant') ?? DEFAULT_TENANT;
  } catch {
    return DEFAULT_TENANT;
  }
}
function rememberTenant(tenant: string): void {
  try {
    localStorage.setItem('imbox.tenant', tenant);
  } catch {
    /* Tenant selection can remain in memory. */
  }
}
function broadcastSessionChange(sourceId: string): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel('imbox.session');
  channel.postMessage(sessionChange(sourceId));
  channel.close();
}

export function App() {
  const { location, navigate } = useAppLocation();
  const section = location.section;
  const [sourceId] = useState(() => crypto.randomUUID());
  const [tenantId, setTenantId] = useState(() => location.tenantId ?? savedTenant());
  const [session, setSession] = useState<Session | null>(null);
  const setSection = useCallback(
    (section: AppSection) => navigate({ section, tenantId: session?.tenant_id ?? tenantId }),
    [navigate, session?.tenant_id, tenantId],
  );
  const [checking, setChecking] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const authEpoch = useRef(0);
  const authController = useRef<AbortController | null>(null);

  const clearSession = useCallback((message: string | null) => {
    authEpoch.current += 1;
    authController.current?.abort();
    setSession(null);
    setChecking(false);
    setNotice(message);
  }, []);

  useDeviceSession(session, clearSession);

  useEffect(() => {
    const controller = new AbortController();
    authController.current = controller;
    const epoch = ++authEpoch.current;
    void new ApiClient(tenantId)
      .me(controller.signal)
      .then((me) => {
        if (!controller.signal.aborted && authEpoch.current === epoch) {
          setSession(me);
          setChecking(false);
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || authEpoch.current !== epoch) return;
        setChecking(false);
        if (!(error instanceof ApiError && error.status === 401)) setNotice(describeError(error));
      });
    return () => controller.abort();
    // Initial restore only; later changes run through the explicit login boundary.
  }, []);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel('imbox.session');
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (isExternalSessionChange(event.data, sourceId)) {
        clearSession('此浏览器中的登录状态已改变，请重新确认身份。');
        void clearDeviceData().catch(() => {});
      }
    };
    return () => channel.close();
  }, [clearSession, sourceId]);

  useEffect(() => {
    if (session && location.tenantId && location.tenantId !== session.tenant_id) {
      authController.current?.abort();
      setSession(null);
      window.location.reload();
    }
  }, [session, location.tenantId]);

  const login = async (nextTenant: string, principalId?: string): Promise<void> => {
    authController.current?.abort();
    const controller = new AbortController();
    authController.current = controller;
    const epoch = ++authEpoch.current;
    const next = nextTenant.trim();
    setTenantId(next);
    if (location.tenantId && location.tenantId !== next)
      navigate({ section: 'messages', tenantId: next }, true);
    rememberTenant(next);
    setSession(null);
    setNotice(null);
    setChecking(true);
    try {
      const client = new ApiClient(next);
      if (principalId !== undefined) {
        if (!DEV_LOGIN) throw new Error('Development login is disabled');
        broadcastSessionChange(sourceId);
        await client.devLogin(principalId);
      }
      const me = await client.me(controller.signal);
      if (!controller.signal.aborted && authEpoch.current === epoch) {
        setSession(me);
        setChecking(false);
      }
    } catch (error: unknown) {
      if (!controller.signal.aborted && authEpoch.current === epoch) {
        setChecking(false);
        setNotice(describeError(error));
      }
    }
  };

  const logout = async (): Promise<void> => {
    const old = session;
    clearSession(null);
    await clearDeviceData().catch(() => {});
    broadcastSessionChange(sourceId);
    if (old === null) return;
    try {
      await new ApiClient(old.tenant_id, old.csrf_token).logout();
    } catch {
      setNotice('本地内容已清除，服务端退出尚未确认。请联网后再次确认登录状态。');
    }
  };

  if (session === null) {
    if (section === 'device') return <DeviceWorkspace onClose={() => setSection('messages')} />;
    return (
      <>
        <LoginScreen tenantId={tenantId} checking={checking} notice={notice} onLogin={login} />
        <button className="offline-entry" onClick={() => setSection('device')}>
          查看本机离线数据
        </button>
      </>
    );
  }
  const identity = `${session.tenant_id}:${session.principal.id}:${session.authz_revision}`;
  const tasksEnabled = session.capabilities.includes('tasks.collaboration');
  const executionEnabled =
    session.capabilities.includes('agents.runs') ||
    session.capabilities.includes('actions.approvals');
  const resourcesEnabled = session.capabilities.includes('resources.text_uploads');
  const knowledgeEnabled =
    session.capabilities.includes('knowledge.search') ||
    session.capabilities.includes('knowledge.memory');
  const recoveryEnabled =
    session.principal.kind === 'human' && session.capabilities.includes('actions.recovery');
  const agentsEnabled = session.capabilities.includes('agents.directory');
  const notificationsEnabled = session.capabilities.includes('notifications.inbox');
  const governanceEnabled = session.capabilities.includes('governance.policy');
  return (
    <div className="application-shell">
      <nav className="app-navigation" aria-label="应用导航">
        <button
          aria-current={section === 'messages' ? 'page' : undefined}
          onClick={() => setSection('messages')}
        >
          <Icon name="chat" size={16} />
          消息
        </button>
        {tasksEnabled && (
          <button
            aria-current={section === 'tasks' ? 'page' : undefined}
            onClick={() => setSection('tasks')}
          >
            <Icon name="check" size={16} />
            任务工作台
          </button>
        )}
        {executionEnabled && (
          <button
            aria-current={section === 'execution' ? 'page' : undefined}
            onClick={() => setSection('execution')}
          >
            <Icon name="arrow" size={16} />
            运行与行动
          </button>
        )}
        {resourcesEnabled && (
          <button
            aria-current={section === 'resources' ? 'page' : undefined}
            onClick={() => setSection('resources')}
          >
            <Icon name="info" size={16} />
            文件与制品
          </button>
        )}
        {knowledgeEnabled && (
          <button
            aria-current={section === 'knowledge' ? 'page' : undefined}
            onClick={() => setSection('knowledge')}
          >
            <Icon name="search" size={16} />
            搜索与记忆
          </button>
        )}
        {recoveryEnabled && (
          <button
            aria-current={section === 'recovery' ? 'page' : undefined}
            onClick={() => setSection('recovery')}
          >
            <Icon name="alert" size={16} />
            恢复核对
          </button>
        )}
        {agentsEnabled && (
          <button
            aria-current={section === 'agents' ? 'page' : undefined}
            onClick={() => setSection('agents')}
          >
            Agent 目录
          </button>
        )}
        {notificationsEnabled && (
          <button
            aria-current={section === 'notifications' ? 'page' : undefined}
            onClick={() => setSection('notifications')}
          >
            通知中心
          </button>
        )}
        {governanceEnabled && (
          <button
            aria-current={section === 'governance' ? 'page' : undefined}
            onClick={() => setSection('governance')}
          >
            <Icon name="info" size={16} />
            数据与隐私
          </button>
        )}
        <button
          aria-current={section === 'device' ? 'page' : undefined}
          onClick={() => setSection('device')}
        >
          本机离线数据
        </button>
        <span>{session.workspaces[0]?.name ?? 'Imbox'}</span>
      </nav>
      <div className="application-content">
        {section === 'device' ? (
          <DeviceWorkspace onClose={() => setSection('messages')} />
        ) : section === 'agents' && agentsEnabled ? (
          <AgentWorkspace
            key={identity}
            session={session}
            onClose={() => setSection('messages')}
            onSessionLost={clearSession}
            onSessionUpdated={setSession}
          />
        ) : section === 'notifications' && notificationsEnabled ? (
          <NotificationWorkspace
            key={identity}
            session={session}
            onClose={() => setSection('messages')}
            onSessionLost={clearSession}
            onSessionUpdated={setSession}
            onOpen={(item) => {
              const base = { tenantId: session.tenant_id };
              if (item.target.type === 'message' && item.conversation_id)
                navigate({
                  ...base,
                  section: 'messages',
                  conversationId: item.conversation_id,
                  messageId: item.target.id,
                });
              else if (item.target.type === 'task')
                navigate({ ...base, section: 'tasks', taskId: item.target.id });
              else if (item.target.type === 'request')
                navigate({ ...base, section: 'tasks', requestId: item.target.id });
              else if (item.target.type === 'action')
                navigate({ ...base, section: 'execution', actionId: item.target.id });
              else if (item.target.type === 'run')
                navigate({ ...base, section: 'execution', runId: item.target.id });
            }}
          />
        ) : section === 'governance' && governanceEnabled ? (
          <GovernanceWorkspace
            key={identity}
            session={session}
            onClose={() => setSection('messages')}
            onSessionLost={clearSession}
            onSessionUpdated={setSession}
          />
        ) : section === 'recovery' && recoveryEnabled ? (
          <RecoveryWorkspace
            key={identity}
            session={session}
            onClose={() => setSection('messages')}
            onSessionLost={clearSession}
            onSessionUpdated={setSession}
          />
        ) : section === 'knowledge' && knowledgeEnabled ? (
          <KnowledgeWorkspace
            key={identity}
            session={session}
            onLogout={() => {
              void logout();
            }}
            onSessionLost={clearSession}
            onSessionUpdated={setSession}
            onOpenTask={(id) => {
              navigate({ section: 'tasks', tenantId: session.tenant_id, taskId: id });
            }}
          />
        ) : section === 'resources' && resourcesEnabled ? (
          <ResourceWorkspace
            key={identity}
            session={session}
            onLogout={() => {
              void logout();
            }}
            onSessionLost={clearSession}
            onSessionUpdated={setSession}
            {...(location.shareId ? { initialShareId: location.shareId } : {})}
          />
        ) : section === 'execution' && executionEnabled ? (
          <ExecutionWorkspace
            key={identity}
            session={session}
            onLogout={() => {
              void logout();
            }}
            onSessionLost={clearSession}
            onSessionUpdated={setSession}
            onOpenTask={(taskId) => {
              navigate({ section: 'tasks', tenantId: session.tenant_id, taskId });
            }}
            {...(location.runId ? { initialRunId: location.runId } : {})}
            {...(location.actionId ? { initialActionId: location.actionId } : {})}
            {...(location.grantId ? { initialGrantId: location.grantId } : {})}
            onSelection={(kind, id) =>
              navigate({
                section: 'execution',
                tenantId: session.tenant_id,
                ...(id
                  ? kind === 'runs'
                    ? { runId: id }
                    : kind === 'actions'
                      ? { actionId: id }
                      : { grantId: id }
                  : {}),
              })
            }
          />
        ) : section === 'tasks' && tasksEnabled ? (
          <TaskWorkspace
            key={identity}
            session={session}
            onLogout={() => {
              void logout();
            }}
            onSessionLost={clearSession}
            onSessionUpdated={setSession}
            {...(location.taskId ? { initialTaskId: location.taskId } : {})}
            {...(location.requestId ? { initialRequestId: location.requestId } : {})}
            onSelection={(kind, id) =>
              navigate({
                section: 'tasks',
                tenantId: session.tenant_id,
                ...(id ? (kind === 'task' ? { taskId: id } : { requestId: id }) : {}),
              })
            }
            onOpenRun={(id) => {
              navigate({ section: 'execution', tenantId: session.tenant_id, runId: id });
            }}
          />
        ) : (
          <ChatWorkspace
            key={identity}
            session={session}
            onLogout={() => {
              void logout();
            }}
            onSessionLost={clearSession}
            onSessionUpdated={setSession}
            {...(location.conversationId ? { initialConversationId: location.conversationId } : {})}
            {...(location.messageId ? { initialMessageId: location.messageId } : {})}
            onSelectConversation={(id) =>
              navigate({
                section: 'messages',
                tenantId: session.tenant_id,
                ...(id ? { conversationId: id } : {}),
              })
            }
          />
        )}
      </div>
    </div>
  );
}

function LoginScreen({
  tenantId,
  checking,
  notice,
  onLogin,
}: {
  readonly tenantId: string;
  readonly checking: boolean;
  readonly notice: string | null;
  readonly onLogin: (tenant: string, principalId?: string) => Promise<void>;
}) {
  const [tenant, setTenant] = useState(tenantId);
  return (
    <main className="login-page">
      <section className="login-story">
        <Brand />
        <div className="login-copy">
          <span className="eyebrow">A SPACE TO THINK TOGETHER</span>
          <h1>
            好想法，
            <br />
            从好对话开始<span>。</span>
          </h1>
          <p>
            让人和 AI Agent 在同一个空间相遇。
            <br />
            交流、分享，开始一起做点什么。
          </p>
        </div>
        <div className="login-illustration" aria-hidden="true">
          <div className="floating-note first">
            让沟通回到事情本身。<span>一个共同的开始</span>
          </div>
          <div className="floating-note second">
            <span className="note-star">✧</span>每一种声音，都有自己的位置。
          </div>
          <div className="illustration-orbit" />
        </div>
        <span className="login-footnote">IMBOX · 人与 Agent 的共同沟通空间</span>
      </section>
      <section className="login-panel" aria-label="登录 Imbox">
        <div className="login-card">
          <span className="eyebrow">WELCOME TO IMBOX</span>
          <h2>回到你的交流空间</h2>
          <p className="muted">使用组织身份登录，继续未完的对话。</p>
          <label className="field-label" htmlFor="tenant">
            组织标识
          </label>
          <input
            id="tenant"
            className="text-input mono-input"
            value={tenant}
            onChange={(event) => setTenant(event.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          <a
            className={`button primary full-width ${checking ? 'disabled-link' : ''}`}
            href="/v1/auth/login"
            onClick={() => rememberTenant(tenant.trim())}
          >
            使用组织账号登录
            <Icon name="arrow" size={18} />
          </a>
          <button
            className="button subtle full-width"
            disabled={checking || tenant.trim() === ''}
            onClick={() => {
              void onLogin(tenant);
            }}
          >
            确认现有登录状态
          </button>
          {checking && <Spinner label="正在确认登录状态…" />}
          {notice !== null && <ErrorNotice>{notice}</ErrorNotice>}
          {DEV_LOGIN && (
            <section className="dev-login">
              <span className="dev-label">仅本地开发环境</span>
              <p>选择已配置的测试成员。此入口不会出现在生产构建中。</p>
              <div className="dev-people">
                {DEV_PEOPLE.map((person) => (
                  <button
                    key={person.id}
                    disabled={checking || tenant.trim() === ''}
                    onClick={() => {
                      void onLogin(tenant, person.id);
                    }}
                  >
                    <Avatar name={person.name} size="small" />
                    {person.name}
                  </button>
                ))}
              </div>
            </section>
          )}
          <p className="login-privacy">
            登录凭证保存在受保护的会话 Cookie 中。
            <br />
            当前版本不在设备上保存消息正文。
          </p>
        </div>
      </section>
    </main>
  );
}

function ChatWorkspace({
  session,
  onLogout,
  onSessionLost,
  onSessionUpdated,
  initialConversationId,
  initialMessageId,
  onSelectConversation,
}: {
  readonly session: Session;
  readonly onLogout: () => void;
  readonly onSessionLost: (message: string | null) => void;
  readonly onSessionUpdated: (session: Session) => void;
  readonly initialConversationId?: string;
  readonly initialMessageId?: string;
  readonly onSelectConversation: (id: string | null) => void;
}) {
  const client = useMemo(
    () => new ApiClient(session.tenant_id, session.csrf_token),
    [session.tenant_id, session.csrf_token],
  );
  const [conversations, setConversations] = useState<readonly Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialConversationId ?? null);
  useEffect(() => {
    setSelectedId(initialConversationId ?? null);
  }, [initialConversationId]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [connected, setConnected] = useState(navigator.onLine);
  const selected = conversations.find((conversation) => conversation.id === selectedId) ?? null;

  useEffect(() => {
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
        const items: Conversation[] = [];
        let cursor: string | undefined;
        const visited = new Set<string>();
        do {
          const page = await client.conversations(controller.signal, cursor);
          items.push(...page.items);
          cursor = page.next_cursor;
          if (cursor !== undefined) {
            if (visited.has(cursor)) throw new Error('Invalid pagination response');
            visited.add(cursor);
          }
        } while (cursor !== undefined && !controller.signal.aborted);
        if (controller.signal.aborted) return;
        setConversations(items);
        setSelectedId((current) =>
          current !== null && items.some((item) => item.id === current) ? current : null,
        );
        setConnected(true);
        setError(null);
      } catch (failure: unknown) {
        if (controller.signal.aborted) return;
        if (isAccessLoss(failure)) {
          onSessionLost(describeError(failure));
          return;
        }
        setConnected(false);
        setError(describeError(failure));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          timer = setTimeout(() => {
            void poll();
          }, 2_000);
        }
      }
    };
    void poll();
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [
    client,
    session.principal.id,
    session.tenant_id,
    session.authz_revision,
    onSessionLost,
    onSessionUpdated,
    refresh,
  ]);

  const workspaceName = session.workspaces[0]?.name ?? '我的工作空间';
  const visible = conversations.filter((conversation) =>
    conversation.title.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
  );
  return (
    <main className={`workspace ${selected === null ? '' : 'has-selection'}`}>
      <aside className="sidebar" aria-label="会话导航">
        <header className="sidebar-header">
          <Brand />
          <button
            className="icon-button create-button"
            onClick={() => setCreating(true)}
            aria-label="新建会话"
          >
            <Icon name="plus" />
          </button>
        </header>
        <div className="workspace-heading">
          <span className="workspace-symbol" aria-hidden="true">
            ◈
          </span>
          <div>
            <strong>{workspaceName}</strong>
            <span>沟通，从这里开始</span>
          </div>
        </div>
        <div className="search-field">
          <Icon name="search" size={17} />
          <input
            aria-label="筛选当前会话"
            placeholder="搜索会话"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
        <div className="section-heading">
          <span>全部会话</span>
          <span className="count-label">{conversations.length}</span>
        </div>
        <nav className="conversation-list" aria-label="会话列表">
          {loading ? (
            <Spinner />
          ) : visible.length === 0 ? (
            <div className="sidebar-empty">
              <Icon name="chat" size={28} />
              <p>{filter ? '没有匹配的会话' : '还没有会话'}</p>
              {!filter && (
                <button className="text-button" onClick={() => setCreating(true)}>
                  发起第一段对话
                </button>
              )}
            </div>
          ) : (
            visible.map((conversation) => (
              <button
                key={conversation.id}
                className={`conversation-item ${conversation.id === selectedId ? 'selected' : ''}`}
                onClick={() => {
                  setSelectedId(conversation.id);
                  onSelectConversation(conversation.id);
                }}
                aria-current={conversation.id === selectedId ? 'page' : undefined}
              >
                <Avatar name={conversation.title || '会话'} />
                <span className="conversation-copy">
                  <span className="conversation-name">
                    {conversation.title || (conversation.kind === 'direct' ? '私聊' : '群组会话')}
                  </span>
                  <span className="conversation-preview">
                    {conversation.kind === 'direct' ? '一对一交流' : '群组交流'}
                  </span>
                </span>
                <span className="conversation-date">{relativeTime(conversation.created_at)}</span>
              </button>
            ))
          )}
        </nav>
        {error !== null && (
          <div className="sidebar-warning">
            <Icon name="alert" size={15} />
            <span>连接中断，正在重试</span>
            <button
              className="icon-button"
              onClick={() => setRefresh((value) => value + 1)}
              aria-label="重新连接"
            >
              <Icon name="refresh" size={15} />
            </button>
          </div>
        )}
        <div className="sidebar-footer">
          <Avatar name={session.principal.display_name} size="small" />
          <div className="profile-copy">
            <strong>{session.principal.display_name}</strong>
            <IdentityTag principal={session.principal} />
          </div>
          <button className="icon-button" onClick={onLogout} aria-label="退出登录" title="退出登录">
            <Icon name="logout" size={18} />
          </button>
        </div>
      </aside>
      {selected === null ? (
        <section className="welcome-panel">
          <div className="welcome-art" aria-hidden="true">
            <span className="welcome-orbit" />
            <span className="welcome-bubble">
              <Icon name="chat" size={46} />
            </span>
            <span className="welcome-star">✧</span>
          </div>
          <span className="eyebrow">GOOD CONVERSATIONS START HERE</span>
          <h1>给想法一个相遇的地方</h1>
          <p>选择一段对话，或邀请伙伴开启新的交流。</p>
          <button className="button primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={18} />
            新建会话
          </button>
          <span className="welcome-footnote">人类与 AI Agent，身份清晰，共同交流。</span>
        </section>
      ) : (
        <ConversationPane
          key={`${selected.id}:${selected.authz_generation}`}
          client={client}
          session={session}
          conversation={selected}
          online={connected}
          {...(initialMessageId ? { anchorMessageId: initialMessageId } : {})}
          onBack={() => {
            setSelectedId(null);
            onSelectConversation(null);
          }}
          onAccessLost={(failure) => {
            if (failure instanceof ApiError && failure.status === 401)
              onSessionLost(describeError(failure));
            else {
              setSelectedId(null);
              onSelectConversation(null);
              setConversations((items) => items.filter((item) => item.id !== selected.id));
              setError(describeError(failure));
            }
          }}
        />
      )}
      {creating && (
        <CreateConversationModal
          client={client}
          session={session}
          onClose={() => setCreating(false)}
          onCreated={(conversation) => {
            setConversations((items) => [
              conversation,
              ...items.filter((item) => item.id !== conversation.id),
            ]);
            setSelectedId(conversation.id);
            onSelectConversation(conversation.id);
            setCreating(false);
            setRefresh((value) => value + 1);
          }}
        />
      )}
    </main>
  );
}

function CreateConversationModal({
  client,
  session,
  onClose,
  onCreated,
}: {
  readonly anchorMessageId?: string;
  readonly client: ApiClient;
  readonly session: Session;
  readonly onClose: () => void;
  readonly onCreated: (conversation: Conversation) => void;
}) {
  const [workspaceId, setWorkspaceId] = useState(session.workspaces[0]?.id ?? '');
  const [kind, setKind] = useState<'group' | 'direct'>('group');
  const [title, setTitle] = useState('');
  const [members, setMembers] = useState<readonly Member[]>([]);
  const [selectedMembers, setSelectedMembers] = useState<readonly string[]>([]);
  const [history, setHistory] = useState<'all' | 'since_join'>('all');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const command = useRef<{ body: string; key: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setMembers([]);
    setSelectedMembers([]);
    setLoading(true);
    setError(null);
    if (workspaceId === '') {
      setLoading(false);
      return () => controller.abort();
    }
    void client
      .workspaceMembers(workspaceId, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted)
          setMembers(
            page.items.filter(
              (member) =>
                member.principal.id !== session.principal.id &&
                member.principal.status === 'active',
            ),
          );
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(describeError(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [client, workspaceId, session.principal.id]);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const firstMember = selectedMembers[0];
    if (busy || firstMember === undefined) return;
    setBusy(true);
    setError(null);
    const name =
      title.trim() ||
      members
        .filter((member) => selectedMembers.includes(member.principal.id))
        .map((member) => member.principal.display_name)
        .join('、');
    const input: CreateConversationInput = {
      workspace_id: workspaceId,
      kind,
      title: name,
      member_ids: [firstMember, ...selectedMembers.slice(1)],
      history_policy: history,
    };
    const body = JSON.stringify(input);
    if (command.current?.body !== body) command.current = { body, key: crypto.randomUUID() };
    try {
      onCreated(await client.createConversation(input, command.current.key));
    } catch (failure: unknown) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="开启新的对话"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <p className="dialog-intro">让合适的人加入，给想法一个共同的空间。</p>
        <label className="field-label" htmlFor="create-workspace">
          工作空间
        </label>
        <select
          id="create-workspace"
          className="text-input"
          value={workspaceId}
          onChange={(event) => setWorkspaceId(event.target.value)}
          disabled={busy}
        >
          {session.workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
            </option>
          ))}
        </select>
        <div className="segmented-control" aria-label="会话类型">
          <button
            type="button"
            className={kind === 'group' ? 'active' : ''}
            aria-pressed={kind === 'group'}
            onClick={() => {
              setKind('group');
              setSelectedMembers([]);
            }}
            disabled={busy}
          >
            群组会话
          </button>
          <button
            type="button"
            className={kind === 'direct' ? 'active' : ''}
            aria-pressed={kind === 'direct'}
            onClick={() => {
              setKind('direct');
              setSelectedMembers([]);
            }}
            disabled={busy}
          >
            一对一私聊
          </button>
        </div>
        <label className="field-label" htmlFor="create-title">
          {kind === 'group' ? '会话名称' : '会话名称（可选）'}
        </label>
        <input
          id="create-title"
          className="text-input"
          placeholder="例如：产品讨论室"
          maxLength={200}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          disabled={busy}
        />
        <div className="field-label">
          邀请成员{' '}
          <span className="muted">
            {kind === 'direct' ? '选择一位伙伴' : `已选择 ${selectedMembers.length} 位`}
          </span>
        </div>
        <div className="member-picker">
          {loading ? (
            <Spinner />
          ) : members.length === 0 ? (
            <p className="muted">当前没有可邀请的成员。</p>
          ) : (
            members.map((member) => (
              <label key={member.principal.id} className="member-option">
                <input
                  type={kind === 'direct' ? 'radio' : 'checkbox'}
                  name="members"
                  checked={selectedMembers.includes(member.principal.id)}
                  disabled={
                    busy ||
                    (selectedMembers.length >= 99 && !selectedMembers.includes(member.principal.id))
                  }
                  onChange={() =>
                    setSelectedMembers((current) =>
                      kind === 'direct'
                        ? [member.principal.id]
                        : current.includes(member.principal.id)
                          ? current.filter((id) => id !== member.principal.id)
                          : [...current, member.principal.id],
                    )
                  }
                />
                <Avatar
                  name={member.principal.display_name}
                  agent={member.principal.kind === 'agent'}
                  size="small"
                />
                <span>{member.principal.display_name}</span>
                <IdentityTag principal={member.principal} />
              </label>
            ))
          )}
        </div>
        <label className="field-label" htmlFor="history-policy">
          新成员可以查看
        </label>
        <select
          id="history-policy"
          className="text-input"
          value={history}
          onChange={(event) => setHistory(event.target.value === 'all' ? 'all' : 'since_join')}
          disabled={busy}
        >
          <option value="all">会话的全部历史消息</option>
          <option value="since_join">加入后的消息</option>
        </select>
        {error !== null && <ErrorNotice>{error}</ErrorNotice>}
        <div className="dialog-actions">
          <button type="button" className="button subtle" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            className="button primary"
            disabled={busy || loading || selectedMembers.length === 0 || workspaceId === ''}
          >
            {busy ? '正在创建…' : '创建会话'}
            <Icon name="arrow" size={17} />
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ConversationPane({
  anchorMessageId,
  client,
  session,
  conversation,
  online,
  onBack,
  onAccessLost,
}: {
  readonly anchorMessageId?: string;
  readonly client: ApiClient;
  readonly session: Session;
  readonly conversation: Conversation;
  readonly online: boolean;
  readonly onBack: () => void;
  readonly onAccessLost: (error: unknown) => void;
}) {
  const [snapshot, setSnapshot] = useState<MessageSnapshot | null>(null);
  const snapshotRef = useRef<MessageSnapshot | null>(null);
  const { queueAllowed, historySaved } = useConversationDevice(
    session,
    conversation,
    snapshot?.messages,
  );
  const [pending, setPending] = useState<readonly PendingMessage[]>([]);
  const { draft, editDraft, resetDraft, draftNotice } = useDeviceDraft(
    session,
    conversation,
    queueAllowed && snapshot !== null,
  );
  const resourceApi = useMemo(
    () => new ResourceApi(session.tenant_id, session.csrf_token),
    [session.tenant_id, session.csrf_token],
  );
  const [draftAttachments, setDraftAttachments] = useState<StoredResource[]>([]);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [reactionId, setReactionId] = useState<string | null>(null);
  const attachmentsEnabled = session.capabilities.includes('resources.message_attachments');
  const syncAvailable = session.capabilities.includes('sync.snapshot');
  const [members, setMembers] = useState<readonly Member[]>([]);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('loading');
  const [pageCount, setPageCount] = useState(1);
  const [truncatedHistory, setTruncatedHistory] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historicalWindow, setHistoricalWindow] = useState(false);
  const historicalWindowRef = useRef(false);
  const historyCursor = useRef<string | undefined>(undefined);
  const historyEpoch = useRef(0);
  const [membersRefresh, setMembersRefresh] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [browserOnline, setBrowserOnline] = useState(navigator.onLine);
  const [atBottom, setAtBottom] = useState(true);
  const [editing, setEditing] = useState<{
    message: ChatMessage;
    body: string;
    key: string;
  } | null>(null);
  const [deleting, setDeleting] = useState<ChatMessage | null>(null);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [confirmedDeletes, setConfirmedDeletes] = useState<ReadonlySet<string>>(new Set());
  const scroll = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const composition = useRef(false);
  const nearBottom = useRef(true);
  const historyAnchor = useRef<{ height: number; top: number } | null>(null);
  const mounted = useRef(true);
  const commands = useRef(new Set<AbortController>());
  const accessLoss = useRef(onAccessLost);
  const [syncClientId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    accessLoss.current = (failure) => {
      if (!(failure instanceof ApiError && failure.status === 401))
        void deviceStore()
          .invalidateScope(conversationScope(session, conversation), 'ACCESS_REVOKED')
          .catch(() => {});
      onAccessLost(failure);
    };
  }, [onAccessLost, session, conversation]);

  useEffect(() => {
    mounted.current = true;
    const update = (): void => setBrowserOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      mounted.current = false;
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
      for (const controller of commands.current) controller.abort();
      commands.current.clear();
    };
  }, []);

  useEffect(() => {
    const clearView = (): void => {
      for (const request of commands.current) request.abort();
      commands.current.clear();
      snapshotRef.current = null;
      setSnapshot(null);
      setPending([]);
      resetDraft();
      setDraftAttachments([]);
      setUploadingAttachment(false);
      setReplyTo(null);
      setThreadId(null);
      setReactionId(null);
      setMembers([]);
      setEditing(null);
      setDeleting(null);
      setMutationBusy(false);
      setConfirmedDeletes(new Set());
      setPageCount(1);
      setHistoricalWindow(false);
      historicalWindowRef.current = false;
      setTruncatedHistory(false);
      historyCursor.current = undefined;
      historyEpoch.current += 1;
      setHistoryBusy(false);
      setLoading(true);
      setMembersRefresh((value) => value + 1);
    };
    if (!syncAvailable) {
      clearView();
      setLoading(false);
      return;
    }
    return startConversationSync({
      api: client,
      view: {
        tenantId: session.tenant_id,
        principalId: session.principal.id,
        scopeId: conversation.view_scope,
        authzGeneration: conversation.authz_generation,
      },
      clientId: syncClientId,
      openSocket: () => new BrowserSyncSocket(session.tenant_id),
      callbacks: {
        reset: clearView,
        replace: (view, messages, truncated) => {
          const previous = snapshotRef.current;
          if (previous !== null && viewKey(previous.view) !== viewKey(view)) clearView();
          historicalWindowRef.current = false;
          setHistoricalWindow(false);
          historyEpoch.current += 1;
          historyCursor.current = undefined;
          historyAnchor.current = null;
          setHistoryBusy(false);
          setPageCount(1);
          const next = { view, messages };
          snapshotRef.current = next;
          setSnapshot(next);
          setPending((items) => remainingPending(items, messages));
          setTruncatedHistory(truncated);
          setLoading(false);
        },
        apply: (message) => {
          const current = snapshotRef.current;
          if (current === null) throw new Error('INCONSISTENT_VIEW');
          if (
            historicalWindowRef.current &&
            !current.messages.some((item) => item.id === message.id)
          )
            return;
          const updated = applyMessageMutation(current, message);
          if (updated.messages.length > 1_000) setTruncatedHistory(true);
          const next = { ...updated, messages: updated.messages.slice(-1_000) };
          snapshotRef.current = next;
          setSnapshot(next);
          setPending((items) => remainingPending(items, next.messages));
        },
        status: setSyncStatus,
        accessLost: (failure) => accessLoss.current(failure),
      },
    });
  }, [
    client,
    conversation.id,
    conversation.authz_generation,
    conversation.view_scope,
    session.tenant_id,
    session.principal.id,
    syncClientId,
    refresh,
    syncAvailable,
  ]);

  useEffect(() => {
    const controller = new AbortController();
    void client
      .conversationMembers(conversation.id, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted) {
          setMembers(page.items);
          setMembersError(null);
        }
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        setMembers([]);
        if (isAccessLoss(failure)) accessLoss.current(failure);
        else setMembersError('暂时无法读取成员列表');
      });
    return () => controller.abort();
  }, [
    client,
    conversation.id,
    conversation.version,
    conversation.authz_generation,
    refresh,
    membersRefresh,
  ]);

  useLayoutEffect(() => {
    const element = scroll.current;
    if (element === null) return;
    if (historyAnchor.current !== null) {
      element.scrollTop =
        historyAnchor.current.top + element.scrollHeight - historyAnchor.current.height;
      historyAnchor.current = null;
    } else if (nearBottom.current) element.scrollTop = element.scrollHeight;
  }, [snapshot, pending, pageCount]);

  const applySaved = (message: ChatMessage): void => {
    const current = snapshotRef.current;
    if (current === null) return;
    const updated = applyMessageMutation(current, message);
    if (updated.messages.length > 1_000) setTruncatedHistory(true);
    const next = { ...updated, messages: updated.messages.slice(-1_000) };
    snapshotRef.current = next;
    setSnapshot(next);
    setPending((items) => remainingPending(items, next.messages));
  };

  const postPending = async (message: PendingMessage): Promise<void> => {
    const current = snapshotRef.current;
    if (current === null || !browserOnline) return;
    const boundary = viewKey(current.view);
    const controller = new AbortController();
    commands.current.add(controller);
    setPending((items) =>
      items.map((item) =>
        item.clientMessageId === message.clientMessageId
          ? { ...item, state: 'sending', error: null }
          : item,
      ),
    );
    try {
      const saved = await client.sendMessage(
        conversation.id,
        message.clientMessageId,
        message.body,
        message.idempotencyKey,
        controller.signal,
        message.attachmentIds,
        message.reply,
      );
      if (
        !mounted.current ||
        controller.signal.aborted ||
        snapshotRef.current === null ||
        viewKey(snapshotRef.current.view) !== boundary
      )
        return;
      applySaved(saved);
    } catch (failure: unknown) {
      if (
        !mounted.current ||
        controller.signal.aborted ||
        snapshotRef.current === null ||
        viewKey(snapshotRef.current.view) !== boundary
      )
        return;
      if (isAccessLoss(failure)) {
        setPending([]);
        resetDraft();
        setDraftAttachments([]);
        setUploadingAttachment(false);
        setReplyTo(null);
        setThreadId(null);
        setReactionId(null);
        setSnapshot(null);
        snapshotRef.current = null;
        accessLoss.current(failure);
        return;
      }
      setPending((items) => failPending(items, message.clientMessageId, describeError(failure)));
    } finally {
      commands.current.delete(controller);
    }
  };

  const send = (): void => {
    const body = draft.trim();
    if (
      !body ||
      historicalWindowRef.current ||
      composition.current ||
      snapshotRef.current === null ||
      (!queueAllowed && (!browserOnline || !online || !polling))
    )
      return;
    const id = crypto.randomUUID();
    const message: PendingMessage = {
      clientMessageId: id,
      idempotencyKey: id,
      body,
      attachmentIds: draftAttachments.map((resource) => resource.id),
      ...(replyTo ? { reply: { id: replyTo.id, version: replyTo.version } } : {}),
      createdAt: new Date().toISOString(),
      state: 'sending',
      error: null,
    };
    nearBottom.current = true;
    setPending((items) => [...items, message]);
    editDraft('');
    setDraftAttachments([]);
    setReplyTo(null);
    if (queueAllowed) {
      void deviceStore()
        .enqueue(conversationScope(session, conversation), session.authz_revision, {
          clientMessageId: message.clientMessageId,
          idempotencyKey: message.idempotencyKey,
          body: message.body,
          attachmentIds: message.attachmentIds ?? [],
          ...(message.reply ? { reply: message.reply } : {}),
          createdAt: Date.parse(message.createdAt),
        })
        .then(() => deviceChanged())
        .catch(() => {
          if (mounted.current)
            setPending((items) =>
              failPending(items, message.clientMessageId, '本机保存失败，消息尚未进入待发队列。'),
            );
        });
    } else void postPending(message);
    composer.current?.focus();
  };

  useEffect(() => {
    const saved = (event: Event) => {
      const message = (event as CustomEvent<ChatMessage>).detail,
        current = snapshotRef.current;
      if (
        !current ||
        message.conversation_id !== conversation.id ||
        message.authz_generation !== current.view.authzGeneration
      )
        return;
      const next = applyMessageMutation(current, message);
      snapshotRef.current = next;
      setSnapshot(next);
      setPending((items) => remainingPending(items, [message]));
    };
    const rejected = (event: Event) => {
      const id = (event as CustomEvent<{ id: string }>).detail.id;
      setPending((items) => items.filter((item) => item.clientMessageId !== id));
    };
    window.addEventListener('imbox:offline-saved', saved);
    window.addEventListener('imbox:offline-rejected', rejected);
    return () => {
      window.removeEventListener('imbox:offline-saved', saved);
      window.removeEventListener('imbox:offline-rejected', rejected);
    };
  }, [conversation.id]);

  const saveEdit = async (): Promise<void> => {
    if (editing === null || mutationBusy || !editing.body.trim()) return;
    const controller = new AbortController();
    commands.current.add(controller);
    const boundary = snapshotRef.current === null ? null : viewKey(snapshotRef.current.view);
    setMutationBusy(true);
    setMutationError(null);
    try {
      const saved = await client.editMessage(
        editing.message,
        editing.body.trim(),
        editing.key,
        controller.signal,
      );
      if (
        !mounted.current ||
        controller.signal.aborted ||
        snapshotRef.current === null ||
        boundary !== viewKey(snapshotRef.current.view)
      )
        return;
      applySaved(saved);
      setEditing(null);
    } catch (failure: unknown) {
      if (!mounted.current || controller.signal.aborted) return;
      if (isAccessLoss(failure)) {
        setEditing(null);
        accessLoss.current(failure);
      } else {
        setMutationError(describeError(failure));
        setRefresh((value) => value + 1);
      }
    } finally {
      commands.current.delete(controller);
      if (mounted.current) setMutationBusy(false);
    }
  };

  const deleteKey = useRef<string | null>(null);
  const confirmDelete = async (): Promise<void> => {
    if (deleting === null || mutationBusy) return;
    const target = deleting;
    const controller = new AbortController();
    commands.current.add(controller);
    const boundary = snapshotRef.current === null ? null : viewKey(snapshotRef.current.view);
    setMutationBusy(true);
    setMutationError(null);
    deleteKey.current ??= crypto.randomUUID();
    try {
      await client.deleteMessage(target, deleteKey.current, controller.signal);
      if (
        !mounted.current ||
        controller.signal.aborted ||
        snapshotRef.current === null ||
        boundary !== viewKey(snapshotRef.current.view)
      )
        return;
      setConfirmedDeletes((ids) => new Set([...ids, target.id]));
      setDeleting(null);
      deleteKey.current = null;
      setRefresh((value) => value + 1);
    } catch (failure: unknown) {
      if (!mounted.current || controller.signal.aborted) return;
      if (isAccessLoss(failure)) {
        setDeleting(null);
        accessLoss.current(failure);
      } else {
        setMutationError(describeError(failure));
        setRefresh((value) => value + 1);
      }
    } finally {
      commands.current.delete(controller);
      if (mounted.current) setMutationBusy(false);
    }
  };

  const loadOlder = async () => {
    if (historyBusy || snapshotRef.current === null) return;
    if (scroll.current !== null)
      historyAnchor.current = {
        height: scroll.current.scrollHeight,
        top: scroll.current.scrollTop,
      };
    const advanceWindow = pageCount >= 20;
    const oldest = snapshotRef.current.messages[0];
    const desired = Math.min(1_000, (pageCount + 1) * 50);
    if (!advanceWindow && (snapshotRef.current.messages.length >= desired || !truncatedHistory)) {
      setPageCount((value) => value + 1);
      return;
    }
    const controller = new AbortController(),
      epoch = historyEpoch.current;
    const boundary = viewKey(snapshotRef.current.view);
    commands.current.add(controller);
    setHistoryBusy(true);
    try {
      // First page overlaps the recent snapshot. Follow opaque cursors, never raw sequence IDs.
      // Bound work per click when many new messages arrive during history navigation.
      for (let page = 0; page < 10; page += 1) {
        const result = await client.messages(
          conversation.id,
          controller.signal,
          historyCursor.current,
        );
        const current: MessageSnapshot | null = snapshotRef.current;
        if (
          !mounted.current ||
          controller.signal.aborted ||
          epoch !== historyEpoch.current ||
          !current ||
          viewKey(current.view) !== boundary
        )
          return;
        if (advanceWindow && oldest) {
          const earlier = result.items.filter((item) => BigInt(item.seq) < BigInt(oldest.seq));
          historyCursor.current = result.next_cursor;
          setTruncatedHistory(result.next_cursor !== undefined);
          if (earlier.length) {
            let next: MessageSnapshot = { view: current.view, messages: [] };
            for (const item of earlier) next = applyMessageMutation(next, item);
            historicalWindowRef.current = true;
            setHistoricalWindow(true);
            historyAnchor.current = null;
            nearBottom.current = false;
            snapshotRef.current = next;
            setSnapshot(next);
            setPageCount(1);
            scroll.current?.scrollTo({ top: 0 });
            return;
          }
          if (!result.next_cursor) break;
          continue;
        }
        let next: MessageSnapshot = current;
        for (const item of result.items) next = applyMessageMutation(next, item);
        snapshotRef.current = next;
        setSnapshot(next);
        historyCursor.current = result.next_cursor;
        setTruncatedHistory(result.next_cursor !== undefined);
        if (!result.next_cursor || next.messages.length >= desired) break;
      }
      if (mounted.current && !controller.signal.aborted && epoch === historyEpoch.current)
        setPageCount((value) => Math.min(20, value + 1));
    } catch (failure: unknown) {
      if (mounted.current && !controller.signal.aborted && epoch === historyEpoch.current) {
        if (isAccessLoss(failure)) accessLoss.current(failure);
        else setMutationError(describeError(failure));
      }
    } finally {
      commands.current.delete(controller);
      if (mounted.current && epoch === historyEpoch.current) setHistoryBusy(false);
    }
  };
  const messages = snapshot?.messages.slice(-pageCount * 50) ?? [];
  const hasOlder = truncatedHistory || (snapshot?.messages.length ?? 0) > pageCount * 50;
  const polling = syncStatus === 'live' || syncStatus === 'fallback';
  const canSend = browserOnline && online && polling && snapshot !== null;
  const canCompose = !historicalWindow && (canSend || (queueAllowed && snapshot !== null));
  useReadCursor({
    api: client,
    scopeId: conversation.id,
    viewKey: snapshot === null ? null : viewKey(snapshot.view),
    container: scroll,
    enabled:
      canSend &&
      editing === null &&
      deleting === null &&
      !detailsOpen &&
      threadId === null &&
      reactionId === null,
    contentRevision: snapshot,
    windowSize: pageCount,
    accessLost: (failure) => accessLoss.current(failure),
  });
  const newestEditing =
    editing === null ? undefined : messages.find((message) => message.id === editing.message.id);
  return (
    <>
      <section className="chat-panel" aria-label={conversation.title || '会话'}>
        <header className="chat-header">
          <button className="icon-button mobile-back" onClick={onBack} aria-label="返回会话列表">
            <Icon name="back" />
          </button>
          <Avatar name={conversation.title || '会话'} />
          <div className="chat-heading">
            <h1>{conversation.title || '会话'}</h1>
            <span>
              {conversation.kind === 'direct' ? '一对一交流' : '群组交流'}
              {members.length > 0 ? ` · ${members.length} 位成员` : ''}
            </span>
          </div>
          <span className={`connection-label ${canSend ? '' : 'disconnected'}`} role="status">
            <span />
            {canSend
              ? syncStatus === 'live'
                ? '实时同步'
                : '同步中 · 正在重连'
              : browserOnline
                ? '连接恢复中'
                : '网络已断开'}
          </span>
          <button
            className="icon-button details-toggle"
            onClick={() => setDetailsOpen((value) => !value)}
            aria-label="查看会话详情"
            aria-expanded={detailsOpen}
          >
            <Icon name="info" />
          </button>
        </header>
        {anchorMessageId && (
          <LinkedMessage
            key={`${anchorMessageId}:${conversation.authz_generation}`}
            client={client}
            id={anchorMessageId}
            conversationId={conversation.id}
            generation={conversation.authz_generation}
            sessionLost={onAccessLost}
          />
        )}
        {historySaved && (
          <p className="connection-banner" role="status">
            本机副本已更新
          </p>
        )}
        {!canSend && !loading && (
          <div className="connection-banner">
            <Icon name="alert" size={16} />
            <span>
              {syncAvailable
                ? queueAllowed
                  ? '消息将在本机排队；联网重新核对身份和权限后发送。'
                  : '暂时无法同步，恢复连接后才能发送。当前内容仅保存在页面内存中。'
                : '当前服务未启用消息同步，暂时无法打开消息或发送内容。请管理员启用同步服务。'}
            </span>
            <button className="text-button" onClick={() => setRefresh((value) => value + 1)}>
              重试
            </button>
          </div>
        )}
        <div
          ref={scroll}
          className="message-scroll"
          onScroll={() => {
            const element = scroll.current;
            if (element !== null) {
              nearBottom.current =
                element.scrollHeight - element.scrollTop - element.clientHeight < 100;
              setAtBottom(nearBottom.current);
            }
          }}
          tabIndex={0}
          aria-label="消息记录"
        >
          {hasOlder && (
            <div className="history-button">
              <button
                className="text-button"
                disabled={historyBusy}
                onClick={() => {
                  void loadOlder();
                }}
              >
                {pageCount >= 20 ? '查看更早的历史窗口' : '加载更早的消息'}
              </button>
            </div>
          )}
          {historicalWindow && (
            <p className="history-limit">正在查看较早历史。返回最新消息后可继续发送。</p>
          )}
          {loading ? (
            <Spinner label="正在载入对话…" />
          ) : messages.length === 0 && pending.length === 0 ? (
            <div className="conversation-empty">
              <span className="empty-chat-mark">
                <Icon name="chat" size={30} />
              </span>
              <h2>新的对话，新的可能</h2>
              <p>打个招呼，让交流从这里开始。</p>
            </div>
          ) : (
            <div className="timeline">
              {
                <VirtualMessages
                  messages={messages}
                  scroll={scroll}
                  followBottom={nearBottom}
                  render={(message, index) => {
                    const previous = messages[index - 1];
                    const showDay =
                      previous === undefined ||
                      new Date(previous.created_at).toDateString() !==
                        new Date(message.created_at).toDateString();
                    const own = message.actor.id === session.principal.id;
                    const deleted = message.deleted || confirmedDeletes.has(message.id);
                    return (
                      <div key={message.id}>
                        {showDay && (
                          <div className="day-divider">
                            <span>
                              {new Intl.DateTimeFormat('zh-CN', {
                                month: 'long',
                                day: 'numeric',
                                weekday: 'short',
                              }).format(new Date(message.created_at))}
                            </span>
                          </div>
                        )}
                        <article
                          className={`message-row ${own ? 'own' : ''}`}
                          aria-label={`${message.actor.display_name}的消息`}
                        >
                          {!own && (
                            <Avatar
                              name={message.actor.display_name}
                              agent={message.actor.kind === 'agent'}
                              size="small"
                            />
                          )}
                          <div className="message-content">
                            <div className="message-byline">
                              <strong>{own ? '你' : message.actor.display_name}</strong>
                              <IdentityTag principal={message.actor} />
                              <time
                                dateTime={message.created_at}
                                title={fullTime(message.created_at)}
                              >
                                {relativeTime(message.created_at)}
                              </time>
                            </div>
                            {!deleted && message.quote && <Quote quote={message.quote} />}
                            <div
                              className={`message-bubble ${deleted ? 'deleted-message' : ''}`}
                              data-message-seq={message.seq}
                            >
                              {deleted ? '这条消息已被删除' : message.body}
                            </div>
                            {!deleted && message.attachment_ids.length > 0 && (
                              <AttachmentLinks api={resourceApi} ids={message.attachment_ids} />
                            )}
                            {!deleted && (
                              <MessageActions
                                message={message}
                                session={session}
                                onReply={() => {
                                  setReplyTo(message);
                                  composer.current?.focus();
                                }}
                                onThread={() => setThreadId(message.thread_root_id ?? message.id)}
                                onReactions={() => setReactionId(message.id)}
                              />
                            )}
                            <div className="message-meta">
                              {message.edited_at !== undefined && !deleted && <span>已编辑</span>}
                              {own && (
                                <span className="saved-label">
                                  <Icon name="check" size={12} />
                                  已保存
                                </span>
                              )}
                              {own && !deleted && (
                                <div className="message-tools">
                                  <button
                                    aria-label="编辑消息"
                                    title="编辑消息"
                                    onClick={() => {
                                      setMutationError(null);
                                      setEditing({
                                        message,
                                        body: message.body,
                                        key: crypto.randomUUID(),
                                      });
                                    }}
                                  >
                                    <Icon name="edit" size={14} />
                                  </button>
                                  <button
                                    aria-label="删除消息"
                                    title="删除消息"
                                    onClick={() => {
                                      setMutationError(null);
                                      deleteKey.current = null;
                                      setDeleting(message);
                                    }}
                                  >
                                    <Icon name="trash" size={14} />
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        </article>
                      </div>
                    );
                  }}
                />
              }
              {pending.map((message) => (
                <article
                  key={message.clientMessageId}
                  className="message-row own pending-message"
                  aria-label="正在发送的消息"
                >
                  <div className="message-content">
                    <div className="message-byline">
                      <strong>你</strong>
                      <time dateTime={message.createdAt}>{relativeTime(message.createdAt)}</time>
                    </div>
                    <div className="message-bubble">{message.body}</div>
                    <div
                      className={`message-meta ${message.state === 'failed' ? 'send-failed' : ''}`}
                    >
                      {message.state === 'sending' ? (
                        '发送中…'
                      ) : (
                        <>
                          <span>发送未确认</span>
                          <button
                            className="text-button"
                            disabled={!canSend}
                            onClick={() => {
                              void postPending(message);
                            }}
                          >
                            按原请求重试
                          </button>
                        </>
                      )}
                    </div>
                    {message.error !== null && <p className="pending-error">{message.error}</p>}
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
        {(!atBottom || historicalWindow) && (
          <button
            className="jump-to-latest"
            onClick={() => {
              nearBottom.current = true;
              if (historicalWindow) {
                historyEpoch.current += 1;
                historyCursor.current = undefined;
                historyAnchor.current = null;
                historicalWindowRef.current = false;
                setHistoricalWindow(false);
                setPageCount(1);
                setHistoryBusy(false);
                setLoading(true);
                snapshotRef.current = null;
                setSnapshot(null);
                setRefresh((value) => value + 1);
              }
              scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'auto' });
            }}
          >
            回到最新消息 ↓
          </button>
        )}
        <footer className="composer-area">
          {draftNotice && <p role="status">{draftNotice}</p>}
          <form
            className={`composer ${canSend ? '' : 'composer-unavailable'}`}
            onSubmit={(event) => {
              event.preventDefault();
              send();
            }}
          >
            {replyTo && (
              <div className="composer-quote">
                <button type="button" aria-label="取消引用回复" onClick={() => setReplyTo(null)}>
                  ×
                </button>
                <strong>
                  引用 {replyTo.actor.display_name} · 固定版本 {replyTo.version}
                </strong>
                <p>{replyTo.body}</p>
              </div>
            )}
            <textarea
              ref={composer}
              aria-label="消息内容"
              placeholder={canCompose ? '写下你的想法…' : '暂时无法发送，你可以先写下草稿…'}
              value={draft}
              maxLength={16_384}
              rows={3}
              onChange={(event) => editDraft(event.target.value)}
              onCompositionStart={() => {
                composition.current = true;
              }}
              onCompositionEnd={() => {
                composition.current = false;
              }}
              onKeyDown={(event) => {
                if (
                  shouldSendOnEnter({
                    key: event.key,
                    shiftKey: event.shiftKey,
                    isComposing: event.nativeEvent.isComposing,
                    keyCode: event.keyCode,
                    compositionActive: composition.current,
                  })
                ) {
                  event.preventDefault();
                  send();
                }
              }}
            />
            <div className="composer-bottom">
              <span>Enter 发送 · Shift + Enter 换行</span>
              {attachmentsEnabled && (
                <button
                  className="text-button"
                  type="button"
                  disabled={!canSend || draftAttachments.length >= 10}
                  onClick={() => setUploadingAttachment(true)}
                >
                  添加附件
                </button>
              )}
              <button
                className="send-button"
                disabled={!canCompose || !draft.trim()}
                aria-label="发送消息"
              >
                <span>发送</span>
                <Icon name="send" size={17} />
              </button>
            </div>
            {draftAttachments.length > 0 && (
              <div className="composer-attachments">
                {draftAttachments.map((resource) => (
                  <span key={resource.id}>
                    {resource.filename}
                    <button
                      type="button"
                      aria-label={`移除附件 ${resource.filename}`}
                      onClick={() =>
                        setDraftAttachments((items) =>
                          items.filter((item) => item.id !== resource.id),
                        )
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
                <small>请写一段消息说明后发送。</small>
              </div>
            )}
          </form>
          <p className="composer-note">
            {queueAllowed
              ? '已启用本机文字草稿与离线排队；联网后重新核对权限再发送。'
              : '尚未启用本机文字草稿与离线排队；刷新或切换会话会清除未发送文字。可在“数据与隐私”中设置。'}
          </p>
        </footer>
        {uploadingAttachment && (
          <UploadForm
            api={resourceApi}
            scope={{ type: 'conversation', id: conversation.id }}
            title="上传消息附件"
            onClose={() => setUploadingAttachment(false)}
            onUploaded={(resource) => {
              setDraftAttachments((items) => [...items, resource].slice(0, 10));
              setUploadingAttachment(false);
            }}
            accessLost={onAccessLost}
          />
        )}
        {threadId && (
          <ThreadDialog
            client={client}
            resources={resourceApi}
            rootId={threadId}
            session={session}
            onChanged={applySaved}
            onClose={() => setThreadId(null)}
            accessLost={onAccessLost}
          />
        )}
        {reactionId &&
          messages.some((message) => message.id === reactionId && !message.deleted) && (
            <ReactionsDialog
              client={client}
              message={messages.find((message) => message.id === reactionId)!}
              principalId={session.principal.id}
              members={members}
              onChanged={applySaved}
              onClose={() => setReactionId(null)}
              accessLost={onAccessLost}
            />
          )}
      </section>
      <aside className={`details-panel ${detailsOpen ? 'details-open' : ''}`} aria-label="会话详情">
        <header>
          <span>会话详情</span>
          <button
            className="icon-button details-close"
            onClick={() => setDetailsOpen(false)}
            aria-label="关闭会话详情"
          >
            <Icon name="close" />
          </button>
        </header>
        <div className="details-identity">
          <Avatar name={conversation.title || '会话'} size="large" />
          <h2>{conversation.title || '会话'}</h2>
          <span className="conversation-kind">
            {conversation.kind === 'group' ? '群组会话' : '私聊'}
          </span>
        </div>
        <div className="details-section">
          <div className="details-title">
            <Icon name="users" size={17} />
            <h3>会话成员</h3>
            <span>{members.length || ''}</span>
          </div>
          {membersError !== null ? (
            <p className="muted small">{membersError}</p>
          ) : members.length === 0 ? (
            <p className="muted small">正在读取成员…</p>
          ) : (
            <ul className="member-list">
              {members.map((member) => (
                <li key={member.principal.id}>
                  <Avatar
                    name={member.principal.display_name}
                    agent={member.principal.kind === 'agent'}
                    size="small"
                  />
                  <span className="member-name">
                    {member.principal.display_name}
                    {member.principal.id === session.principal.id && <small>你</small>}
                    <IdentityTag principal={member.principal} />
                  </span>
                  {(member.role === 'owner' || member.role === 'admin') && (
                    <span className="role-label">
                      {member.role === 'owner' ? '创建者' : '管理员'}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="details-section">
          <h3>关于这段对话</h3>
          <dl className="conversation-facts">
            <div>
              <dt>历史可见范围</dt>
              <dd>{conversation.history_policy === 'all' ? '全部会话历史' : '加入后的消息'}</dd>
            </div>
            <div>
              <dt>创建于</dt>
              <dd>{fullTime(conversation.created_at)}</dd>
            </div>
            <div>
              <dt>当前已加载</dt>
              <dd>{messages.length} 条消息</dd>
            </div>
          </dl>
        </div>
        <div className="details-note">
          <span>✧</span>
          <p>
            每位参与者都有明确的身份。
            <br />
            消息已保存，不代表对方已读或接单。
          </p>
        </div>
      </aside>
      {editing !== null && (
        <Modal
          title="编辑消息"
          onClose={() => {
            if (!mutationBusy) setEditing(null);
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void saveEdit();
            }}
          >
            <label className="field-label" htmlFor="edit-message">
              消息内容
            </label>
            <textarea
              id="edit-message"
              className="text-input edit-textarea"
              rows={6}
              maxLength={16_384}
              value={editing.body}
              onChange={(event) =>
                setEditing({ ...editing, body: event.target.value, key: crypto.randomUUID() })
              }
              disabled={mutationBusy}
            />
            {mutationError !== null && <ErrorNotice>{mutationError}</ErrorNotice>}
            {newestEditing !== undefined && newestEditing.version !== editing.message.version && (
              <div className="edit-conflict">
                <p>最新内容：{newestEditing.deleted ? '消息已删除' : newestEditing.body}</p>
                {!newestEditing.deleted && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      setEditing({ ...editing, message: newestEditing, key: crypto.randomUUID() });
                      setMutationError(null);
                    }}
                  >
                    已核对，以最新版本继续编辑
                  </button>
                )}
              </div>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="button subtle"
                onClick={() => setEditing(null)}
                disabled={mutationBusy}
              >
                取消
              </button>
              <button
                className="button primary"
                disabled={mutationBusy || !editing.body.trim() || newestEditing?.deleted === true}
              >
                {mutationBusy ? '正在保存…' : '保存修改'}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {deleting !== null && (
        <Modal
          title="删除这条消息？"
          onClose={() => {
            if (!mutationBusy) setDeleting(null);
          }}
        >
          <p className="dialog-intro">删除后，会话中会显示删除标记。</p>
          <blockquote className="delete-preview">{deleting.body.slice(0, 240)}</blockquote>
          {mutationError !== null && <ErrorNotice>{mutationError}</ErrorNotice>}
          <div className="dialog-actions">
            <button
              className="button subtle"
              onClick={() => setDeleting(null)}
              disabled={mutationBusy}
            >
              保留消息
            </button>
            <button
              className="button danger"
              onClick={() => {
                void confirmDelete();
              }}
              disabled={mutationBusy}
            >
              {mutationBusy ? '正在删除…' : '确认删除'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
