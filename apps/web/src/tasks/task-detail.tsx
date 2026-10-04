import { useEffect, useMemo, useState } from 'react';
import type { Submission, Task, TaskParticipantPage, TaskReview } from '@imbox/contracts';
import { ApiClient, isAccessLoss } from '../api.js';
import type { Session } from '../api.js';
import { ErrorNotice, fullTime, Icon, Spinner } from '../components.js';
import { TaskApi } from './task-api.js';
import { MemberName, TaskStatus, useWorkspaceMembers } from './task-common.js';
import { ProposalForm } from './task-forms.js';
import { LifecycleForm, ParticipantForm, ReviewForm, SubmissionForm } from './task-actions.js';
import type { LifecycleAction } from './task-actions.js';
import { formatMicrounits, taskError, terminalTask } from './task-state.js';
import { ResourceApi } from '../resources/resource-api.js';
import { ArtifactEvidenceViewer } from '../resources/artifact-evidence.js';
import { RunOrigin } from './run-origin.js';

type OpenForm =
  | { kind: 'proposal' | 'participants' | 'submission' }
  | { kind: 'review'; submission: Submission }
  | { kind: 'lifecycle'; action: LifecycleAction };
export function TaskDetail({
  api,
  client,
  task,
  session,
  refresh,
  accessLost,
  onBack,
  onOpenRun,
}: {
  readonly api: TaskApi;
  readonly client: ApiClient;
  readonly task: Task;
  readonly session: Session;
  readonly refresh: () => void;
  readonly accessLost: (error: unknown) => void;
  readonly onBack: () => void;
  readonly onOpenRun: (id: string) => void;
}) {
  const roster = useWorkspaceMembers(client, task.workspace_id);
  const resourceApi = useMemo(
    () => new ResourceApi(session.tenant_id, session.csrf_token),
    [session.tenant_id, session.csrf_token],
  );
  const [participants, setParticipants] = useState<TaskParticipantPage['items']>([]);
  const [submissions, setSubmissions] = useState<readonly Submission[]>([]);
  const [reviews, setReviews] = useState<readonly TaskReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<OpenForm | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void Promise.all([
      api.participants(task.id, controller.signal),
      api.submissions(task.id, controller.signal),
      api.reviews(task.id, controller.signal),
    ])
      .then(([people, results, decisions]) => {
        if (controller.signal.aborted) return;
        setParticipants(people.items);
        setSubmissions(results.items);
        setReviews(decisions.items);
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        if (isAccessLoss(failure)) {
          setParticipants([]);
          setSubmissions([]);
          setReviews([]);
          accessLost(failure);
        } else setError(taskError(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, task.id, task.version, task.authz_generation, revision, accessLost]);
  const owner = task.owner_principal_id === session.principal.id;
  const accountable = task.accountable_principal_id === session.principal.id;
  const role = participants.find((person) => person.principal_id === session.principal.id)?.role;
  const admin = session.workspaces.some(
    (workspace) => workspace.id === task.workspace_id && workspace.role === 'admin',
  );
  const ended = terminalTask(task);
  const maySubmit = task.status === 'active' && (role === 'owner' || role === 'contributor');
  const mayReview =
    task.status === 'in_review' &&
    task.reviewer_principal_ids.includes(session.principal.id) &&
    (role === 'owner' || role === 'reviewer');
  const refreshAll = (): void => {
    setRevision((value) => value + 1);
    refresh();
  };
  const actions = {
    api,
    client,
    task,
    refresh: refreshAll,
    accessLost,
    onClose: () => setForm(null),
  };
  return (
    <section className="task-detail" aria-label="任务详情">
      <header className="task-detail-header">
        <button className="icon-button task-mobile-back" onClick={onBack} aria-label="返回任务列表">
          <Icon name="back" />
        </button>
        <div>
          <span className="eyebrow">TASK · 明确目标，共同完成</span>
          <h1>{task.title}</h1>
        </div>
        <TaskStatus task={task} />
      </header>
      <div className="task-detail-scroll">
        {session.capabilities.includes('tasks.run_promotion') && (
          <RunOrigin api={api} taskId={task.id} accessLost={accessLost} onOpenRun={onOpenRun} />
        )}
        <div className="task-owner-grid">
          <div>
            <span>负责人 · 执行与协调</span>
            <strong>
              <MemberName id={task.owner_principal_id} members={roster.members} />
            </strong>
          </div>
          <div>
            <span>最终责任人 · 结果责任</span>
            <strong>
              <MemberName id={task.accountable_principal_id} members={roster.members} />
            </strong>
          </div>
          <div>
            <span>交付期限</span>
            <strong>{task.due_at === undefined ? '未设置' : fullTime(task.due_at)}</strong>
          </div>
          <div>
            <span>预算上限</span>
            <strong>
              {task.budget.currency} {formatMicrounits(task.budget.limit_microunits)}
            </strong>
            <small>
              已用 {formatMicrounits(task.budget.spent_microunits)} · 已预占{' '}
              {formatMicrounits(task.budget.reserved_microunits)}
            </small>
          </div>
        </div>
        <section className="task-section">
          <h2>目标</h2>
          <p className="task-prose">{task.goal}</p>
        </section>
        <section className="task-section">
          <h2>验收约定</h2>
          <ol>
            {task.acceptance_criteria.map((criterion, index) => (
              <li key={index}>{criterion}</li>
            ))}
          </ol>
          <div className="task-reviewers">
            <span>指定验收人</span>
            {task.reviewer_principal_ids.map((id) => (
              <MemberName key={id} id={id} members={roster.members} />
            ))}
          </div>
        </section>
        <div className="task-action-row" aria-label="任务操作">
          {owner && task.status === 'open' && (
            <button
              className="button primary"
              onClick={() => setForm({ kind: 'lifecycle', action: 'active' })}
            >
              开始任务
            </button>
          )}
          {owner && task.status === 'blocked' && (
            <button
              className="button primary"
              onClick={() => setForm({ kind: 'lifecycle', action: 'resume' })}
            >
              恢复任务
            </button>
          )}
          {maySubmit && (
            <button className="button primary" onClick={() => setForm({ kind: 'submission' })}>
              提交结果与证据
            </button>
          )}
          {owner && !ended && (
            <button className="button subtle" onClick={() => setForm({ kind: 'proposal' })}>
              发起协作提案
            </button>
          )}
          {owner && !ended && task.status !== 'blocked' && (
            <button
              className="button subtle"
              onClick={() => setForm({ kind: 'lifecycle', action: 'blocked' })}
            >
              标记受阻
            </button>
          )}
          {owner && ended && (
            <button
              className="button subtle"
              onClick={() => setForm({ kind: 'lifecycle', action: 'reopen' })}
            >
              重新打开任务
            </button>
          )}
          {(owner || accountable) && !ended && (
            <button
              className="text-button danger-text"
              onClick={() => setForm({ kind: 'lifecycle', action: 'cancel' })}
            >
              取消任务
            </button>
          )}
          {owner && !ended && (
            <button
              className="text-button danger-text"
              onClick={() => setForm({ kind: 'lifecycle', action: 'failed' })}
            >
              结束为失败
            </button>
          )}
          {admin && !owner && !ended && (
            <button
              className="text-button danger-text"
              onClick={() => setForm({ kind: 'lifecycle', action: 'takeover' })}
            >
              管理员接管
            </button>
          )}
        </div>
        {error !== null && <ErrorNotice>{error}</ErrorNotice>}
        <section className="task-section">
          <div className="task-section-title">
            <h2>参与者</h2>
            {owner && !ended && (
              <button className="text-button" onClick={() => setForm({ kind: 'participants' })}>
                管理权限
              </button>
            )}
          </div>
          <ul className="task-participants">
            {participants.map((person) => (
              <li key={person.principal_id}>
                <MemberName id={person.principal_id} members={roster.members} />
                <span>
                  {
                    {
                      owner: '负责人',
                      contributor: '协作者',
                      reviewer: '验收人',
                      observer: '观察者',
                    }[person.role]
                  }
                </span>
              </li>
            ))}
          </ul>
        </section>
        <section className="task-section">
          <h2>提交与验收</h2>
          {loading && <Spinner label="正在同步任务记录…" />}
          {!loading && submissions.length === 0 && (
            <p className="muted">还没有提交。开始任务后，负责人或协作者可提交固定文字证据。</p>
          )}
          {[...submissions].reverse().map((submission) => {
            const review = reviews.find((item) => item.submission_id === submission.id);
            const current =
              submission.goal_version === task.goal_version &&
              submission.execution_epoch === task.execution_epoch;
            return (
              <article className="submission-card" key={submission.id}>
                <div className="submission-heading">
                  <strong>{submission.summary}</strong>
                  <span>{fullTime(submission.created_at)}</span>
                </div>
                <p className="small muted">
                  提交者 <MemberName id={submission.submitted_by} members={roster.members} />
                  {current ? '' : ' · 历史提交'}
                </p>
                {submission.evidence.map((evidence) => (
                  <div
                    className="submission-evidence"
                    key={evidence.type === 'text' ? evidence.id : evidence.version_id}
                  >
                    {evidence.type === 'text' ? (
                      <p>{evidence.text}</p>
                    ) : (
                      <ArtifactEvidenceViewer api={resourceApi} evidence={evidence} />
                    )}
                    <details>
                      <summary>查看证据校验记录</summary>
                      <code>{evidence.sha256}</code>
                    </details>
                  </div>
                ))}
                {review !== undefined ? (
                  <div className={`review-result ${review.decision}`}>
                    <strong>{review.decision === 'accept' ? '通过验收' : '退回修改'}</strong>
                    <p>{review.comment}</p>
                    <small>
                      <MemberName id={review.reviewer_id} members={roster.members} /> ·{' '}
                      {fullTime(review.created_at)}
                    </small>
                  </div>
                ) : mayReview && current ? (
                  <button
                    className="button primary"
                    onClick={() => setForm({ kind: 'review', submission })}
                  >
                    验收这次提交
                  </button>
                ) : (
                  <p className="small muted">
                    {current ? '等待指定验收人作出决定。' : '此记录不用于当前一轮验收。'}
                  </p>
                )}
              </article>
            );
          })}
        </section>
        <p className="task-audit-note">
          任务 {task.id} · 版本 {task.version} · 目标版本 {task.goal_version}
          <br />
          {task.parent_task_id === undefined ? '根任务' : `子任务 · 父任务 ${task.parent_task_id}`}
        </p>
      </div>
      {form?.kind === 'proposal' && <ProposalForm {...actions} />}
      {form?.kind === 'participants' && <ParticipantForm {...actions} />}
      {form?.kind === 'submission' && <SubmissionForm {...actions} session={session} />}
      {form?.kind === 'review' && (
        <ReviewForm {...actions} session={session} submission={form.submission} />
      )}
      {form?.kind === 'lifecycle' && <LifecycleForm {...actions} action={form.action} />}
    </section>
  );
}
