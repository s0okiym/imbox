import { useEffect, useRef, useState } from 'react';
import type {
  Conversation,
  ExplicitMemory,
  KnowledgeSearchHit,
  MemorySourceRef,
  Task,
  UpdateMemoryInput,
} from '@imbox/contracts';
import { isAccessLoss } from '../api.js';
import { ErrorNotice, Modal, Spinner } from '../components.js';
import { SubmitActions, useExecutionCommand } from '../execution/execution-common.js';
import { Field } from '../tasks/task-common.js';
import { localDeadline } from '../tasks/task-state.js';
import { KnowledgeApi, knowledgeError, MEMORY_CONFIRMATION, SOURCE_KIND } from './knowledge-api.js';

export function SourceReferences({ sources }: { readonly sources: readonly MemorySourceRef[] }) {
  return (
    <ul className="knowledge-sources">
      {sources.map((source) => (
        <li key={`${source.kind}:${source.id}`}>
          <strong>
            {SOURCE_KIND[source.kind]} · 版本 {source.version}
          </strong>
          <code>{source.id}</code>
          <details>
            <summary>查看固定内容校验值</summary>
            <code>{source.sha256}</code>
          </details>
        </li>
      ))}
    </ul>
  );
}
export function MemoryForm({
  api,
  tasks,
  conversations,
  memory,
  initialSource,
  onClose,
  onChanged,
  refresh,
  accessLost,
}: {
  readonly api: KnowledgeApi;
  readonly tasks: readonly Task[];
  readonly conversations: readonly Conversation[];
  readonly memory?: ExplicitMemory;
  readonly initialSource?: KnowledgeSearchHit;
  readonly onClose: () => void;
  readonly onChanged: (memory: ExplicitMemory) => void;
  readonly refresh: () => void;
  readonly accessLost: (error: unknown) => void;
}) {
  const toLocal = (value: string) => {
    const date = new Date(value);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  };
  const [scope, setScope] = useState(
    memory
      ? memory.scope === 'personal'
        ? 'personal'
        : `${memory.scope}:${memory.task_id ?? memory.conversation_id}`
      : 'personal',
  );
  const [body, setBody] = useState(memory?.body ?? '');
  const [confirmation, setConfirmation] = useState<ExplicitMemory['confirmation']>(
    memory?.confirmation ?? 'needs_confirmation',
  );
  const [confidence, setConfidence] = useState(String(memory?.confidence ?? 50));
  const [enabled, setEnabled] = useState(memory?.status !== 'disabled');
  const [expiry, setExpiry] = useState(memory?.expires_at ? toLocal(memory.expires_at) : '');
  const [sources, setSources] = useState<MemorySourceRef[]>(
    memory?.source_refs ??
      (initialSource && initialSource.kind !== 'memory'
        ? [
            {
              kind: initialSource.kind,
              id: initialSource.id,
              version: initialSource.version,
              sha256: initialSource.sha256,
            },
          ]
        : []),
  );
  const [confirmed, setConfirmed] = useState(false);
  const command = useExecutionCommand(memory?.version ?? 'new-memory', refresh, accessLost);
  const changed = () => setConfirmed(false);
  return (
    <Modal title={memory ? '修订显式记忆' : '建立显式记忆'} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!confirmed) return;
          try {
            const input: UpdateMemoryInput = {
              scope:
                scope === 'personal'
                  ? 'personal'
                  : scope.startsWith('task:')
                    ? 'task'
                    : 'conversation',
              ...(scope.startsWith('task:')
                ? { task_id: scope.slice(5) }
                : scope.startsWith('conversation:')
                  ? { conversation_id: scope.slice(13) }
                  : {}),
              body: body.trim(),
              source_refs: sources,
              confirmation,
              confidence: Number(confidence),
              status: enabled ? 'active' : 'disabled',
              expires_at: expiry ? localDeadline(expiry)! : null,
            };
            void command.run(input, async (key, signal) => {
              const value = memory
                ? await api.update(memory, input, key, signal)
                : await api.create(input, key, signal);
              if (!signal.aborted) onChanged(value);
            });
          } catch {
            command.setError('请核对有效期及内容格式。');
          }
        }}
      >
        <p className="execution-note">
          记忆是可溯源的用户内容，不会成为系统指令或执行授权。确认状态和可信程度由你填写；待确认、冲突或停用的内容不会进入搜索结果与运行上下文。
        </p>
        <Field
          label="记忆可见范围"
          hint={
            memory
              ? '既有记忆不能修改范围。需要其他范围时，应明确创建新记忆。'
              : '共享记忆只能使用同一范围的来源。切换范围会清空已选来源。'
          }
        >
          <select
            className="text-input"
            value={scope}
            disabled={!!memory || command.busy}
            onChange={(event) => {
              setScope(event.target.value);
              setSources([]);
              changed();
            }}
          >
            <option value="personal">仅我个人可见</option>
            {conversations.map((item) => (
              <option key={item.id} value={`conversation:${item.id}`}>
                会话 · {item.title}
              </option>
            ))}
            {tasks.map((item) => (
              <option key={item.id} value={`task:${item.id}`}>
                任务 · {item.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="记忆内容">
          <textarea
            className="text-input"
            rows={5}
            required
            maxLength={32000}
            value={body}
            disabled={command.busy}
            onChange={(event) => {
              setBody(event.target.value);
              changed();
            }}
          />
        </Field>
        <div className="execution-form-grid">
          <Field label="人工确认状态">
            <select
              className="text-input"
              value={confirmation}
              disabled={command.busy}
              onChange={(event) => {
                setConfirmation(event.target.value as typeof confirmation);
                changed();
              }}
            >
              {Object.entries(MEMORY_CONFIRMATION).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="人工评估可信程度（0–100）" hint="这是你的判断，不是模型计算的概率。">
            <input
              className="text-input"
              type="number"
              min={0}
              max={100}
              required
              value={confidence}
              disabled={command.busy}
              onChange={(event) => {
                setConfidence(event.target.value);
                changed();
              }}
            />
          </Field>
        </div>
        <Field label="记忆有效期（本机时区，可选）">
          <input
            className="text-input"
            type="datetime-local"
            value={expiry}
            disabled={command.busy}
            onChange={(event) => {
              setExpiry(event.target.value);
              changed();
            }}
          />
        </Field>
        <label className="execution-confirm">
          <input
            type="checkbox"
            checked={enabled}
            disabled={command.busy}
            onChange={(event) => {
              setEnabled(event.target.checked);
              changed();
            }}
          />
          启用此记忆（仍须人工已确认且来源有效才能用于检索）。
        </label>
        <section className="knowledge-form-section">
          <h3>固定来源 · {sources.length} / 20</h3>
          {!sources.length && (
            <p className="execution-note">没有关联来源：这将作为你明确填写的陈述保存。</p>
          )}
          {sources.map((source) => (
            <div key={`${source.kind}:${source.id}`}>
              <SourceReferences sources={[source]} />
              <button
                type="button"
                className="text-button"
                disabled={command.busy}
                onClick={() => {
                  setSources((items) =>
                    items.filter((item) => item.kind !== source.kind || item.id !== source.id),
                  );
                  changed();
                }}
              >
                移除此来源
              </button>
            </div>
          ))}
          <SourcePicker
            key={scope}
            api={api}
            scope={scope}
            sources={sources}
            disabled={command.busy || sources.length >= 20}
            accessLost={accessLost}
            onAdd={(source) => {
              setSources((items) => [
                ...items.filter((item) => item.kind !== source.kind || item.id !== source.id),
                source,
              ]);
              changed();
            }}
          />
        </section>
        <label className="execution-confirm">
          <input
            type="checkbox"
            checked={confirmed}
            disabled={command.busy}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          我已核对内容、来源固定版本、共享范围和确认状态，明确保存这条记忆。
        </label>
        <SubmitActions
          command={command}
          label={memory ? '保存记忆修订' : '保存显式记忆'}
          onClose={onClose}
          disabled={!confirmed || !body.trim()}
          onAdopt={changed}
        />
      </form>
    </Modal>
  );
}
function SourcePicker({
  api,
  scope,
  sources,
  disabled,
  onAdd,
  accessLost,
}: {
  readonly api: KnowledgeApi;
  readonly scope: string;
  readonly sources: readonly MemorySourceRef[];
  readonly disabled: boolean;
  readonly onAdd: (source: MemorySourceRef) => void;
  readonly accessLost: (error: unknown) => void;
}) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<KnowledgeSearchHit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const search = async () => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    setBusy(true);
    setItems([]);
    setError(null);
    try {
      const page = await api.search(
        {
          q: query.trim(),
          limit: 50,
          ...(scope.startsWith('task:')
            ? { task_id: scope.slice(5) }
            : scope.startsWith('conversation:')
              ? { conversation_id: scope.slice(13) }
              : {}),
        },
        next.signal,
      );
      if (!next.signal.aborted) setItems(page.items.filter((item) => item.kind !== 'memory'));
    } catch (failure: unknown) {
      if (!next.signal.aborted) {
        if (isAccessLoss(failure)) accessLost(failure);
        else setError(knowledgeError(failure));
      }
    } finally {
      if (!next.signal.aborted) setBusy(false);
    }
  };
  return (
    <div className="knowledge-source-picker">
      <Field label="查找来源关键词">
        <input
          className="text-input"
          value={query}
          maxLength={200}
          disabled={disabled}
          onChange={(event) => {
            controller.current?.abort();
            setBusy(false);
            setQuery(event.target.value);
            setItems([]);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              if (query.trim().length >= 2 && !disabled) void search();
            }
          }}
        />
      </Field>
      <button
        type="button"
        className="button subtle"
        disabled={disabled || busy || query.trim().length < 2}
        onClick={() => {
          void search();
        }}
      >
        查询当前有权访问的来源
      </button>
      {busy && <Spinner />}
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {items.map((item) => (
        <article className="execution-context" key={`${item.kind}:${item.id}`}>
          <strong>
            {SOURCE_KIND[item.kind]} · {item.title || '未命名内容'}
          </strong>
          <p className="task-prose">{item.snippet}</p>
          <p className="execution-note">固定版本 {item.version}</p>
          <button
            type="button"
            className="button subtle"
            disabled={
              disabled ||
              sources.some(
                (source) =>
                  source.kind === item.kind &&
                  source.id === item.id &&
                  source.version === item.version &&
                  source.sha256 === item.sha256,
              )
            }
            onClick={() => {
              if (item.kind !== 'memory')
                onAdd({ kind: item.kind, id: item.id, version: item.version, sha256: item.sha256 });
            }}
          >
            选用此固定来源
          </button>
        </article>
      ))}
      {!busy && items.length > 0 && (
        <p className="execution-note">每次展示前 50 项，请使用更具体的关键词缩小范围。</p>
      )}
    </div>
  );
}
export function DeleteMemoryForm({
  api,
  memory,
  onClose,
  onDeleted,
  refresh,
  accessLost,
}: {
  readonly api: KnowledgeApi;
  readonly memory: ExplicitMemory;
  readonly onClose: () => void;
  readonly onDeleted: () => void;
  readonly refresh: () => void;
  readonly accessLost: (error: unknown) => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const command = useExecutionCommand(memory.version, refresh, accessLost);
  return (
    <Modal title="删除显式记忆" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (confirmed)
            void command.run({ id: memory.id, delete: true }, async (key, signal) => {
              await api.delete(memory, key, signal);
              if (!signal.aborted) onDeleted();
            });
        }}
      >
        <p className="execution-note">
          删除会清除这条记忆保留的修订正文，不会删除它引用的消息、任务或制品；已经导出到外部的副本不能通过此操作收回。
        </p>
        <label className="execution-confirm">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          确认删除此记忆及其保留的修订正文。
        </label>
        <SubmitActions
          command={command}
          label="确认删除记忆"
          disabled={!confirmed}
          onClose={onClose}
          onAdopt={() => setConfirmed(false)}
        />
      </form>
    </Modal>
  );
}
