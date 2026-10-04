import type { RecoveryCase, RecoveryEvidence, RecoveryStatus } from '@imbox/contracts';
import { ApiError, describeError } from '../api.js';
export function canConfirmOrphan(
  item: RecoveryCase,
  evidence: RecoveryEvidence | undefined,
): boolean {
  return (
    item.status === 'open' &&
    item.reason === 'missing_after_restore' &&
    item.intent?.tool_version !== null &&
    !!item.intent?.budget_account_ids?.length &&
    evidence?.case_id === item.id &&
    evidence.outcome !== 'unknown' &&
    evidence.actual_microunits !== null
  );
}
export function recoverySnapshotChanged(before: RecoveryStatus, current: RecoveryStatus): boolean {
  return (
    before.revision !== current.revision ||
    before.freeze_digest !== current.freeze_digest ||
    before.journal_digest !== current.journal_digest
  );
}
export function recoveryError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'CHARGE_STATUS_UNKNOWN')
      return '仍有未知或冲突结果，或缺少原始预算账户。保持冻结，不能将未知费用按零处理。';
    if (error.status === 409) return '恢复记录或独立日志已经变化，请重新读取并核对。';
    if (error.status === 403) return '当前身份没有恢复管理权限，页面中的恢复记录已清除。';
  }
  return describeError(error);
}
