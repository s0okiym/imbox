import { useEffect, useState } from 'react';
import type { Session } from '../api.js';
import { describeError } from '../api.js';
import type { GovernancePolicy } from '@imbox/contracts';
import { ErrorNotice } from '../components.js';
import { namespaceKey } from './offline-store.js';
import {
  adoptDeviceSession,
  clearDeviceData,
  deviceChanged,
  deviceGeneration,
  deviceStore,
} from './device-store.js';
export function DeviceDataSettings({
  session,
  policy,
}: {
  session: Session;
  policy: GovernancePolicy;
}) {
  const [history, setHistory] = useState(false),
    [queue, setQueue] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void deviceStore()
      .preferences.get(
        namespaceKey({ tenantId: session.tenant_id, principalId: session.principal.id }),
      )
      .then((pref) => {
        if (active) {
          setHistory(!!pref?.history && policy.offline_message_cache_allowed);
          setQueue(!!pref?.queue && policy.offline_queue_allowed);
        }
      })
      .catch((failure: unknown) => {
        if (active) setError(describeError(failure));
      });
    return () => {
      active = false;
    };
  }, [
    session.tenant_id,
    session.principal.id,
    policy.offline_message_cache_allowed,
    policy.offline_queue_allowed,
  ]);
  return (
    <section aria-label="本机离线设置">
      <h2>本机离线数据</h2>
      <p>
        仅在你主动开启且部署允许时保存。历史最多保留 20 个会话各 200 条消息，最多 7 天；排队消息最多
        100 条。此设备上的离线副本无法在断网时获知远程撤权。
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError(null);
          setNotice(null);
          const epoch = deviceGeneration();
          void (async () => {
            await deviceStore().transaction('rw', deviceStore().tables, async () => {
              if (epoch !== deviceGeneration()) return;
              await deviceStore().setPreferences(
                { tenantId: session.tenant_id, principalId: session.principal.id },
                { history, queue },
                policy,
              );
            });
            if (epoch !== deviceGeneration()) return;
            await adoptDeviceSession(session, epoch);
            deviceChanged();
            setNotice('已保存本机设置。');
          })()
            .catch((failure: unknown) => setError(describeError(failure)))
            .finally(() => setBusy(false));
        }}
      >
        <label>
          <input
            type="checkbox"
            checked={history}
            disabled={!policy.offline_message_cache_allowed || busy}
            onChange={(event) => setHistory(event.target.checked)}
          />
          在本机保留最近消息
        </label>
        {!policy.offline_message_cache_allowed && <p>此部署不允许消息历史缓存。</p>}
        <label>
          <input
            type="checkbox"
            checked={queue}
            disabled={!policy.offline_queue_allowed || busy}
            onChange={(event) => setQueue(event.target.checked)}
          />
          允许消息在本机排队，联网重新核对权限后发送
        </label>
        <p>
          启用队列也会在本机保存文字草稿，最多保留 7
          天，不保存草稿附件和引用。任务接受、交接和审批始终需要在线明确操作。停用队列会清除草稿及待发正文。
        </p>
        <button type="submit" disabled={busy}>
          保存本机设置
        </button>
      </form>
      <button
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          void clearDeviceData()
            .then(() => {
              setHistory(false);
              setQueue(false);
              setNotice('已清除本机缓存、草稿及待发消息。');
            })
            .catch((failure: unknown) => setError(describeError(failure)))
            .finally(() => setBusy(false));
        }}
      >
        清除本机离线数据
      </button>
      {notice && <p role="status">{notice}</p>}
      {error && <ErrorNotice>{error}</ErrorNotice>}
    </section>
  );
}
