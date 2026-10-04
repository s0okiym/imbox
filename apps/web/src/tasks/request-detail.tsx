import { useState } from 'react';
import type {
  CollaborationRequest,
  RequestDecisionInput,
  RequestDecisionResult,
} from '@imbox/contracts';
import type { Member, Session } from '../api.js';
import { ErrorNotice, fullTime, Icon } from '../components.js';
import { TaskApi } from './task-api.js';
import { Field, MemberName, useTaskCommand } from './task-common.js';
import { formatMicrounits, REQUEST_KINDS, REQUEST_LABELS } from './task-state.js';

const ACCEPTANCE_EFFECT: Record<CollaborationRequest['kind'], string> = {
  handoff: '接受后，我将成为此任务的负责人；原负责人停止执行。',
  delegate: '接受后，将创建由我负责的子任务；父任务负责人保持不变，不会因此开放父任务权限。',
  consult: '接受后，我将成为此任务的协作者并获得任务查看权限。',
  review: '接受后，我将获得任务评审访问权限；最终验收仍须符合指定验收人约定。',
};
export function RequestDetail({
  api,
  request,
  session,
  members,
  refresh,
  accessLost,
  onChanged,
  onDecision,
  onOpenTask,
  acceptedTaskId,
  onBack,
}: {
  readonly api: TaskApi;
  readonly request: CollaborationRequest;
  readonly session: Session;
  readonly members: readonly Member[];
  readonly refresh: () => void;
  readonly accessLost: (error: unknown) => void;
  readonly onChanged: (request: CollaborationRequest) => void;
  readonly onDecision: (result: RequestDecisionResult) => void;
  readonly onOpenTask: (id?: string) => void;
  readonly acceptedTaskId?: string;
  readonly onBack: () => void;
}) {
  const command = useTaskCommand(request, refresh, accessLost);
  const [comment, setComment] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const recipient = request.recipient_id === session.principal.id;
  const pending =
    request.status === 'pending' && Date.parse(request.request_expires_at) > Date.now();
  const withdrawable = request.status === 'pending' || request.status === 'clarification_requested';
  const p = request.proposal;
  const decide = async (decision: RequestDecisionInput['decision']): Promise<void> => {
    if ((decision === 'accept' && !confirmed) || (decision === 'clarify' && !comment.trim()))
      return;
    const base = command.baseline;
    const input: RequestDecisionInput = {
      decision,
      proposal_version: base.proposal_version,
      expected_task_version: base.expected_task_version,
      ...(comment.trim() ? { comment: comment.trim() } : {}),
    };
    await command.run(input, async (baseline, key, signal) => {
      const result = await api.decide(baseline, input, key, signal);
      if (!signal.aborted) {
        setConfirmed(false);
        onDecision(result);
        refresh();
      }
    });
  };
  const withdraw = async (): Promise<void> => {
    if (!comment.trim()) return;
    await command.run({ withdraw: comment.trim() }, async (base, key, signal) => {
      const updated = await api.withdraw(base, comment.trim(), key, signal);
      if (!signal.aborted) {
        onChanged(updated);
        refresh();
      }
    });
  };
  const staleNotice = command.stale && (
    <div className="task-conflict" role="alert">
      <p>提案状态或版本已经改变，请重新阅读以上条款后再回应。</p>
      <button
        className="text-button"
        onClick={() => {
          command.adoptLatest();
          setConfirmed(false);
        }}
      >
        已阅读，核对最新版本
      </button>
    </div>
  );
  return (
    <section className="task-detail" aria-label="协作提案详情">
      <header className="task-detail-header">
        <button
          className="icon-button task-mobile-back"
          onClick={onBack}
          aria-label="返回协作请求列表"
        >
          <Icon name="back" />
        </button>
        <div>
          <span className="eyebrow">
            {recipient ? '收到的提案' : '发出的提案'} · {REQUEST_KINDS[request.kind]}
          </span>
          <h1>{p.title}</h1>
        </div>
        <span className={`task-status request-${request.status}`}>
          {REQUEST_LABELS[request.status]}
        </span>
      </header>
      <div className="task-detail-scroll">
        {request.received_at && (
          <p className="task-note" role="status">
            Agent 已接收此版本 · {fullTime(request.received_at)}。
            {request.status === 'accepted'
              ? '已另行明确接受提案。'
              : request.status === 'pending'
                ? '尚未接受；接收确认不改变负责人或任务权限。'
                : `当前提案${REQUEST_LABELS[request.status]}；接收确认与协作决定分别记录。`}
          </p>
        )}
        <div className="proposal-disclosure">
          <Icon name="info" size={18} />
          <div>
            <strong>本页展示发起人明确提供的协作条款。</strong>
            <p>查看这份提案，不代表获得完整任务或其他资源的访问权。</p>
          </div>
        </div>
        <div className="task-owner-grid">
          <div>
            <span>发起人</span>
            <strong>
              <MemberName id={request.proposer_id} members={members} />
            </strong>
          </div>
          <div>
            <span>收件人</span>
            <strong>
              <MemberName id={request.recipient_id} members={members} />
            </strong>
          </div>
          <div>
            <span>回应期限</span>
            <strong>{fullTime(request.request_expires_at)}</strong>
          </div>
          <div>
            <span>预算上限</span>
            <strong>
              {p.budget.currency} {formatMicrounits(p.budget.limit_microunits)}
            </strong>
          </div>
        </div>
        <section className="task-section">
          <h2>目标与披露范围</h2>
          <p className="task-prose">{p.goal}</p>
          <div className="proposal-fixed-terms">
            <strong>发起人的披露说明</strong>
            <p>{p.disclosure.summary}</p>
          </div>
        </section>
        <section className="task-section">
          <h2>明确共享的输入</h2>
          {p.inputs.length === 0 ? (
            <p className="muted">未附加输入材料。</p>
          ) : (
            p.inputs.map((input, index) => (
              <div className="submission-evidence" key={index}>
                {input.type === 'text' ? (
                  <>
                    <p>{input.text}</p>
                    {input.source_refs.length > 0 && (
                      <p className="small muted">
                        来源引用（不代表授予来源权限）：
                        {input.source_refs
                          .map((source) => `${source.id} · v${source.version}`)
                          .join('；')}
                      </p>
                    )}
                  </>
                ) : (
                  <p>制品版本引用 {input.version_id}</p>
                )}
              </div>
            ))
          )}
        </section>
        <section className="task-section">
          <h2>交付与验收</h2>
          <p className="small muted">交付形式：固定文字证据</p>
          <ol>
            {p.acceptance.criteria.map((criterion, index) => (
              <li key={index}>{criterion}</li>
            ))}
          </ol>
          <div className="task-reviewers">
            <span>指定验收人</span>
            {p.acceptance.reviewer_principal_ids.map((id) => (
              <MemberName key={id} id={id} members={members} />
            ))}
          </div>
          <p className="small">
            交付期限：{p.due_at === undefined ? '未设置' : fullTime(p.due_at)}
            <br />
            执行截止：
            {p.execution_deadline === undefined ? '未设置' : fullTime(p.execution_deadline)}
          </p>
        </section>
        {p.handoff !== undefined && (
          <section className="task-section">
            <h2>交接说明</h2>
            <h3>已完成内容</h3>
            <p className="task-prose">{p.handoff.completed_summary || '无'}</p>
            <h3>待完成内容</h3>
            <p className="task-prose">{p.handoff.pending_summary || '无'}</p>
            <h3>提案列出的待处理行动</h3>
            <p>
              共 {p.handoff.pending_action_ids.length} 项；这是发起时的清单，行动结果可能继续变化。
            </p>
            <ul aria-label="提案行动编号">
              {p.handoff.pending_action_ids.map((id) => (
                <li key={id}>{id}</li>
              ))}
            </ul>
            <p className="small muted">
              接管后，请到“行动”中核对仍在执行或结果未知的外部行动。交接不会撤销已经发出的操作。
            </p>
          </section>
        )}
        <section className="task-section">
          <h2>协作边界</h2>
          <p>
            负责人或最终责任人可取消任务；需要升级求助时联系{' '}
            <MemberName id={p.escalation_principal_id} members={members} />。
          </p>
          <p className="small muted">
            本提案不授予外部工具或凭证权限。
            {p.dependencies.length === 0
              ? '未指定前置任务。'
              : `前置任务引用：${p.dependencies.join('、')}（引用不授予查看权）。`}
          </p>
        </section>
        {recipient && pending && (
          <section className="request-decision-panel">
            <h2>明确回应这份提案</h2>
            <p>{ACCEPTANCE_EFFECT[request.kind]}</p>
            <Field label="回应说明（请求澄清时必填）">
              <textarea
                className="text-input"
                rows={3}
                maxLength={2000}
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                disabled={command.busy}
              />
            </Field>
            <label className="task-confirmation">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                disabled={command.busy}
              />
              我已阅读目标、输入、预算、期限和验收规则，愿意按此版本接受。
            </label>
            {staleNotice}
            {command.error !== null && <ErrorNotice>{command.error}</ErrorNotice>}
            <div className="task-action-row">
              <button
                className="button primary"
                disabled={!confirmed || command.busy || command.stale}
                onClick={() => {
                  void decide('accept');
                }}
              >
                明确接受提案
              </button>
              <button
                className="button subtle"
                disabled={!comment.trim() || command.busy || command.stale}
                onClick={() => {
                  void decide('clarify');
                }}
              >
                请求澄清
              </button>
              <button
                className="text-button danger-text"
                disabled={command.busy || command.stale}
                onClick={() => {
                  void decide('reject');
                }}
              >
                拒绝提案
              </button>
            </div>
          </section>
        )}
        {recipient && request.status === 'clarification_requested' && (
          <p className="task-note">已请求澄清。请等待发起人修订条款，再阅读并决定是否接受。</p>
        )}
        {!recipient && withdrawable && (
          <section className="request-decision-panel">
            <h2>撤回提案</h2>
            <p className="small muted">撤回只结束这份尚未接受的提案，不改变任务负责人。</p>
            <Field label="撤回原因">
              <textarea
                className="text-input"
                rows={2}
                maxLength={2000}
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                disabled={command.busy}
              />
            </Field>
            {staleNotice}
            {command.error !== null && <ErrorNotice>{command.error}</ErrorNotice>}
            <button
              className="button subtle"
              disabled={!comment.trim() || command.busy || command.stale}
              onClick={() => {
                void withdraw();
              }}
            >
              确认撤回提案
            </button>
          </section>
        )}
        {request.status === 'accepted' && (
          <div className="task-note">
            <strong>提案已被明确接受。</strong>
            <p>{ACCEPTANCE_EFFECT[request.kind]}</p>
            <button
              className="button primary"
              onClick={() =>
                onOpenTask(
                  acceptedTaskId ?? (request.kind === 'delegate' ? undefined : request.task_id),
                )
              }
            >
              {request.kind === 'delegate' && acceptedTaskId === undefined
                ? '到任务列表查看子任务'
                : '打开已获授权的任务'}
            </button>
          </div>
        )}
        <p className="task-audit-note">
          提案版本 {request.proposal_version} · 请求版本 {request.version}
          <br />
          只针对已展示的明确条款作出回应；聊天已读和传输确认不会接受提案。
        </p>
      </div>
    </section>
  );
}
