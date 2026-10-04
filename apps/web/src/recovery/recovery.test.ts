import { describe, expect, it, vi } from 'vitest';
import type { RecoveryCase, RecoveryEvidence, RecoveryStatus } from '@imbox/contracts';
import type { FetchLike } from '../api.js';
import { RecoveryApi } from './recovery-api.js';
import { canConfirmOrphan, recoverySnapshotChanged } from './recovery-state.js';
const evidence: RecoveryEvidence = {
  id: 'evidence',
  case_id: 'case',
  intent_hash: 'a'.repeat(64),
  evidence_hash: 'b'.repeat(64),
  outcome: 'succeeded',
  receipt_id: 'provider-receipt',
  actual_microunits: '7',
  reason: null,
  created_at: '2026-10-04T00:00:00Z',
};
const item: RecoveryCase = {
  id: 'case',
  action_id: 'action',
  attempt_id: 'attempt',
  reason: 'missing_after_restore',
  status: 'open',
  version: '2',
  intent: {
    task_id: 'task',
    fingerprint: 'a'.repeat(64),
    business_key: 'business-key',
    tool_id: 'fixed',
    tool_version: '1',
    target_id: 'fixed-target',
    currency: 'USD',
    estimate_microunits: '10',
    budget_account_ids: ['task'],
    created_at: '2026-10-04T00:00:00Z',
  },
  evidence: [evidence],
  created_at: '2026-10-04T00:00:00Z',
  resolved_at: null,
  resolved_by: null,
};
const state: RecoveryStatus = {
  frozen: true,
  journal_frozen: true,
  database_frozen: true,
  revision: '2',
  open_cases: 0,
  pending_operations: 0,
  freeze_digest: 'a'.repeat(64),
  journal_digest: 'b'.repeat(64),
};
describe('recovery review controls and transport', () => {
  it('never offers orphan accounting for unknown, foreign, legacy or intact/conflicting records', () => {
    expect(canConfirmOrphan(item, evidence)).toBe(true);
    expect(
      canConfirmOrphan(item, { ...evidence, outcome: 'unknown', actual_microunits: null }),
    ).toBe(false);
    expect(canConfirmOrphan(item, { ...evidence, case_id: 'different' })).toBe(false);
    expect(
      canConfirmOrphan({ ...item, intent: { ...item.intent!, tool_version: null } }, evidence),
    ).toBe(false);
    expect(
      canConfirmOrphan(
        { ...item, intent: { ...item.intent!, budget_account_ids: null } },
        evidence,
      ),
    ).toBe(false);
    expect(canConfirmOrphan({ ...item, reason: 'recovery_in_flight' }, evidence)).toBe(false);
    expect(canConfirmOrphan({ ...item, status: 'resolved' }, evidence)).toBe(false);
  });
  it('requires re-review if the independent log changes even before the database fence changes', () => {
    expect(recoverySnapshotChanged(state, { ...state })).toBe(false);
    expect(recoverySnapshotChanged(state, { ...state, journal_digest: 'c'.repeat(64) })).toBe(true);
    expect(recoverySnapshotChanged(state, { ...state, freeze_digest: 'c'.repeat(64) })).toBe(true);
    expect(recoverySnapshotChanged(state, { ...state, revision: '3' })).toBe(true);
  });
  it('sends stable idempotency/version/tenant/CSRF bindings, while lookups accept no fabricated evidence', async () => {
    const fetcher = vi.fn<FetchLike>(
      async () =>
        new Response(JSON.stringify(item), { headers: { 'content-type': 'application/json' } }),
    );
    const api = new RecoveryApi('tenant', 'csrf', fetcher),
      signal = new AbortController().signal;
    const body = {
      evidence_id: evidence.id,
      confirmed: true as const,
      reason: 'Reviewed exact receipt',
    };
    await api.confirm(item, body, 'stable-key', signal);
    await api.confirm(item, body, 'stable-key', signal);
    for (const [, init] of fetcher.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.get('X-Imbox-Tenant-Id')).toBe('tenant');
      expect(headers.get('X-CSRF-Token')).toBe('csrf');
      expect(headers.get('Idempotency-Key')).toBe('stable-key');
      expect(headers.get('If-Match')).toBe('"2"');
      expect(JSON.parse(String(init?.body))).toEqual(body);
    }
    await api.lookup(item.id, 'lookup-key', signal);
    expect(fetcher.mock.calls[2]?.[1]?.body).toBe('{}');
  });
});
