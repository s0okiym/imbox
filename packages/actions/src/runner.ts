import type { AuthContext } from '@imbox/application';
import type { LeaseClaim } from '@imbox/runtime';
import type { ActionService } from './service.js';
import type { ToolObservation } from './tools.js';
/** Internal worker object. Never mount these methods as authenticated user HTTP routes. */
export function createToolRunner(options: { actions: ActionService; workerId: string }) {
  return {
    async runOnce(
      tenantId: string,
      actionId: string,
      runClaim?: LeaseClaim,
      machine?: AuthContext,
    ) {
      const claim = await options.actions.claim(
        tenantId,
        actionId,
        options.workerId,
        runClaim,
        machine,
      );
      let admitted: Awaited<ReturnType<ActionService['dispatch']>>;
      try {
        await options.actions.persistIntent(claim);
        admitted = await options.actions.dispatch(claim);
      } catch (error) {
        await options.actions.abortPrepared(claim);
        throw error;
      }
      // This is deliberately outside every SQL transaction. Invocation parameters come only from persisted admission.
      let observation: ToolObservation;
      try {
        observation = await admitted.tool.execute(admitted.call);
      } catch {
        observation = { status: 'unknown', reason: 'timeout_or_disconnect' };
      }
      return options.actions.recordOutcome(claim, observation, !runClaim);
    },
    async scan(tenantId: string) {
      await options.actions.auditJournal(tenantId);
      await options.actions.expireLeases(tenantId);
      return options.actions.pending(tenantId);
    },
  };
}
