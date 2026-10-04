import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Conversation, Task, GovernancePolicy, CreateExportInput } from '@imbox/contracts';
import { ApiClient, ApiError, describeError, type Session } from '../api.js';
import { TaskApi } from '../tasks/task-api.js';
import { ErrorNotice } from '../components.js';
import { DeviceDataSettings } from '../offline/DeviceDataSettings.js';
import { GovernanceApi } from './governance-api.js';
import { commandIdentity, type CommandIdentity } from '../tasks/task-state.js';
interface Props {
  session: Session;
  onClose: () => void;
  onSessionLost: (message: string | null) => void;
  onSessionUpdated: (session: Session) => void;
}
export function GovernanceWorkspace(props: Props) {
  return (
    <GovernanceScope
      key={[props.session.tenant_id, props.session.principal.id, props.session.authz_revision].join(
        ':',
      )}
      {...props}
    />
  );
}
function GovernanceScope({ session, onClose, onSessionLost, onSessionUpdated }: Props) {
  const api = useMemo(
    () => new GovernanceApi(session.tenant_id, session.csrf_token),
    [session.tenant_id, session.csrf_token],
  );
  const [policy, setPolicy] = useState<GovernancePolicy | null>(null),
    [conversations, setConversations] = useState<Conversation[]>([]),
    [tasks, setTasks] = useState<Task[]>([]),
    [selection, setSelection] = useState('personal'),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  const command = useRef<CommandIdentity | null>(null),
    mutation = useRef<AbortController | null>(null);
  useEffect(() => () => mutation.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      const base = new ApiClient(session.tenant_id, session.csrf_token),
        me = await base.me(controller.signal);
      if (controller.signal.aborted) return;
      if (
        me.principal.id !== session.principal.id ||
        me.authz_revision !== session.authz_revision
      ) {
        mutation.current?.abort();
        setConversations([]);
        setTasks([]);
        setPolicy(null);
        onSessionUpdated(me);
        return;
      }
      const [p, c, t] = await Promise.all([
        api.policy(controller.signal),
        base.conversations(controller.signal),
        new TaskApi(session.tenant_id, session.csrf_token).tasks(controller.signal),
      ]);
      if (controller.signal.aborted) return;
      setPolicy(p);
      setConversations(c.items);
      setTasks(t.items);
    };
    const refresh = () => {
      void load().catch((failure) => {
        if (controller.signal.aborted) return;
        if (failure instanceof ApiError && [401, 403, 404].includes(failure.status)) {
          mutation.current?.abort();
          setConversations([]);
          setTasks([]);
          setPolicy(null);
          if (failure.status === 401) onSessionLost('登录已失效，请重新登录。');
        }
        setError(describeError(failure));
      });
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [api, session, revision, onSessionLost, onSessionUpdated]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const [scope, id] = selection.split(':');
    const body: CreateExportInput =
      scope === 'personal'
        ? { scope: 'personal' }
        : { scope: scope as 'conversation' | 'task', scope_id: id! };
    command.current = commandIdentity(command.current, body, '1', () => crypto.randomUUID());
    const controller = new AbortController();
    mutation.current?.abort();
    mutation.current = controller;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const job = await api.create(body, command.current.key, controller.signal),
        blob = await api.download(job, controller.signal);
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob),
        a = document.createElement('a');
      a.href = url;
      a.download = 'imbox-' + job.id + '.ndjson';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      command.current = null;
      setNotice('导出已通过完整性校验并开始保存。');
    } catch (failure) {
      if (!controller.signal.aborted) {
        if (failure instanceof ApiError && failure.status === 401)
          onSessionLost('登录已失效，请重新登录。');
        setError(describeError(failure));
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <main className="task-workspace" aria-label="数据与隐私">
      <header className="workspace-header">
        <div>
          <h1>数据与隐私</h1>
          <p>查看保留策略，导出你当前有权读取的资料。</p>
        </div>
        <button onClick={onClose}>返回消息</button>
      </header>
      {error && (
        <ErrorNotice>
          {error}
          <button onClick={() => setRevision((v) => v + 1)}>重试</button>
        </ErrorNotice>
      )}
      {notice && <p role="status">{notice}</p>}
      {policy && <DeviceDataSettings session={session} policy={policy} />}
      <section>
        <h2>导出资料</h2>
        <form onSubmit={(event) => void submit(event)}>
          <label>
            导出范围
            <select
              value={selection}
              onChange={(event) => setSelection(event.target.value)}
              disabled={busy}
            >
              <option value="personal">我的显式记忆</option>
              <optgroup label="可见会话（前 100 项）">
                {conversations.map((item) => (
                  <option key={item.id} value={'conversation:' + item.id}>
                    {item.title || '未命名会话'}
                  </option>
                ))}
              </optgroup>
              <optgroup label="可见任务（前 100 项）">
                {tasks.map((item) => (
                  <option key={item.id} value={'task:' + item.id}>
                    {item.title}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
          <button type="submit" disabled={busy || !policy}>
            {busy ? '正在导出与校验…' : '导出并下载'}
          </button>
        </form>
        <p>
          导出按下载时的权限读取。下载过程中权限变化会中止保存。下载后由你保管的副本无法远程撤回。浏览器单次上限
          128 MiB。
        </p>
      </section>
      {policy && (
        <section>
          <h2>当前保留策略</h2>
          <dl>
            <dt>消息</dt>
            <dd>{policy.message_days} 天</dd>
            <dt>文件</dt>
            <dd>{policy.resource_days} 天</dd>
            <dt>已结束运行的内容</dt>
            <dd>{policy.run_content_days} 天</dd>
            <dt>导出入口有效期</dt>
            <dd>{policy.export_hours} 小时</dd>
            <dt>离线消息缓存</dt>
            <dd>
              {policy.offline_message_cache_allowed ? '允许，由设备用户选择开启' : '此部署已关闭'}
            </dd>
            <dt>离线发送队列</dt>
            <dd>
              {policy.offline_queue_allowed
                ? `最长 ${policy.offline_queue_max_days} 天`
                : '此部署已关闭'}
            </dd>
          </dl>
          <p>
            以上策略由当前部署统一设置，适用于所有工作空间。
            {policy.independent_ledger
              ? '已启用独立删除与撤销记录。'
              : '尚未启用独立删除与撤销记录。'}
          </p>
          <p>
            删除单条内容请进入对应消息、文件或记忆。删除后会阻止继续读取，并清理相关缓存及派生正文。
          </p>
        </section>
      )}
    </main>
  );
}
