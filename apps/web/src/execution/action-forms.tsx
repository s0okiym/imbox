import { useEffect, useState } from 'react';
import type {
  Action,
  ActionResourceRef,
  CapabilityGrant,
  CreateActionInput,
  CreateGrantInput,
  Task,
  TaskParticipantPage,
} from '@imbox/contracts';
import type { ApiClient, Session } from '../api.js';
import { ApiError, isAccessLoss } from '../api.js';
import { ErrorNotice, Modal, Spinner } from '../components.js';
import { Field, MemberPicker, requiredIds, useWorkspaceMembers } from '../tasks/task-common.js';
import { TaskApi } from '../tasks/task-api.js';
import { decimalToMicrounits, futureLocalDate, localDeadline } from '../tasks/task-state.js';
import { ExecutionApi } from './execution-api.js';
import { BudgetCard, Fact, Facts, SubmitActions, useExecutionCommand } from './execution-common.js';
import { PublicationPicker } from './publication-picker.js';
import { executionError } from './execution-state.js';

export function CreateGrantForm({
  api,
  taskApi,
  client,
  session,
  tasks,
  onClose,
  onCreated,
  refresh,
  accessLost,
}: {
  readonly api: ExecutionApi;
  readonly taskApi: TaskApi;
  readonly client: ApiClient;
  readonly session: Session;
  readonly tasks: readonly Task[];
  readonly onClose: () => void;
  readonly onCreated: (grant: CapabilityGrant) => void;
  readonly refresh: () => void;
  readonly accessLost: (error: unknown) => void;
}) {
  const [taskId, setTaskId] = useState('');
  const [publication, setPublication] = useState<ActionResourceRef | null>(null);
  const task = tasks.find((item) => item.id === taskId);
  const roster = useWorkspaceMembers(client, task?.workspace_id ?? '');
  const [participants, setParticipants] = useState<TaskParticipantPage['items']>([]);
  const [loading, setLoading] = useState(false);
  const [executor, setExecutor] = useState('');
  const [approvers, setApprovers] = useState<string[]>([]);
  const [tool, setTool] = useState('demo.delivery');
  const [toolVersion, setToolVersion] = useState('1');
  const [target, setTarget] = useState('demo-provider');
  const [amount, setAmount] = useState('0');
  const [expires, setExpires] = useState(() => futureLocalDate());
  const [execute, setExecute] = useState(false);
  const [disclose, setDisclose] = useState(false);
  const command = useExecutionCommand('new-grant', refresh, accessLost);
  useEffect(() => {
    setExecute(false);
    setDisclose(false);
  }, [task?.version, executor, tool, toolVersion, target, amount, expires, approvers, publication]);
  useEffect(() => {
    const controller = new AbortController();
    setParticipants([]);
    setExecutor('');
    setApprovers([]);
    setExecute(false);
    setDisclose(false);
    if (!taskId) return () => controller.abort();
    setLoading(true);
    void taskApi
      .participants(taskId, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted) setParticipants(page.items);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) {
          if (isAccessLoss(failure)) accessLost(failure);
          else command.setError(executionError(failure));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [taskApi, taskId, accessLost]);
  const executors = roster.members.filter((member) =>
    participants.some(
      (item) =>
        item.principal_id === member.principal.id && ['owner', 'contributor'].includes(item.role),
    ),
  );
  const reviewers = roster.members.filter(
    (member) =>
      member.principal.kind === 'human' &&
      participants.some(
        (item) =>
          item.principal_id === member.principal.id && ['owner', 'reviewer'].includes(item.role),
      ),
  );
  return (
    <Modal title="创建工具授权" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void (async () => {
            if (!task || !execute || !disclose) return;
            try {
              const input: CreateGrantInput = {
                task_id: task.id,
                executor_principal_id: executor,
                tool_id: tool,
                tool_version: toolVersion,
                target_id: target,
                allow_execute: execute,
                allow_disclosure: disclose,
                resource_versions: [
                  { type: 'task', id: task.id, version: task.version },
                  ...(publication ? [publication] : []),
                ],
                approver_principal_ids: requiredIds(approvers),
                budget: {
                  currency: task.budget.currency,
                  limit_microunits: decimalToMicrounits(amount),
                },
                expires_at: localDeadline(expires)!,
              };
              await command.run(input, async (key, signal) => {
                const grant = await api.createGrant(input, key, signal);
                if (!signal.aborted) onCreated(grant);
              });
            } catch (failure: unknown) {
              command.setError(executionError(failure));
            }
          })();
        }}
      >
        <p className="execution-note">
          只有获授权的人类管理员可以签发。任务读取权不会自动变成工具执行权或对外披露权。
        </p>
        <Field label="授权所属任务">
          <select
            className="text-input"
            required
            value={taskId}
            onChange={(event) => {
              setTaskId(event.target.value);
              setPublication(null);
            }}
          >
            <option value="">选择进行中的任务</option>
            {tasks
              .filter((item) => item.status === 'active')
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
          </select>
        </Field>
        {task && (
          <PublicationPicker
            key={task.id}
            tenantId={api.tenantId}
            csrfToken={api.csrfToken}
            taskId={task.id}
            onChange={setPublication}
          />
        )}
        {loading || roster.loading ? (
          <Spinner />
        ) : (
          <>
            <Field label="获授权的执行者">
              <select
                className="text-input"
                required
                value={executor}
                onChange={(event) => setExecutor(event.target.value)}
              >
                <option value="">选择任务负责人或贡献者</option>
                {executors.map(({ principal }) => (
                  <option key={principal.id} value={principal.id}>
                    {principal.display_name}
                    {principal.kind === 'agent' ? ' · Agent' : ''}
                  </option>
                ))}
              </select>
            </Field>
            <fieldset className="execution-inputs">
              <legend>指定人类审批者</legend>
              <MemberPicker members={reviewers} selected={approvers} onChange={setApprovers} />
              {!reviewers.length && <p>请先为任务指定可用的人类负责人或验收人。</p>}
            </fieldset>
          </>
        )}
        <div className="execution-form-grid">
          <Field label="已登记工具标识">
            <input
              className="text-input"
              required
              maxLength={100}
              value={tool}
              onChange={(event) => setTool(event.target.value)}
            />
          </Field>
          <Field label="工具版本">
            <input
              className="text-input"
              required
              pattern="[1-9][0-9]{0,18}"
              value={toolVersion}
              onChange={(event) => setToolVersion(event.target.value)}
            />
          </Field>
        </div>
        <Field
          label="已登记目标标识"
          hint="使用管理员提供的标识。实际地址由受控连接器配置，此处不能填写网络地址。"
        >
          <input
            className="text-input"
            required
            maxLength={200}
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          />
        </Field>
        {task && (
          <p className="execution-note">
            绑定任务「{task.title}」版本 {task.version}；后续任务或授权范围变化可能使授权失效。
          </p>
        )}
        <div className="execution-form-grid">
          <Field label={`授权预算上限${task ? `（${task.budget.currency}）` : ''}`}>
            <input
              className="text-input"
              required
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </Field>
          <Field label="授权到期时间">
            <input
              className="text-input"
              type="datetime-local"
              required
              value={expires}
              onChange={(event) => setExpires(event.target.value)}
            />
          </Field>
        </div>
        <label className="execution-confirm">
          <input
            type="checkbox"
            checked={execute}
            onChange={(event) => setExecute(event.target.checked)}
          />
          允许此执行者在上述范围内调用工具。
        </label>
        <label className="execution-confirm">
          <input
            type="checkbox"
            checked={disclose}
            onChange={(event) => setDisclose(event.target.checked)}
          />
          允许将经人工审批的行动参数披露给上述目标。
        </label>
        {roster.error && <ErrorNotice>{roster.error}</ErrorNotice>}
        <SubmitActions
          command={command}
          label="签发授权"
          onClose={onClose}
          disabled={
            session.principal.kind !== 'human' ||
            !task ||
            !executor ||
            !approvers.length ||
            !execute ||
            !disclose ||
            loading
          }
        />
      </form>
    </Modal>
  );
}

