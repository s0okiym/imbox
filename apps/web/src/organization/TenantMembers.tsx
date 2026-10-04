import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ContractTypes as C } from '@imbox/contracts';
import { ApiClient, ApiError, describeError, type Session } from '../api.js';
import { ErrorNotice } from '../components.js';
import { commandIdentity, type CommandIdentity } from '../tasks/task-state.js';

type Props = {
  api: ApiClient;
  session: Session;
  onSessionLost: (message: string | null) => void;
  onSessionUpdated: (session: Session) => void;
  onChanged: () => void;
};
export function TenantMembers({ api, session, onSessionLost, onSessionUpdated, onChanged }: Props) {
  const [members, setMembers] = useState<C['ManagedTenantMember'][]>([]),
    [revision, setRevision] = useState(0),
    [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState(''),
    [role, setRole] = useState<C['SetTenantMemberInput']['role']>('member'),
    [status, setStatus] = useState<C['SetTenantMemberInput']['status']>('active'),
    [reason, setReason] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  const mutation = useRef<AbortController | null>(null),
    identity = useRef<CommandIdentity | null>(null);
  useEffect(() => () => mutation.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(false);
    setConfirmed(false);
    void (async () => {
      const items: C['ManagedTenantMember'][] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await api.managedTenantMembers(controller.signal, cursor);
        items.push(...page.items);
        cursor = page.next_cursor;
        if (cursor) {
          if (seen.has(cursor) || seen.size >= 1000)
            throw new Error('组织成员目录过大，请稍后重试。');
          seen.add(cursor);
        }
      } while (cursor);
      if (controller.signal.aborted) return;
      setMembers(items);
      setLoaded(true);
    })().catch((e: unknown) => {
      if (controller.signal.aborted) return;
      setMembers([]);
      setError(describeError(e));
      if (e instanceof ApiError && e.status === 401) onSessionLost('登录已失效，请重新登录。');
    });
    return () => controller.abort();
  }, [api, revision, onSessionLost]);
  const member = members.find((m) => m.principal.id === selected),
    isOwner = members.find((m) => m.principal.id === session.principal.id)?.role === 'owner';
  const editable = (m: C['ManagedTenantMember']) =>
    m.principal.kind === 'human' &&
    m.role !== 'agent' &&
    m.status !== 'historical' &&
    (isOwner || !['owner', 'admin'].includes(m.role));
  function choose(m: C['ManagedTenantMember']) {
    if (!editable(m)) return;
    setSelected(m.principal.id);
    setRole(m.role as typeof role);
    setStatus(m.status === 'active' ? 'active' : 'disabled');
    setConfirmed(false);
    setReason('');
    setError(null);
    setNotice(null);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!loaded || busy || !member || !editable(member) || !confirmed) return;
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(true);
    setError(null);
    setNotice(null);
    const body = { role, status, reason: reason.trim() };
    identity.current = commandIdentity(
      identity.current,
      { id: selected, body },
      member.version,
      () => crypto.randomUUID(),
    );
    try {
      await api.setTenantMember(
        selected,
        body,
        member.version,
        identity.current.key,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      identity.current = null;
      setConfirmed(false);
      setReason('');
      setSelected('');
      setNotice('组织成员权限已更新。');
      const me = await api.me(controller.signal);
      if (controller.signal.aborted) return;
      onSessionUpdated(me);
      setRevision((n) => n + 1);
      onChanged();
    } catch (e) {
      if (controller.signal.aborted) return;
      if (e instanceof ApiError && e.status === 401) onSessionLost('登录已失效，请重新登录。');
      else {
        setError(describeError(e));
        if (e instanceof ApiError && ['VERSION_CONFLICT', 'FORBIDDEN'].includes(e.code)) {
          setConfirmed(false);
          setSelected('');
          setRevision((n) => n + 1);
        }
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  const roles = { owner: '所有者', admin: '管理员', member: '成员', guest: '访客', agent: 'Agent' };
  return (
    <section aria-label="组织级成员管理">
      <h2>组织成员权限</h2>
      <p>
        此处管理整个组织的角色和访问状态。停用将阻止访问本组织；恢复会重新开放仍保留的具体权限，但旧运行授权仍然失效。组织所有者可以任免管理员，管理员只能管理普通成员和访客。
      </p>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {notice && <p role="status">{notice}</p>}
      <button
        disabled={busy}
        onClick={() => {
          setError(null);
          setRevision((n) => n + 1);
        }}
      >
        刷新组织成员
      </button>
      {!loaded ? (
        <p>正在加载组织成员…</p>
      ) : (
        <table aria-label="组织成员权限">
          <thead>
            <tr>
              <th>人员</th>
              <th>组织角色</th>
              <th>组织状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.principal.id}>
                <td>
                  {m.principal.display_name}
                  <small>{m.principal.id}</small>
                </td>
                <td>{roles[m.role]}</td>
                <td>{{ active: '有效', disabled: '已停用', historical: '历史成员' }[m.status]}</td>
                <td>
                  {editable(m) && (
                    <button disabled={busy} onClick={() => choose(m)}>
                      管理组织权限 {m.principal.display_name}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {member && editable(member) && (
        <form onSubmit={(e) => void submit(e)}>
          <h3>修改 {member.principal.display_name} 的组织权限</h3>
          <label>
            组织角色
            <select
              value={role}
              disabled={busy || !loaded}
              onChange={(e) => {
                setRole(e.target.value as typeof role);
                setConfirmed(false);
              }}
            >
              {(isOwner
                ? (['owner', 'admin', 'member', 'guest'] as const)
                : (['member', 'guest'] as const)
              ).map((r) => (
                <option key={r} value={r}>
                  {roles[r]}
                </option>
              ))}
            </select>
          </label>
          <label>
            组织访问状态
            <select
              value={status}
              disabled={busy || !loaded}
              onChange={(e) => {
                setStatus(e.target.value as typeof status);
                setConfirmed(false);
              }}
            >
              <option value="active">有效</option>
              <option value="disabled">停用</option>
            </select>
          </label>
          <label>
            组织变更理由
            <textarea
              required
              maxLength={2000}
              value={reason}
              disabled={busy || !loaded}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <p>至少保留一名有效的人类组织所有者；停用人员前，各工作区也需保留有效的人类管理员。</p>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy || !loaded}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            我已核对组织级影响，确认变更
          </label>
          <button disabled={busy || !loaded || !confirmed || !reason.trim()}>保存组织权限</button>
        </form>
      )}
    </section>
  );
}
