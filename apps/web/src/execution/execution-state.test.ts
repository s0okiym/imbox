import { describe, expect, it } from 'vitest';
import type { Action, CapabilityGrant, Principal, RuntimeRun } from '@imbox/contracts';
import { ApiError } from '../api.js';
import { actionControls, canApprove, executionError, runControls } from './execution-state.js';
const run = (status: RuntimeRun['status'], extra: Partial<RuntimeRun> = {}): RuntimeRun =>
  ({ status, pause_requested: false, cancellation_requested: false, ...extra }) as RuntimeRun;
const principal = { id: 'human', kind: 'human' } as Principal;
const action = {
  requester_id: 'human',
  status: 'awaiting_approval',
  attempt_count: 0,
  fingerprint: 'fixed',
  approval_binding_version: '9007199254740993',
  grant_revision: '2',
  approval: {
    status: 'pending',
    consumed: false,
    fingerprint: 'fixed',
    action_version: '9007199254740993',
    expires_at: '2030-01-01T00:00:00.000Z',
  },
} as Action;
const grant = {
  status: 'active',
  revision: '2',
  approver_principal_ids: ['human'],
  expires_at: '2030-01-01T00:00:00.000Z',
} as CapabilityGrant;
describe('execution controls preserve authority and uncertainty', () => {
  it('waits for actual pause and cancellation acknowledgement and never resumes terminal runs', () => {
    expect(runControls(run('running', { pause_requested: true }))).toEqual(['cancel']);
    expect(runControls(run('paused'))).toEqual(['resume', 'cancel']);
    for (const status of ['cancelling', 'completed', 'failed', 'cancelled', 'expired'] as const)
      expect(runControls(run(status))).toEqual([]);
    expect(runControls(run('running', { cancellation_requested: true }))).toEqual([]);
  });
  it('only nominated humans can decide an unexpired exact approval binding under its current grant', () => {
    const now = Date.parse('2026-10-04');
    expect(canApprove(action, grant, principal, now)).toBe(true);
    expect(canApprove(action, grant, { ...principal, kind: 'agent' }, now)).toBe(false);
    expect(canApprove(action, grant, { ...principal, id: 'other' }, now)).toBe(false);
    expect(canApprove(action, { ...grant, revision: '3' }, principal, now)).toBe(false);
    expect(canApprove(action, { ...grant, status: 'revoked' }, principal, now)).toBe(false);
    expect(canApprove({ ...action, fingerprint: 'changed' }, grant, principal, now)).toBe(false);
    expect(
      canApprove(
        { ...action, approval_binding_version: '9007199254740992' },
        grant,
        principal,
        now,
      ),
    ).toBe(false);
    expect(
      canApprove(
        { ...action, approval: { ...action.approval!, consumed: true } },
        grant,
        principal,
        now,
      ),
    ).toBe(false);
    expect(canApprove(action, grant, principal, Date.parse('2031-01-01'))).toBe(false);
  });
  it('an unknown result has only lookup controls even for its original requester', () => {
    expect(actionControls({ ...action, status: 'unknown', attempt_count: 1 }, 'human')).toEqual({
      revise: false,
      cancel: false,
      reconcile: true,
    });
    expect(actionControls({ ...action, status: 'executing', attempt_count: 1 }, 'human')).toEqual({
      revise: false,
      cancel: false,
      reconcile: false,
    });
    expect(actionControls({ ...action, status: 'ready', attempt_count: 1 }, 'human').revise).toBe(
      false,
    );
    expect(actionControls(action, 'other')).toEqual({
      revise: false,
      cancel: false,
      reconcile: false,
    });
  });
  it('reports capacity and expiry without exposing internal error text', () => {
    for (const code of ['CAPACITY_EXCEEDED', 'STEP_LIMIT_EXCEEDED', 'EXECUTION_EXPIRED']) {
      expect(executionError(new ApiError(409, code, 'private SQL'))).not.toContain('private');
      expect(executionError(new ApiError(409, code, 'private SQL'))).not.toBe(
        '请求未能完成。请稍后重试。',
      );
    }
  });
});
