import type { RuntimeSourcePort } from '@imbox/application';
import { sql } from '@imbox/db';
import { authorizeResourceScope } from '@imbox/resources';
import type { KnowledgeService } from './service.js';
import { fail } from './shared.js';
/** Explicit references never grant a wider audience or turn user text into instructions. */
export function knowledgeRuntimeSourcePort(knowledge: KnowledgeService): RuntimeSourcePort {
  return {
    async read(tx, { creator, agent, reference, scope }) {
      const raw =
        reference.type === 'memory'
          ? (
              await sql<{
                conversation_id: string | null;
                task_id: string | null;
              }>`select conversation_id,task_id from memory_items where id=${reference.id}`.execute(
                tx,
              )
            ).rows[0]
          : (
              await sql<{
                conversation_id: string | null;
                task_id: string | null;
              }>`select a.conversation_id,a.task_id from artifact_versions av join artifacts a on a.tenant_id=av.tenant_id and a.id=av.artifact_id where av.id=${reference.id}`.execute(
                tx,
              )
            ).rows[0];
      if (!raw) fail('NOT_FOUND', 404);
      // Personal memory needs a future explicit Run-scoped disclosure grant; no implicit widening.
      if (
        (scope.conversationId && (raw.conversation_id !== scope.conversationId || raw.task_id)) ||
        (scope.taskId && (raw.task_id !== scope.taskId || raw.conversation_id)) ||
        (!scope.conversationId && !scope.taskId)
      )
        fail('DISCLOSURE_DENIED', 403);
      const creatorFence = await authorizeResourceScope(tx, creator, raw);
      const agentFence = await authorizeResourceScope(tx, agent, raw);
      if (reference.type === 'memory') {
        const a = await knowledge.readMemoryTx(tx, creator, reference.id);
        const b = await knowledge.readMemoryTx(tx, agent, reference.id);
        if (
          a.version !== reference.version ||
          a.sha256 !== reference.sha256 ||
          b.version !== a.version ||
          b.sha256 !== a.sha256
        )
          fail('VERSION_CONFLICT', 409);
        return {
          payload: {
            body: a.body,
            memory_id: a.id,
            source_refs: a.source_refs,
            confirmation: a.confirmation,
          },
          authorization: {
            creator: creatorFence,
            agent: agentFence,
            source_sha256: a.sha256,
            memory_version: a.version,
            expires_at: a.expires_at,
          },
        };
      }
      const ref = {
        kind: 'artifact_version' as const,
        id: reference.id,
        version: reference.version,
        sha256: reference.sha256,
      };
      const a = await knowledge.readSourceTx(tx, creator, ref);
      const b = await knowledge.readSourceTx(tx, agent, ref);
      if (a.sha256 !== b.sha256 || a.version !== b.version) fail('VERSION_CONFLICT', 409);
      return {
        payload: { body: a.body, title: a.title, artifact_version_id: a.id },
        authorization: {
          creator: creatorFence,
          agent: agentFence,
          source_sha256: a.sha256,
          artifact_version: a.version,
        },
      };
    },
  };
}
