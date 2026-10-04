import { PushSettings } from './PushSettings.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  NotificationItem,
  NotificationLocation,
  NotificationPreferences,
  NotificationDevice,
  Conversation,
} from '@imbox/contracts';
import { ApiClient, ApiError, describeError, type Session } from '../api.js';
import { ErrorNotice } from '../components.js';
import { NotificationApi } from './notification-api.js';
interface Props {
  session: Session;
  onClose(): void;
  onSessionLost(message: string | null): void;
  onSessionUpdated(session: Session): void;
  onOpen(location: NotificationLocation): void;
}
const labels = {
  message: '消息',
  task: '任务',
  request: '协作请求',
  action: '行动',
  run: 'Agent 运行',
};
export function NotificationWorkspace({
  session,
  onClose,
  onSessionLost,
  onSessionUpdated,
  onOpen,
}: Props) {
  const api = useMemo(
    () => new NotificationApi(session.tenant_id, session.csrf_token),
    [session.tenant_id, session.csrf_token],
  );
  const [items, setItems] = useState<NotificationItem[]>([]),
    [cursor, setCursor] = useState<string>(),
    [unread, setUnread] = useState(0),
    [preferences, setPreferences] = useState<NotificationPreferences | null>(null),
    [devices, setDevices] = useState<NotificationDevice[]>([]),
    [conversations, setConversations] = useState<Conversation[]>([]),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    const abort = new AbortController();
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const base = new ApiClient(session.tenant_id, session.csrf_token),
          me = await base.me(abort.signal);
        if (abort.signal.aborted) return;
        if (
          me.principal.id !== session.principal.id ||
          me.authz_revision !== session.authz_revision
        ) {
          controller.current?.abort();
          setItems([]);
          setPreferences(null);
          setDevices([]);
          setConversations([]);
          onSessionUpdated(me);
          return;
        }
        const [page, count] = await Promise.all([api.list(abort.signal), api.unread(abort.signal)]);
        if (abort.signal.aborted) return;
        // Refresh the authoritative first page so revoked items are removed promptly.
        setItems(page.items);
        setCursor(page.next_cursor);
        setUnread(count.unread_count);
      } catch (failure) {
        if (!abort.signal.aborted) {
          setItems([]);
          setCursor(undefined);
          if (failure instanceof ApiError && failure.status === 401)
            onSessionLost('登录已失效，请重新登录。');
          setError(describeError(failure));
        }
      } finally {
        loading = false;
      }
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 5000);
    void Promise.all([
      api.preferences(abort.signal),
      api.devices(abort.signal),
      new ApiClient(session.tenant_id, session.csrf_token).conversations(abort.signal),
    ])
      .then(([p, d, c]) => {
        if (!abort.signal.aborted) {
          setPreferences(p);
          setDevices(d.items);
          setConversations(c.items);
        }
      })
      .catch((failure: unknown) => {
        if (!abort.signal.aborted) setError(describeError(failure));
      });
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [api, session, revision, onSessionLost, onSessionUpdated]);
  const run = async (operation: (signal: AbortSignal) => Promise<void>, refresh = true) => {
    if (busy) return;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError(null);
    try {
      await operation(abort.signal);
      if (!abort.signal.aborted && refresh) setRevision((v) => v + 1);
    } catch (failure) {
      if (!abort.signal.aborted) {
        if (failure instanceof ApiError && failure.status === 401)
          onSessionLost('登录已失效，请重新登录。');
        setError(describeError(failure));
      }
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  };
  return (
    <section className="workspace-panel" aria-label="通知中心">
      <header>
        <h1>通知中心</h1>
        <button onClick={onClose}>返回消息</button>
      </header>
      <p aria-live="polite">未读 {unread} 项。已读表示已查看，任务和审批仍需单独处理。</p>
      <PushSettings api={api} changed={() => setRevision((n) => n + 1)} />
      {error && <ErrorNotice>{error}</ErrorNotice>}
      <button disabled={busy} onClick={() => setRevision((v) => v + 1)}>
        刷新通知
      </button>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <span>
              {labels[item.category]} · {item.unread ? '未读' : '已读'}
              {item.silent ? ' · 静音' : ''} · {new Date(item.updated_at).toLocaleString()}
            </span>
            <p>{item.hint}</p>
            <button
              disabled={busy}
              onClick={() =>
                void run(async (signal) => {
                  const location = await api.open(item.id, signal);
                  await api.read(item.id, location.version, signal);
                  if (!signal.aborted) onOpen(location);
                })
              }
            >
              查看事项
            </button>
            {item.unread && (
              <button
                disabled={busy}
                onClick={() =>
                  void run(async (signal) => {
                    await api.read(item.id, item.version, signal);
                  })
                }
              >
                标为已读
              </button>
            )}
          </li>
        ))}
      </ul>
      {cursor && (
        <button
          disabled={busy}
          onClick={() =>
            void run(async (signal) => {
              const page = await api.list(signal, cursor);
              if (!signal.aborted) {
                setItems((old) => [
                  ...old.filter((item) => !page.items.some((next) => next.id === item.id)),
                  ...page.items,
                ]);
                setCursor(page.next_cursor);
              }
            }, false)
          }
        >
          加载更多通知
        </button>
      )}
      {preferences && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(async (signal) => {
              const { version, ...body } = preferences;
              const saved = await api.savePreferences(body, version, signal);
              if (!signal.aborted) setPreferences(saved);
            });
          }}
        >
          <h2>系统提醒偏好</h2>
          <p>这些设置控制系统推送；通知中心保留当前有权查看的事项。</p>
          {(Object.keys(labels) as Array<keyof typeof labels>).map((category) => (
            <label key={category}>
              <input
                type="checkbox"
                checked={preferences.categories[category]}
                onChange={(event) =>
                  setPreferences({
                    ...preferences,
                    categories: { ...preferences.categories, [category]: event.target.checked },
                  })
                }
              />
              {labels[category]}
            </label>
          ))}
          <label>
            <input
              type="checkbox"
              checked={preferences.dnd.enabled}
              onChange={(event) =>
                setPreferences({
                  ...preferences,
                  dnd: { ...preferences.dnd, enabled: event.target.checked },
                })
              }
            />
            开启免打扰时段
          </label>
          <label>
            时区
            <input
              required
              value={preferences.dnd.time_zone}
              onChange={(event) =>
                setPreferences({
                  ...preferences,
                  dnd: { ...preferences.dnd, time_zone: event.target.value },
                })
              }
            />
          </label>
          <label>
            开始
            <input
              required
              type="time"
              value={preferences.dnd.start}
              onChange={(event) =>
                setPreferences({
                  ...preferences,
                  dnd: { ...preferences.dnd, start: event.target.value },
                })
              }
            />
          </label>
          <label>
            结束
            <input
              required
              type="time"
              value={preferences.dnd.end}
              onChange={(event) =>
                setPreferences({
                  ...preferences,
                  dnd: { ...preferences.dnd, end: event.target.value },
                })
              }
            />
          </label>
          <button disabled={busy} type="submit">
            保存提醒偏好
          </button>
        </form>
      )}
      <h2>会话静音</h2>
      <p>静音保留收件箱通知，同时停止该会话的系统提醒。</p>
      {conversations.map((conversation) => (
        <div key={conversation.id}>
          <span>{conversation.title}</span>
          <button
            disabled={busy}
            onClick={() =>
              void run(async (signal) => {
                await api.mute(conversation.id, true, signal);
              })
            }
          >
            静音
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void run(async (signal) => {
                await api.mute(conversation.id, false, signal);
              })
            }
          >
            取消静音
          </button>
        </div>
      ))}
      <h2>已登记设备</h2>
      {devices.map((device) => (
        <div key={device.id}>
          <span>
            {device.id} · {device.enabled ? '已启用' : '已停用'}
          </span>
          <button
            disabled={busy || !device.enabled}
            onClick={() =>
              void run(async (signal) => {
                await api.disableDevice(device.id, signal);
              })
            }
          >
            停用设备提醒
          </button>
        </div>
      ))}
    </section>
  );
}
