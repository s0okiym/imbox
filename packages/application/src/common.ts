import { createHash, createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { sql, lockPrincipal, type TenantTransaction } from '@imbox/db';

export interface AuthContext {
  principalId: string;
  tenantId: string;
  kind: 'human' | 'agent' | 'service';
  authzRevision: string;
  machine?: {
    installationId: string;
    installationRevision: string;
    credentialId: string;
    credentialRevision: string;
    tokenId: string;
    principalVersion: string;
  };
}

export class ApplicationError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message = code,
  ) {
    super(message);
    this.name = 'ApplicationError';
  }
}

export function fail(code: string, status: number): never {
  throw new ApplicationError(code, status);
}

/** Short transactions retain policy locks until the authorized operation commits. */
export async function authorizeTenant(tx: TenantTransaction, auth: AuthContext): Promise<void> {
  const tenant = await tx
    .selectFrom('tenants')
    .select('status')
    .where('id', '=', auth.tenantId)
    .forShare()
    .executeTakeFirst();
  if (tenant?.status !== 'active') fail('NOT_FOUND', 404);
  const member = await tx
    .selectFrom('tenant_principals')
    .select(['status', 'authz_revision'])
    .where('tenant_id', '=', auth.tenantId)
    .where('principal_id', '=', auth.principalId)
    .forShare()
    .executeTakeFirst();
  if (member?.status !== 'active' || member.authz_revision !== auth.authzRevision)
    fail('FORBIDDEN', 403);
  // HTTP authentication is a preflight; retain the live global identity fence in this business transaction.
  if (!auth.machine) {
    const principal = await lockPrincipal(tx, auth.principalId);
    if (principal?.status !== 'active' || principal.kind !== auth.kind) fail('FORBIDDEN', 403);
  }
  if (auth.machine) {
    const m = auth.machine;
    const principal = await lockPrincipal(tx, auth.principalId);
    if (
      auth.kind !== 'agent' ||
      principal?.kind !== 'agent' ||
      principal.status !== 'active' ||
      principal.version !== m.principalVersion
    )
      fail('UNAUTHENTICATED', 401);
    const installation = (
      await sql<{
        agent_principal_id: string;
        status: string;
        authz_revision: string;
      }>`select agent_principal_id,status,authz_revision from agent_installations where id=${m.installationId} for share`.execute(
        tx,
      )
    ).rows[0];
    if (
      installation?.agent_principal_id !== auth.principalId ||
      installation.status !== 'active' ||
      installation.authz_revision !== m.installationRevision
    )
      fail('UNAUTHENTICATED', 401);
    const credential = (
      await sql<{
        valid: boolean;
        installation_id: string;
        revision: string;
      }>`select status='active' and expires_at>clock_timestamp() as valid,installation_id,revision from agent_credentials where id=${m.credentialId} for share`.execute(
        tx,
      )
    ).rows[0];
    if (
      !credential?.valid ||
      credential.installation_id !== m.installationId ||
      credential.revision !== m.credentialRevision
    )
      fail('UNAUTHENTICATED', 401);
    const token = (
      await sql<{
        valid: boolean;
      }>`select revoked_at is null and expires_at>clock_timestamp() and audience='imbox-api' and installation_id=${m.installationId} and credential_id=${m.credentialId} and principal_id=${auth.principalId} and installation_revision=${m.installationRevision} and credential_revision=${m.credentialRevision} and principal_version=${m.principalVersion} and tenant_authz_revision=${auth.authzRevision} as valid from agent_access_tokens where id=${m.tokenId} for share`.execute(
        tx,
      )
    ).rows[0];
    if (!token?.valid) fail('UNAUTHENTICATED', 401);
  }
}

/** Workspace authorization is a live fence, independent of tenant membership. */
export async function authorizeWorkspace(tx: TenantTransaction, auth: AuthContext, id: string) {
  const row = await tx
    .selectFrom('memberships')
    .selectAll()
    .where('tenant_id', '=', auth.tenantId)
    .where('workspace_id', '=', id)
    .where('principal_id', '=', auth.principalId)
    .where('status', '=', 'active')
    .forShare()
    .executeTakeFirst();
  if (!row) return fail('NOT_FOUND', 404);
  return row;
}

