import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ContractTypes as C } from '@imbox/contracts';
import { ApiClient, ApiError, describeError } from '../api.js';
import { ErrorNotice, fullTime } from '../components.js';

export function AccountEntry({
  checking,
  onJoined,
  onLogout,
}: {
  checking: boolean;
  onJoined: (tenant: string) => Promise<void>;
  onLogout: (account: C['Account']) => Promise<void>;
}) {
  const [account, setAccount] = useState<C['Account'] | null>(null),
    [code, setCode] = useState(''),
    [preview, setPreview] = useState<C['OrganizationInvitationPreview'] | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [refresh, setRefresh] = useState(0);
  const mutation = useRef<AbortController | null>(null);
  useEffect(() => () => mutation.current?.abort(), []);
  const accountIdentity = useRef<string | null>(null);
  useEffect(() => {
    if (checking) {
      mutation.current?.abort();
      setBusy(false);
      setAccount(null);
      setCode('');
      setPreview(null);
      setConfirmed(false);
      return;
    }
    const controller = new AbortController();
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const value = await new ApiClient('').account(controller.signal);
        if (controller.signal.aborted) return;
        const identity = `${value.principal.id}:${value.session_id}`;
        if (accountIdentity.current && accountIdentity.current !== identity) {
          mutation.current?.abort();
          setBusy(false);
          setCode('');
          setPreview(null);
          setConfirmed(false);
          setError('当前账号已改变，请重新核对邀请。');
        }
        accountIdentity.current = identity;
        setAccount(value);
      } catch (e) {
        if (controller.signal.aborted) return;
        setAccount(null);
        if (e instanceof ApiError && e.status === 401) {
          mutation.current?.abort();
          setBusy(false);
          setCode('');
          setPreview(null);
          setConfirmed(false);
          accountIdentity.current = null;
        } else setError(describeError(e));
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    const focus = () => void load();
    window.addEventListener('focus', focus);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener('focus', focus);
    };
  }, [checking, refresh]);
  async function inspect() {
    if (!account || busy || checking) return;
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(true);
    setError(null);
    setPreview(null);
    setConfirmed(false);
    try {
      const result = await new ApiClient('', account.csrf_token).previewInvitation(
        { code: code.trim() },
        controller.signal,
      );
      if (!controller.signal.aborted) setPreview(result);
    } catch (e) {
      if (!controller.signal.aborted) setError(describeError(e));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function join(event: FormEvent) {
    event.preventDefault();
    if (!account || busy || checking || !preview || !confirmed) return;
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(true);
    setError(null);
    try {
      const result = await new ApiClient('', account.csrf_token).acceptInvitation(
        { code: code.trim() },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setCode('');
      setPreview(null);
      setConfirmed(false);
      await onJoined(result.tenant_id);
    } catch (e) {
      if (controller.signal.aborted) return;
      setError(describeError(e));
      setPreview(null);
      setConfirmed(false);
      if (e instanceof ApiError && e.status === 401) {
        setAccount(null);
        setCode('');
        setPreview(null);
        setConfirmed(false);
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section aria-label="当前账号与入组">
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {account && (
        <>
          <h3>已登录为 {account.principal.display_name}</h3>
          <p>尚未进入组织时，可以把自己的账号标识交给组织管理员，由管理员创建只对你有效的邀请。</p>
          <label>
            我的账号标识
            <input readOnly value={account.principal.id} />
          </label>
          <form onSubmit={(e) => void join(e)}>
            <label>
              邀请码
              <input
                type="password"
                autoComplete="off"
                maxLength={300}
                value={code}
                disabled={busy || checking}
                onChange={(e) => {
                  setCode(e.target.value);
                  setPreview(null);
                  setConfirmed(false);
                }}
              />
            </label>
            <button
              type="button"
              disabled={busy || checking || !code.trim()}
              onClick={() => void inspect()}
            >
              查看邀请
            </button>
            {preview && (
              <section aria-label="邀请信息">
                <dl>
                  <dt>组织</dt>
                  <dd>{preview.tenant_name}</dd>
                  <dt>工作区</dt>
                  <dd>{preview.workspace_name}</dd>
                  <dt>角色</dt>
                  <dd>{preview.role === 'member' ? '成员' : '访客'}</dd>
                  <dt>截止时间</dt>
                  <dd>{fullTime(preview.expires_at)}</dd>
                </dl>
                {preview.status === 'accepted' && (
                  <p>此邀请已经接受，本次只进入现有组织，不会恢复已停用的访问。</p>
                )}
                <label>
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={busy || checking}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  我已核对组织、工作区和权限，确认接受
                </label>
              </section>
            )}
            <button disabled={busy || checking || !preview || !confirmed}>
              {preview?.status === 'accepted' ? '进入已接受的组织' : '接受邀请并进入组织'}
            </button>
          </form>
          <button
            disabled={busy || checking}
            onClick={() => {
              setAccount(null);
              setCode('');
              setPreview(null);
              setConfirmed(false);
              void onLogout(account).finally(() => setRefresh((n) => n + 1));
            }}
          >
            退出当前账号
          </button>
        </>
      )}
    </section>
  );
}
