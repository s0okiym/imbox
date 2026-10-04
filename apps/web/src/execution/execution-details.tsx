import { useEffect, useState } from 'react';
import type {
  Action,
  CapabilityGrant,
  RuntimeContextManifest,
  RuntimeRun,
  Task,
} from '@imbox/contracts';
import type { Session } from '../api.js';
import { ApiError, isAccessLoss } from '../api.js';
import { ErrorNotice, fullTime, Icon, Modal, Spinner } from '../components.js';
import { Field } from '../tasks/task-common.js';
import { ExecutionApi } from './execution-api.js';
import { BudgetCard, Fact, Facts, SubmitActions, useExecutionCommand } from './execution-common.js';
import {
  ACTION_LABELS,
  actionControls,
  canApprove,
  executionError,
  RUN_LABELS,
  runControls,
} from './execution-state.js';

const CONTROL_LABELS = { pause: '暂停运行', resume: '继续运行', cancel: '取消运行' } as const;
export function RunDetail({
  api,
  run,
  session,
  onPromote,
  onOpenAction,
  onSchedule,
  onChanged,
  onBack,
  refresh,
  accessLost,
}: {
  readonly api: ExecutionApi;
  readonly run: RuntimeRun;
  readonly session: Session;
  readonly onPromote: () => void;
  readonly onOpenAction: (id: string) => void;
  readonly onSchedule: () => void;
  readonly onChanged: (run: RuntimeRun) => void;
  readonly onBack: () => void;
  readonly refresh: () => void;
  readonly accessLost: (error: unknown) => void;
}) {
  const [toolAction, setToolAction] = useState<Action | null>(null);
  const [toolError, setToolError] = useState<string | null>(null);
  const [manifest, setManifest] = useState<RuntimeContextManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [operation, setOperation] = useState<'pause' | 'resume' | 'cancel' | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setManifest(null);
    setError(null);
    void api
      .context(run.id, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setManifest(value);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) {
          setManifest(null);
          if (isAccessLoss(failure)) accessLost(failure);
          else setError(executionError(failure));
        }
      });
    return () => controller.abort();
  }, [api, run.id, run.version, accessLost]);
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    const load = async () => {
      if (busy || !run.tool_grant_id) return;
      busy = true;
      try {
        const item = await api.runToolIntent(run.id, controller.signal);
        if (!controller.signal.aborted) {
          setToolAction(item);
          setToolError(null);
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          setToolAction(null);
          if (failure instanceof ApiError && failure.status === 404) setToolError(null);
          else {
            setToolError(executionError(failure));
            if (isAccessLoss(failure)) accessLost(failure);
          }
        }
      } finally {
        busy = false;
      }
    };
    void load();
    const timer = setInterval(() => {
      void load();
    }, 3000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [api, run.id, run.tool_grant_id, accessLost]);
  return (
    <section className="task-detail" aria-label="运行详情">
      <header className="task-detail-header">
        <button className="icon-button" aria-label="返回运行列表" onClick={onBack}>
          <Icon name="back" />
        </button>
        <div>
          <span className="eyebrow">
            AGENT RUN ·{' '}
            {run.execution_location === 'hosted'
              ? '托管运行'
              : run.execution_location === 'device'
                ? '设备运行'
                : '外部运行'}
          </span>
          <h1>{RUN_LABELS[run.status]}</h1>
        </div>
        <button className="icon-button" aria-label="刷新运行" onClick={refresh}>
          <Icon name="refresh" />
        </button>
      </header>
      <div className="task-detail-scroll">
        <p className="execution-note">
          {run.report_source === 'external_report'
            ? '结果来源：外部 Agent 自报，尚不代表平台独立验证。'
            : '结果来源：平台运行记录。'}{' '}
          运行结束后，任务仍需独立提交和验收。
        </p>
        {(run.cancellation_requested || run.status === 'cancelled') && (
          <p className="execution-note" role="status">
            {run.cancellation_acknowledged_at
              ? `${run.execution_location === 'external' ? '远端 Agent 自报已停止（未独立验证）' : '执行器已确认停止'}：${fullTime(run.cancellation_acknowledged_at)}。`
              : run.execution_location === 'external'
                ? '尚无执行器停止确认；平台侧取消不代表远端进程已停止。'
                : '尚无执行器停止确认。'}
          </p>
        )}
        {run.pause_requested && run.status !== 'paused' && (
          <p className="execution-warning" role="status">
            已请求暂停，正在等待执行器到达安全停止点。
          </p>
        )}
        {run.cancellation_requested && run.status === 'cancelling' && (
          <p className="execution-warning" role="status">
            取消请求已记录，尚未确认停止。已经产生的外部效果需要单独核对。
          </p>
        )}
        <div className="task-action-row">
          {run.task_id &&
            run.status === 'paused' &&
            !run.tool_grant_id &&
            session.capabilities.includes('agents.schedules') && (
              <button className="button subtle" onClick={onSchedule}>
                设置定时唤醒
              </button>
            )}
          {run.conversation_id &&
            !run.task_id &&
            ['completed', 'failed', 'cancelled', 'expired'].includes(run.status) &&
            session.capabilities.includes('tasks.run_promotion') && (
              <button className="button primary" onClick={onPromote}>
                升级为独立任务
              </button>
            )}
          {runControls(run).map((control) => (
            <button
              key={control}
              className={`button ${control === 'cancel' ? 'subtle' : 'primary'}`}
              onClick={() => setOperation(control)}
            >
              {CONTROL_LABELS[control]}
            </button>
          ))}
        </div>
        {run.tool_grant_id && (
          <section className="task-section">
            <h2>关联工具行动</h2>
            <p className="execution-note">
              审批后仍需手动继续运行。结果未知时先核对原行动，不能通过重发来确认。
            </p>
            {toolError ? (
              <ErrorNotice>{toolError}</ErrorNotice>
            ) : toolAction ? (
              <>
                <p>{ACTION_LABELS[toolAction.status]}</p>
                <button className="button subtle" onClick={() => onOpenAction(toolAction.id)}>
                  查看并审批关联行动
                </button>
              </>
            ) : (
              <p>尚未提出工具行动。</p>
            )}
          </section>
        )}
        <BudgetCard budget={run.budget} label="运行预算" />
        <section className="task-section">
          <h2>运行结果</h2>
          <p className="task-prose">{run.summary || '尚未产生摘要。'}</p>
          {run.output !== null && <pre className="execution-output">{run.output}</pre>}
        </section>
        <section className="task-section">
          <h2>本次上下文清单</h2>
          {error ? (
            <ErrorNotice>{error}</ErrorNotice>
          ) : manifest === null ? (
            <Spinner />
          ) : (
            <>
              <Facts>
                <Fact label="处理目的">{manifest.purpose}</Fact>
                <Fact label="处理目的地">{manifest.destination}</Fact>
                <Fact label="输入数量">{manifest.items.length}</Fact>
                <Fact label="内容大小">{manifest.total_bytes} 字节</Fact>
              </Facts>
              <p className="execution-note">
                以下为创建运行时固定的输入版本。输入视为不可信内容，不会成为额外权限或系统指令。
              </p>
              {manifest.items.map((item) => (
                <article className="execution-context" key={item.ordinal}>
                  <h3>
                    {item.source_type === 'task' ? '任务' : '消息'} · 版本 {item.source_version} ·{' '}
                    {item.required ? '必需输入' : '可选输入'}
                  </h3>
                  <pre className="execution-output">
                    {Object.entries(item.payload)
                      .map(
                        ([key, value]) =>
                          `${key === 'body' ? '内容' : key === 'goal' ? '目标' : key === 'title' ? '标题' : key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
                      )
                      .join('\n')}
                  </pre>
                  <details>
                    <summary>来源与内容指纹</summary>
                    <code>{item.source_id}</code>
                    <code>{item.content_hash}</code>
                  </details>
                </article>
              ))}
            </>
          )}
        </section>
        <Facts>
          <Fact label="运行 ID">{run.id}</Fact>
          <Fact label="版本">{run.version}</Fact>
          <Fact label="Agent ID / 修订">
            {run.agent_id} / {run.agent_revision}
          </Fact>
          <Fact label="更新时间">{fullTime(run.updated_at)}</Fact>
        </Facts>
      </div>
      {operation && (
        <RunControlForm
          key={operation}
          api={api}
          run={run}
          operation={operation}
          onClose={() => setOperation(null)}
          onChanged={onChanged}
          refresh={refresh}
          accessLost={accessLost}
        />
      )}
    </section>
  );
}
function RunControlForm({
  api,
  run,
  operation,
  onClose,
  onChanged,
  refresh,
  accessLost,
}: {
  readonly api: ExecutionApi;
  readonly run: RuntimeRun;
  readonly operation: 'pause' | 'resume' | 'cancel';
  readonly onClose: () => void;
  readonly onChanged: (run: RuntimeRun) => void;
  readonly refresh: () => void;
  readonly accessLost: (error: unknown) => void;
}) {
  const command = useExecutionCommand(run.version, refresh, accessLost);
  const [confirmed, setConfirmed] = useState(false);
  return (
    <Modal title={CONTROL_LABELS[operation]} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void command.run({ operation }, async (key, signal) => {
            const next = await api.control(run, operation, key, signal);
            if (!signal.aborted) {
              onChanged(next);
              onClose();
            }
          });
        }}
      >
        <p className="execution-note">
          当前状态：{RUN_LABELS[run.status]}；版本 {run.version}。
          {operation === 'cancel'
            ? '取消不会撤销已经发生的外部行动，也不会取消整个任务。'
            : operation === 'pause'
              ? '正在执行时需要等待安全停止点，暂停请求不等于已经停止。'
              : '继续之前，服务端会重新检查权限、输入、任务状态和预算。'}
        </p>
        <label className="execution-confirm">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          我确认对这一运行提交上述控制。
        </label>
        <SubmitActions
          command={command}
          label={`确认${CONTROL_LABELS[operation]}`}
          onClose={onClose}
          disabled={!confirmed || !runControls(run).includes(operation)}
          onAdopt={() => setConfirmed(false)}
        />
      </form>
    </Modal>
  );
}

export function ActionDetail({
  api,
  action,
  grant,
  session,
  task,
  onChanged,
  onBack,
  refresh,
  accessLost,
}: {
  readonly api: ExecutionApi;
  readonly action: Action;
  readonly grant: CapabilityGrant | undefined;
  readonly session: Session;
  readonly task: Task | undefined;
  readonly onChanged: (action: Action) => void;
  readonly onBack: () => void;
  readonly refresh: () => void;
  readonly accessLost: (error: unknown) => void;
}) {
  const controls = actionControls(action, session.principal.id);
  const [operation, setOperation] = useState<
    'approve' | 'reject' | 'reconcile' | 'cancel' | 'revise' | null
  >(null);
  return (
    <section className="task-detail" aria-label="行动详情">
      <header className="task-detail-header">
        <button className="icon-button" aria-label="返回行动列表" onClick={onBack}>
          <Icon name="back" />
        </button>
        <div>
          <span className="eyebrow">EXPLICIT ACTION · {task?.title ?? '独立任务权限'}</span>
          <h1>{ACTION_LABELS[action.status]}</h1>
        </div>
        <button className="icon-button" aria-label="刷新行动" onClick={refresh}>
          <Icon name="refresh" />
        </button>
      </header>
      <div className="task-detail-scroll">
        {action.status === 'unknown' && (
          <div className="execution-warning" role="status">
            <strong>外部效果可能已经发生。</strong>
            <p>预算保持预占，任务不能验收。查询只核对已有业务去重键的结果，不再次发送行动。</p>
          </div>
        )}
        {action.status === 'ready' && (
          <p className="execution-note">审批已记录，等待受控执行器重新检查权限与预算后执行。</p>
        )}
        <ActionTerms action={action} />
        <section className="task-section">
          <h2>人工审批</h2>
          {action.approval ? (
            <Facts>
              <Fact label="审批状态">
                {
                  { pending: '待决定', approved: '已批准', rejected: '已拒绝', revoked: '已失效' }[
                    action.approval.status
                  ]
                }
              </Fact>
              <Fact label="绑定行动版本">{action.approval.action_version}</Fact>
              <Fact label="有效期">{fullTime(action.approval.expires_at)}</Fact>
              <Fact label="审批使用情况">
                {action.approval.consumed ? '已用于执行准入' : '尚未使用'}
              </Fact>
            </Facts>
          ) : (
            <p>此行动没有待处理的审批记录。</p>
          )}
          <div className="task-action-row">
            {canApprove(action, grant, session.principal) && (
              <>
                <button className="button primary" onClick={() => setOperation('approve')}>
                  核对并批准
                </button>
                <button className="button subtle" onClick={() => setOperation('reject')}>
                  拒绝此行动
                </button>
              </>
            )}
            {controls.reconcile && session.capabilities.includes('actions.reconciliation') && (
              <button className="button primary" onClick={() => setOperation('reconcile')}>
                查询外部结果
              </button>
            )}
            {controls.revise && (
              <button className="button subtle" onClick={() => setOperation('revise')}>
                修改行动参数
              </button>
            )}
            {controls.cancel && (
              <button className="button subtle" onClick={() => setOperation('cancel')}>
                取消此行动
              </button>
            )}
          </div>
        </section>
        <Facts>
          <Fact label="行动 ID">{action.id}</Fact>
          <Fact label="业务去重键">{action.business_key}</Fact>
          <Fact label="尝试次数">{action.attempt_count}</Fact>
          <Fact label="验收条件">
            {action.required ? '必须成功才能验收' : '非必要行动；未知结果仍会阻断验收'}
          </Fact>
        </Facts>
      </div>
      {operation && (
        <ActionDecisionForm
          key={operation}
          api={api}
          action={action}
          operation={operation}
          grant={grant}
          session={session}
          onClose={() => setOperation(null)}
          onChanged={onChanged}
          refresh={refresh}
          accessLost={accessLost}
        />
      )}
    </section>
  );
}
function ActionTerms({ action }: { readonly action: Action }) {
  return (
    <>
      <Facts>
        <Fact label="目标">{action.target_id}</Fact>
        <Fact label="工具 / 版本">
          {action.tool_id} / {action.tool_version}
        </Fact>
        <Fact label="执行者">{action.executor_id}</Fact>
        <Fact label="授权 / 修订">
          {action.grant_id} / {action.grant_revision}
        </Fact>
        <Fact label="当前行动版本">{action.version}</Fact>
        <Fact label="审批绑定版本">{action.approval_binding_version}</Fact>
      </Facts>
      <section className="task-section">
        <h2>将披露给目标的完整参数</h2>
        {action.content_restricted && (
          <ErrorNotice>来源已不可用，正文已隐藏；仍可核对既有外部结果。</ErrorNotice>
        )}
        <pre className="execution-output">{action.parameters.text}</pre>
        <details>
          <summary>固定资源版本与参数指纹</summary>
          {action.resource_versions.map((ref) => (
            <code key={ref.id}>
              {ref.type === 'task' ? '任务' : '产物固定版本'} {ref.id} · 版本 {ref.version}
              {ref.type === 'artifact_version' && ` · SHA-256 ${ref.sha256}`}
            </code>
          ))}
          <code>{action.fingerprint}</code>
        </details>
      </section>
      <BudgetCard budget={action.estimate} label="本次费用预估上限" />
    </>
  );
}
function ActionDecisionForm({
  api,
  action,
  operation,
  grant,
  session,
  onClose,
  onChanged,
  refresh,
  accessLost,
}: {
  readonly api: ExecutionApi;
  readonly action: Action;
  readonly operation: 'approve' | 'reject' | 'reconcile' | 'cancel' | 'revise';
  readonly grant: CapabilityGrant | undefined;
  readonly session: Session;
  readonly onClose: () => void;
  readonly onChanged: (action: Action) => void;
  readonly refresh: () => void;
  readonly accessLost: (error: unknown) => void;
}) {
  const command = useExecutionCommand(action.version, refresh, accessLost);
  const [reason, setReason] = useState('');
  const [text, setText] = useState(action.parameters.text);
  const [confirmed, setConfirmed] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const titles = {
    approve: '批准这一具体行动',
    reject: '拒绝这一具体行动',
    reconcile: '查询外部结果',
    cancel: '取消这一行动',
    revise: '修改行动参数',
  };
  const permitted =
    operation === 'approve' || operation === 'reject'
      ? canApprove(action, grant, session.principal)
      : actionControls(action, session.principal.id)[operation];
  return (
    <Modal title={titles[operation]} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!confirmed || !permitted) return;
          const body =
            operation === 'approve' || operation === 'reject'
              ? {
                  decision: operation,
                  action_version: action.approval_binding_version,
                  fingerprint: action.fingerprint,
                  comment: reason,
                }
              : operation === 'revise'
                ? { parameters: { text }, resource_versions: action.resource_versions }
                : { reason };
          void command.run({ operation, body }, async (key, signal) => {
            if (operation === 'reconcile') {
              const result = await api.reconcile(action, reason, key, signal);
              if (!signal.aborted) {
                onChanged(result.action);
                setOutcome(
                  {
                    succeeded: '已查询到成功回执，没有再次发送。',
                    no_effect: '已确认未产生效果；是否安全重试由受控执行器重新判断。',
                    unknown: '暂未取得确定结果，仍保持未知与预算预占。',
                    conflict: '回执存在冲突，保持隔离并等待核对。',
                  }[result.outcome],
                );
              }
              return;
            }
            const next =
              operation === 'approve' || operation === 'reject'
                ? await api.decide(
                    action,
                    {
                      decision: operation,
                      action_version: action.approval_binding_version,
                      fingerprint: action.fingerprint,
                      comment: reason,
                    },
                    key,
                    signal,
                  )
                : operation === 'revise'
                  ? await api.revise(
                      action,
                      { parameters: { text }, resource_versions: action.resource_versions },
                      key,
                      signal,
                    )
                  : await api.cancel(action, reason, key, signal);
            if (!signal.aborted) {
              onChanged(next);
              onClose();
            }
          });
        }}
      >
        {operation === 'approve' || operation === 'reject' ? (
          <ActionTerms action={action} />
        ) : (
          <p className="execution-note">
            目标：{action.target_id}；行动版本 {action.version}。
            {operation === 'reconcile'
              ? '这只查询已经记录的外部结果，不会再次发送。'
              : operation === 'revise'
                ? '修改后旧批准失效，需要重新审批。'
                : '取消不会撤销已经发生的外部效果。'}
          </p>
        )}
        {outcome && (
          <p role="status" className="execution-result">
            {outcome}
          </p>
        )}
        {operation === 'revise' ? (
          <Field label="新的完整行动参数">
            <textarea
              className="text-input"
              required
              maxLength={4000}
              rows={5}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setConfirmed(false);
              }}
            />
          </Field>
        ) : (
          <Field label={operation === 'reconcile' ? '查询理由' : '决定说明'}>
            <textarea
              className="text-input"
              required
              maxLength={2000}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
        )}
        <label className="execution-confirm">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          {operation === 'approve'
            ? '我已逐项核对参数、目标、资源版本、授权与费用，同意这一具体行动。'
            : '我已核对当前行动及本次操作。'}
        </label>
        <SubmitActions
          command={command}
          label={operation === 'reconcile' ? '仅查询已有结果' : '提交明确决定'}
          onClose={onClose}
          disabled={!confirmed || !permitted || outcome !== null}
          onAdopt={() => {
            setConfirmed(false);
            setOutcome(null);
          }}
        />
      </form>
    </Modal>
  );
}

export function GrantDetail({
  api,
  grant,
  session,
  onChanged,
  onBack,
  onPropose,
  refresh,
  accessLost,
}: {
  readonly api: ExecutionApi;
  readonly grant: CapabilityGrant;
  readonly session: Session;
  readonly onChanged: (grant: CapabilityGrant) => void;
  readonly onBack: () => void;
  readonly onPropose: () => void;
  readonly refresh: () => void;
  readonly accessLost: (error: unknown) => void;
}) {
  const [revoking, setRevoking] = useState(false);
  const [reason, setReason] = useState('');
  const command = useExecutionCommand(grant.revision, refresh, accessLost);
  const active = grant.status === 'active' && new Date(grant.expires_at).getTime() > Date.now();
  return (
    <section className="task-detail" aria-label="授权详情">
      <header className="task-detail-header">
        <button className="icon-button" aria-label="返回授权列表" onClick={onBack}>
          <Icon name="back" />
        </button>
        <div>
          <span className="eyebrow">
            CAPABILITY GRANT ·{' '}
            {grant.status === 'revoked' ? '已撤销' : active ? '有效期内' : '已过期'}
          </span>
          <h1>
            {grant.tool_id} → {grant.target_id}
          </h1>
        </div>
      </header>
      <div className="task-detail-scroll">
        <p className="execution-note">
          读取本授权不代表获得执行权。每次执行会重新检查任务权限、有效期、审批和预算。
        </p>
        <Facts>
          <Fact label="任务">{grant.task_id}</Fact>
          <Fact label="执行者">{grant.executor_principal_id}</Fact>
          <Fact label="签发者">{grant.issued_by}</Fact>
          <Fact label="授权修订">{grant.revision}</Fact>
          <Fact label="允许执行">{grant.allow_execute ? '是' : '否'}</Fact>
          <Fact label="允许披露">{grant.allow_disclosure ? '是' : '否'}</Fact>
          <Fact label="到期时间">{fullTime(grant.expires_at)}</Fact>
          <Fact label="指定审批者">{grant.approver_principal_ids.join('、')}</Fact>
        </Facts>
        <BudgetCard budget={grant.budget} label="授权预算" />
        <section className="task-section">
          <h2>固定资源范围</h2>
          {grant.resource_versions.map((ref) => (
            <p className="execution-note" key={ref.id}>
              {ref.type === 'task' ? '任务' : '产物固定版本'} {ref.id} · 版本 {ref.version}
              {ref.type === 'artifact_version' && ` · SHA-256 ${ref.sha256}`}
            </p>
          ))}
        </section>
        <div className="task-action-row">
          {active && (
            <button className="button primary" onClick={onPropose}>
              使用此授权提出行动
            </button>
          )}
          {active &&
            session.principal.kind === 'human' &&
            grant.issued_by === session.principal.id && (
              <button className="button subtle" onClick={() => setRevoking(true)}>
                撤销此授权
              </button>
            )}
        </div>
      </div>
      {revoking && (
        <Modal title="撤销工具授权" onClose={() => setRevoking(false)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void command.run({ reason }, async (key, signal) => {
                const next = await api.revoke(grant, reason, key, signal);
                if (!signal.aborted) {
                  onChanged(next);
                  setRevoking(false);
                }
              });
            }}
          >
            <p className="execution-note">
              撤销后不能以此授权发起新效果；已产生或结果未知的效果仍需核对。
            </p>
            <Field label="撤销理由">
              <textarea
                className="text-input"
                required
                maxLength={2000}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
            <SubmitActions
              command={command}
              label="确认撤销授权"
              onClose={() => setRevoking(false)}
            />
          </form>
        </Modal>
      )}
    </section>
  );
}
