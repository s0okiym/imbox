import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Task } from '@imbox/contracts';
import { ApiClient, ApiError, isAccessLoss } from '../api.js';
import type { Member } from '../api.js';
import { Avatar, ErrorNotice, IdentityTag } from '../components.js';
import { commandIdentity, taskError, TASK_LABELS } from './task-state.js';
import type { CommandIdentity } from './task-state.js';

export function useTaskCommand<T extends { version: string }>(
  current: T,
  refresh: () => void,
  accessLost: (error: unknown) => void,
) {
  const [baseline, setBaseline] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const identity = useRef<CommandIdentity | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const stale = current.version !== baseline.version;
  const run = async (body: unknown, operation: (base: T, key: string, signal: AbortSignal) => Promise<void>): Promise<boolean> => {
    if (busy || stale) return false;
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    identity.current = commandIdentity(identity.current, body, baseline.version, () => crypto.randomUUID());
    setBusy(true); setError(null);
    try {
      await operation(baseline, identity.current.key, next.signal);
      return !next.signal.aborted;
    } catch (failure: unknown) {
      if (next.signal.aborted) return false;
      if (isAccessLoss(failure)) accessLost(failure);
      else {
        setError(taskError(failure));
        if (failure instanceof ApiError && failure.status === 409) refresh();
      }
      return false;
    } finally { if (!next.signal.aborted) setBusy(false); }
  };
  return { baseline, busy, error, stale, run, setError,
    adoptLatest: () => { setBaseline(current); identity.current = null; setError(null); },
  };
}
export type TaskCommand = ReturnType<typeof useTaskCommand>;

export function CommandActions({ command, label, onClose, disabled = false }: {
  readonly command: Pick<TaskCommand, 'busy' | 'error' | 'stale' | 'adoptLatest'>;
  readonly label: string; readonly onClose: () => void; readonly disabled?: boolean;
}) {
  return <>
    {command.error !== null && <ErrorNotice>{command.error}</ErrorNotice>}
    {command.stale && <div className="task-conflict" role="alert">
      <p>最新版本已经改变。草稿仍在，请重新核对页面中的目标、负责人和验收标准。</p>
      <button type="button" className="text-button" onClick={command.adoptLatest}>已核对，采用最新版本</button>
    </div>}
    <div className="dialog-actions">
      <button type="button" className="button subtle" disabled={command.busy} onClick={onClose}>取消</button>
      <button className="button primary" disabled={disabled || command.busy || command.stale}>{command.busy ? '正在提交…' : label}</button>
    </div>
  </>;
}

export function useWorkspaceMembers(client: ApiClient, workspaceId: string): {
  members: readonly Member[]; loading: boolean; error: string | null;
} {
  const [members, setMembers] = useState<readonly Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setMembers([]); setLoading(true); setError(null);
    if (!workspaceId) { setLoading(false); return () => controller.abort(); }
    void client.workspaceMembers(workspaceId, controller.signal).then((page) => {
      if (!controller.signal.aborted) setMembers(page.items.filter((entry) => entry.principal.status === 'active'));
    }).catch((failure: unknown) => { if (!controller.signal.aborted) setError(taskError(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [client, workspaceId]);
  return { members, loading, error };
}
export function MemberPicker({ members, selected, onChange, disabled = false }: {
  readonly members: readonly Member[]; readonly selected: readonly string[];
  readonly onChange: (ids: string[]) => void; readonly disabled?: boolean;
}) {
  const prefix = useId();
  return <div className="task-member-picker">
    {members.map(({ principal }) => <label key={principal.id} htmlFor={`${prefix}-${principal.id}`}>
      <input id={`${prefix}-${principal.id}`} type="checkbox" checked={selected.includes(principal.id)} disabled={disabled}
        onChange={(event) => onChange(event.target.checked ? [...selected, principal.id] : selected.filter((id) => id !== principal.id))} />
      <Avatar name={principal.display_name} size="small" agent={principal.kind === 'agent'} />
      <span>{principal.display_name}<IdentityTag principal={principal} /></span>
    </label>)}
  </div>;
}
export function MemberName({ id, members }: { readonly id: string; readonly members: readonly Member[] }) {
  const principal = members.find((entry) => entry.principal.id === id)?.principal;
  return <span className="task-principal" title={id}>{principal?.display_name ?? `${id.slice(0, 8)}…`}{principal !== undefined && <IdentityTag principal={principal} />}</span>;
}
export function TaskStatus({ task }: { readonly task: Task }) {
  return <span className={`task-status status-${task.status}`}>{TASK_LABELS[task.status]}{task.archived ? ' · 已归档' : ''}</span>;
}
export function Field({ label, children, hint }: { readonly label: string; readonly children: ReactNode; readonly hint?: string }) {
  return <label className="task-field"><span className="field-label">{label}</span>{children}{hint !== undefined && <small>{hint}</small>}</label>;
}
export function requiredIds(ids: readonly string[]): [string, ...string[]] {
  const first = ids[0];
  if (first === undefined || ids.length > 20) throw new Error('请选择 1 至 20 位验收人。');
  return [first, ...ids.slice(1)];
}
