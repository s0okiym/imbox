import { useEffect, useState } from 'react';
import type { Task, TaskEscalation } from '@imbox/contracts';
import { isAccessLoss } from '../api.js';
import { ErrorNotice, fullTime, Modal, Spinner } from '../components.js';
import { SubmitActions, useExecutionCommand } from '../execution/execution-common.js';
import { TaskApi } from './task-api.js';
import { Field } from './task-common.js';
import { taskError } from './task-state.js';

export function TaskEscalations({
  api,
  onClose,
  onTakenOver,
  accessLost,
}: {
  readonly api: TaskApi;
  readonly onClose: () => void;
  readonly onTakenOver: (task: Task) => void;
  readonly accessLost: (error: unknown) => void;
}) {
  const [items, setItems] = useState<TaskEscalation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const all: TaskEscalation[] = [];
        const seen = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = await api.escalations(controller.signal, cursor);
          all.push(...page.items);
          cursor = page.next_cursor;
          if (cursor) {
            if (seen.has(cursor)) throw new Error('Invalid pagination');
            seen.add(cursor);
          }
        } while (cursor && !controller.signal.aborted);
        if (!controller.signal.aborted) {
          setItems(all);
          setError(null);
        }
      } catch (failure: unknown) {
        if (!controller.signal.aborted) {
          if (isAccessLoss(failure)) {
            setItems([]);
            setSelected(null);
            accessLost(failure);
          } else setError(taskError(failure));
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          timer = setTimeout(() => {
            void poll();
          }, 3_000);
        }
      }
    };
    void poll();
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [api, tick, accessLost]);
  const escalation = items.find((item) => item.id === selected);
  return (
    <Modal title="任务升级待处理" onClose={onClose}>
      <p className="execution-note">
        这里只展示需要协调处理的任务标识与原因，不会因为管理员身份自动开放任务正文。接管是一次独立的权限变更。
      </p>
      {loading && <Spinner />}
      {!loading && !items.length && <p className="execution-note">当前没有需要处理的升级。</p>}
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {items.map((item) => (
        <article className="execution-context" key={item.id}>
          <h3>
            {item.reason === 'owner_unavailable' ? '任务负责人当前不可用' : '任务超过执行截止时间'}
          </h3>
          <p className="execution-note">
            任务 {item.task_id}
            <br />
            {fullTime(item.created_at)}
          </p>
          {item.can_takeover ? (
            <button className="button subtle" onClick={() => setSelected(item.id)}>
              核对并接管此任务
            </button>
          ) : (
            <p className="execution-note">请与工作空间管理员协调处理；当前身份不能直接接管。</p>
          )}
        </article>
      ))}
      {escalation && (
        <TakeoverEscalation
          api={api}
          escalation={escalation}
          onClose={() => setSelected(null)}
          onTakenOver={onTakenOver}
          refresh={() => setTick((value) => value + 1)}
          accessLost={accessLost}
        />
      )}
    </Modal>
  );
}
function TakeoverEscalation({
  api,
  escalation,
  onClose,
  onTakenOver,
  refresh,
  accessLost,
}: {
  readonly api: TaskApi;
  readonly escalation: TaskEscalation;
  readonly onClose: () => void;
  readonly onTakenOver: (task: Task) => void;
  readonly refresh: () => void;
  readonly accessLost: (error: unknown) => void;
}) {
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const command = useExecutionCommand(escalation.task_version, refresh, accessLost);
  return (
    <Modal title="明确接管任务" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!confirmed || !escalation.can_takeover) return;
          void command.run({ reason, task_id: escalation.task_id }, async (key, signal) => {
            const task = await api.takeover(
              escalation.task_id,
              escalation.task_version,
              reason,
              key,
              signal,
            );
            if (!signal.aborted) onTakenOver(task);
          });
        }}
      >
        <p className="execution-note">
          任务 {escalation.task_id} · 当前版本 {escalation.task_version}
          。接管后你将成为新负责人，原负责人的执行权限失效。后续恢复运行仍需重新检查权限与预算。
        </p>
        <Field label="管理员接管理由">
          <textarea
            className="text-input"
            required
            maxLength={2000}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
        <label className="execution-confirm">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          我确认承担此任务的负责人职责。
        </label>
        <SubmitActions
          command={command}
          label="确认接管并打开任务"
          disabled={!confirmed || !escalation.can_takeover}
          onClose={onClose}
          onAdopt={() => setConfirmed(false)}
        />
      </form>
    </Modal>
  );
}
