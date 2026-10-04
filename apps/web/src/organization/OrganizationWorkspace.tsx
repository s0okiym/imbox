import { Invitations } from './Invitations.js';
import { TenantMembers } from './TenantMembers.js';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { ContractTypes as C } from '@imbox/contracts';
import { ApiClient, ApiError, describeError, type Session } from '../api.js';
import { ErrorNotice } from '../components.js';
import { commandIdentity, type CommandIdentity } from '../tasks/task-state.js';

type Props = {
  session: Session;
  onClose: () => void;
  onSessionLost: (message: string | null) => void;
  onSessionUpdated: (session: Session) => void;
};
async function allPages<T>(
  load: (cursor?: string) => Promise<{ items: T[]; next_cursor?: string }>,
) {
  const items: T[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const result = await load(cursor);
    items.push(...result.items);
    cursor = result.next_cursor;
    if (cursor) {
      if (seen.has(cursor) || seen.size >= 1000)
        throw new Error('成员目录过大或分页失效，请刷新后重试。');
      seen.add(cursor);
    }
  } while (cursor);
  return items;
}
export function OrganizationWorkspace(props: Props) {
  return (
    <OrganizationScope
      key={`${props.session.tenant_id}:${props.session.principal.id}:${props.session.authz_revision}`}
      {...props}
    />
  );
}
function OrganizationScope({ session, onClose, onSessionLost, onSessionUpdated }: Props) {
  const api = useMemo(
    () => new ApiClient(session.tenant_id, session.csrf_token),
    [session.tenant_id, session.csrf_token],
  );
  const [allowed, setAllowed] = useState<boolean | null>(null),
    [workspaces, setWorkspaces] = useState<C['ManagedWorkspace'][]>([]),
    [candidates, setCandidates] = useState<C['OrganizationCandidate'][]>([]),
    [members, setMembers] = useState<C['ManagedWorkspaceMember'][]>([]);
  const [selected, setSelected] = useState(''),
    [revision, setRevision] = useState(0),
    [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const [name, setName] = useState(''),
    [principal, setPrincipal] = useState(''),
    [role, setRole] = useState<C['SetWorkspaceMemberInput']['role']>('member'),
    [status, setStatus] = useState<C['SetWorkspaceMemberInput']['status']>('active'),
    [reason, setReason] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  const mutation = useRef<AbortController | null>(null),
    createCommand = useRef<CommandIdentity | null>(null),
    memberCommand = useRef<CommandIdentity | null>(null);
  useEffect(() => () => mutation.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(false);
    setMembers([]);
    setConfirmed(false);
    void (async () => {
      const access = await api.organizationAccess(controller.signal);
      if (controller.signal.aborted) return;
      setAllowed(access.can_manage);
      if (!access.can_manage) return;
      const [ws, people] = await Promise.all([
        allPages((cursor) => api.managedWorkspaces(controller.signal, cursor)),
        allPages((cursor) => api.organizationCandidates(controller.signal, cursor)),
      ]);
      const current = ws.find((w) => w.id === selected)?.id ?? ws[0]?.id ?? '';
      const roster = current
        ? await allPages((cursor) => api.managedMembers(current, controller.signal, cursor))
        : [];
      if (controller.signal.aborted) return;
      setWorkspaces(ws);
      setCandidates(people);
      setMembers(roster);
      if (current !== selected) {
        // Selecting the initial/default workspace triggers the scoped load effect again.
        // Do not expose an enabled form in between those two loads.
        setSelected(current);
        return;
      }
      setLoaded(true);
    })().catch((e: unknown) => {
      if (controller.signal.aborted) return;
      if (e instanceof ApiError && e.status === 401) onSessionLost('登录已失效，请重新登录。');
      else {
        if (e instanceof ApiError && [403, 404].includes(e.status)) {
          setAllowed(false);
          setWorkspaces([]);
          setCandidates([]);
          setMembers([]);
          setReason('');
          setConfirmed(false);
        }
        setError(describeError(e));
      }
    });
    return () => controller.abort();
  }, [api, selected, revision, onSessionLost]);
  // Revalidate the management view without overwriting an in-progress role edit.
  useEffect(() => {
    const controller = new AbortController();
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const me = await api.me(controller.signal);
        if (controller.signal.aborted) return;
        if (
          me.principal.id !== session.principal.id ||
          me.authz_revision !== session.authz_revision
        ) {
          mutation.current?.abort();
          setLoaded(false);
          setMembers([]);
          setCandidates([]);
          setWorkspaces([]);
          setReason('');
          setConfirmed(false);
          onSessionUpdated(me);
          return;
        }
        const access = await api.organizationAccess(controller.signal);
        if (controller.signal.aborted) return;
        if (!access.can_manage) {
          mutation.current?.abort();
          setAllowed(false);
          setLoaded(false);
          setMembers([]);
          setCandidates([]);
          setWorkspaces([]);
          setReason('');
          setConfirmed(false);
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
          mutation.current?.abort();
          setAllowed(false);
          setLoaded(false);
          setMembers([]);
          setCandidates([]);
          setWorkspaces([]);
          setReason('');
          setConfirmed(false);
          if (e.status === 401) onSessionLost('登录已失效，请重新登录。');
        }
      } finally {
        checking = false;
      }
    };
    const timer = setInterval(() => void check(), 3000);
    window.addEventListener('focus', check);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener('focus', check);
    };
  }, [api, session.principal.id, session.authz_revision, onSessionUpdated, onSessionLost]);
  const workspace = workspaces.find((w) => w.id === selected);
  function choose(id: string) {
    setPrincipal(id);
    setConfirmed(false);
    const member = members.find((m) => m.principal.id === id);
    setRole(member?.role ?? 'member');
    setStatus(member?.status ?? 'active');
  }
  async function submit(event: FormEvent, kind: 'create' | 'member') {
    event.preventDefault();
    if (busy || !loaded) return;
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (kind === 'create') {
        const body = { name: name.trim() };
        createCommand.current = commandIdentity(createCommand.current, body, 'create', () =>
          crypto.randomUUID(),
        );
        const w = await api.createManagedWorkspace(
          body,
          createCommand.current.key,
          controller.signal,
        );
        createCommand.current = null;
        setName('');
        setSelected(w.id);
        setNotice('工作区已创建。');
      } else {
        if (!workspace || !confirmed) return;
        const body = { principal_id: principal, role, status, reason: reason.trim() };
        memberCommand.current = commandIdentity(
          memberCommand.current,
          { id: workspace.id, body },
          workspace.version,
          () => crypto.randomUUID(),
        );
        await api.setWorkspaceMember(
          workspace.id,
          body,
          workspace.version,
          memberCommand.current.key,
          controller.signal,
        );
        memberCommand.current = null;
        setConfirmed(false);
        setReason('');
        setNotice('成员权限已更新。');
      }
      const me = await api.me(controller.signal);
      if (controller.signal.aborted) return;
      onSessionUpdated(me);
      setRevision((n) => n + 1);
    } catch (e) {
      if (controller.signal.aborted) return;
      if (e instanceof ApiError && e.status === 401) onSessionLost('登录已失效，请重新登录。');
      else {
        setError(describeError(e));
        if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
          setConfirmed(false);
          setRevision((n) => n + 1);
        }
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  const people = new Map(candidates.map((c) => [c.principal.id, c.principal]));
  for (const m of members)
    if (m.principal.kind === 'human') people.set(m.principal.id, m.principal);
  return (
    <section className="organization-workspace" aria-label="组织与成员管理">
      <header>
        <h1>组织与成员</h1>
        <button onClick={onClose}>返回会话</button>
      </header>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {notice && <p role="status">{notice}</p>}
      {allowed === null ? (
        <p>正在检查管理权限…</p>
      ) : !allowed ? (
        <p>只有组织所有者或组织管理员可以管理工作区成员。</p>
      ) : (
        <>
          <p>
            管理当前组织已有的人员。加入工作区后，具体会话和任务仍需单独授权；Agent 请在 Agent
            目录管理。
          </p>
          <TenantMembers
            api={api}
            session={session}
            onSessionLost={onSessionLost}
            onSessionUpdated={onSessionUpdated}
            onChanged={() => setRevision((n) => n + 1)}
          />
          <Invitations api={api} workspaces={workspaces} onSessionLost={onSessionLost} />
          <form onSubmit={(e) => void submit(e, 'create')}>
            <label>
              新工作区名称
              <input
                required
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={busy}
              />
            </label>
            <button disabled={busy || !loaded || !name.trim()}>创建工作区</button>
          </form>
          <label>
            管理的工作区
            <select
              value={selected}
              disabled={busy}
              onChange={(e) => {
                setSelected(e.target.value);
                setPrincipal('');
                setError(null);
              }}
            >
              <option value="">选择工作区</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={busy}
            onClick={() => {
              setError(null);
              setRevision((n) => n + 1);
            }}
          >
            刷新成员
          </button>
          {!loaded ? (
            <p>正在加载成员…</p>
          ) : (
            workspace && (
              <>
                <h2>{workspace.name} 的成员</h2>
                <table aria-label="工作区成员">
                  <thead>
                    <tr>
                      <th>成员</th>
                      <th>类型</th>
                      <th>角色</th>
                      <th>工作区状态</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((m) => (
                      <tr key={m.principal.id}>
                        <td>
                          {m.principal.display_name}
                          <small>{m.principal.id}</small>
                          {(m.principal.status !== 'active' || m.tenant_status !== 'active') && (
                            <span>身份或组织成员已停用</span>
                          )}
                        </td>
                        <td>{m.principal.kind}</td>
                        <td>{{ admin: '管理员', member: '成员', guest: '访客' }[m.role]}</td>
                        <td>{m.status === 'active' ? '有效' : '已停用'}</td>
                        <td>
                          {m.principal.kind === 'human' && (
                            <button disabled={busy} onClick={() => choose(m.principal.id)}>
                              编辑 {m.principal.display_name}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <form onSubmit={(e) => void submit(e, 'member')}>
                  <h2>添加或修改成员</h2>
                  <label>
                    组织成员
                    <select
                      required
                      value={principal}
                      disabled={busy}
                      onChange={(e) => choose(e.target.value)}
                    >
                      <option value="">选择人员</option>
                      {[...people.values()].map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.display_name} · {p.id.slice(0, 8)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    成员角色
                    <select
                      value={role}
                      disabled={busy}
                      onChange={(e) => {
                        setRole(e.target.value as typeof role);
                        setConfirmed(false);
                      }}
                    >
                      <option value="admin">管理员</option>
                      <option value="member">成员</option>
                      <option value="guest">访客</option>
                    </select>
                  </label>
                  <label>
                    成员状态
                    <select
                      value={status}
                      disabled={busy}
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
                    变更理由
                    <textarea
                      required
                      maxLength={2000}
                      value={reason}
                      disabled={busy}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </label>
                  <p>
                    权限变化会使该成员在本组织的旧运行授权失效。恢复成员会重新开放其仍保留的会话和任务权限，但不会恢复旧运行授权。工作区至少保留一名有效的人类管理员。
                  </p>
                  <label>
                    <input
                      type="checkbox"
                      checked={confirmed}
                      disabled={busy}
                      onChange={(e) => setConfirmed(e.target.checked)}
                    />
                    我已核对人员、角色和状态，确认变更
                  </label>
                  <button disabled={busy || !principal || !confirmed || !reason.trim()}>
                    保存成员权限
                  </button>
                </form>
              </>
            )
          )}
        </>
      )}
    </section>
  );
}