/** Shared by HTTP messaging and realtime sync; workspace revocation must close both paths. */
export async function authorizeConversation(
  tx: TenantTransaction,
  auth: AuthContext,
  id: string,
  write = false,
) {
  const reference = await tx
    .selectFrom('conversations')
    .select('workspace_id')
    .where('tenant_id', '=', auth.tenantId)
    .where('id', '=', id)
    .executeTakeFirst();
  if (!reference) return fail('NOT_FOUND', 404);
  if (reference.workspace_id) await authorizeWorkspace(tx, auth, reference.workspace_id);
  const query = tx
    .selectFrom('conversations')
    .selectAll()
    .where('tenant_id', '=', auth.tenantId)
    .where('id', '=', id);
  const row = await (write ? query.forUpdate() : query.forShare()).executeTakeFirst();
  if (!row || row.workspace_id !== reference.workspace_id) return fail('NOT_FOUND', 404);
  const member = await tx
    .selectFrom('conversation_members')
    .selectAll()
    .where('tenant_id', '=', auth.tenantId)
    .where('conversation_id', '=', id)
    .where('principal_id', '=', auth.principalId)
    .where('status', '=', 'active')
    .forShare()
    .executeTakeFirst();
  if (!member) return fail('NOT_FOUND', 404);
  return { row, member };
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

/** Persist only resource references. Every replay must independently recheck current ACL. */
export async function command(
  tx: TenantTransaction,
  auth: AuthContext,
  operation: string,
  key: string,
  input: unknown,
  execute: () => Promise<string>,
): Promise<string> {
  if (!/^[A-Za-z0-9._~-]{16,128}$/.test(key)) fail('VALIDATION_FAILED', 400);
  const hash = createHash('sha256').update(canonical(input)).digest('hex');
  await tx
    .insertInto('command_receipts')
    .values({
      tenant_id: auth.tenantId,
      principal_id: auth.principalId,
      operation,
      idempotency_key: key,
      request_hash: hash,
      result_ref: null,
      expires_at: sql<Date>`clock_timestamp() + interval '30 days'`,
    })
    .onConflict((conflict) =>
      conflict.columns(['tenant_id', 'principal_id', 'operation', 'idempotency_key']).doNothing(),
    )
    .execute();
  const receipt = await tx
    .selectFrom('command_receipts')
    .selectAll()
    .select(sql<boolean>`expires_at > clock_timestamp()`.as('valid'))
    .where('tenant_id', '=', auth.tenantId)
    .where('principal_id', '=', auth.principalId)
    .where('operation', '=', operation)
    .where('idempotency_key', '=', key)
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (receipt.request_hash !== hash || !receipt.valid) fail('IDEMPOTENCY_CONFLICT', 409);
  if (receipt.status === 'completed') {
    const ref = receipt.result_ref as { id?: unknown } | null;
    if (typeof ref?.id !== 'string') throw new Error('Invalid stored command reference');
    return ref.id;
  }
  const id = await execute();
  await tx
    .updateTable('command_receipts')
    .set({ status: 'completed', result_ref: { id } })
    .where('tenant_id', '=', auth.tenantId)
    .where('principal_id', '=', auth.principalId)
    .where('operation', '=', operation)
    .where('idempotency_key', '=', key)
    .execute();
  return id;
}

export async function appendEvent(
  tx: TenantTransaction,
  auth: AuthContext,
  event: {
    aggregateType: string;
    aggregateId: string;
    version: string;
    type: string;
    payload: unknown;
    target: string;
  },
): Promise<string> {
  const id = randomUUID();
  await tx
    .insertInto('domain_events')
    .values({
      tenant_id: auth.tenantId,
      id,
      aggregate_type: event.aggregateType,
      aggregate_id: event.aggregateId,
      aggregate_version: event.version,
      event_type: event.type,
      actor_principal_id: auth.principalId,
      payload: event.payload,
    })
    .execute();
  await tx
    .insertInto('outbox')
    .values({ tenant_id: auth.tenantId, id: randomUUID(), event_id: id, target: event.target })
    .execute();
  return id;
}

/** A cursor is bound to caller, authorization generation, scope and query purpose. */
export class CursorCodec {
  private readonly key: Buffer;
  constructor(secret: string) {
    if (secret.length < 32) throw new Error('Cursor signing secret must be at least 32 characters');
    this.key = createHash('sha256').update('imbox.cursor.v1\0').update(secret).digest();
  }
  encode(binding: string, position: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from('imbox.cursor.v1'));
    const plaintext = JSON.stringify({ binding, position, expires: Date.now() + 86_400_000 });
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `v1.${Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url')}`;
  }
  decode(token: string, binding: string): string {
    if (token.length > 4096 || !/^v1\.[A-Za-z0-9_-]+$/.test(token)) fail('RESYNC_REQUIRED', 409);
    let data: { binding?: unknown; position?: unknown; expires?: unknown };
    try {
      const bytes = Buffer.from(token.slice(3), 'base64url');
      if (bytes.length < 29) return fail('RESYNC_REQUIRED', 409);
      const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from('imbox.cursor.v1'));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const plaintext = Buffer.concat([
        decipher.update(bytes.subarray(28)),
        decipher.final(),
      ]).toString('utf8');
      data = JSON.parse(plaintext) as typeof data;
    } catch {
      return fail('RESYNC_REQUIRED', 409);
    }
    if (
      !data ||
      data.binding !== binding ||
      typeof data.position !== 'string' ||
      typeof data.expires !== 'number' ||
      data.expires <= Date.now()
    )
      fail('RESYNC_REQUIRED', 409);
    return data.position;
  }
}

export function expectedVersion(actual: string, expected: string): void {
  if (actual !== expected) fail('VERSION_CONFLICT', 409);
}
