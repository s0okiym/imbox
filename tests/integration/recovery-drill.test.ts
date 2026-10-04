import { expect, it } from 'vitest';
import { runRecoveryDrill } from '../../scripts/recovery-drill.js';
it('restores a real database/object backup and reapplies independent deletion and revocation facts before reopening', async () => {
  const report = await runRecoveryDrill();
  expect(report.result).toBe('passed');
  expect(report.policy_facts_replayed).toBe(4);
}, 60000);
