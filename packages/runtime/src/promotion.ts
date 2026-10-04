import {
  authorizeConversation,
  type RuntimeSourcePort,
  type RunPromotionPort,
} from '@imbox/application';
import { isTerminalRunStatus } from '@imbox/domain';
import { fail, liveActors, runRow, verifyContext, principal } from './shared.js';
/** Promotion records new authorization; it never rewrites the original Run's scope or budget. */
export function runtimePromotionPort(
  options: { sources?: RuntimeSourcePort } = {},
): RunPromotionPort {
  return {
    async validate(tx, auth, id, version, purpose) {
      const run = await runRow(tx, id);
      if (!run.conversation_id || run.task_id || run.created_by !== auth.principalId)
        fail('NOT_FOUND', 404);
      const actor = await principal(tx, auth.principalId);
      if (actor.kind !== auth.kind || actor.status !== 'active') fail('FORBIDDEN', 403);
      if (purpose === 'create' && auth.kind !== 'human') fail('FORBIDDEN', 403);
      const conversation = await authorizeConversation(tx, auth, run.conversation_id);
      const actors = await liveActors(tx, run);
      await verifyContext(tx, run, actors.creator, actors.agent, options.sources);
      // Terminal status is immutable. No unfinished generation acquires new authority by promotion.
      if (!isTerminalRunStatus(run.status) || run.version !== version)
        fail('VERSION_CONFLICT', 409);
      if (!conversation.row.workspace_id) fail('NOT_FOUND', 404);
      return {
        conversationId: run.conversation_id,
        workspaceId: conversation.row.workspace_id,
        manifestId: run.context_manifest_id,
      };
    },
  };
}
