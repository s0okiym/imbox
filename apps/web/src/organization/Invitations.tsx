import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ContractTypes as C } from '@imbox/contracts';
import { ApiClient, ApiError, describeError } from '../api.js';
import { ErrorNotice, fullTime } from '../components.js';
import { commandIdentity, type CommandIdentity } from '../tasks/task-state.js';

export function Invitations({
  api,
  workspaces,
  onSessionLost,
}: {
  api: ApiClient;
  workspaces: C['ManagedWorkspace'][];
  onSessionLost: (message: string | null) => void;
}) {
  const [items, setItems] = useState<C['OrganizationInvitation'][]>([]),
    [loaded, setLoaded] = useState(false),
    [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const [principal, setPrincipal] = useState(''),
    [workspace, setWorkspace] = useState(''),
    [role, setRole] = useState<'member' | 'guest'>('member'),
    [hours, setHours] = useState(72),
    [reason, setReason] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [code, setCode] = useState('');
  const [revoking, setRevoking] = useState<C['OrganizationInvitation'] | null>(null),
    [revokeReason, setRevokeReason] = useState('');
  const createIdentity = useRef<CommandIdentity | null>(null),
    revokeIdentity = useRef<CommandIdentity | null>(null),
    mutation = useRef<AbortController | null>(null);
  useEffect(() => () => mutation.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(false);
    void (async () => {
      const collected: C['OrganizationInvitation'][] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await api.organizationInvitations(controller.signal, cursor);
        collected.push(...page.items);
        cursor = page.next_cursor;
        if (cursor) {
          if (seen.has(cursor) || seen.size >= 1000) throw new Error('邀请目录过大，请稍后重试。');
          seen.add(cursor);
        }
      } while (cursor);
      if (controller.signal.aborted) return;
      setItems(collected);
      setLoaded(true);
    })().catch((e: unknown) => {
      if (controller.signal.aborted) return;
      setItems([]);
      setCode('');
      setError(describeError(e));
      if (e instanceof ApiError && e.status === 401) onSessionLost('登录已失效，请重新登录。');
    });
    return () => controller.abort();
  }, [api, revision, onSessionLost]);
  async function submit(event: FormEvent, revoke = false) {
    event.preventDefault();
    if (busy || !loaded || (!revoke && !confirmed)) return;
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(true);
    setError(null);
    setNotice(null);
    setCode('');
    try {
      if (revoke) {
        if (!revoking) return;
        const body = { reason: revokeReason.trim() };
        revokeIdentity.current = commandIdentity(
          revokeIdentity.current,
          { id: revoking.id, body },
          revoking.version,
          () => crypto.randomUUID(),
        );
        await api.revokeInvitation(
          revoking.id,
          body,
          revoking.version,
          revokeIdentity.current.key,
          controller.signal,
        );
        revokeIdentity.current = null;
        setRevoking(null);
        setRevokeReason('');
        setNotice('邀请已撤销。');
      } else {
        if (!workspaces.some((w) => w.id === workspace)) return;
        const body = {
          principal_id: principal.trim(),
          workspace_id: workspace,
          role,
          expires_in_hours: hours,
          reason: reason.trim(),
        };
        createIdentity.current = commandIdentity(createIdentity.current, body, 'create', () =>
          crypto.randomUUID(),
        );
        const result = await api.createInvitation(
          body,
          createIdentity.current.key,
          controller.signal,
        );
        createIdentity.current = null;
        setConfirmed(false);
        setReason('');
        if (result.code) {
          setCode(result.code);
          setNotice('邀请已创建，请通过可信方式交给指定账号。邀请码不会保存在本机存储中。');
        } else setNotice('原邀请已处理或过期，请查看当前状态。');
      }
      if (!controller.signal.aborted) setRevision((n) => n + 1);
    } catch (e) {
      if (controller.signal.aborted) return;
      setError(describeError(e));
      if (e instanceof ApiError && e.status === 401) onSessionLost('登录已失效，请重新登录。');
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
        setRevoking(null);
        setRevision((n) => n + 1);
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  const statuses = { pending: '待接受', accepted: '已接受', revoked: '已撤销', expired: '已过期' };
  return (
    <section aria-label="邀请新成员">
      <h2>邀请新成员</h2>
      <p>
        请对方先登录，并从登录页提供“我的账号标识”。邀请码只允许该账号在有效期内接受；现有成员的停用和恢复请使用成员管理。
      </p>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {notice && <p role="status">{notice}</p>}
      {code && (
        <div>
          <label>
            新邀请码
            <input type="password" readOnly autoComplete="off" value={code} />
          </label>
          <button
            onClick={() =>
              void navigator.clipboard
                .writeText(code)
                .then(() => setNotice('邀请码已复制，请交给指定账号。'))
                .catch(() => setError('无法自动复制，请选择邀请码字段后手动复制。'))
            }
          >
            复制邀请码
          </button>
          <button onClick={() => setCode('')}>隐藏邀请码</button>
        </div>
      )}
      <form onSubmit={(e) => void submit(e)}>
        <label>
          被邀请账号标识
          <input
            required
            maxLength={36}
            value={principal}
            disabled={busy}
            onChange={(e) => {
              setPrincipal(e.target.value);
              setConfirmed(false);
            }}
          />
        </label>
        <label>
          邀请加入工作区
          <select
            required
            value={workspace}
            disabled={busy}
            onChange={(e) => {
              setWorkspace(e.target.value);
              setConfirmed(false);
            }}
          >
            <option value="">选择工作区</option>
            {workspaces.map((w) => (
              <option value={w.id} key={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          邀请角色
          <select
            value={role}
            disabled={busy}
            onChange={(e) => {
              setRole(e.target.value as typeof role);
              setConfirmed(false);
            }}
          >
            <option value="member">成员</option>
            <option value="guest">访客</option>
          </select>
        </label>
        <label>
          邀请有效小时
          <input
            type="number"
            min={1}
            max={168}
            required
            value={hours}
            disabled={busy}
            onChange={(e) => {
              setHours(Number(e.target.value));
              setConfirmed(false);
            }}
          />
        </label>
        <label>
          邀请理由
          <textarea
            required
            maxLength={2000}
            value={reason}
            disabled={busy}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={confirmed}
            disabled={busy}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          已核对目标账号、工作区和权限
        </label>
        <button
          disabled={
            busy || !loaded || !confirmed || !principal.trim() || !workspace || !reason.trim()
          }
        >
          创建邀请
        </button>
      </form>
      <button
        disabled={busy}
        onClick={() => {
          setError(null);
          setRevision((n) => n + 1);
        }}
      >
        刷新邀请
      </button>
      {!loaded ? (
        <p>正在加载邀请…</p>
      ) : (
        <table aria-label="组织邀请">
          <thead>
            <tr>
              <th>账号</th>
              <th>工作区</th>
              <th>角色</th>
              <th>状态</th>
              <th>截止时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id}>
                <td>{i.principal_id}</td>
                <td>{workspaces.find((w) => w.id === i.workspace_id)?.name ?? i.workspace_id}</td>
                <td>{i.role === 'member' ? '成员' : '访客'}</td>
                <td>{statuses[i.status]}</td>
                <td>{fullTime(i.expires_at)}</td>
                <td>
                  {['pending', 'expired'].includes(i.status) && (
                    <button
                      disabled={busy}
                      onClick={() => {
                        setRevoking(i);
                        setRevokeReason('');
                      }}
                    >
                      撤销邀请 {i.id.slice(0, 8)}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {revoking && (
        <form onSubmit={(e) => void submit(e, true)}>
          <h3>撤销邀请 {revoking.id.slice(0, 8)}</h3>
          <label>
            撤销邀请理由
            <textarea
              required
              maxLength={2000}
              value={revokeReason}
              disabled={busy}
              onChange={(e) => setRevokeReason(e.target.value)}
            />
          </label>
          <button disabled={busy || !loaded || !revokeReason.trim()}>确认撤销邀请</button>
          <button type="button" disabled={busy} onClick={() => setRevoking(null)}>
            保留邀请
          </button>
        </form>
      )}
    </section>
  );
}
