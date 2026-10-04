import type { CollaborationRequest, Task } from '@imbox/contracts';
import { ApiError, describeError } from '../api.js';

export const TASK_LABELS: Record<Task['status'], string> = {
  open: '待开始', active: '进行中', blocked: '受阻', in_review: '待验收', completed: '已完成', failed: '已失败', cancelled: '已取消',
};
export const REQUEST_LABELS: Record<CollaborationRequest['status'], string> = {
  pending: '待回应', clarification_requested: '待澄清', accepted: '已接受', rejected: '已拒绝', cancelled: '已撤回', expired: '已过期', superseded: '已失效',
};
export const REQUEST_KINDS: Record<CollaborationRequest['kind'], string> = {
  consult: '咨询', review: '评审', delegate: '委派子任务', handoff: '交接负责人',
};
export function terminalTask(task: Task): boolean { return ['completed', 'failed', 'cancelled'].includes(task.status); }
export function decimalToMicrounits(value: string): string {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(value.trim())) throw new Error('金额需为非负数，最多保留 6 位小数。');
  const [whole = '0', fraction = ''] = value.trim().split('.');
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (amount > 9_223_372_036_854_775_807n) throw new Error('金额超过允许范围。');
  return amount.toString();
}
export function formatMicrounits(value: string): string {
  const amount = BigInt(value);
  const fraction = (amount % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${amount / 1_000_000n}${fraction ? `.${fraction}` : ''}`;
}
export function requiredLines(value: string): [string, ...string[]] {
  const lines = value.split('\n').map((line) => line.trim()).filter(Boolean);
  const first = lines[0];
  if (first === undefined || lines.length > 20) throw new Error('请填写 1 至 20 条验收标准，每行一条。');
  if (lines.some((line) => [...line].length > 1_000)) throw new Error('请将每条验收标准限制在 1,000 字以内。');
  return [first, ...lines.slice(1)];
}
export function localDeadline(value: string): string | undefined {
  if (!value) return undefined;
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) throw new Error('请填写有效的截止时间。');
  return time.toISOString();
}
export function futureLocalDate(hours = 24): string {
  const date = new Date(Date.now() + hours * 3_600_000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
export function taskError(error: unknown): string {
  if (!(error instanceof ApiError)) return error instanceof Error && error.message.startsWith('请') || error instanceof Error && error.message.startsWith('金额') ? error.message : describeError(error);
  const errors: Record<string, string> = {
    VERSION_CONFLICT: '任务或提案已更新。请核对最新版本后，再明确提交你的决定。',
    PROPOSAL_VERSION_CONFLICT: '提案条款已改变，请重新阅读最新提案。',
    TASK_TERMINATED: '任务已经结束，不能继续此操作。',
    BUDGET_EXCEEDED: '提案预算必须与主任务同币种，且不能超过其上限。',
    DEPENDENCY_BLOCKED: '前置任务尚未完成，暂时不能继续。',
    ACCEPTANCE_REQUIRED: '任务必须保留至少一位验收人。',
    REQUEST_EXPIRED: '这份提案已经过期，请发起人重新发起。',
    INVALID_TRANSITION: '任务状态已变化，当前操作不再适用。',
    STALE_EXECUTION: '任务的执行范围已改变，请重新确认目标和提案。',
  };
  return errors[error.code] ?? describeError(error);
}

export interface CommandIdentity { readonly fingerprint: string; readonly key: string }
export function commandIdentity(previous: CommandIdentity | null, body: unknown, version: string, createKey: () => string): CommandIdentity {
  const fingerprint = JSON.stringify([version, body]);
  return previous?.fingerprint === fingerprint ? previous : { fingerprint, key: createKey() };
}
