import type { Action, CapabilityGrant, RuntimeRun, Principal } from '@imbox/contracts';
import { ApiError, describeError } from '../api.js';
export const RUN_LABELS: Record<RuntimeRun['status'], string> = {
  queued: '排队中',
  running: '运行中',
  waiting_input: '等待输入',
  waiting_approval: '等待审批',
  waiting_dependency: '等待依赖',
  paused: '已暂停',
  cancelling: '取消中',
  completed: '运行完成',
  failed: '运行失败',
  cancelled: '已取消',
  expired: '已过期',
};
export const ACTION_LABELS: Record<Action['status'], string> = {
  proposed: '已提出',
  awaiting_approval: '等待人工审批',
  ready: '等待执行',
  executing: '执行中',
  succeeded: '外部结果已确认',
  failed: '已失败',
  unknown: '结果未知',
  cancelled: '已取消',
};
export function runControls(run: RuntimeRun): readonly ('pause' | 'resume' | 'cancel')[] {
  if (['completed', 'failed', 'cancelled', 'expired'].includes(run.status)) return [];
  if (run.status === 'cancelling' || run.cancellation_requested) return [];
  if (['paused', 'waiting_input', 'waiting_approval', 'waiting_dependency'].includes(run.status))
    return ['resume', 'cancel'];
  return run.pause_requested ? ['cancel'] : ['pause', 'cancel'];
}
export function canApprove(
  action: Action,
  grant: CapabilityGrant | undefined,
  principal: Principal,
  now = Date.now(),
): boolean {
  return (
    principal.kind === 'human' &&
    action.status === 'awaiting_approval' &&
    action.approval?.status === 'pending' &&
    !action.approval.consumed &&
    action.approval.fingerprint === action.fingerprint &&
    action.approval.action_version === action.approval_binding_version &&
    new Date(action.approval.expires_at).getTime() > now &&
    grant?.status === 'active' &&
    grant.revision === action.grant_revision &&
    new Date(grant.expires_at).getTime() > now &&
    grant.approver_principal_ids.includes(principal.id)
  );
}
export function actionControls(
  action: Action,
  principalId: string,
): { revise: boolean; cancel: boolean; reconcile: boolean } {
  const owner = action.requester_id === principalId;
  return {
    revise:
      owner && ['awaiting_approval', 'ready'].includes(action.status) && action.attempt_count === 0,
    cancel: owner && ['proposed', 'awaiting_approval', 'ready', 'failed'].includes(action.status),
    reconcile: action.status === 'unknown',
  };
}
export function executionError(error: unknown): string {
  if (!(error instanceof ApiError))
    return error instanceof Error && /^(请|金额)/.test(error.message)
      ? error.message
      : describeError(error);
  const messages: Record<string, string> = {
    BUDGET_EXCEEDED: '预算不足或已被占用，请核对任务、运行和授权上限。',
    BUDGET_BLOCKED: '预算已阻断，需要先核对已发生费用。',
    EXECUTION_FENCE_CONFLICT: '任务或权限边界已变化，请重新核对并创建授权。',
    STALE_EXECUTION: '执行范围已变化，请刷新后重新确认。',
    APPROVAL_REQUIRED: '该行动需要指定的人类审批。',
    INVALID_TRANSITION: '状态已变化，此操作当前不可用。',
    ACTION_UNKNOWN: '外部结果尚不确定，只能查询结果。',
    RECOVERY_REQUIRED: '行动执行已冻结，等待恢复核对。',
    VERSION_CONFLICT: '版本已更新，请重新核对最新内容后明确提交。',
  };
  const runtime: Record<string, string> = {
    CAPACITY_EXCEEDED: '同时运行的数量已达上限，请等待已有运行结束。',
    STEP_LIMIT_EXCEEDED: '本次运行已达到步骤上限，请先检查已有结果。',
    EXECUTION_EXPIRED: '本次运行已超过执行期限，需要明确创建新的运行。',
    INVALID_STATE_TRANSITION: '状态已变化，此操作当前不可用。',
  };
  return messages[error.code] ?? runtime[error.code] ?? describeError(error);
}
