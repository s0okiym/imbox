import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Conversation, StoredArtifact, StoredResource, Task } from '@imbox/contracts';
import { ApiClient, ApiError, describeError, isAccessLoss } from '../api.js';
import type { Session } from '../api.js';
import { Avatar, Brand, ErrorNotice, Icon, IdentityTag, Spinner } from '../components.js';
import { TaskApi } from '../tasks/task-api.js';
import { ResourceApi, resourceError } from './resource-api.js';
import type { ResourceScope } from './resource-api.js';
import {
  ArtifactContent,
  CreateArtifactForm,
  DeleteResourceForm,
  ResourceContent,
  UploadForm,
} from './resource-components.js';
import '../execution/execution.css';
import { ReceivedShare } from './artifact-collaboration-panel.js';

async function pages<T>(
  read: (cursor?: string) => Promise<{ items: T[]; next_cursor?: string }>,
  signal: AbortSignal,
) {
  const items: T[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
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
export function ResourceWorkspace({
  session,
  onLogout,
  onSessionLost,
  onSessionUpdated,
  initialShareId,
}: {
  readonly session: Session;
  readonly initialShareId?: string;
  readonly onLogout: () => void;
  readonly onSessionLost: (message: string | null) => void;
  readonly onSessionUpdated: (session: Session) => void;
}) {
  const api = useMemo(
    () => new ResourceApi(session.tenant_id, session.csrf_token),
    [session.tenant_id, session.csrf_token],
  );
  const client = useMemo(
    () => new ApiClient(session.tenant_id, session.csrf_token),
    [session.tenant_id, session.csrf_token],
  );
  const tasksApi = useMemo(
    () => new TaskApi(session.tenant_id, session.csrf_token),
    [session.tenant_id, session.csrf_token],
  );
  const [tasks, setTasks] = useState<Task[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [scopeValue, setScopeValue] = useState('');
  const scope = useMemo<ResourceScope | null>(
    () =>
      scopeValue
        ? {
            type: scopeValue.startsWith('task:') ? 'task' : 'conversation',
            id: scopeValue.slice(scopeValue.indexOf(':') + 1),
          }
        : null,
    [scopeValue],
  );
  const [shareOpen, setShareOpen] = useState(!!initialShareId);
  const [mode, setMode] = useState<'files' | 'artifacts'>('files');
  const [resources, setResources] = useState<StoredResource[]>([]);
  const [artifacts, setArtifacts] = useState<StoredArtifact[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<'upload' | 'artifact' | 'delete' | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((value) => value + 1), []);
  const selection = useRef<AbortController | null>(null);
  useEffect(() => () => selection.current?.abort(), []);
  const accessLost = useCallback(
    (failure: unknown) => {
      selection.current?.abort();
      setOpening(false);
      setForm(null);
      setSelectedId(null);
      setResources([]);
      setArtifacts([]);
      setScopeValue('');
      setError(resourceError(failure));
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
        const [taskItems, conversationItems] = await Promise.all([
          session.capabilities.includes('tasks.collaboration')
            ? pages((cursor) => tasksApi.tasks(controller.signal, cursor), controller.signal)
            : Promise.resolve([]),
          session.capabilities.includes('messaging.text')
            ? pages((cursor) => client.conversations(controller.signal, cursor), controller.signal)
            : Promise.resolve([]),
        ]);
        const [files, objects] = scope
          ? await Promise.all([
              pages((cursor) => api.resources(scope, controller.signal, cursor), controller.signal),
              session.capabilities.includes('resources.artifact_versions')
                ? pages(
                    (cursor) => api.artifacts(scope, controller.signal, cursor),
                    controller.signal,
                  )
                : Promise.resolve([]),
            ])
          : [[], []];
        if (!controller.signal.aborted) {
          setTasks(taskItems);
          setConversations(conversationItems);
          setResources(files);
          setArtifacts(objects);
          setError(null);
        }
      } catch (failure: unknown) {
        if (!controller.signal.aborted) {
          if (isAccessLoss(failure)) accessLost(failure);
          else setError(resourceError(failure));
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
  }, [api, client, tasksApi, session, scope, tick, onSessionLost, onSessionUpdated, accessLost]);
  const changedResource = (resource: StoredResource) => {
    setResources((items) => [resource, ...items.filter((item) => item.id !== resource.id)]);
    setMode('files');
    setSelectedId(resource.id);
  };
  const changedArtifact = (artifact: StoredArtifact) => {
    setArtifacts((items) => [artifact, ...items.filter((item) => item.id !== artifact.id)]);
    setMode('artifacts');
    setSelectedId(artifact.id);
  };
  const open = async (id: string) => {
    selection.current?.abort();
    const controller = new AbortController();
    selection.current = controller;
    setSelectedId(null);
    setOpening(true);
    try {
      if (mode === 'files') {
        const resource = await api.resource(id, controller.signal);
        if (!controller.signal.aborted) changedResource(resource);
      } else {
        const artifact = await api.artifact(id, controller.signal);
        if (!controller.signal.aborted) changedArtifact(artifact);
      }
    } catch (failure: unknown) {
      if (!controller.signal.aborted) {
        if (isAccessLoss(failure)) accessLost(failure);
        else setError(resourceError(failure));
      }
    } finally {
      if (!controller.signal.aborted) setOpening(false);
    }
  };
  const selectedResource = resources.find((item) => item.id === selectedId);
  const selectedArtifact = artifacts.find((item) => item.id === selectedId);
  const selected = mode === 'files' ? selectedResource : selectedArtifact;
  return (
    <main className={`task-workspace execution-workspace ${selected ? 'has-selection' : ''}`}>
      <aside className="task-sidebar" aria-label="文件与制品导航">
        <header className="task-sidebar-header">
          <Brand />
          <button
            className="icon-button"
            disabled={!scope}
            aria-label="上传文件"
            onClick={() => setForm('upload')}
          >
            <Icon name="plus" />
          </button>
        </header>
        <div className="task-tabs" role="tablist" aria-label="文件与制品">
          <button
            role="tab"
            aria-selected={mode === 'files'}
            onClick={() => {
              setMode('files');
              setSelectedId(null);
              setFilter('');
            }}
          >
            文件
          </button>
          {session.capabilities.includes('resources.artifact_versions') && (
            <button
              role="tab"
              aria-selected={mode === 'artifacts'}
              onClick={() => {
                setMode('artifacts');
                setSelectedId(null);
                setFilter('');
              }}
            >
              制品版本
            </button>
          )}
        </div>
        <select
          className="text-input resource-scope"
          aria-label="文件访问范围"
          value={scopeValue}
          onChange={(event) => {
            selection.current?.abort();
            setOpening(false);
            setSelectedId(null);
            setResources([]);
            setArtifacts([]);
            setScopeValue(event.target.value);
          }}
        >
          <option value="">选择任务或会话</option>
          <optgroup label="任务">
            {tasks.map((task) => (
              <option key={task.id} value={`task:${task.id}`}>
                {task.title}
              </option>
            ))}
          </optgroup>
          <optgroup label="会话">
            {conversations.map((conversation) => (
              <option key={conversation.id} value={`conversation:${conversation.id}`}>
                {conversation.title}
              </option>
            ))}
          </optgroup>
        </select>
        {session.capabilities.includes('artifacts.shares') && (
          <button onClick={() => setShareOpen(true)}>打开分享</button>
        )}
        <div className="search-field">
          <Icon name="search" size={17} />
          <input
            aria-label="筛选文件或制品"
            placeholder="筛选名称"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
        <nav className="task-list" aria-label={mode === 'files' ? '文件列表' : '制品列表'}>
          {loading ? (
            <Spinner />
          ) : mode === 'files' ? (
            resources
              .filter((item) => item.filename.includes(filter))
              .map((resource) => (
                <button
                  className={`task-list-item ${resource.id === selectedId ? 'selected' : ''}`}
                  key={resource.id}
                  onClick={() => {
                    void open(resource.id);
                  }}
                >
                  <strong>{resource.filename}</strong>
                  <span className="task-status">已验证文本</span>
                  <p>
                    {resource.byte_size.toLocaleString()} 字节 · {resource.content_type}
                  </p>
                </button>
              ))
          ) : (
            artifacts
              .filter((item) => item.title.includes(filter))
              .map((artifact) => (
                <button
                  className={`task-list-item ${artifact.id === selectedId ? 'selected' : ''}`}
                  key={artifact.id}
                  onClick={() => {
                    void open(artifact.id);
                  }}
                >
                  <strong>{artifact.title}</strong>
                  <span className="task-status">当前版本 {artifact.head_version}</span>
                  <p>{artifact.resource.filename}</p>
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
      {shareOpen && (
        <ReceivedShare
          session={session}
          {...(initialShareId ? { initialId: initialShareId } : {})}
          onClose={() => setShareOpen(false)}
        />
      )}
      {opening ? (
        <section className="task-welcome">
          <Spinner />
        </section>
      ) : selected ? (
        <section className="task-detail" aria-label={mode === 'files' ? '文件详情' : '制品详情'}>
          <header className="task-detail-header">
            <button
              className="icon-button"
              aria-label="返回资源列表"
              onClick={() => setSelectedId(null)}
            >
              <Icon name="back" />
            </button>
            <div>
              <span className="eyebrow">SHARED CONTENT · FIXED VERSIONS</span>
              <h1>{mode === 'files' ? selectedResource?.filename : selectedArtifact?.title}</h1>
            </div>
            <button className="icon-button" aria-label="刷新资源" onClick={refresh}>
              <Icon name="refresh" />
            </button>
          </header>
          <div className="task-detail-scroll">
            {selectedResource && mode === 'files' ? (
              <>
                <ResourceContent
                  key={selectedResource.id}
                  api={api}
                  resource={selectedResource}
                  accessLost={accessLost}
                />
                <div className="task-action-row">
                  {session.capabilities.includes('resources.artifact_versions') && (
                    <button className="button subtle" onClick={() => setForm('artifact')}>
                      保存为版本化制品
                    </button>
                  )}
                  {selectedResource.created_by === session.principal.id && (
                    <button className="button subtle" onClick={() => setForm('delete')}>
                      删除文件
                    </button>
                  )}
                </div>
              </>
            ) : (
              selectedArtifact && (
                <ArtifactContent
                  key={selectedArtifact.id}
                  api={api}
                  artifact={selectedArtifact}
                  onChanged={changedArtifact}
                  accessLost={accessLost}
                  refresh={refresh}
                  editable={selectedArtifact.can_append_version ?? false}
                  {...(session.capabilities.includes('artifacts.comments')
                    ? { collaboration: { session, conversations, tasks } }
                    : {})}
                />
              )
            )}
          </div>
        </section>
      ) : (
        <section className="task-welcome">
          <span className="task-welcome-symbol" aria-hidden="true">
            ▧
          </span>
          <span className="eyebrow">FILES WITH CONTEXT</span>
          <h1>把成果留在明确的范围里</h1>
          <p>选择任务或会话，上传受限文本文件；将可复用成果保存为固定版本，再作为明确证据引用。</p>
          <button className="button primary" disabled={!scope} onClick={() => setForm('upload')}>
            上传文件
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
      {form === 'upload' && scope && (
        <UploadForm
          api={api}
          scope={scope}
          onClose={() => setForm(null)}
          onUploaded={(resource) => {
            changedResource(resource);
            setForm(null);
            refresh();
          }}
          accessLost={accessLost}
        />
      )}
      {form === 'artifact' && selectedResource && (
        <CreateArtifactForm
          api={api}
          resource={selectedResource}
          onClose={() => setForm(null)}
          onCreated={(artifact) => {
            changedArtifact(artifact);
            setForm(null);
            refresh();
          }}
          accessLost={accessLost}
          refresh={refresh}
        />
      )}
      {form === 'delete' && selectedResource && (
        <DeleteResourceForm
          api={api}
          resource={selectedResource}
          onClose={() => setForm(null)}
          onDeleted={() => {
            setResources((items) => items.filter((item) => item.id !== selectedResource.id));
            setSelectedId(null);
            setForm(null);
            refresh();
          }}
          accessLost={accessLost}
          refresh={refresh}
        />
      )}
    </main>
  );
}
