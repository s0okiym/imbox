import { useEffect, useState } from 'react';
import type {
  CreateTaskInput,
  CreateTaskRequestInput,
  RuntimeRun,
  Task,
  WorkProposal,
} from '@imbox/contracts';
import { ApiClient } from '../api.js';
import type { Session } from '../api.js';
import { ErrorNotice, Modal, Spinner } from '../components.js';
import { TaskApi } from './task-api.js';
import {
  CommandActions,
  Field,
  MemberPicker,
  requiredIds,
  useTaskCommand,
  useWorkspaceMembers,
} from './task-common.js';
import {
  decimalToMicrounits,
  formatMicrounits,
  futureLocalDate,
  localDeadline,
  REQUEST_KINDS,
  requiredLines,
  taskError,
} from './task-state.js';

interface FormEvents {
  readonly onClose: () => void;
  readonly refresh: () => void;
  readonly accessLost: (error: unknown) => void;
}
export function CreateTaskForm({
  api,
  client,
  session,
  onCreated,
  promotion,
  ...events
}: FormEvents & {
  readonly api: TaskApi;
  readonly client: ApiClient;
  readonly session: Session;
  readonly onCreated: (task: Task) => void;
  readonly promotion?: RuntimeRun;
}) {
  const [workspaceId, setWorkspaceId] = useState(session.workspaces[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [criteria, setCriteria] = useState('');
  const [reviewers, setReviewers] = useState<string[]>([session.principal.id]);
  const [currency, setCurrency] = useState('USD');
  const [budget, setBudget] = useState('');
  const [due, setDue] = useState('');
  const [deadline, setDeadline] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    setConfirmed(false);
  }, [promotion?.version]);
  const roster = useWorkspaceMembers(client, workspaceId);
  const command = useTaskCommand(
    { version: promotion?.version ?? '0' },
    events.refresh,
    events.accessLost,
  );
  const submit = async (): Promise<void> => {
    if (promotion && !confirmed) return;
    try {
      const input: CreateTaskInput = {
        workspace_id: workspaceId,
        title: title.trim(),
        goal: goal.trim(),
        acceptance_criteria: requiredLines(criteria),
        reviewer_principal_ids: requiredIds(reviewers),
        budget: { currency, limit_microunits: decimalToMicrounits(budget) },
        ...(due ? { due_at: localDeadline(due)! } : {}),
        ...(deadline ? { execution_deadline: localDeadline(deadline)! } : {}),
      };
      await command.run(input, async (_base, key, signal) => {
        const task = promotion
          ? await api.promote(promotion, input, key, signal)
          : await api.create(input, key, signal);
        if (!signal.aborted) onCreated(task);
      });
    } catch (error: unknown) {
      command.setError(taskError(error));
    }
  };
  return (
    <Modal
      title={promotion ? '把会话运行升级为新任务' : '新建任务'}
      onClose={() => {
        if (!command.busy) events.onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className="dialog-intro">你将成为任务负责人和最终责任人。先明确目标，再开始协作。</p>
        {promotion && (
          <p className="execution-note">
            来源运行 {promotion.id} · 版本 {promotion.version}
            。请明确填写新目标、验收人和预算；原回答不会自动成为新目标，原会话上下文和工具授权不会自动复制。
          </p>
        )}
        <Field label="工作空间">
          <select
            className="text-input"
            value={workspaceId}
            disabled={command.busy}
            onChange={(event) => {
              setWorkspaceId(event.target.value);
              setReviewers([session.principal.id]);
            }}
          >
            {session.workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="任务标题">
          <input
            className="text-input"
            required
            maxLength={200}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            disabled={command.busy}
          />
        </Field>
        <Field label="目标">
          <textarea
            className="text-input"
            required
            rows={3}
            maxLength={8000}
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            disabled={command.busy}
          />
        </Field>
        <Field label="验收标准" hint="每行一条，明确完成任务所需的结果。">
          <textarea
            className="text-input"
            required
            rows={3}
            maxLength={16000}
            value={criteria}
            onChange={(event) => setCriteria(event.target.value)}
            disabled={command.busy}
          />
        </Field>
        <fieldset className="task-fieldset">
          <legend>指定验收人</legend>
          <p className="small muted">这些成员可查看任务并决定验收；默认包含你自己。</p>
          {roster.loading ? (
            <Spinner />
          ) : (
            <MemberPicker
              members={roster.members}
              selected={reviewers}
              onChange={setReviewers}
              disabled={command.busy}
            />
          )}
          {roster.error !== null && <ErrorNotice>{roster.error}</ErrorNotice>}
        </fieldset>
        <div className="task-form-grid">
          <Field label="预算币种">
            <select
              className="text-input"
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
              disabled={command.busy}
            >
              <option>USD</option>
              <option>CNY</option>
              <option>EUR</option>
            </select>
          </Field>
          <Field label="预算上限" hint="允许为 0，最多 6 位小数。">
            <input
              className="text-input"
              required
              inputMode="decimal"
              value={budget}
              onChange={(event) => setBudget(event.target.value)}
              disabled={command.busy}
              placeholder="0.00"
            />
          </Field>
          <Field label="交付截止时间（可选）">
            <input
              className="text-input"
              type="datetime-local"
              value={due}
              onChange={(event) => setDue(event.target.value)}
              disabled={command.busy}
            />
          </Field>
          <Field label="执行截止时间（可选）">
            <input
              className="text-input"
              type="datetime-local"
              value={deadline}
              onChange={(event) => setDeadline(event.target.value)}
              disabled={command.busy}
            />
          </Field>
        </div>
        {promotion && (
          <label className="execution-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            我确认建立新的任务授权边界；后续 Agent 参与者、运行、上下文及工具权限需要分别明确授权。
          </label>
        )}
        <CommandActions
          command={command}
          label={promotion ? '创建独立任务' : '创建任务'}
          onClose={events.onClose}
          disabled={
            !workspaceId || roster.loading || reviewers.length === 0 || (!!promotion && !confirmed)
          }
        />
      </form>
    </Modal>
  );
}

export function ProposalForm({
  api,
  client,
  task,
  ...events
}: FormEvents & {
  readonly api: TaskApi;
  readonly client: ApiClient;
  readonly task: Task;
}) {
  const command = useTaskCommand(task, events.refresh, events.accessLost);
  const base = command.baseline;
  const roster = useWorkspaceMembers(client, task.workspace_id);
  const [kind, setKind] = useState<CreateTaskRequestInput['kind']>('handoff');
  const [recipient, setRecipient] = useState('');
  const [title, setTitle] = useState(task.title);
  const [goal, setGoal] = useState(task.goal);
  const [criteria, setCriteria] = useState(task.acceptance_criteria.join('\n'));
  const [reviewers, setReviewers] = useState<string[]>(task.reviewer_principal_ids);
  const [budget, setBudget] = useState(formatMicrounits(task.budget.limit_microunits));
  const [inputs, setInputs] = useState('');
  const [disclosure, setDisclosure] = useState('');
  const [completed, setCompleted] = useState('');
  const [pending, setPending] = useState('');
  const [expires, setExpires] = useState(() => futureLocalDate());
  const [due, setDue] = useState('');
  const [deadline, setDeadline] = useState('');
  const [escalation, setEscalation] = useState(task.accountable_principal_id);
  const handoff = kind === 'handoff';
  const submit = async (): Promise<void> => {
    try {
      const expiration = localDeadline(expires);
      if (expiration === undefined || Date.parse(expiration) <= Date.now())
        throw new Error('请设置未来的提案回应期限。');
      const proposal: WorkProposal = {
        title: handoff ? base.title : title.trim(),
        goal: handoff ? base.goal : goal.trim(),
        inputs: inputs.trim() ? [{ type: 'text', text: inputs.trim(), source_refs: [] }] : [],
        deliverable_schema: 'imbox.text-evidence.v1',
        acceptance: {
          criteria: handoff
            ? requiredLines(base.acceptance_criteria.join('\n'))
            : requiredLines(criteria),
          reviewer_principal_ids: requiredIds(handoff ? base.reviewer_principal_ids : reviewers),
        },
        budget: {
          currency: base.budget.currency,
          limit_microunits: handoff ? base.budget.limit_microunits : decimalToMicrounits(budget),
        },
        ...(due
          ? { due_at: localDeadline(due)! }
          : base.due_at === undefined
            ? {}
            : { due_at: base.due_at }),
        ...(deadline ? { execution_deadline: localDeadline(deadline)! } : {}),
        allowed_actions: [],
        disclosure: { scope: 'request_recipients', summary: disclosure.trim() },
        dependencies: [],
        cancellation_rule: 'owner_or_accountable',
        escalation_principal_id: escalation,
        ...(handoff
          ? {
              handoff: {
                completed_summary: completed.trim(),
                pending_summary: pending.trim(),
                pending_action_ids: [],
              },
            }
          : {}),
      };
      const input: CreateTaskRequestInput = {
        kind,
        recipient_principal_id: recipient,
        proposal,
        request_expires_at: expiration,
      };
      const done = await command.run(input, async (baseline, key, signal) => {
        await api.propose(baseline, input, key, signal);
      });
      if (done) {
        events.refresh();
        events.onClose();
      }
    } catch (error: unknown) {
      command.setError(taskError(error));
    }
  };
  return (
    <Modal
      title="发起协作提案"
      onClose={() => {
        if (!command.busy) events.onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className="dialog-intro">
          对方会先阅读这些明确条款，再决定是否接受。发送提案不会自动转移负责人或创建子任务。
        </p>
        <div className="task-form-grid">
          <Field label="协作方式">
            <select
              className="text-input"
              value={kind}
              onChange={(event) => setKind(event.target.value as CreateTaskRequestInput['kind'])}
              disabled={command.busy}
            >
              {Object.entries(REQUEST_KINDS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="收件人">
            <select
              className="text-input"
              required
              value={recipient}
              onChange={(event) => setRecipient(event.target.value)}
              disabled={command.busy || roster.loading}
            >
              <option value="">选择一位成员</option>
              {roster.members
                .filter((member) => member.principal.id !== task.owner_principal_id)
                .map(({ principal }) => (
                  <option key={principal.id} value={principal.id}>
                    {principal.display_name}
                  </option>
                ))}
            </select>
          </Field>
        </div>
        {roster.error !== null && <ErrorNotice>{roster.error}</ErrorNotice>}
        {handoff ? (
          <div className="proposal-fixed-terms">
            <strong>交接保持现有目标和验收约定</strong>
            <p>{base.goal}</p>
            <ul>
              {base.acceptance_criteria.map((criterion, index) => (
                <li key={index}>{criterion}</li>
              ))}
            </ul>
            <span>
              预算上限 {base.budget.currency} {formatMicrounits(base.budget.limit_microunits)}
              ；验收人保持不变。
            </span>
          </div>
        ) : (
          <>
            <Field label="提案标题">
              <input
                className="text-input"
                required
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={200}
                disabled={command.busy}
              />
            </Field>
            <Field label="提案目标">
              <textarea
                className="text-input"
                required
                rows={3}
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                maxLength={8000}
                disabled={command.busy}
              />
            </Field>
            <Field label="提案验收标准" hint="每行一条。">
              <textarea
                className="text-input"
                required
                rows={3}
                value={criteria}
                onChange={(event) => setCriteria(event.target.value)}
                disabled={command.busy}
              />
            </Field>
            <fieldset className="task-fieldset">
              <legend>提案验收人</legend>
              <MemberPicker
                members={roster.members}
                selected={reviewers}
                onChange={setReviewers}
                disabled={command.busy}
              />
            </fieldset>
            <Field
              label={`提案预算上限（${base.budget.currency}）`}
              hint={`不能超过主任务的 ${formatMicrounits(base.budget.limit_microunits)}。`}
            >
              <input
                className="text-input"
                required
                inputMode="decimal"
                value={budget}
                onChange={(event) => setBudget(event.target.value)}
                disabled={command.busy}
              />
            </Field>
          </>
        )}
        <Field
          label="共享输入（可选）"
          hint="仅这份提案明确写出的文本会提供给收件人，不会自动开放任务或其他资源。"
        >
          <textarea
            className="text-input"
            rows={3}
            value={inputs}
            onChange={(event) => setInputs(event.target.value)}
            maxLength={16000}
            disabled={command.busy}
          />
        </Field>
        <Field label="对收件人披露的说明">
          <textarea
            className="text-input"
            required
            rows={2}
            value={disclosure}
            onChange={(event) => setDisclosure(event.target.value)}
            maxLength={2000}
            disabled={command.busy}
          />
        </Field>
        {handoff && (
          <>
            <Field label="已完成内容">
              <textarea
                className="text-input"
                required
                rows={2}
                value={completed}
                onChange={(event) => setCompleted(event.target.value)}
                maxLength={4000}
                disabled={command.busy}
              />
            </Field>
            <Field label="待完成内容">
              <textarea
                className="text-input"
                required
                rows={2}
                value={pending}
                onChange={(event) => setPending(event.target.value)}
                maxLength={4000}
                disabled={command.busy}
              />
            </Field>
          </>
        )}
        <div className="task-form-grid">
          <Field label="提案回应期限">
            <input
              className="text-input"
              required
              type="datetime-local"
              value={expires}
              onChange={(event) => setExpires(event.target.value)}
              disabled={command.busy}
            />
          </Field>
          <Field label="交付截止时间（可选）">
            <input
              className="text-input"
              type="datetime-local"
              value={due}
              onChange={(event) => setDue(event.target.value)}
              disabled={command.busy}
            />
          </Field>
          <Field label="执行截止时间（可选）">
            <input
              className="text-input"
              type="datetime-local"
              value={deadline}
              onChange={(event) => setDeadline(event.target.value)}
              disabled={command.busy}
            />
          </Field>
          <Field label="升级求助联系人">
            <select
              className="text-input"
              required
              value={escalation}
              onChange={(event) => setEscalation(event.target.value)}
              disabled={command.busy}
            >
              {roster.members.map(({ principal }) => (
                <option key={principal.id} value={principal.id}>
                  {principal.display_name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <p className="small muted">
          交付形式为固定文字证据；负责人或最终责任人可取消任务。接受提案不会授予外部工具权限。
        </p>
        <CommandActions
          command={command}
          label="发送提案"
          onClose={events.onClose}
          disabled={!recipient || roster.loading}
        />
      </form>
    </Modal>
  );
}
