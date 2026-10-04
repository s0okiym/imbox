import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type {
  ArtifactComment,
  ArtifactCommentAnchor,
  ArtifactShare,
  ArtifactShareSummary,
  Conversation,
  StoredArtifact,
  StoredResource,
  Task,
} from '@imbox/contracts';
import { ApiError, isAccessLoss, type Session } from '../api.js';
import { ErrorNotice, Modal, fullTime } from '../components.js';
import { SubmitActions, useExecutionCommand } from '../execution/execution-common.js';
import { ResourceApi, resourceError } from './resource-api.js';
import {
  ArtifactCollaborationApi,
  selectedAnchor,
  shareLink,
} from './artifact-collaboration-api.js';
interface Props {
  session: Session;
  artifact: StoredArtifact;
  versionId: string;
  resource: StoredResource;
  conversations: Conversation[];
  tasks: Task[];
  accessLost: (failure: unknown) => void;
}
export function ArtifactCollaborationPanel(props: Props) {
  return <Panel key={props.versionId + ':' + props.resource.version} {...props} />;
}
function Panel({
  session,
  artifact,
  versionId,
  resource,
  conversations,
  tasks,
  accessLost,
}: Props) {
  const selectionField = useRef<HTMLTextAreaElement | null>(null);
  const api = useMemo(
    () => new ArtifactCollaborationApi(session.tenant_id, session.csrf_token),
    [session.tenant_id, session.csrf_token],
  );
  const [comments, setComments] = useState<ArtifactComment[]>([]),
    [shares, setShares] = useState<ArtifactShareSummary[]>([]),
    [error, setError] = useState<string | null>(null),
    [tick, setTick] = useState(0),
    [body, setBody] = useState(''),
    [preview, setPreview] = useState<string | null>(null),
    [anchor, setAnchor] = useState<ArtifactCommentAnchor>({ type: 'whole' }),
    [editing, setEditing] = useState<string | null>(null),
    [target, setTarget] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [expires, setExpires] = useState(() => new Date(Date.now() + 3600000).toISOString()),
    [created, setCreated] = useState<ArtifactShare | null>(null);
  const [commentCursor, setCommentCursor] = useState<string | undefined>(),
    [shareCursor, setShareCursor] = useState<string | undefined>();
  const refresh = useCallback(() => setTick((v) => v + 1), []),
    life = useRef<AbortController | null>(null);
  const failed = useCallback(
    (failure: unknown) => {
      if (isAccessLoss(failure)) {
        setComments([]);
        setShares([]);
        setPreview(null);
        setBody('');
        setEditing(null);
        setCreated(null);
        accessLost(failure);
      } else setError(resourceError(failure));
    },
    [accessLost],
  );
  const command = useExecutionCommand(versionId, refresh, failed);
  useEffect(() => {
    const controller = new AbortController();
    life.current = controller;
    const poll = async () => {
      try {
        const [c, s] = await Promise.all([
          api.comments(artifact.id, versionId, controller.signal),
          api.shares(artifact.id, controller.signal),
        ]);
        if (controller.signal.aborted) return;
        setComments(c.items);
        setShares(s.items);
        setCommentCursor(c.next_cursor);
        setShareCursor(s.next_cursor);
      } catch (failure) {
        if (!controller.signal.aborted) failed(failure);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [api, artifact.id, versionId, tick, failed]);
  const post = async (event: FormEvent) => {
    event.preventDefault();
    const input = { version_id: versionId, sha256: resource.sha256, body, anchor };
    if (
      await command.run(input, async (key, signal) => {
        await api.createComment(artifact.id, input, key, signal);
      })
    ) {
      setBody('');
      setAnchor({ type: 'whole' });
      refresh();
    }
  };
  const share = async (event: FormEvent) => {
    event.preventDefault();
    if (!confirmed || !target) return;
    const [kind, id] = target.split(':');
    const input = {
      version_id: versionId,
      sha256: resource.sha256,
      expires_at: expires,
      ...(kind === 'task' ? { task_id: id! } : { conversation_id: id! }),
    };
    if (
      await command.run(input, async (key, signal) => {
        const result = await api.createShare(artifact.id, input, key, signal);
        if (!signal.aborted) setCreated(result);
      })
    ) {
      setConfirmed(false);
      refresh();
    }
  };
  const loadPreview = async () => {
    try {
      const signal = life.current!.signal;
      const blob = await new ResourceApi(session.tenant_id, session.csrf_token).download(
        resource,
        signal,
      );
      const text = await blob.text();
      if (!signal.aborted) setPreview(text);
    } catch (failure) {
      if (!life.current?.signal.aborted) failed(failure);
    }
  };
  const more = async (kind: 'comments' | 'shares') => {
    try {
      const signal = life.current!.signal;
      if (kind === 'comments') {
        const page = await api.comments(artifact.id, versionId, signal, commentCursor);
        if (!signal.aborted) {
          setComments((items) => [
            ...items,
            ...page.items.filter((item) => !items.some((old) => old.id === item.id)),
          ]);
          setCommentCursor(page.next_cursor);
        }
      } else {
        const page = await api.shares(artifact.id, signal, shareCursor);
        if (!signal.aborted) {
          setShares((items) => [
            ...items,
            ...page.items.filter((item) => !items.some((old) => old.id === item.id)),
          ]);
          setShareCursor(page.next_cursor);
        }
      }
    } catch (failure) {
      failed(failure);
    }
  };
  return (
    <section className="task-section" aria-label="版本评论与分享">
      <h2>此固定版本的评论</h2>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      <button onClick={() => void loadPreview()}>预览并选择评论片段</button>
      {preview !== null && (
        <label>
          版本正文
          <textarea
            ref={selectionField}
            aria-label="版本正文"
            readOnly
            value={preview}
            rows={8}
            onSelect={(event) => {
              const field = event.currentTarget;
              if (field.selectionEnd > field.selectionStart)
                try {
                  setAnchor(selectedAnchor(preview, field.selectionStart, field.selectionEnd));
                } catch (failure) {
                  failed(failure);
                }
            }}
          />
        </label>
      )}
      {preview !== null && (
        <button
          onClick={() => {
            const field = selectionField.current;
            if (field)
              try {
                setAnchor(selectedAnchor(preview, field.selectionStart, field.selectionEnd));
              } catch (failure) {
                failed(failure);
              }
          }}
        >
          对选中文字评论
        </button>
      )}
      <form onSubmit={(event) => void post(event)}>
        <label>
          评论
          <textarea
            required
            maxLength={4000}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
        </label>
        <p>
          {anchor.type === 'whole'
            ? '评论整个固定版本'
            : `评论已选文字（${anchor.start + 1}–${anchor.end} 字符）`}
        </p>
        {anchor.type !== 'whole' && (
          <button type="button" onClick={() => setAnchor({ type: 'whole' })}>
            改为整个版本
          </button>
        )}
        <button disabled={command.busy || !body.trim()}>发表评论</button>
      </form>
      {comments.map((comment) => (
        <article key={comment.id}>
          <p>{comment.deleted ? '评论已删除' : comment.body}</p>
          <small>
            {fullTime(comment.updated_at)} ·{' '}
            {comment.anchor.type === 'whole'
              ? '整个版本'
              : `字符 ${comment.anchor.start + 1}–${comment.anchor.end}`}
          </small>
          {!comment.deleted && comment.created_by === session.principal.id && (
            <div>
              <button disabled={command.busy} onClick={() => setEditing(comment.id)}>
                编辑评论
              </button>
              <button
                disabled={command.busy}
                onClick={() =>
                  void command.run(
                    { delete_comment: comment.id, version: comment.version },
                    async (key, signal) => {
                      await api.deleteComment(comment, key, signal);
                      refresh();
                    },
                  )
                }
              >
                删除我的评论
              </button>
            </div>
          )}
        </article>
      ))}
      {commentCursor && <button onClick={() => void more('comments')}>加载更多评论</button>}
      {editing && comments.find((c) => c.id === editing) && (
        <CommentEditor
          key={editing}
          comment={comments.find((c) => c.id === editing)!}
          api={api}
          refresh={refresh}
          accessLost={failed}
          onClose={() => setEditing(null)}
        />
      )}
      {artifact.created_by === session.principal.id &&
        resource.created_by === session.principal.id && (
          <>
            <h2>受控分享此版本</h2>
            <form onSubmit={(event) => void share(event)}>
              <label>
                接收范围
                <select
                  required
                  value={target}
                  onChange={(event) => {
                    setTarget(event.target.value);
                    setConfirmed(false);
                  }}
                >
                  <option value="">选择接收范围</option>
                  <optgroup label="会话">
                    {conversations.map((item) => (
                      <option key={item.id} value={'conversation:' + item.id}>
                        {item.title || '未命名会话'}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="任务">
                    {tasks.map((item) => (
                      <option key={item.id} value={'task:' + item.id}>
                        {item.title}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </label>
              <label>
                有效时间
                <select
                  defaultValue="1"
                  onChange={(event) => {
                    setExpires(
                      new Date(Date.now() + Number(event.target.value) * 3600000).toISOString(),
                    );
                    setConfirmed(false);
                  }}
                >
                  <option value="1">1 小时</option>
                  <option value="8">8 小时</option>
                  <option value="23">23 小时</option>
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                允许接收范围的当前成员在有效期内读取此固定版本。权限变化后可能需要重新分享。
              </label>
              <button disabled={command.busy || !confirmed || !target}>创建受控分享</button>
            </form>
          </>
        )}
      {created && (
        <p role="status">
          分享已创建。
          <label>
            分享链接
            <input
              readOnly
              value={shareLink(created.id)}
              onFocus={(event) => event.target.select()}
            />
          </label>
        </p>
      )}
      <h3>我创建的分享</h3>
      {shares.map((item) => (
        <article key={item.id}>
          <p>
            {item.status === 'revoked'
              ? '已撤回'
              : Date.parse(item.expires_at) <= Date.now()
                ? '已过期'
                : '已创建'}{' '}
            · {fullTime(item.expires_at)}
          </p>
          <label>
            分享链接
            <input readOnly value={shareLink(item.id)} onFocus={(event) => event.target.select()} />
          </label>
          {item.status === 'active' && (
            <button
              disabled={command.busy}
              onClick={() =>
                void command.run(
                  { revoke_share: item.id, version: item.version },
                  async (key, signal) => {
                    await api.revoke(item, key, signal);
                    setCreated(null);
                    refresh();
                  },
                )
              }
            >
              撤回分享
            </button>
          )}
        </article>
      ))}
      {shareCursor && <button onClick={() => void more('shares')}>加载更多分享</button>}
      {command.error && <ErrorNotice>{command.error}</ErrorNotice>}
    </section>
  );
}
function CommentEditor({
  comment,
  api,
  refresh,
  accessLost,
  onClose,
}: {
  comment: ArtifactComment;
  api: ArtifactCollaborationApi;
  refresh: () => void;
  accessLost: (failure: unknown) => void;
  onClose: () => void;
}) {
  const [body, setBody] = useState(comment.body),
    command = useExecutionCommand(comment.version, refresh, accessLost);
  return (
    <Modal title="编辑版本评论" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void command.run({ id: comment.id, body }, async (key, signal) => {
            await api.editComment(comment, body, key, signal);
            if (!signal.aborted) {
              refresh();
              onClose();
            }
          });
        }}
      >
        <label>
          修改评论
          <textarea
            required
            maxLength={4000}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
        </label>
        <SubmitActions
          command={command}
          label="保存评论"
          onClose={onClose}
          onAdopt={() => setBody(comment.body)}
        />
      </form>
    </Modal>
  );
}
export function ReceivedShare({
  session,
  initialId = '',
  onClose,
}: {
  session: Session;
  initialId?: string;
  onClose: () => void;
}) {
  const api = useMemo(
      () => new ArtifactCollaborationApi(session.tenant_id, session.csrf_token),
      [session.tenant_id, session.csrf_token],
    ),
    [id, setId] = useState(initialId),
    [opened, setOpened] = useState(initialId),
    [item, setItem] = useState<ArtifactShare | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    flight = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!opened) return;
    const controller = new AbortController();
    flight.current = controller;
    const poll = async () => {
      try {
        const next = await api.share(opened, controller.signal);
        if (!controller.signal.aborted) setItem(next);
      } catch (failure) {
        if (!controller.signal.aborted) {
          setItem(null);
          setError(resourceError(failure));
          if (failure instanceof ApiError && [401, 403, 404].includes(failure.status))
            controller.abort();
        }
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [api, opened]);
  const download = async () => {
    if (!item || busy) return;
    setBusy(true);
    try {
      const signal = flight.current!.signal,
        current = await api.share(item.id, signal),
        blob = await api.download(current, signal);
      if (signal.aborted) return;
      const url = URL.createObjectURL(blob),
        a = document.createElement('a');
      a.href = url;
      a.download = current.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) {
      setItem(null);
      setError(resourceError(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="打开受控分享" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          let handle = id.trim();
          try {
            const url = new URL(handle);
            if (url.origin !== location.origin) throw new Error('不支持外部分享地址');
            handle = url.searchParams.get('share') ?? '';
          } catch {
            if (handle.includes('://')) {
              setError('请使用当前 Imbox 的分享链接。');
              return;
            }
          }
          if (!/^[0-9a-f-]{36}$/i.test(handle)) {
            setError('请填写有效分享链接或标识。');
            return;
          }
          setItem(null);
          setError(null);
          setOpened(handle);
        }}
      >
        <label>
          分享链接或标识
          <input required value={id} onChange={(event) => setId(event.target.value)} />
        </label>
        <button>读取分享</button>
      </form>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {item && (
        <>
          <h2>{item.title}</h2>
          <p>
            {item.filename} · {fullTime(item.expires_at)} 前有效
          </p>
          <button disabled={busy} onClick={() => void download()}>
            {busy ? '正在核验…' : '下载分享版本'}
          </button>
        </>
      )}
    </Modal>
  );
}
