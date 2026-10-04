import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { sql, withTenant, type Db } from '@imbox/db';
import { assertContract, type ContractTypes as C } from '@imbox/contracts';
import {
  appendEvent,
  authorizeTenant,
  command,
  ApplicationError,
  type AuthContext,
  type MessagingService,
  type TaskService,
} from '@imbox/application';
import {
  authorizeResourceScope,
  type ResourceService,
  type ArtifactCollaborationService,
} from '@imbox/resources';
import type { KnowledgeService } from '@imbox/knowledge';
interface Job {
  id: string;
  created_by: string;
  scope: 'conversation' | 'task' | 'personal';
  scope_id: string | null;
  created_at: Date;
  expires_at: Date;
  live: boolean;
}
const fail = (code: string, status: number): never => {
  throw new ApplicationError(code, status);
};
export function createGovernanceService(options: {
  db: Db;
  messaging: MessagingService;
  tasks: TaskService;
  knowledge: KnowledgeService;
  resources?: ResourceService;
  collaboration?: ArtifactCollaborationService;
  independentLedger: boolean;
  messageDays?: number;
  resourceDays?: number;
  runContentDays?: number;
  offlineMessageCacheAllowed?: boolean;
  offlineQueueAllowed?: boolean;
}) {
  const policy = assertContract('GovernancePolicy', {
    message_days: options.messageDays ?? 365,
    resource_days: options.resourceDays ?? 365,
    run_content_days: options.runContentDays ?? 7,
    export_hours: 24,
    independent_ledger: options.independentLedger,
    scope: 'deployment',
    external_copies: 'not_recallable',
    offline_message_cache_allowed: options.offlineMessageCacheAllowed ?? false,
    offline_queue_allowed: options.offlineQueueAllowed ?? true,
    offline_queue_max_days: 7,
    workspace_policy: 'inherits_deployment',
  });
  const human = (auth: AuthContext) => {
    if (auth.kind !== 'human' || auth.machine) fail('FORBIDDEN', 403);
  };
  const scopeOf = (j: Pick<Job, 'scope' | 'scope_id'>) =>
    j.scope === 'conversation'
      ? { conversation_id: j.scope_id! }
      : j.scope === 'task'
        ? { task_id: j.scope_id! }
        : {};
  const aclScope = (j: Pick<Job, 'scope' | 'scope_id'>) => ({
    conversation_id: j.scope === 'conversation' ? j.scope_id : null,
    task_id: j.scope === 'task' ? j.scope_id : null,
  });
  const dto = (j: Job) =>
    assertContract('ExportJob', {
      id: j.id,
      scope: j.scope,
      scope_id: j.scope_id,
      created_at: j.created_at.toISOString(),
      expires_at: j.expires_at.toISOString(),
      format: 'imbox.ndjson.v1',
      consistency: 'live_authorized_reads',
      content_url: `/v1/exports/${j.id}/content`,
    });
  async function get(auth: AuthContext, id: string) {
    human(auth);
    return withTenant(options.db, auth.tenantId, async (tx) => {
      await authorizeTenant(tx, auth);
      const j =
        (
          await sql<Job>`select *,expires_at>clock_timestamp() as live from governance_exports where id=${id} and created_by=${auth.principalId}`.execute(
            tx,
          )
        ).rows[0] ?? fail('NOT_FOUND', 404);
      if (!j.live) fail('NOT_FOUND', 404);
      if (j.scope !== 'personal') await authorizeResourceScope(tx, auth, aclScope(j));
      return j;
    });
  }
  return {
    async policy(auth: AuthContext) {
      await withTenant(options.db, auth.tenantId, (tx) => authorizeTenant(tx, auth));
      return policy;
    },
    async createExport(auth: AuthContext, input: C['CreateExportInput'], key: string) {
      human(auth);
      assertContract('CreateExportInput', input);
      if ((input.scope === 'personal') === !!input.scope_id) fail('VALIDATION_FAILED', 400);
      const id = await withTenant(options.db, auth.tenantId, async (tx) => {
        await authorizeTenant(tx, auth);
        return command(tx, auth, 'export.create', key, input, async () => {
          await sql`select pg_advisory_xact_lock(hashtextextended(${`exports:${auth.principalId}`},0))`.execute(
            tx,
          );
          if (input.scope !== 'personal')
            await authorizeResourceScope(
              tx,
              auth,
              aclScope({ scope: input.scope, scope_id: input.scope_id ?? null }),
            );
          const count = (
            await sql<{
              n: string;
            }>`select count(*) as n from governance_exports where created_by=${auth.principalId} and expires_at>clock_timestamp()`.execute(
              tx,
            )
          ).rows[0]!;
          if (Number(count.n) >= 50) fail('RATE_LIMITED', 429);
          const id = randomUUID();
          await sql`insert into governance_exports(tenant_id,id,created_by,scope,scope_id) values(${auth.tenantId},${id},${auth.principalId},${input.scope},${input.scope_id ?? null})`.execute(
            tx,
          );
          await appendEvent(tx, auth, {
            aggregateType: 'export',
            aggregateId: id,
            version: '1',
            type: 'export.created',
            payload: { scope: input.scope, scope_id: input.scope_id ?? null },
            target: `principal:${auth.principalId}`,
          });
          return id;
        });
      });
      return dto(await get(auth, id));
    },
    async getExport(auth: AuthContext, id: string) {
      return dto(await get(auth, id));
    },
    async content(
      auth: AuthContext,
      id: string,
      reauthorize: () => Promise<AuthContext> = async () => auth,
    ) {
      const job = await get(auth, id),
        scope = scopeOf(job),
        hash = createHash('sha256');
      let count = 0;
      async function authorize() {
        const current = await reauthorize();
        if (current.tenantId !== auth.tenantId || current.principalId !== auth.principalId)
          fail('FORBIDDEN', 403);
        await get(current, id);
        return current;
      }
      const line = (type: string, data: unknown) => {
        const value = JSON.stringify({ type, data }) + '\n';
        hash.update(value);
        count++;
        return value;
      };
      async function* pages<T>(
        fetchPage: (
          auth: AuthContext,
          cursor?: string,
        ) => Promise<{ items: T[]; next_cursor?: string }>,
      ) {
        let cursor: string | undefined;
        do {
          const page = await fetchPage(await authorize(), cursor);
          for (const item of page.items) yield item;
          cursor = page.next_cursor;
          if (count > 500000) fail('EXPORT_TOO_LARGE', 413);
        } while (cursor);
      }
      async function* records() {
        try {
          yield line('manifest', {
            ...dto(job),
            attachments: !!options.resources,
            ordering: 'paged',
            complete_marker_required: true,
          });
          if (job.scope === 'conversation') {
            yield line(
              'conversation',
              await options.messaging.getConversation(await authorize(), job.scope_id!),
            );
            for await (const item of pages((current, cursor) =>
              options.messaging.listMessages(current, job.scope_id!, {
                ...(cursor ? { cursor } : {}),
                limit: 100,
              }),
            )) {
              yield line('message', await options.messaging.getMessage(await authorize(), item.id));
            }
          }
          if (job.scope === 'task') {
            yield line('task', await options.tasks.getTask(await authorize(), job.scope_id!));
            yield line(
              'participants',
              await options.tasks.participants(await authorize(), job.scope_id!),
            );
          }
          for await (const item of pages((current, cursor) =>
            options.knowledge.listMemories(current, {
              ...scope,
              ...(cursor ? { cursor } : {}),
              limit: 50,
            }),
          )) {
            if (job.scope === 'personal' && item.scope !== 'personal') continue;
            yield line('memory', await options.knowledge.getMemory(await authorize(), item.id));
          }
          if (options.resources && job.scope !== 'personal') {
            const resources = options.resources;
            for await (const item of pages((current, cursor) =>
              resources.listArtifacts(current, {
                ...scope,
                ...(cursor ? { cursor } : {}),
                limit: 100,
              }),
            )) {
              yield line('artifact', await resources.getArtifact(await authorize(), item.id));
              for await (const version of pages((current, cursor) =>
                resources.listArtifactVersions(current, item.id, {
                  ...(cursor ? { cursor } : {}),
                  limit: 100,
                }),
              )) {
                yield line('artifact_version', version);
                if (options.collaboration)
                  for await (const comment of pages((current, cursor) =>
                    options.collaboration!.listComments(current, item.id, {
                      version_id: version.id,
                      ...(cursor ? { cursor } : {}),
                      limit: 100,
                    }),
                  ))
                    yield line('artifact_comment', comment);
              }
              if (options.collaboration)
                for await (const share of pages((current, cursor) =>
                  options.collaboration!.listShares(current, item.id, {
                    ...(cursor ? { cursor } : {}),
                    limit: 100,
                  }),
                ))
                  yield line('owned_artifact_share', share);
            }
            for await (const item of pages((current, cursor) =>
              resources.listResources(current, {
                ...scope,
                ...(cursor ? { cursor } : {}),
                limit: 100,
              }),
            )) {
              const content = await resources.openDownload(await authorize(), item.id);
              yield line('resource', content.metadata);
              let ordinal = 0;
              for await (const chunk of content.chunks()) {
                await authorize();
                yield line('resource_chunk', {
                  resource_id: item.id,
                  ordinal: ++ordinal,
                  encoding: 'base64',
                  data: Buffer.from(chunk).toString('base64'),
                });
              }
              yield line('resource_end', {
                resource_id: item.id,
                chunks: ordinal,
                sha256: content.metadata.sha256,
              });
            }
          }
          await authorize();
          yield JSON.stringify({
            type: 'complete',
            data: { records: count, sha256: hash.digest('hex') },
          }) + '\n';
        } catch {
          // Any partial download lacks a complete marker. Never expose underlying DB/ACL errors or hidden IDs.
          yield JSON.stringify({ type: 'error', data: { code: 'EXPORT_INTERRUPTED' } }) + '\n';
        }
      }
      return { stream: Readable.from(records()), records };
    },
  };
}
export type GovernanceService = ReturnType<typeof createGovernanceService>;
