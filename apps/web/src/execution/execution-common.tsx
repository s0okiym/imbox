import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, isAccessLoss } from '../api.js';
import { ErrorNotice } from '../components.js';
import { commandIdentity, formatMicrounits } from '../tasks/task-state.js';
import type { CommandIdentity } from '../tasks/task-state.js';
import { executionError } from './execution-state.js';

export function useExecutionCommand(
  version: string,
  refresh: () => void,
  accessLost: (error: unknown) => void,
) {
  const [baseline, setBaseline] = useState(version);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const identity = useRef<CommandIdentity | null>(null);
  const flight = useRef<AbortController | null>(null);
  useEffect(() => () => flight.current?.abort(), []);
  const stale = version !== baseline;
  const run = async (
    body: unknown,
    operation: (key: string, signal: AbortSignal) => Promise<void>,
  ): Promise<boolean> => {
    if (flight.current !== null || stale) return false;
    const controller = new AbortController();
    flight.current = controller;
    identity.current = commandIdentity(identity.current, body, baseline, () => crypto.randomUUID());
    setBusy(true);
    setError(null);
    try {
      await operation(identity.current.key, controller.signal);
      return !controller.signal.aborted;
    } catch (failure: unknown) {
      if (!controller.signal.aborted) {
        if (isAccessLoss(failure)) accessLost(failure);
        else {
          setError(executionError(failure));
          if (failure instanceof ApiError && failure.status === 409) refresh();
        }
      }
      return false;
    } finally {
      if (!controller.signal.aborted) {
        flight.current = null;
        setBusy(false);
      }
    }
  };
  return {
    baseline,
    stale,
    busy,
    error,
    run,
    setError,
    adoptLatest: () => {
      setBaseline(version);
      identity.current = null;
      setError(null);
    },
  };
}
export function SubmitActions({
  command,
  label,
  onClose,
  disabled = false,
  onAdopt,
}: {
  readonly command: ReturnType<typeof useExecutionCommand>;
  readonly label: string;
  readonly onClose: () => void;
  readonly disabled?: boolean;
  readonly onAdopt?: () => void;
}) {
  return (
    <>
      {command.error && <ErrorNotice>{command.error}</ErrorNotice>}
      {command.stale && (
        <div className="task-conflict" role="alert">
          <p>版本已变化，原决定不能直接提交。请核对最新的目标、参数、权限与预算。</p>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              command.adoptLatest();
              onAdopt?.();
            }}
          >
            重新核对最新版本
          </button>
        </div>
      )}
      <div className="dialog-actions">
        <button className="button subtle" type="button" onClick={onClose} disabled={command.busy}>
          关闭
        </button>
        <button className="button primary" disabled={disabled || command.busy || command.stale}>
          {command.busy ? '正在提交…' : label}
        </button>
      </div>
    </>
  );
}
export function BudgetCard({
  budget,
  label = '预算',
}: {
  readonly budget: {
    currency: string;
    limit_microunits: string;
    reserved_microunits?: string;
    spent_microunits?: string;
    blocked?: boolean;
  };
  readonly label?: string;
}) {
  return (
    <section className="execution-budget" aria-label={label}>
      <h2>
        {label} <small>{budget.currency}</small>
      </h2>
      <dl>
        <div>
          <dt>上限</dt>
          <dd>{formatMicrounits(budget.limit_microunits)}</dd>
        </div>
        {budget.reserved_microunits !== undefined && (
          <div>
            <dt>已预占</dt>
            <dd>{formatMicrounits(budget.reserved_microunits)}</dd>
          </div>
        )}
        {budget.spent_microunits !== undefined && (
          <div>
            <dt>已计费</dt>
            <dd>{formatMicrounits(budget.spent_microunits)}</dd>
          </div>
        )}
      </dl>
      {budget.blocked && (
        <p role="status" className="execution-warning">
          预算已阻断，不能开始新的费用预占。
        </p>
      )}
    </section>
  );
}
export function Facts({ children }: { readonly children: ReactNode }) {
  return <dl className="execution-facts">{children}</dl>;
}
export function Fact({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