export function CreateActionForm({
  api,
  grants,
  tasks,
  initialGrant,
  onClose,
  onCreated,
  refresh,
  accessLost,
}: {
  readonly api: ExecutionApi;
  readonly grants: readonly CapabilityGrant[];
  readonly tasks: readonly Task[];
  readonly initialGrant?: string;
  readonly onClose: () => void;
  readonly onCreated: (action: Action) => void;
  readonly refresh: () => void;
  readonly accessLost: (error: unknown) => void;
}) {
  const [grantId, setGrantId] = useState(initialGrant ?? '');
  const [text, setText] = useState('');
  const [publicationId, setPublicationId] = useState('');
  const [publicationReady, setPublicationReady] = useState(false);
  const [amount, setAmount] = useState('0');
  const [businessKey, setBusinessKey] = useState<string>(() => crypto.randomUUID());
  const [required, setRequired] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const grant = grants.find((item) => item.id === grantId);
  const command = useExecutionCommand('new-action', refresh, accessLost);
  const artifactRefs =
    grant?.resource_versions.filter((ref) => ref.type === 'artifact_version') ?? [];
  const selectedPublication = artifactRefs.find((ref) => ref.id === publicationId);
  useEffect(() => {
    setPublicationId('');
    setText('');
    setConfirmed(false);
  }, [grant?.id]);
  useEffect(() => {
    const controller = new AbortController();
    setPublicationReady(false);
    setConfirmed(false);
    if (!grant || !selectedPublication) return () => controller.abort();
    setText('');
    void api
      .publicationSource(grant.id, selectedPublication.id, controller.signal)
      .then((source) => {
        if (!controller.signal.aborted) {
          setText(source.text);
          setPublicationReady(true);
        }
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) {
          setText('');
          if (isAccessLoss(failure)) accessLost(failure);
          else
            command.setError(
              failure instanceof ApiError && failure.code === 'PUBLICATION_TOO_LARGE'
                ? '所选版本为空或超过 4000 字符，不能通过此文本工具完整发布。'
                : executionError(failure),
            );
        }
      });
    return () => controller.abort();
  }, [api, grant?.id, grant?.revision, publicationId]);

  useEffect(() => {
    setConfirmed(false);
  }, [grant?.revision, grant?.status]);
  return (
    <Modal title="提出外部行动" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void (async () => {
            if (!grant || !confirmed || (artifactRefs.length > 0 && !publicationReady)) return;
            try {
              const input: CreateActionInput = {
                task_id: grant.task_id,
                grant_id: grant.id,
                executor_principal_id: grant.executor_principal_id,
                tool_id: grant.tool_id,
                tool_version: grant.tool_version,
                target_id: grant.target_id,
                parameters: { text },
                resource_versions: grant.resource_versions.filter(
                  (ref) => ref.type === 'task' || ref.id === selectedPublication?.id,
                ),
                business_key: businessKey,
                estimate: {
                  currency: grant.budget.currency,
                  limit_microunits: decimalToMicrounits(amount),
                },
                required,
              };
              await command.run(input, async (key, signal) => {
                const action = await api.createAction(input, key, signal);
                if (!signal.aborted) onCreated(action);
              });
            } catch (failure: unknown) {
              command.setError(executionError(failure));
            }
          })();
        }}
      >
        <Field label="使用的工具授权">
          <select
            className="text-input"
            required
            value={grantId}
            onChange={(event) => {
              setGrantId(event.target.value);
              setConfirmed(false);
            }}
          >
            <option value="">选择当前授权</option>
            {grants
              .filter(
                (item) =>
                  item.status === 'active' && new Date(item.expires_at).getTime() > Date.now(),
              )
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {tasks.find((task) => task.id === item.task_id)?.title ?? item.task_id} ·{' '}
                  {item.tool_id} → {item.target_id}
                </option>
              ))}
          </select>
        </Field>
        {grant && (
          <>
            <Facts>
              <Fact label="固定目标">{grant.target_id}</Fact>
              <Fact label="工具">
                {grant.tool_id} · {grant.tool_version}
              </Fact>
              <Fact label="授权修订">{grant.revision}</Fact>
              <Fact label="执行者">{grant.executor_principal_id}</Fact>
            </Facts>
            <BudgetCard budget={grant.budget} label="授权预算" />
          </>
        )}
        {artifactRefs.length > 0 && (
          <>
            <Field label="本次发布的固定产物版本">
              <select
                className="text-input"
                required
                value={publicationId}
                onChange={(e) => {
                  setPublicationId(e.target.value);
                  setPublicationReady(false);
                  setConfirmed(false);
                  setText('');
                }}
              >
                <option value="">选择授权内的固定版本</option>
                {artifactRefs.map((ref) => (
                  <option key={ref.id} value={ref.id}>
                    版本 {ref.version} · {ref.id}
                  </option>
                ))}
              </select>
            </Field>
            <p className="execution-note">
              正文从固定版本读取，只读核对；修改内容须创建新产物版本并重新授权。
            </p>
            {selectedPublication && (
              <p className="execution-note">SHA-256 {selectedPublication.sha256}</p>
            )}
          </>
        )}
        <Field label="将发送给目标的完整内容">
          <textarea
            className="text-input"
            required
            maxLength={4000}
            rows={5}
            value={text}
            readOnly={artifactRefs.length > 0}
            onChange={(event) => {
              setText(event.target.value);
              setConfirmed(false);
            }}
          />
        </Field>
        <Field
          label="业务去重键"
          hint="同一业务事项使用同一个键。请求响应丢失时不要通过换键重复提出相同行动。"
        >
          <input
            className="text-input"
            required
            minLength={8}
            maxLength={128}
            value={businessKey}
            onChange={(event) => {
              setBusinessKey(event.target.value);
              setConfirmed(false);
            }}
          />
        </Field>
        <Field label={`本次费用预估上限${grant ? `（${grant.budget.currency}）` : ''}`}>
          <input
            className="text-input"
            required
            inputMode="decimal"
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
              setConfirmed(false);
            }}
          />
        </Field>
        <label className="execution-confirm">
          <input
            type="checkbox"
            checked={required}
            onChange={(event) => {
              setRequired(event.target.checked);
              setConfirmed(false);
            }}
          />
          本行动成功是任务验收的必要条件。
        </label>
        <label className="execution-confirm">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          我已核对授权、完整参数、目标及费用，提交给指定人类审批。
        </label>
        <SubmitActions
          command={command}
          label="提交行动提案"
          onClose={onClose}
          disabled={!grant || !confirmed || (artifactRefs.length > 0 && !publicationReady)}
        />
      </form>
    </Modal>
  );
}
