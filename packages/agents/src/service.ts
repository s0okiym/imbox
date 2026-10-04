import { recordPolicy, type PolicyLedger, type RuntimeSourcePort } from '@imbox/application';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  CursorCodec,
  appendEvent,
  authorizeTenant,
  authorizeWorkspace,
  command,
  fail,
  type AuthContext,
} from '@imbox/application';
import {
  assertContract,
  type RegisterAgentInput,
  type IssueAgentCredentialInput,
  type MachineTokenInput,
  type MachineReportInput,
} from '@imbox/contracts';
import { sql, withTenant, lockPrincipal, type Db, type TenantTransaction as Tx } from '@imbox/db';
import { createRuntimeWorker, createRuntimeService } from '@imbox/runtime';

type Installation = {
  id: string;
  agent_principal_id: string;
  mode: 'hosted' | 'device' | 'external';
  status: 'active' | 'disabled';
  authz_revision: string;
  version: string;
  allowed_scopes: string[];
};
type Credential = {
  id: string;
  installation_id: string;
  secret_hash: string;
  scopes: string[];
  status: 'active' | 'revoked';
  revision: string;
  expires_at: Date;
  valid: boolean;
};
type Token = {
  id: string;
  token_hash: string;
  installation_id: string;
  credential_id: string;
  principal_id: string;
  scopes: string[];
  installation_revision: string;
  credential_revision: string;
  principal_version: string;
  tenant_authz_revision: string;
  expires_at: Date;
};
type Provision = {
  id: string;
  principal_id: string;
  installation_id: string;
  request_hash: string;
  status: 'reserved' | 'awaiting_activation' | 'ready';
};
const json = (value: unknown) => JSON.stringify(value);
const canonical = (v: unknown): string =>
  v !== null && typeof v === 'object'
    ? Array.isArray(v)
      ? `[${v.map(canonical).join(',')}]`
      : `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
          .join(',')}}`
    : JSON.stringify(v);
const digest = (value: unknown): string =>
  createHash('sha256').update(canonical(value)).digest('hex');
const credentialDto = (c: Credential) => ({
  id: c.id,
  installation_id: c.installation_id,
  scopes: c.scopes,
  status: c.status,
  revision: c.revision,
  expires_at: c.expires_at.toISOString(),
});
const subset = (requested: string[], permitted: string[]) => {
  if (!requested.length || requested.some((s) => !permitted.includes(s))) fail('FORBIDDEN', 403);
};

