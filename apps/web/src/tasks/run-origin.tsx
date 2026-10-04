import { useEffect, useState } from 'react';
import type { TaskRunOrigin } from '@imbox/contracts';
import { isAccessLoss } from '../api.js';
import { ErrorNotice, fullTime } from '../components.js';
import { TaskApi } from './task-api.js';
import { taskError } from './task-state.js';
export function RunOrigin({
  api,
  taskId,
  accessLost,
  onOpenRun,
}: {
  readonly api: TaskApi;
  readonly taskId: string;
  readonly accessLost: (error: unknown) => void;
  readonly onOpenRun: (id: string) => void;
}) {
  const [origin, setOrigin] = useState<TaskRunOrigin>({ access: 'none' });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const value = await api.origin(taskId, controller.signal);
        if (!controller.signal.aborted) {
          setOrigin(value);
          setError(null);
        }
      } catch (failure: unknown) {
        if (!controller.signal.aborted) {
          setOrigin({ access: 'none' });
          if (isAccessLoss(failure)) accessLost(failure);
          else setError(taskError(failure));
        }
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => {
            void poll();
          }, 3_000);
      }
    };
    void poll();
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [api, taskId, accessLost]);
  if (origin.access === 'none') return error ? <ErrorNotice>{error}</ErrorNotice> : null;
  return (
    <section className="task-section">
      <h2>任务的来源运行</h2>
      {origin.access === 'restricted' ? (
        <p className="execution-note">当前无权查看来源运行。任务自身的授权与验收边界保持独立。</p>
      ) : (
        <>
          <p className="execution-note">
            从会话运行明确升级 · 来源版本 {origin.run_version} · {fullTime(origin.created_at)}
            。原回答未被自动当作任务目标；上下文和工具权限没有自动继承。
          </p>
          <button className="button subtle" onClick={() => onOpenRun(origin.run_id)}>
            查看有权访问的来源运行
          </button>
        </>
      )}
    </section>
  );
}
