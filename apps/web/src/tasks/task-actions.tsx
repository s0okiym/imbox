import { useMemo, useState } from 'react';
import type {
  ArtifactEvidenceRef,
  EvidenceInput,
  Submission,
  SubmissionInput,
  Task,
  TaskParticipantInput,
  TaskReviewInput,
  TaskStateInput,
} from '@imbox/contracts';
import { ApiClient } from '../api.js';
import type { Session } from '../api.js';
import { ResourceApi } from '../resources/resource-api.js';
import { ArtifactEvidencePicker, ArtifactEvidenceViewer } from '../resources/artifact-evidence.js';
import { ErrorNotice, Modal } from '../components.js';
import { TaskApi } from './task-api.js';
import { CommandActions, Field, useTaskCommand, useWorkspaceMembers } from './task-common.js';
import { requiredLines, taskError } from './task-state.js';

interface ActionProps {
  readonly api: TaskApi;
  readonly task: Task;
  readonly onClose: () => void;
  readonly refresh: () => void;
  readonly accessLost: (error: unknown) => void;
}
export type LifecycleAction =
  'active' | 'blocked' | 'resume' | 'failed' | 'cancel' | 'reopen' | 'takeover';
const ACTION_LABELS: Record<LifecycleAction, string> = {
  active: '开始任务',
  blocked: '标记受阻',
  resume: '恢复任务',
  failed: '结束为失败',
  cancel: '取消任务',
  reopen: '重新打开任务',
  takeover: '管理员接管',
};
export function LifecycleForm({
  api,
  task,
  action,
  ...events
}: ActionProps & { readonly action: LifecycleAction }) {
  const command = useTaskCommand(task, events.refresh, events.accessLost);
  const [reason, setReason] = useState('');
  const [criteria, setCriteria] = useState(task.acceptance_criteria.join('\n'));
  const submit = async (): Promise<void> => {
    try {
      const input =
        action === 'reopen'
          ? { reason: reason.trim(), acceptance_criteria: requiredLines(criteria) }
          : { reason: reason.trim() };
      const done = await command.run({ action, ...input }, async (base, key, signal) => {
        if (action === 'cancel' || action === 'reopen' || action === 'takeover')
          await api.lifecycle(base, action, input, key, signal);
        else
          await api.state(
            base,
            { state: action, reason: reason.trim() } satisfies TaskStateInput,
            key,
            signal,
          );
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
      title={ACTION_LABELS[action]}
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
          {action === 'takeover'
            ? '你将成为新的负责人。原负责人会失去执行权，接管原因会被记录。'
            : action === 'reopen'
              ? '重新确认验收标准后启动新一轮任务；旧执行、旧提案和旧提交不会自动恢复。'
              : action === 'cancel' || action === 'failed'
                ? '结束任务会阻止继续执行；已有协作决定和证据会保留。'
                : `请确认将“${task.title}”${ACTION_LABELS[action]}。`}
        </p>
        <Field label="操作理由">
          <textarea
            className="text-input"
            required
            rows={3}
            maxLength={2000}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            disabled={command.busy}
          />
        </Field>
        {action === 'reopen' && (
          <Field label="重新确认验收标准">
            <textarea
              className="text-input"
              required
              rows={4}
              value={criteria}
              onChange={(event) => setCriteria(event.target.value)}
              disabled={command.busy}
            />
          </Field>
        )}
        <CommandActions
          command={command}
          label={`确认${ACTION_LABELS[action]}`}
          onClose={events.onClose}
          disabled={!reason.trim()}
        />
      </form>
    </Modal>
  );
}
export function SubmissionForm({
  api,
  task,
  session,
  ...events
}: ActionProps & { readonly session: Session }) {
  const command = useTaskCommand(task, events.refresh, events.accessLost);
  const [summary, setSummary] = useState('');
  const [evidence, setEvidence] = useState('');
  const [artifacts, setArtifacts] = useState<ArtifactEvidenceRef[]>([]);
  const resourceApi = useMemo(
    () => new ResourceApi(session.tenant_id, session.csrf_token),
    [session.tenant_id, session.csrf_token],
  );
  const submit = async (): Promise<void> => {
    const items: EvidenceInput[] = [
      ...(evidence.trim()
        ? [{ type: 'text' as const, text: evidence.trim(), source_refs: [] }]
        : []),
      ...artifacts,
    ];
    if (!items[0]) return;
    const input: SubmissionInput = {
      goal_version: command.baseline.goal_version,
      summary: summary.trim(),
      evidence: [items[0], ...items.slice(1)],
    };
    const done = await command.run(input, async (base, key, signal) => {
      await api.submit(base, input, key, signal);
    });
    if (done) {
      events.refresh();
      events.onClose();
    }
  };
  return (
    <Modal
      title="提交结果与证据"
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
          提交内容将固定保存，绑定当前目标版本。提交后由指定验收人决定是否完成。
        </p>
        <div className="proposal-fixed-terms">
          <strong>当前验收标准</strong>
          <ul>
            {command.baseline.acceptance_criteria.map((criterion, index) => (
              <li key={index}>{criterion}</li>
            ))}
          </ul>
        </div>
        <Field label="结果摘要">
          <textarea
            className="text-input"
            required
            rows={2}
            maxLength={2000}
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            disabled={command.busy}
          />
        </Field>
        <Field
          label="固定文字证据"
          hint="写清完成结果、验证方法和可复核的事实。提交后此段文字不会随草稿变化。"
        >
          <textarea
            className="text-input"
            required={!artifacts.length}
            rows={6}
            maxLength={8000}
            value={evidence}
            onChange={(event) => setEvidence(event.target.value)}
            disabled={command.busy}
          />
        </Field>
        {session.capabilities.includes('artifacts.evidence') && (
          <ArtifactEvidencePicker
            api={resourceApi}
            taskId={task.id}
            selected={artifacts}
            onChange={setArtifacts}
            accessLost={events.accessLost}
            disabled={command.busy}
          />
        )}
        <CommandActions
          command={command}
          label="提交验收"
          onClose={events.onClose}
          disabled={!summary.trim() || (!evidence.trim() && !artifacts.length)}
        />
      </form>
    </Modal>
  );
}
export function ReviewForm({
  api,
  task,
  submission,
  session,
  ...events
}: ActionProps & { readonly submission: Submission; readonly session: Session }) {
  const resourceApi = useMemo(
    () => new ResourceApi(session.tenant_id, session.csrf_token),
    [session.tenant_id, session.csrf_token],
  );
  const command = useTaskCommand(task, events.refresh, events.accessLost);
  const [decision, setDecision] = useState<TaskReviewInput['decision']>('return');
  const [comment, setComment] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const submit = async (): Promise<void> => {
    if (!confirmed) return;
    const input: TaskReviewInput = {
      submission_id: submission.id,
      decision,
      comment: comment.trim(),
    };
    const done = await command.run(input, async (base, key, signal) => {
      await api.review(base, input, key, signal);
    });
    if (done) {
      events.refresh();
      events.onClose();
    }
  };
  return (
    <Modal
      title="验收提交"
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
          验收对象是这次固定提交及其证据。通过验收会完成任务；退回后负责人可继续修改并重新提交。
        </p>
        <div className="proposal-fixed-terms">
          <strong>{submission.summary}</strong>
          {submission.evidence.map((evidence) =>
            evidence.type === 'text' ? (
              <p key={evidence.id}>{evidence.text}</p>
            ) : (
              <ArtifactEvidenceViewer
                key={evidence.version_id}
                api={resourceApi}
                evidence={evidence}
              />
            ),
          )}
        </div>
        <Field label="验收决定">
          <select
            className="text-input"
            value={decision}
            onChange={(event) => {
              setDecision(event.target.value === 'accept' ? 'accept' : 'return');
              setConfirmed(false);
            }}
            disabled={command.busy}
          >
            <option value="return">退回修改</option>
            <option value="accept">通过验收并完成任务</option>
          </select>
        </Field>
        <Field label="验收意见">
          <textarea
            className="text-input"
            required
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
          我已核对当前验收标准和这次提交的证据。
        </label>
        <CommandActions
          command={command}
          label="提交验收决定"
          onClose={events.onClose}
          disabled={!confirmed || !comment.trim()}
        />
      </form>
    </Modal>
  );
}
export function ParticipantForm({
  api,
  client,
  task,
  ...events
}: ActionProps & { readonly client: ApiClient }) {
  const command = useTaskCommand(task, events.refresh, events.accessLost);
  const roster = useWorkspaceMembers(client, task.workspace_id);
  const [principalId, setPrincipalId] = useState('');
  const [role, setRole] = useState<TaskParticipantInput['role'] | 'remove'>('observer');
  const [confirmed, setConfirmed] = useState(false);
  const submit = async (): Promise<void> => {
    if (!confirmed) return;
    const done = await command.run({ principalId, role }, async (base, key, signal) => {
      if (role === 'remove') await api.removeParticipant(base, principalId, key, signal);
      else await api.participant(base, { principal_id: principalId, role }, key, signal);
    });
    if (done) {
      events.refresh();
      events.onClose();
    }
  };
  return (
    <Modal
      title="管理任务参与者"
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
          新增参与者将能查看任务内容。负责人只能通过显式交接或管理员接管变更。
        </p>
        <Field label="成员">
          <select
            className="text-input"
            value={principalId}
            required
            onChange={(event) => {
              setPrincipalId(event.target.value);
              setConfirmed(false);
            }}
            disabled={command.busy || roster.loading}
          >
            <option value="">选择成员</option>
            {roster.members
              .filter(
                ({ principal }) =>
                  ![task.owner_principal_id, task.accountable_principal_id].includes(principal.id),
              )
              .map(({ principal }) => (
                <option key={principal.id} value={principal.id}>
                  {principal.display_name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="参与权限">
          <select
            className="text-input"
            value={role}
            onChange={(event) => {
              setRole(event.target.value as typeof role);
              setConfirmed(false);
            }}
            disabled={command.busy}
          >
            <option value="observer">观察者：查看任务</option>
            <option value="contributor">协作者：查看并提交结果</option>
            <option value="reviewer">验收人：查看并决定验收</option>
            <option value="remove">移除此成员的任务权限</option>
          </select>
        </Field>
        <label className="task-confirmation">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            disabled={command.busy}
          />
          确认变更该成员的任务访问权限；验收人变化会更新验收约定并使旧提案失效。
        </label>
        {roster.error !== null && <ErrorNotice>{roster.error}</ErrorNotice>}
        <CommandActions
          command={command}
          label="确认权限变更"
          onClose={events.onClose}
          disabled={!principalId || !confirmed}
        />
      </form>
    </Modal>
  );
}
