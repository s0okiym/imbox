import { useEffect, useState } from 'react';
import type {
  CapabilityGrant,
  Conversation,
  CreateRuntimeRunInput,
  RegisteredAgent,
  RuntimeRun,
  Task,
} from '@imbox/contracts';
import type { ApiClient, ChatMessage, Session } from '../api.js';
import { isAccessLoss } from '../api.js';
import { ErrorNotice, Modal, Spinner } from '../components.js';
import { Field } from '../tasks/task-common.js';
import { decimalToMicrounits, formatMicrounits } from '../tasks/task-state.js';
import { ExecutionApi } from './execution-api.js';
import { SubmitActions, useExecutionCommand } from './execution-common.js';
import { executionError } from './execution-state.js';

export function CreateRunForm({
  api,
  client,
  session,
  tasks,
  grants,
  onClose,
  onCreated,
  refresh,
  accessLost,
}: {
  readonly api: ExecutionApi;
  readonly client: ApiClient;
  readonly session: Session;
  readonly tasks: readonly Task[];
  readonly grants: readonly CapabilityGrant[];
  readonly onClose: () => void;
  readonly onCreated: (run: RuntimeRun) => void;
  readonly refresh: () => void;
  readonly accessLost: (error: unknown) => void;
}) {
  const [workspace, setWorkspace] = useState(session.workspaces[0]?.id ?? '');
  const [agents, setAgents] = useState<RegisteredAgent[]>([]);
  const [agentId, setAgentId] = useState('');
  const [scope, setScope] = useState<'task' | 'conversation'>('task');
  const [scopeId, setScopeId] = useState('');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [selectedMessages, setSelectedMessages] = useState<string[]>([]);
  const [toolGrantId, setToolGrantId] = useState('');
  const [publication, setPublication] = useState<{
    grantId: string;
    versionId: string;
    text: string;
  } | null>(null);
  const [includeTask, setIncludeTask] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [purpose, setPurpose] = useState('');
  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState('0');
  const [currency, setCurrency] = useState('USD');
  const [confirmed, setConfirmed] = useState(false);
  const task = tasks.find((item) => item.id === scopeId);
  const agent = agents.find((item) => item.id === agentId);
  const eligibleGrants = grants.filter(
    (grant) =>
      scope === 'task' &&
      task &&
      agent &&
      grant.task_id === task.id &&
      grant.executor_principal_id === agent.principal_id &&
      grant.status === 'active' &&
      grant.allow_execute &&
      grant.allow_disclosure &&
      grant.approver_principal_ids.length > 0 &&
      Date.parse(grant.expires_at) > Date.now() &&
      grant.resource_versions.some((ref) => ref.type === 'task' && ref.id === task.id) &&
      grant.resource_versions.filter((ref) => ref.type === 'artifact_version').length <= 1 &&
      grant.resource_versions.every(
        (ref) =>
          ref.type === 'artifact_version' || (ref.id === task.id && ref.version === task.version),
      ),
  );
  const selectedGrant = eligibleGrants.find((grant) => grant.id === toolGrantId);
  const artifactRef = selectedGrant?.resource_versions.find(
    (ref) => ref.type === 'artifact_version',
  );
  const publicationReady =
    !artifactRef ||
    (publication !== null &&
      publication.grantId === selectedGrant?.id &&
      publication.versionId === artifactRef.id);
  useEffect(() => {
    const controller = new AbortController();
    setPublication(null);
    setConfirmed(false);
    if (!selectedGrant || !artifactRef) return () => controller.abort();
    void api
      .publicationSource(selectedGrant.id, artifactRef.id, controller.signal)
      .then((source) => {
        if (!controller.signal.aborted)
          setPublication({
            grantId: selectedGrant.id,
            versionId: artifactRef.id,
            text: source.text,
          });
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) {
          if (isAccessLoss(failure)) accessLost(failure);
          else setError(executionError(failure));
        }
      });
    return () => controller.abort();
  }, [api, selectedGrant?.id, selectedGrant?.revision, artifactRef?.id, accessLost]);

  const grantBudgetMatches = (() => {
    if (!selectedGrant) return true;
    try {
      return (
        currency === selectedGrant.budget.currency &&
        BigInt(decimalToMicrounits(amount)) >= BigInt(selectedGrant.budget.limit_microunits)
      );
    } catch {
      return false;
    }
  })();
  const command = useExecutionCommand('new-run', refresh, accessLost);
  useEffect(() => {
    const controller = new AbortController();
    setAgents([]);
    setAgentId('');
    setLoading(true);
    setError(null);
    void Promise.all([
      api.agents(workspace, controller.signal),
      client.conversations(controller.signal),
    ])
      .then(([directory, page]) => {
        if (!controller.signal.aborted) {
          setAgents(directory.items.filter((item) => item.status === 'active'));
          setConversations(page.items.filter((item) => item.workspace_id === workspace));
        }
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) {
          if (isAccessLoss(failure)) accessLost(failure);
          else setError(executionError(failure));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, client, workspace, accessLost]);
  useEffect(() => {
    const controller = new AbortController();
    setMessages([]);
    setSelectedMessages([]);
    setConfirmed(false);
    if (scope === 'conversation' && scopeId)
      void client
        .messages(scopeId, controller.signal)
        .then((page) => {
          if (!controller.signal.aborted) setMessages(page.items.filter((item) => !item.deleted));
        })
        .catch((failure: unknown) => {
          if (!controller.signal.aborted) {
            if (isAccessLoss(failure)) accessLost(failure);
            else setError(executionError(failure));
          }
        });
    return () => controller.abort();
  }, [scope, scopeId, client, accessLost]);
  useEffect(() => {
    setConfirmed(false);
    setToolGrantId('');
  }, [task?.version, agent?.revision, agentId, scopeId]);
  const changeScope = (value: string) => {
    setScopeId(value);
    setConfirmed(false);
    setIncludeTask(false);
    const next = tasks.find((item) => item.id === value);
    if (next) setCurrency(next.budget.currency);
  };
  return (
    <Modal title="新建 Agent 运行" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void (async () => {
            if (
              !agent ||
              !scopeId ||
              !confirmed ||
              (toolGrantId &&
                (!selectedGrant || !includeTask || !grantBudgetMatches || !publicationReady))
            )
              return;
            try {
              const context: CreateRuntimeRunInput['context'] =
                scope === 'task'
                  ? includeTask && task
                    ? selectedGrant
                      ? selectedGrant.resource_versions.map((ref) => ({ ...ref, required: true }))
                      : [{ type: 'task', id: task.id, version: task.version, required: true }]
                    : []
                  : selectedMessages.map((id) => {
                      const message = messages.find((item) => item.id === id)!;
                      return { type: 'message', id, version: message.version, required: true };
                    });
              const input: CreateRuntimeRunInput = {
                agent_id: agent.id,
                agent_revision: agent.revision,
                ...(scope === 'task' ? { task_id: scopeId } : { conversation_id: scopeId }),
                context,
                ...(selectedGrant ? { tool_grant_id: selectedGrant.id } : {}),
                purpose,
                destination,
                budget: { currency, limit_microunits: decimalToMicrounits(amount) },
              };
              await command.run(input, async (key, signal) => {
                const run = await api.createRun(input, key, signal);
                if (!signal.aborted) onCreated(run);
              });
            } catch (failure: unknown) {
              command.setError(executionError(failure));
            }
          })();
        }}
      >
        <p className="execution-note">
          运行只读取这里明确选择的输入。Agent 还必须具有相应任务或会话的当前访问权限。
        </p>
        <Field label="工作空间">
          <select
            className="text-input"
            value={workspace}
            onChange={(event) => {
              setWorkspace(event.target.value);
              changeScope('');
            }}
          >
            {session.workspaces.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </Field>
        {loading ? (
          <Spinner />
        ) : (
          <Field label="执行 Agent">
            <select
              className="text-input"
              value={agentId}
              required
              onChange={(event) => {
                setAgentId(event.target.value);
                setDestination(
                  agents.find((item) => item.id === event.target.value)?.mode === 'hosted'
                    ? 'model:local'
                    : '',
                );
                setConfirmed(false);
              }}
            >
              <option value="">选择已登记的 Agent</option>
              {agents.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.display_name} ·{' '}
                  {item.mode === 'hosted' ? '托管' : item.mode === 'external' ? '外部' : '设备'} ·
                  修订 {item.revision}
                </option>
              ))}
            </select>
          </Field>
        )}
        {!loading && !agents.length && (
          <p className="execution-note">当前工作空间没有可用的 Agent，请管理员登记后刷新。</p>
        )}
        <Field label="运行归属">
          <select
            className="text-input"
            value={scope}
            onChange={(event) => {
              setScope(event.target.value as typeof scope);
              changeScope('');
            }}
          >
            <option value="task">任务</option>
            <option value="conversation">会话</option>
          </select>
        </Field>
        <Field label={scope === 'task' ? '关联任务' : '关联会话'}>
          <select
            className="text-input"
            value={scopeId}
            required
            onChange={(event) => changeScope(event.target.value)}
          >
            <option value="">请选择</option>
            {scope === 'task'
              ? tasks
                  .filter((item) => item.workspace_id === workspace && item.status === 'active')
                  .map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.title}
                    </option>
                  ))
              : conversations.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.title}
                  </option>
                ))}
          </select>
        </Field>
        <fieldset className="execution-inputs">
          <legend>明确提供的输入</legend>
          {scope === 'task' ? (
            task ? (
              <label>
                <input
                  type="checkbox"
                  checked={includeTask}
                  disabled={!!selectedGrant}
                  onChange={(event) => {
                    setIncludeTask(event.target.checked);
                    setConfirmed(false);
                  }}
                />
                <span>
                  任务标题与目标 · 版本 {task.version}
                  <small>{task.goal}</small>
                </span>
              </label>
            ) : (
              <p>选择任务后查看可提供的内容。</p>
            )
          ) : (
            <>
              <p>最近的消息；最多明确选择 50 条。未选消息不会加入上下文。</p>
              {messages.map((message) => (
                <label key={message.id}>
                  <input
                    type="checkbox"
                    checked={selectedMessages.includes(message.id)}
                    disabled={
                      !selectedMessages.includes(message.id) && selectedMessages.length >= 50
                    }
                    onChange={(event) => {
                      setSelectedMessages((items) =>
                        event.target.checked
                          ? [...items, message.id]
                          : items.filter((id) => id !== message.id),
                      );
                      setConfirmed(false);
                    }}
                  />
                  <span>
                    {message.body}
                    <small>消息版本 {message.version}</small>
                  </span>
                </label>
              ))}
            </>
          )}
        </fieldset>
        {scope === 'task' && session.capabilities.includes('agents.run_tools') && (
          <Field label="本次运行的工具授权">
            <select
              className="text-input"
              value={toolGrantId}
              onChange={(event) => {
                setToolGrantId(event.target.value);
                setConfirmed(false);
                if (event.target.value) setIncludeTask(true);
              }}
            >
              <option value="">不授权工具执行</option>
              {eligibleGrants.map((grant) => (
                <option key={grant.id} value={grant.id}>
                  {grant.tool_id} · 目标 {grant.target_id} · 授权修订 {grant.revision}
                </option>
              ))}
            </select>
            {selectedGrant && (
              <p className="execution-note">
                只可向固定目标 {selectedGrant.target_id}{' '}
                提议一次行动。模型不会直接执行；必须人工审批，再由人明确继续运行。将披露本任务选定版本及待审批的工具文本。
              </p>
            )}
          </Field>
        )}
        {artifactRef && (
          <section className="task-section" aria-label="将披露的固定产物">
            <h3>将披露的固定产物</h3>
            <p>
              版本 {artifactRef.version} · {artifactRef.id}
            </p>
            <p>SHA-256 {artifactRef.sha256}</p>
            {publicationReady && publication ? (
              <pre className="execution-output">{publication.text}</pre>
            ) : (
              <p>正在验证并读取所选版本，完成前不能创建运行。</p>
            )}
            <p className="execution-note">
              只发布此版本完整原文；新版本不会替换本次输入，模型提案仍需人工审批。
            </p>
          </section>
        )}
        {selectedGrant && !grantBudgetMatches && (
          <p role="alert">
            运行预算必须与授权币种一致，并至少覆盖授权上限 {selectedGrant.budget.currency}{' '}
            {formatMicrounits(selectedGrant.budget.limit_microunits)}。请明确调整预算后再确认。
          </p>
        )}
        <Field label="处理目的">
          <input
            className="text-input"
            required
            maxLength={500}
            value={purpose}
            onChange={(event) => {
              setPurpose(event.target.value);
              setConfirmed(false);
            }}
          />
        </Field>
        <Field
          label="处理目的地"
          hint="托管运行固定使用部署的本地模型；外部 Agent 请填写其已约定的处理方。"
        >
          <input
            className="text-input"
            required
            maxLength={500}
            value={destination}
            onChange={(event) => {
              setDestination(event.target.value);
              setConfirmed(false);
            }}
          />
        </Field>
        <div className="execution-form-grid">
          <Field label="运行预算上限">
            <input
              className="text-input"
              inputMode="decimal"
              required
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                setConfirmed(false);
              }}
            />
          </Field>
          <Field label="币种">
            <input
              className="text-input"
              required
              pattern="[A-Z]{3}"
              maxLength={3}
              value={currency}
              readOnly={scope === 'task' && !!task}
              onChange={(event) => {
                setCurrency(event.target.value.toUpperCase());
                setConfirmed(false);
              }}
            />
          </Field>
        </div>
        <label className="execution-confirm">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          我已核对 Agent、处理目的地、明确输入和预算，同意创建运行。
        </label>
        {error && <ErrorNotice>{error}</ErrorNotice>}
        <SubmitActions
          command={command}
          label="创建运行"
          disabled={
            !confirmed ||
            !agent ||
            !scopeId ||
            loading ||
            (!!toolGrantId &&
              (!selectedGrant || !includeTask || !grantBudgetMatches || !publicationReady))
          }
          onClose={onClose}
          onAdopt={() => setConfirmed(false)}
        />
      </form>
    </Modal>
  );
}