export function createAgentService(options: {
  db: Db;
  identityDb: Db;
  secret: string;
  policyLedger?: PolicyLedger;
  sources?: RuntimeSourcePort;
}) {
  if (options.secret.length < 32)
    throw new Error('Agent token hashing secret must be at least 32 characters');
  const runtime = createRuntimeService({
    db: options.db,
    cursorSecret: options.secret,
    ...(options.sources ? { sources: options.sources } : {}),
  });
  const secretHash = (value: string) =>
    createHmac('sha256', options.secret).update('imbox.machine.v1\0').update(value).digest('hex');
  const equal = (value: string, hash: string) => {
    const a = Buffer.from(secretHash(value), 'hex'),
      b = Buffer.from(hash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  };
  function parse(value: string, kind: 'cred' | 'token') {
    if (typeof value !== 'string' || value.length > 256) fail('UNAUTHENTICATED', 401);
    const match = new RegExp(
      `^imbox_${kind}_([0-9a-f-]{36})\\.([0-9a-f-]{36})\\.([A-Za-z0-9_-]{43})$`,
    ).exec(value);
    if (!match) fail('UNAUTHENTICATED', 401);
    try {
      return {
        tenantId: assertContract('Identifier', match[1]),
        id: assertContract('Identifier', match[2]),
      };
    } catch {
      return fail('UNAUTHENTICATED', 401);
    }
  }
  async function admin(tx: Tx, auth: AuthContext) {
    await authorizeTenant(tx, auth);
    const p = await lockPrincipal(tx, auth.principalId);
    const m = await tx
      .selectFrom('tenant_principals')
      .select('role')
      .where('principal_id', '=', auth.principalId)
      .executeTakeFirstOrThrow();
    if (
      auth.kind !== 'human' ||
      p?.kind !== 'human' ||
      p.status !== 'active' ||
      !['owner', 'admin'].includes(m.role)
    )
      fail('FORBIDDEN', 403);
  }
  async function installation(tx: Tx, id: string, write = false) {
    assertContract('Identifier', id);
    return (
      (
        await sql<Installation>`select * from agent_installations where id=${id} ${write ? sql`for update` : sql`for share`}`.execute(
          tx,
        )
      ).rows[0] ?? fail('NOT_FOUND', 404)
    );
  }
  async function dto(tx: Tx, id: string) {
    const a = await installation(tx, id);
    const p = await tx
      .selectFrom('principals')
      .select('display_name')
      .where('id', '=', a.agent_principal_id)
      .executeTakeFirstOrThrow();
    const rev =
      (
        await sql<{
          revision: string;
          capabilities: string[];
        }>`select revision,capabilities from agent_revisions where agent_id=${id} order by revision desc limit 1`.execute(
          tx,
        )
      ).rows[0] ?? fail('NOT_FOUND', 404);
    return {
      id: a.id,
      principal_id: a.agent_principal_id,
      display_name: p.display_name,
      mode: a.mode,
      status: a.status,
      revision: rev.revision,
      version: a.version,
      scopes: a.allowed_scopes,
      capabilities: rev.capabilities,
    };
  }
  async function audit(tx: Tx, auth: AuthContext, id: string, type: string, version?: string) {
    const eventVersion =
      version ??
      (
        await sql<{
          version: string;
        }>`update agent_installations set version=version+1,updated_at=clock_timestamp() where id=${id} returning version`.execute(
          tx,
        )
      ).rows[0]!.version;
    await appendEvent(tx, auth, {
      aggregateType: 'agent',
      aggregateId: id,
      type,
      version: eventVersion,
      payload: {},
      target: `agent:${id}`,
    });
  }
  async function authForToken(tx: Tx, tenantId: string, row: Token): Promise<AuthContext> {
    const auth: AuthContext = {
      tenantId,
      principalId: row.principal_id,
      kind: 'agent',
      authzRevision: row.tenant_authz_revision,
      machine: {
        installationId: row.installation_id,
        installationRevision: row.installation_revision,
        credentialId: row.credential_id,
        credentialRevision: row.credential_revision,
        tokenId: row.id,
        principalVersion: row.principal_version,
      },
    };
    await authorizeTenant(tx, auth);
    return auth;
  }
  function worker(auth: AuthContext) {
    const m = auth.machine ?? fail('UNAUTHENTICATED', 401);
    return createRuntimeWorker({
      db: options.db,
      ...(options.sources ? { sources: options.sources } : {}),
      workerId: `external:${m.installationId}:${m.credentialId}`,
      claimActor: auth,
      authorizeExecution: async (tx, runId) => {
        await authorizeTenant(tx, auth);
        const row = (
          await sql<{
            agent_id: string;
            execution_location: string;
          }>`select agent_id,execution_location from agent_runs where id=${runId}`.execute(tx)
        ).rows[0];
        if (row?.agent_id !== m.installationId || row.execution_location !== 'external')
          fail('NOT_FOUND', 404);
      },
    });
  }
  return {
    async register(auth: AuthContext, raw: RegisterAgentInput, key: string) {
      const input = assertContract('RegisterAgentInput', raw);
      assertContract('IdempotencyKey', key);
      if (
        (input.mode === 'hosted' && input.config.model_alias !== 'local') ||
        (input.mode === 'external' && Object.keys(input.config).length)
      )
        fail('VALIDATION_FAILED', 400);
      // Global identities and tenant resources use separate least-privilege pools. Each durable stage is resumable.
      const request = await withTenant(options.db, auth.tenantId, async (tx) => {
        await admin(tx, auth);
        const w = await authorizeWorkspace(tx, auth, input.workspace_id);
        if (w.role !== 'admin') fail('FORBIDDEN', 403);
        await sql`insert into agent_provisioning_requests(tenant_id,id,created_by,idempotency_key,request_hash,principal_id,installation_id) values(${auth.tenantId},${randomUUID()},${auth.principalId},${key},${digest(input)},${randomUUID()},${randomUUID()}) on conflict do nothing`.execute(
          tx,
        );
        const row = (
          await sql<Provision>`select * from agent_provisioning_requests where created_by=${auth.principalId} and idempotency_key=${key} for update`.execute(
            tx,
          )
        ).rows[0]!;
        if (row.request_hash !== digest(input)) fail('IDEMPOTENCY_CONFLICT', 409);
        return row;
      });
      if (request.status === 'ready')
        return withTenant(options.db, auth.tenantId, async (tx) => {
          await admin(tx, auth);
          return dto(tx, request.installation_id);
        });
      await options.identityDb
        .insertInto('principals')
        .values({
          id: request.principal_id,
          kind: 'agent',
          display_name: input.display_name,
          status: 'disabled',
        })
        .onConflict((c) => c.column('id').doNothing())
        .execute();
      await withTenant(options.db, auth.tenantId, async (tx) => {
        await admin(tx, auth);
        const w = await authorizeWorkspace(tx, auth, input.workspace_id);
        if (w.role !== 'admin') fail('FORBIDDEN', 403);
        const row = (
          await sql<Provision>`select * from agent_provisioning_requests where id=${request.id} for update`.execute(
            tx,
          )
        ).rows[0]!;
        if (row.status !== 'reserved') return;
        await tx
          .insertInto('tenant_principals')
          .values({
            tenant_id: auth.tenantId,
            principal_id: request.principal_id,
            role: 'agent',
            status: 'disabled',
          })
          .execute();
        await tx
          .insertInto('memberships')
          .values({
            tenant_id: auth.tenantId,
            workspace_id: input.workspace_id,
            principal_id: request.principal_id,
            role: 'member',
            status: 'disabled',
          })
          .execute();
        await sql`insert into agent_installations(tenant_id,id,agent_principal_id,mode,status,created_by,allowed_scopes) values(${auth.tenantId},${request.installation_id},${request.principal_id},${input.mode},'disabled',${auth.principalId},${json(input.scopes)}::jsonb)`.execute(
          tx,
        );
        await sql`insert into agent_revisions(tenant_id,agent_id,revision,config,config_hash,capabilities) values(${auth.tenantId},${request.installation_id},1,${json(input.config)}::jsonb,${digest(input.config)},${json(input.capabilities)}::jsonb)`.execute(
          tx,
        );
        await sql`update agent_provisioning_requests set status='awaiting_activation',updated_at=clock_timestamp() where id=${request.id}`.execute(
          tx,
        );
      });
      await options.identityDb
        .updateTable('principals')
        .set({ status: 'active', version: sql`version+1` })
        .where('id', '=', request.principal_id)
        .where('status', '=', 'disabled')
        .where('version', '=', '1')
        .execute();
      return withTenant(options.db, auth.tenantId, async (tx) => {
        await admin(tx, auth);
        const w = await authorizeWorkspace(tx, auth, input.workspace_id);
        if (w.role !== 'admin') fail('FORBIDDEN', 403);
        const row = (
          await sql<Provision>`select * from agent_provisioning_requests where id=${request.id} for update`.execute(
            tx,
          )
        ).rows[0]!;
        if (row.status === 'awaiting_activation') {
          await tx
            .updateTable('tenant_principals')
            .set({ status: 'active' })
            .where('principal_id', '=', request.principal_id)
            .execute();
          await tx
            .updateTable('memberships')
            .set({ status: 'active' })
            .where('principal_id', '=', request.principal_id)
            .where('workspace_id', '=', input.workspace_id)
            .execute();
          await sql`update agent_installations set status='active' where id=${request.installation_id}`.execute(
            tx,
          );
          await sql`update agent_provisioning_requests set status='ready',updated_at=clock_timestamp() where id=${request.id}`.execute(
            tx,
          );
          await audit(tx, auth, request.installation_id, 'agent.registered', '1');
        }
        return dto(tx, request.installation_id);
      });
    },
    async directory(auth: AuthContext, workspaceId: string) {
      assertContract('Identifier', workspaceId);
      return withTenant(options.db, auth.tenantId, async (tx) => {
        await authorizeTenant(tx, auth);
        await authorizeWorkspace(tx, auth, workspaceId);
        const rows = (
          await sql<{
            id: string;
          }>`select a.id from agent_installations a join memberships m on m.tenant_id=a.tenant_id and m.principal_id=a.agent_principal_id where m.workspace_id=${workspaceId} and m.status='active' order by a.created_at desc,a.id limit 200`.execute(
            tx,
          )
        ).rows;
        const items = [];
        for (const row of rows) items.push(await dto(tx, row.id));
        return { items };
      });
    },
    async managementAccess(auth: AuthContext) {
      return withTenant(options.db, auth.tenantId, async (tx) => {
        await authorizeTenant(tx, auth);
        const member = await tx
          .selectFrom('tenant_principals')
          .select('role')
          .where('principal_id', '=', auth.principalId)
          .executeTakeFirstOrThrow();
        return {
          can_manage:
            auth.kind === 'human' && !auth.machine && ['owner', 'admin'].includes(member.role),
        };
      });
    },
    async credentials(
      auth: AuthContext,
      agentId: string,
      query: { cursor?: string; limit?: number } = {},
    ) {
      return withTenant(options.db, auth.tenantId, async (tx) => {
        await admin(tx, auth);
        await installation(tx, agentId);
        const limit = query.limit ?? 50;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
          fail('VALIDATION_FAILED', 400);
        const codec = new CursorCodec(options.secret),
          binding = JSON.stringify([
            auth.tenantId,
            auth.principalId,
            auth.authzRevision,
            agentId,
            'agent-credentials:v1',
          ]);
        const after = query.cursor ? codec.decode(query.cursor, binding) : null;
        if (after && !/^[a-f0-9-]{36}$/.test(after)) fail('RESYNC_REQUIRED', 409);
        const rows = (
          await sql<Credential>`select * from agent_credentials where installation_id=${agentId} ${after ? sql`and id>${after}::uuid` : sql``} order by id limit ${limit + 1}`.execute(
            tx,
          )
        ).rows;
        const page = rows.slice(0, limit);
        return {
          items: page.map(credentialDto),
          ...(rows.length > limit ? { next_cursor: codec.encode(binding, page.at(-1)!.id) } : {}),
        };
      });
    },
    async issueCredential(
      auth: AuthContext,
      agentId: string,
      raw: IssueAgentCredentialInput,
      key: string,
    ) {
      const input = assertContract('IssueAgentCredentialInput', raw);
      let secret: string | null = null;
      return withTenant(options.db, auth.tenantId, async (tx) => {
        await admin(tx, auth);
        const a = await installation(tx, agentId, true);
        if (a.status !== 'active' || a.mode !== 'external') fail('FORBIDDEN', 403);
        subset(input.scopes, a.allowed_scopes);
        const id = await command(
          tx,
          auth,
          'agent.credential.issue',
          key,
          { agentId, input },
          async () => {
            const credentialId = randomUUID();
            secret = `imbox_cred_${auth.tenantId}.${credentialId}.${randomBytes(32).toString('base64url')}`;
            await sql`insert into agent_credentials(tenant_id,id,installation_id,secret_hash,scopes,created_by,expires_at) values(${auth.tenantId},${credentialId},${agentId},${secretHash(secret)},${json(input.scopes)}::jsonb,${auth.principalId},clock_timestamp()+${input.lifetime_seconds}*interval '1 second')`.execute(
              tx,
            );
            await audit(tx, auth, agentId, 'agent.credential_issued');
            return credentialId;
          },
        );
        const row = (
          await sql<Credential>`select * from agent_credentials where id=${id}`.execute(tx)
        ).rows[0]!;
        return { credential: credentialDto(row), secret, secret_returned: secret !== null };
      });
    },
    async revokeCredential(auth: AuthContext, credentialId: string, key: string) {
      assertContract('Identifier', credentialId);
      return withTenant(options.db, auth.tenantId, async (tx) => {
        await admin(tx, auth);
        const initial =
          (
            await sql<Credential>`select * from agent_credentials where id=${credentialId}`.execute(
              tx,
            )
          ).rows[0] ?? fail('NOT_FOUND', 404);
        await installation(tx, initial.installation_id, true);
        await command(tx, auth, 'agent.credential.revoke', key, { credentialId }, async () => {
          if (initial.status === 'active')
            await recordPolicy(tx, auth, options.policyLedger, {
              kind: 'revocation.credential',
              target_id: credentialId,
              target_version: initial.revision,
            });
          await sql`update agent_credentials set status='revoked',revision=revision+1,revoked_at=clock_timestamp() where id=${credentialId} and status='active'`.execute(
            tx,
          );
          await sql`update agent_access_tokens set revoked_at=clock_timestamp() where credential_id=${credentialId} and revoked_at is null`.execute(
            tx,
          );
          await audit(tx, auth, initial.installation_id, 'agent.credential_revoked');
          return credentialId;
        });
        return credentialDto(
          (
            await sql<Credential>`select * from agent_credentials where id=${credentialId}`.execute(
              tx,
            )
          ).rows[0]!,
        );
      });
    },
    async disable(auth: AuthContext, agentId: string, key: string) {
      return withTenant(options.db, auth.tenantId, async (tx) => {
        await admin(tx, auth);
        await installation(tx, agentId, true);
        await command(tx, auth, 'agent.disable', key, { agentId }, async () => {
          const current = await installation(tx, agentId);
          if (current.status === 'active')
            await recordPolicy(tx, auth, options.policyLedger, {
              kind: 'revocation.agent',
              target_id: agentId,
              target_version: current.version,
            });
          await sql`update agent_installations set status='disabled',authz_revision=authz_revision+1,version=version+1,updated_at=clock_timestamp() where id=${agentId} and status='active'`.execute(
            tx,
          );
          await sql`update agent_access_tokens set revoked_at=clock_timestamp() where installation_id=${agentId} and revoked_at is null`.execute(
            tx,
          );
          await audit(
            tx,
            auth,
            agentId,
            'agent.disabled',
            (await installation(tx, agentId)).version,
          );
          return agentId;
        });
        return dto(tx, agentId);
      });
    },
    async exchange(raw: MachineTokenInput) {
      const input = assertContract('MachineTokenInput', raw),
        parsed = parse(input.credential, 'cred');
      return withTenant(options.db, parsed.tenantId, async (tx) => {
        const c = (
          await sql<Credential>`select *,status='active' and expires_at>clock_timestamp() as valid from agent_credentials where id=${parsed.id}`.execute(
            tx,
          )
        ).rows[0];
        if (!c || !equal(input.credential, c.secret_hash)) fail('UNAUTHENTICATED', 401);
        const initial =
          (
            await sql<Installation>`select * from agent_installations where id=${c.installation_id}`.execute(
              tx,
            )
          ).rows[0] ?? fail('UNAUTHENTICATED', 401);
        const a = initial;
        const m = await tx
          .selectFrom('tenant_principals')
          .select(['authz_revision', 'status'])
          .where('principal_id', '=', a.agent_principal_id)
          .executeTakeFirst();
        if (m?.status !== 'active') fail('UNAUTHENTICATED', 401);
        const auth: AuthContext = {
          tenantId: parsed.tenantId,
          principalId: a.agent_principal_id,
          kind: 'agent',
          authzRevision: m.authz_revision,
        };
        await authorizeTenant(tx, auth);
        const p = (await lockPrincipal(tx, a.agent_principal_id)) ?? fail('UNAUTHENTICATED', 401);
        const currentInstallation = await installation(tx, c.installation_id);
        if (
          p.kind !== 'agent' ||
          p.status !== 'active' ||
          currentInstallation.status !== 'active' ||
          currentInstallation.authz_revision !== a.authz_revision ||
          a.mode !== 'external'
        )
          fail('UNAUTHENTICATED', 401);
        const current = (
          await sql<Credential>`select *,status='active' and expires_at>clock_timestamp() as valid from agent_credentials where id=${c.id} for update`.execute(
            tx,
          )
        ).rows[0]!;
        if (!current.valid) fail('UNAUTHENTICATED', 401);
        subset(input.scopes, current.scopes);
        subset(input.scopes, a.allowed_scopes);
        const count = (
          await sql<{
            count: string;
          }>`select count(*) from agent_access_tokens where credential_id=${c.id} and revoked_at is null and expires_at>clock_timestamp()`.execute(
            tx,
          )
        ).rows[0]!;
        if (BigInt(count.count) >= 20n) fail('RATE_LIMITED', 429);
        const tokenId = randomUUID(),
          token = `imbox_token_${parsed.tenantId}.${tokenId}.${randomBytes(32).toString('base64url')}`;
        const result = (
          await sql<{
            expires_at: Date;
          }>`insert into agent_access_tokens(tenant_id,id,token_hash,installation_id,credential_id,principal_id,audience,scopes,installation_revision,credential_revision,principal_version,tenant_authz_revision,expires_at) values(${parsed.tenantId},${tokenId},${secretHash(token)},${a.id},${c.id},${a.agent_principal_id},'imbox-api',${json(input.scopes)}::jsonb,${a.authz_revision},${current.revision},${p.version},${m.authz_revision},least(clock_timestamp()+interval '15 minutes',${current.expires_at})) returning expires_at`.execute(
            tx,
          )
        ).rows[0]!;
        return {
          access_token: token,
          token_type: 'Bearer' as const,
          expires_at: result.expires_at.toISOString(),
          scopes: input.scopes,
        };
      });
    },
    async authenticate(authorization: string | undefined, tenantId: string, scope: string) {
      if (!authorization?.startsWith('Bearer ')) fail('UNAUTHENTICATED', 401);
      const token = authorization.slice(7),
        parsed = parse(token, 'token');
      if (parsed.tenantId !== tenantId) fail('UNAUTHENTICATED', 401);
      return withTenant(options.db, tenantId, async (tx) => {
        const row = (
          await sql<Token>`select * from agent_access_tokens where id=${parsed.id}`.execute(tx)
        ).rows[0];
        if (!row || !equal(token, row.token_hash)) fail('UNAUTHENTICATED', 401);
        const auth = await authForToken(tx, tenantId, row);
        if (!row.scopes.includes(scope)) fail('FORBIDDEN', 403);
        return auth;
      });
    },
    async claim(auth: AuthContext, runId: string, key: string) {
      assertContract('Identifier', runId);
      assertContract('IdempotencyKey', key);
      const result = await worker(auth).claim(auth.tenantId, runId, key);
      return { lease: result ? { run_id: result.runId, generation: result.generation } : null };
    },
    async heartbeat(auth: AuthContext, runId: string, generation: string) {
      assertContract('Identifier', runId);
      assertContract('Version', generation);
      const w = worker(auth);
      return w.heartbeat({
        tenantId: auth.tenantId,
        runId,
        holder: `external:${auth.machine!.installationId}:${auth.machine!.credentialId}`,
        generation,
      });
    },
    async report(auth: AuthContext, runId: string, raw: MachineReportInput, key: string) {
      assertContract('Identifier', runId);
      const { generation, ...input } = assertContract('MachineReportInput', raw);
      return worker(auth).report(
        {
          tenantId: auth.tenantId,
          runId,
          holder: `external:${auth.machine!.installationId}:${auth.machine!.credentialId}`,
          generation,
        },
        input,
        key,
      );
    },
    async listRuns(auth: AuthContext) {
      const m = auth.machine ?? fail('UNAUTHENTICATED', 401);
      const ids = await withTenant(options.db, auth.tenantId, async (tx) => {
        await authorizeTenant(tx, auth);
        return (
          await sql<{
            id: string;
          }>`select id from agent_runs where agent_id=${m.installationId} and execution_location='external' and status in ('queued','running','waiting_input','waiting_approval','waiting_dependency','paused','cancelling') order by created_at desc,id limit 100`.execute(
            tx,
          )
        ).rows;
      });
      const items = [];
      for (const row of ids) {
        try {
          items.push(await runtime.getRun(auth, row.id));
        } catch (error) {
          if (!(
            error instanceof Error &&
            'status' in error &&
            [403, 404, 409].includes(Number(error.status))
          ))
            throw error;
        }
      }
      return { items };
    },
  };
}
export type AgentService = ReturnType<typeof createAgentService>;
