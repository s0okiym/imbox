import { useEffect, useState, useRef } from 'react';
import { describeError } from '../api.js';
import type { NotificationApi } from './notification-api.js';
export function PushSettings({ api, changed }: { api: NotificationApi; changed(): void }) {
  const [key, setKey] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState<string | null>(null);
  const command = useRef<AbortController | null>(null);
  useEffect(() => () => command.current?.abort(), [api]);
  useEffect(() => {
    const abort = new AbortController();
    setKey(null);
    void api
      .pushKey(abort.signal)
      .then((result) => {
        if (!abort.signal.aborted) setKey(result.public_key);
      })
      .catch(() => {});
    return () => abort.abort();
  }, [api]);
  const supported =
    'Notification' in window && 'PushManager' in window && 'serviceWorker' in navigator;
  return (
    <section aria-label="系统通知设置">
      <h2>系统通知</h2>
      <p>
        通知只显示通用提示。点击后需登录并重新核对访问权限；本机订阅绑定当前登录会话，退出或会话过期后停止发送。
      </p>
      {!key && <p>此部署尚未启用系统推送。</p>}
      {!supported && <p>此浏览器不支持系统推送，请使用通知收件箱。</p>}
      <button
        disabled={!key || !supported || busy}
        onClick={() => {
          if (!key || busy) return;
          setBusy(true);
          setNotice(null);
          const abort = new AbortController(),
            timer = setTimeout(() => abort.abort(), 15000);
          command.current = abort;
          void (async () => {
            const permission = await Notification.requestPermission();
            if (permission !== 'granted')
              throw new Error('未获系统通知权限，请在浏览器设置中检查。');
            const registration = await navigator.serviceWorker.getRegistration('/');
            if (!registration?.active)
              throw new Error('系统推送需要已安装服务工作线程的正式构建，请刷新后再试。');
            if (abort.signal.aborted) throw new Error('订阅超时，请重试。');
            const subscription =
              (await registration.pushManager.getSubscription()) ??
              (await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: key,
              }));
            if (abort.signal.aborted) throw new Error('订阅已取消，请重新操作。');
            const json = subscription.toJSON();
            if (!json.endpoint || !json.keys?.['p256dh'] || !json.keys['auth'])
              throw new Error('浏览器未返回有效订阅。');
            await api.subscribe(
              {
                endpoint: json.endpoint,
                keys: { p256dh: json.keys['p256dh'], auth: json.keys['auth'] },
              },
              abort.signal,
            );
            setNotice('此登录会话已启用系统通知。');
            changed();
          })()
            .catch((error: unknown) =>
              setNotice(
                error instanceof Error && !(error.name === 'ApiError')
                  ? error.message
                  : describeError(error),
              ),
            )
            .finally(() => {
              clearTimeout(timer);
              setBusy(false);
            });
        }}
      >
        启用此设备的系统通知
      </button>
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
