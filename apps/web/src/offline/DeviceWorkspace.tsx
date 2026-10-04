import { useEffect, useState } from 'react';
import { ErrorNotice } from '../components.js';
import { describeError } from '../api.js';
import { clearDeviceData, deviceChanged, deviceStore } from './device-store.js';
import type { OfflineHistory, OfflineProfile, QueuedMessage } from './offline-store.js';
/** Deliberately a local viewer, never a substitute for an authenticated session. */
export function DeviceWorkspace({ onClose }: { onClose(): void }) {
  const [queuePermissions, setQueuePermissions] = useState<ReadonlySet<string>>(new Set());
  const [profiles, setProfiles] = useState<OfflineProfile[]>([]),
    [profileKey, setProfileKey] = useState(''),
    [history, setHistory] = useState<OfflineHistory[]>([]),
    [queue, setQueue] = useState<QueuedMessage[]>([]),
    [selected, setSelected] = useState(''),
    [draft, setDraft] = useState(''),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    let active = true,
      loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const db = deviceStore();
        await db.expire();
        const [p, h, q, preferences] = await Promise.all([
          db.profiles.toArray(),
          db.history.toArray(),
          db.outbox.toArray(),
          db.preferences.toArray(),
        ]);
        if (active) {
          setQueuePermissions(
            new Set(
              preferences
                .filter((item) => item.queue && item.policy.offline_queue_allowed)
                .map((item) => item.key),
            ),
          );
          setProfiles(p);
          setHistory(h);
          setQueue(q);
          setProfileKey((old) => (p.some((item) => item.key === old) ? old : (p[0]?.key ?? '')));
        }
      } catch (failure) {
        if (active) setError(describeError(failure));
      } finally {
        loading = false;
      }
    };
    const wake = () => {
      void refresh();
    };
    wake();
    const timer = setInterval(wake, 2000);
    window.addEventListener('imbox:device-data', wake);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('imbox:device-data', wake);
    };
  }, []);
  const profile = profiles.find((item) => item.key === profileKey),
    records = history.filter((item) => item.namespace === profileKey);
  const record = records.find((item) => item.key === selected);
  return (
    <main className="workspace-panel" aria-label="本机离线数据">
      <header>
        <h1>本机离线数据</h1>
        <button onClick={onClose}>返回登录或在线消息</button>
      </header>
      <p>
        这里展示用户明确允许保留的本机副本，不代表当前服务器授权。联网并重新登录后才会核对权限、发送待发消息；任务、交接和审批不能在这里执行。
      </p>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {notice && <p role="status">{notice}</p>}
      {profiles.length === 0 ? (
        <p>没有已启用的本机离线资料。请联网后在“数据与隐私”中设置。</p>
      ) : (
        <>
          <label>
            本机资料所属身份
            <select
              value={profileKey}
              onChange={(event) => {
                setProfileKey(event.target.value);
                setSelected('');
                setDraft('');
              }}
            >
              {profiles.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.principal.display_name} · {item.tenantId}
                </option>
              ))}
            </select>
          </label>
          <p>最后核对身份：{profile ? new Date(profile.checkedAt).toLocaleString() : ''}</p>
          <h2>缓存会话</h2>
          {records.length === 0 && <p>没有允许保留的消息历史。</p>}
          {records.map((item) => (
            <button
              key={item.key}
              onClick={() => {
                setSelected(item.key);
                setDraft('');
              }}
            >
              {item.conversation.title || '会话'} · 缓存于 {new Date(item.savedAt).toLocaleString()}
            </button>
          ))}
          {record && (
            <section aria-label="缓存消息记录">
              <h3>{record.conversation.title}</h3>
              <p>副本可能已经过时；断网时无法获知远程编辑、删除或撤权。到期自动清除。</p>
              {record.messages.map((message) => (
                <article key={message.id}>
                  <strong>{message.actor.display_name}</strong>
                  <p>{message.deleted ? '消息已撤回' : message.body}</p>
                </article>
              ))}
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (busy || !profile || !draft.trim()) return;
                  setBusy(true);
                  setError(null);
                  const id = crypto.randomUUID();
                  void deviceStore()
                    .enqueue(record.scope, profile.authzRevision, {
                      clientMessageId: id,
                      idempotencyKey: id,
                      body: draft.trim(),
                      createdAt: Date.now(),
                    })
                    .then(() => {
                      setDraft('');
                      setNotice('消息已保存在本机，等待联网和原身份登录。');
                      deviceChanged();
                    })
                    .catch((failure: unknown) => setError(describeError(failure)))
                    .finally(() => setBusy(false));
                }}
              >
                <label>
                  离线待发消息
                  <textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    maxLength={32000}
                  />
                </label>
                <button disabled={busy || !draft.trim() || !queuePermissions.has(profileKey)}>
                  保存到待发队列
                </button>
                {!queuePermissions.has(profileKey) && (
                  <p>本机未开启待发队列，请联网后在“数据与隐私”中设置。</p>
                )}
              </form>
            </section>
          )}
          <h2>本机待发记录</h2>
          {queue
            .filter((item) => item.namespace === profileKey)
            .map((item) => (
              <article key={item.id}>
                <p>
                  {item.status === 'queued'
                    ? '等待联网核对'
                    : item.status === 'sending'
                      ? '发送结果待确认'
                      : item.status === 'expired'
                        ? '已过期，正文已清除'
                        : item.status === 'rejected'
                          ? '授权或设置变化，正文已清除'
                          : '需要在线处理'}
                </p>
                {item.body && <p>{item.body}</p>}
              </article>
            ))}
        </>
      )}
      <button
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void clearDeviceData()
            .then(() => {
              setProfiles([]);
              setHistory([]);
              setQueue([]);
              setDraft('');
              setNotice('已清除本机数据。');
            })
            .catch((failure: unknown) => setError(describeError(failure)))
            .finally(() => setBusy(false));
        }}
      >
        清除本机数据
      </button>
    </main>
  );
}
