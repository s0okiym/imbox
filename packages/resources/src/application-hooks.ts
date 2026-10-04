import type { MessageResourcePort, ArtifactEvidencePort } from '@imbox/application';
import { sql } from '@imbox/db';
import { fail, resource } from './shared.js';
/** Invoked inside the caller's existing business transaction; never opens a second transaction. */
export function resourceApplicationHooks(): {
  messages: MessageResourcePort;
  artifacts: ArtifactEvidencePort;
} {
  return {
    messages: {
      async attach(tx, auth, conversationId, messageId, resourceIds) {
        if (resourceIds.length > 10 || new Set(resourceIds).size !== resourceIds.length)
          fail('VALIDATION_FAILED', 400);
        let ordinal = 0;
        for (const id of resourceIds) {
          const content = await resource(tx, auth, id);
          if (content.conversation_id !== conversationId || content.task_id)
            fail('DISCLOSURE_DENIED', 403);
          await sql`insert into message_resources(tenant_id,message_id,resource_id,resource_version,ordinal) values(${auth.tenantId},${messageId},${id},${content.version},${++ordinal})`.execute(
            tx,
          );
        }
      },
    },
    artifacts: {
      async verify(tx, auth, taskId, evidence) {
        const version = (
          await sql<{
            artifact_id: string;
            resource_id: string;
            task_id: string | null;
          }>`select av.artifact_id,av.resource_id,a.task_id from artifact_versions av join artifacts a on a.tenant_id=av.tenant_id and a.id=av.artifact_id where av.id=${evidence.version_id} and av.artifact_id=${evidence.artifact_id} for share of av,a`.execute(
            tx,
          )
        ).rows[0];
        if (!version) fail('NOT_FOUND', 404);
        if (version.task_id !== taskId) fail('DISCLOSURE_DENIED', 403);
        const content = await resource(tx, auth, version.resource_id);
        if (content.task_id !== taskId || content.conversation_id) fail('DISCLOSURE_DENIED', 403);
        if (content.sha256 !== evidence.sha256) fail('VERSION_CONFLICT', 409);
        return {
          type: 'artifact_version',
          artifact_id: version.artifact_id,
          version_id: evidence.version_id,
          sha256: content.sha256,
        };
      },
    },
  };
}
