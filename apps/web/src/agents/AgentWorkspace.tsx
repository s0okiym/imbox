import { useEffect, useMemo, useRef, useState } from 'react';
import {
  MACHINE_SCOPES,
  type RegisteredAgent,
  type AgentCredential,
  type RegisterAgentInput,
  type IssueAgentCredentialInput,
} from '@imbox/contracts';
import { ApiClient, ApiError, describeError, type Session } from '../api.js';
import { ErrorNotice } from '../components.js';
import { AgentApi } from './agent-api.js';
type Scope = IssueAgentCredentialInput['scopes'][number];
const scopeLabels: Record<Scope, string> = {
  'agents.read': '读取 Agent 目录',
  'knowledge.read': '读取有权访问的记忆',
  'knowledge.search': '搜索有权访问的知识',
  'messages.read': '读取消息',
  'messages.write': '发送消息',
  'tasks.read': '读取任务',
  'tasks.create': '创建任务',
  'tasks.write': '修改任务',
  'requests.read': '读取协作请求',
  'requests.ack': '确认收到请求',
  'requests.decide': '显式接受或拒绝请求',
  'runs.create': '创建运行',
  'runs.read': '读取运行',
  'runs.execute': '领取与执行运行',
  'runs.report': '报告运行进度',
  'runs.tools': '提出工具行动意图',
};
function ScopePicker({
  allowed,
  value,
  change,
  disabled,
}: {
  allowed: readonly Scope[];
  value: Scope[];
  change(value: Scope[]): void;
  disabled: boolean;
}) {
  return (
    <fieldset disabled={disabled}>
      <legend>允许的能力范围</legend>
      {allowed.map((scope) => (
        <label key={scope}>
          <input
            type="checkbox"
            checked={value.includes(scope)}
            onChange={(event) =>
              change(
                event.target.checked ? [...value, scope] : value.filter((item) => item !== scope),
              )
            }
          />
          {scopeLabels[scope]}
        </label>
      ))}
    </fieldset>
  );
}
interface Props {
  session: Session;
  onClose(): void;
  onSessionLost(message: string | null): void;
  onSessionUpdated(session: Session): void;
}
export function AgentWorkspace({ session, onClose, onSessionLost, onSessionUpdated }: Props) {
  const api = useMemo(
    () => new AgentApi(session.tenant_id, session.csrf_token),
    [session.tenant_id, session.csrf_token],
  );
  const [workspace, setWorkspace] = useState(session.workspaces[0]?.id ?? ''),
    [items, setItems] = useState<RegisteredAgent[]>([]),
    [selected, setSelected] = useState(''),
    [canManage, setCanManage] = useState(false),
    [revision, setRevision] = useState(0),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const [credentials, setCredentials] = useState<AgentCredential[]>([]),
    [cursor, setCursor] = useState<string>(),
    [secret, setSecret] = useState<string | null>(null),
    [showSecret, setShowSecret] = useState(false),
    [notice, setNotice] = useState<string | null>(null);
  const [name, setName] = useState(''),
    [mode, setMode] = useState<'hosted' | 'external'>('external'),
    [scopes, setScopes] = useState<Scope[]>(['agents.read']),
    [credentialScopes, setCredentialScopes] = useState<Scope[]>([]),
    [lifetime, setLifetime] = useState(3600),
    [confirmDisable, setConfirmDisable] = useState(false),
    [revokeId, setRevokeId] = useState('');
  const aborts = useRef(new Set<AbortController>()),
    intent = useRef<{ fingerprint: string; key: string } | null>(null);
  const selectedAgent = items.find((item) => item.id === selected);
  useEffect(
    () => () => {
      for (const controller of aborts.current) controller.abort();
    },
    [],
  );
  useEffect(() => {
    setSecret(null);
    setShowSecret(false);
    setCredentials([]);
    setCursor(undefined);
    setConfirmDisable(false);
    setRevokeId('');
    setCredentialScopes([]);
    setNotice(null);
  }, [selected, workspace, session.authz_revision]);
  useEffect(() => {
    if (!secret) return;
    const clear = () => {
        setSecret(null);
        setShowSecret(false);
      },
      visibility = () => {
        if (document.visibilityState !== 'visible') clear();
      };
    const timer = setTimeout(clear, 60000);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [secret]);
  useEffect(() => {
    const abort = new AbortController();
    let loading = false;
    const refresh = async () => {
      if (loading || !workspace) return;
      loading = true;
      try {
        const me = await new ApiClient(session.tenant_id, session.csrf_token).me(abort.signal);
        if (abort.signal.aborted) return;
        if (
          me.principal.id !== session.principal.id ||
          me.authz_revision !== session.authz_revision
        ) {
          for (const controller of aborts.current) controller.abort();
          setSecret(null);
          setItems([]);
          setCredentials([]);
          setCanManage(false);
          onSessionUpdated(me);
          return;
        }
        const [directory, access] = await Promise.all([
          api.directory(workspace, abort.signal),
          api.access(abort.signal),
        ]);
        if (abort.signal.aborted) return;
        setItems(directory.items);
        setCanManage(access.can_manage);
        if (!access.can_manage) {
          setSecret(null);
          setCredentials([]);
        }
        if (selected && !directory.items.some((item) => item.id === selected)) {
          setSelected('');
          setSecret(null);
          setCredentials([]);
        }
      } catch (failure) {
        if (abort.signal.aborted) return;
        setItems([]);
        setCredentials([]);
        setSecret(null);
        setCanManage(false);
        setError(describeError(failure));
        if (failure instanceof ApiError && failure.status === 401)
          onSessionLost('登录已失效，请重新登录。');
      } finally {
        loading = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [api, workspace, revision, session, selected, onSessionUpdated, onSessionLost]);
  useEffect(() => {
    if (!selected || !canManage) return;
    const abort = new AbortController();
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const result = await api.credentials(selected, abort.signal);
        if (!abort.signal.aborted) {
          setCredentials(result.items);
          setCursor(result.next_cursor);
        }
      } catch (failure) {
        if (!abort.signal.aborted) {
          setCredentials([]);
          setSecret(null);
          setError(describeError(failure));
        }
      } finally {
        loading = false;
      }
    };
    void refresh();
    return () => abort.abort();
  }, [api, selected, canManage, revision]);
  const command = async (
    fingerprint: string,
    work: (key: string, signal: AbortSignal) => Promise<void>,
    refreshAfter = true,
  ) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const controller = new AbortController();
    aborts.current.add(controller);
    if (intent.current?.fingerprint !== fingerprint)
      intent.current = { fingerprint, key: crypto.randomUUID() };
    try {
      await work(intent.current.key, controller.signal);
      if (!controller.signal.aborted) {
        intent.current = null;
        if (refreshAfter) setRevision((n) => n + 1);
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(describeError(failure));
        if (failure instanceof ApiError && failure.status === 401)
          onSessionLost('登录已失效，请重新登录。');
      }
    } finally {
      aborts.current.delete(controller);
      setBusy(false);
    }
  };
  return (
    <main className="workspace-panel" aria-label="Agent 目录与管理">
      <header>
        <h1>Agent 目录与管理</h1>
        <button onClick={onClose}>返回消息</button>
      </header>
      <label>
        工作空间
        <select
          value={workspace}
          disabled={busy}
          onChange={(event) => {
            setWorkspace(event.target.value);
            setSelected('');
            setItems([]);
          }}
        >
          {session.workspaces.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <p>
        Agent
        有独立身份和权限。能力范围不会自动赋予会话、任务或资源访问权；人类审批和验收仍由明确授权的人完成。
      </p>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {notice && <p role="status">{notice}</p>}
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <button
              disabled={busy}
              aria-pressed={selected === item.id}
              onClick={() => setSelected(item.id)}
            >
              {item.display_name}
            </button>{' '}
            · {item.mode === 'hosted' ? '托管运行' : '外部 Agent'} ·{' '}
            {item.status === 'active' ? '可用' : '已停用'} · 修订 {item.revision}
          </li>
        ))}
      </ul>
      {!canManage && <p>当前身份可查看目录；注册、停用和凭证管理需要租户管理员权限。</p>}
      {canManage && (
        <form
          aria-label="注册 Agent"
          onSubmit={(event) => {
            event.preventDefault();
            if (!scopes[0]) return;
            const body: RegisterAgentInput = {
              workspace_id: workspace,
              display_name: name.trim(),
              mode,
              scopes: [scopes[0], ...scopes.slice(1)],
              capabilities: ['text_generation'],
              config: mode === 'hosted' ? { model_alias: 'local' } : {},
            };
            void command(JSON.stringify(['register', body]), async (key, signal) => {
              const agent = await api.register(body, key, signal);
              if (signal.aborted) return;
              setItems((old) => [agent, ...old.filter((item) => item.id !== agent.id)]);
              setSelected(agent.id);
              setName('');
              setNotice('Agent 已注册并安装到当前工作空间。');
            });
          }}
        >
          <h2>注册 Agent</h2>
          <label>
            Agent 名称
            <input
              required
              maxLength={120}
              value={name}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            运行方式
            <select
              value={mode}
              disabled={busy}
              onChange={(event) => setMode(event.target.value as 'hosted' | 'external')}
            >
              <option value="external">外部 Agent</option>
              <option value="hosted">平台托管（本地模型）</option>
            </select>
          </label>
          <ScopePicker allowed={MACHINE_SCOPES} value={scopes} change={setScopes} disabled={busy} />
          <button disabled={busy || !workspace || !name.trim() || !scopes.length}>
            注册并安装
          </button>
        </form>
      )}
      {selectedAgent && (
        <section aria-label="Agent 详情">
          <h2>{selectedAgent.display_name}</h2>
          <p>安装 ID：{selectedAgent.id}</p>
          <p>主体 ID：{selectedAgent.principal_id}</p>
          <p>已授权能力：{selectedAgent.scopes.map((scope) => scopeLabels[scope]).join('、')}</p>
          {canManage && selectedAgent.status === 'active' && (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={confirmDisable}
                  disabled={busy}
                  onChange={(event) => setConfirmDisable(event.target.checked)}
                />
                确认停用此 Agent，阻断其后续运行和机器访问
              </label>
              <button
                disabled={busy || !confirmDisable}
                onClick={() =>
                  void command(`disable:${selected}`, async (key, signal) => {
                    await api.disable(selected, key, signal);
                    if (!signal.aborted) {
                      setSecret(null);
                      setConfirmDisable(false);
                      setNotice('Agent 已停用。');
                    }
                  })
                }
              >
                停用 Agent
              </button>
            </>
          )}
          {canManage && selectedAgent.mode === 'external' && (
            <>
              <h3>访问凭证</h3>
              <button disabled={busy} onClick={() => setRevision((n) => n + 1)}>
                刷新凭证状态
              </button>
              <p>
                凭证最多有效 30 天，用于换取最多 15 分钟的机器令牌。不要放入消息、URL 或客户端存储。
              </p>
              {selectedAgent.status === 'active' && (
                <form
                  aria-label="签发 Agent 凭证"
                  onSubmit={(event) => {
                    event.preventDefault();
                    setSecret(null);
                    if (!credentialScopes[0]) return;
                    const body: IssueAgentCredentialInput = {
                      scopes: [credentialScopes[0], ...credentialScopes.slice(1)],
                      lifetime_seconds: lifetime,
                    };
                    void command(JSON.stringify(['issue', selected, body]), async (key, signal) => {
                      const issued = await api.issue(selected, body, key, signal);
                      if (signal.aborted) return;
                      setCredentials((old) => [
                        issued.credential,
                        ...old.filter((item) => item.id !== issued.credential.id),
                      ]);
                      setSecret(issued.secret);
                      setShowSecret(false);
                      setNotice(
                        issued.secret
                          ? '凭证已签发，密钥仅本次返回；请存入你的密钥管理工具。'
                          : '此命令已经签发过凭证，密钥不能再次读取。若未保存，请撤销此凭证再明确签发新凭证。',
                      );
                    });
                  }}
                >
                  <ScopePicker
                    allowed={selectedAgent.scopes}
                    value={credentialScopes}
                    change={setCredentialScopes}
                    disabled={busy}
                  />
                  <label>
                    凭证有效期
                    <select
                      value={lifetime}
                      disabled={busy}
                      onChange={(event) => setLifetime(Number(event.target.value))}
                    >
                      <option value={3600}>1 小时</option>
                      <option value={86400}>1 天</option>
                      <option value={604800}>7 天</option>
                      <option value={2592000}>30 天</option>
                    </select>
                  </label>
                  <button disabled={busy || !credentialScopes.length}>签发凭证</button>
                </form>
              )}
              {secret && (
                <section aria-label="一次性凭证">
                  <p>仅在本页保留 60 秒，切换页面或隐藏窗口即清除。平台不保存可再次读取的明文。</p>
                  <label>
                    一次性密钥
                    <input
                      readOnly
                      type={showSecret ? 'text' : 'password'}
                      value={secret}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={showSecret}
                      onChange={(event) => setShowSecret(event.target.checked)}
                    />
                    显示密钥
                  </label>
                  <button
                    onClick={() => {
                      setSecret(null);
                      setShowSecret(false);
                    }}
                  >
                    我已保存，隐藏密钥
                  </button>
                </section>
              )}
              <ul aria-label="凭证列表">
                {credentials.map((credential) => (
                  <li key={credential.id}>
                    <code>{credential.id}</code> ·{' '}
                    {credential.status === 'revoked'
                      ? '已撤销'
                      : Date.parse(credential.expires_at) <= Date.now()
                        ? '已过期'
                        : '有效'}{' '}
                    · 到期 {new Date(credential.expires_at).toLocaleString()}
                    <p>{credential.scopes.map((scope) => scopeLabels[scope]).join('、')}</p>
                    {credential.status === 'active' && (
                      <button disabled={busy} onClick={() => setRevokeId(credential.id)}>
                        撤销此凭证
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {cursor && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void command(
                      `page:${selected}:${cursor}`,
                      async (_key, signal) => {
                        const page = await api.credentials(selected, signal, cursor);
                        if (!signal.aborted) {
                          setCredentials((old) => [
                            ...old,
                            ...page.items.filter(
                              (item) => !old.some((existing) => existing.id === item.id),
                            ),
                          ]);
                          setCursor(page.next_cursor);
                        }
                      },
                      false,
                    )
                  }
                >
                  加载更多凭证
                </button>
              )}
              {revokeId && (
                <section aria-label="确认撤销凭证">
                  <p>撤销凭证 {revokeId} 及它已签发的机器令牌。</p>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void command(`revoke:${revokeId}`, async (key, signal) => {
                        await api.revoke(revokeId, key, signal);
                        if (!signal.aborted) {
                          setRevokeId('');
                          setSecret(null);
                          setNotice('凭证及关联令牌已撤销。');
                        }
                      })
                    }
                  >
                    确认撤销
                  </button>
                  <button disabled={busy} onClick={() => setRevokeId('')}>
                    取消
                  </button>
                </section>
              )}
            </>
          )}
        </section>
      )}
    </main>
  );
}
