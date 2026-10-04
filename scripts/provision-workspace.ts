import { createHash } from 'node:crypto';
import { sql, withTenant, type Db } from '@imbox/db';

export type WorkspaceManifest = {
  tenant_id: string;
  workspace_id: string;
  tenant_name: string;
  workspace_name: string;
  owner_principal_id: string;
  member_principal_ids: string[];
  requested_by: string;
  change_reference: string;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseWorkspaceManifest(value: unknown): WorkspaceManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid manifest');
  const v = value as Record<string, unknown>;
  const fields = [
    'tenant_id',
    'workspace_id',
    'tenant_name',
    'workspace_name',
    'owner_principal_id',
    'member_principal_ids',
    'requested_by',
    'change_reference',
  ];
  if (Object.keys(v).length !== fields.length || fields.some((k) => !(k in v)))
    throw new Error('Manifest fields do not match the documented schema');
  for (const field of ['tenant_id', 'workspace_id', 'owner_principal_id'])
    if (typeof v[field] !== 'string' || !uuid.test(v[field])) throw new Error(`Invalid ${field}`);
  for (const field of ['tenant_name', 'workspace_name', 'requested_by', 'change_reference'])
    if (
      typeof v[field] !== 'string' ||
      !v[field].trim() ||
      Array.from(v[field]).length > 200 ||
      Array.from(v[field]).some((char) => char.charCodeAt(0) < 32)
    )
      throw new Error(`Invalid ${field}`);
  if (
    !Array.isArray(v.member_principal_ids) ||
    v.member_principal_ids.length > 99 ||
    v.member_principal_ids.some((id) => typeof id !== 'string' || !uuid.test(id))
  )
    throw new Error('Invalid member_principal_ids');
  const owner = (v.owner_principal_id as string).toLowerCase();
  const members = (v.member_principal_ids as string[]).map((id) => id.toLowerCase()).sort();
  if (new Set([owner, ...members]).size !== members.length + 1)
    throw new Error('Duplicate principal');
  return {
    tenant_id: (v.tenant_id as string).toLowerCase(),
    workspace_id: (v.workspace_id as string).toLowerCase(),
    tenant_name: (v.tenant_name as string).trim(),
    workspace_name: (v.workspace_name as string).trim(),
    owner_principal_id: owner,
    member_principal_ids: members,
    requested_by: (v.requested_by as string).trim(),
    change_reference: (v.change_reference as string).trim(),
  };
}

/** Privileged offline provisioning of a NEW tenant; never changes existing grants or identity mappings. */
export async function provisionWorkspace(db: Db, input: unknown, apply: boolean) {
  const manifest = parseWorkspaceManifest(input);
  const digest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  return withTenant(db, manifest.tenant_id, async (tx) => {
    const role = await sql<{
      allowed: boolean;
    }>`select pg_has_role(current_user, relowner, 'USAGE') as allowed from pg_class where oid='workspace_provisioning_receipts'::regclass`.execute(
      tx,
    );
    if (!role.rows[0]?.allowed) throw new Error('Provisioning requires the migration owner role');
    await sql`select pg_advisory_xact_lock(hashtextextended(${`imbox:provision:${manifest.tenant_id}`},0))`.execute(
      tx,
    );
    const prior = await sql<{
      manifest_sha256: string;
    }>`select manifest_sha256 from workspace_provisioning_receipts where tenant_id=${manifest.tenant_id}::uuid`.execute(
      tx,
    );
    const result = {
      tenant_id: manifest.tenant_id,
      workspace_id: manifest.workspace_id,
      member_count: manifest.member_principal_ids.length + 1,
      manifest_sha256: digest,
    };
    if (prior.rows[0]) {
      if (prior.rows[0].manifest_sha256 !== digest)
        throw new Error('Tenant already provisioned with a different manifest');
      return { ...result, status: 'already_applied' as const };
    }
    if (
      await tx
        .selectFrom('tenants')
        .select('id')
        .where('id', '=', manifest.tenant_id)
        .executeTakeFirst()
    )
      throw new Error('Existing tenant cannot be adopted or overwritten');
    const ids = [manifest.owner_principal_id, ...manifest.member_principal_ids].sort();
    const principals = await tx
      .selectFrom('principals')
      .select(['id', 'kind', 'status'])
      .where('id', 'in', ids)
      .orderBy('id')
      .forShare()
      .execute();
    if (
      principals.length !== ids.length ||
      principals.some((p) => p.kind !== 'human' || p.status !== 'active')
    )
      throw new Error('Every principal must be an existing active human identity');
    if (!apply) return { ...result, status: 'planned' as const };
    await tx
      .insertInto('tenants')
      .values({ id: manifest.tenant_id, name: manifest.tenant_name })
      .execute();
    await tx
      .insertInto('tenant_principals')
      .values(
        ids.map((id) => ({
          tenant_id: manifest.tenant_id,
          principal_id: id,
          role: id === manifest.owner_principal_id ? ('owner' as const) : ('member' as const),
        })),
      )
      .execute();
    await tx
      .insertInto('workspaces')
      .values({
        tenant_id: manifest.tenant_id,
        id: manifest.workspace_id,
        name: manifest.workspace_name,
      })
      .execute();
    await tx
      .insertInto('memberships')
      .values(
        ids.map((id) => ({
          tenant_id: manifest.tenant_id,
          workspace_id: manifest.workspace_id,
          principal_id: id,
          role: id === manifest.owner_principal_id ? ('admin' as const) : ('member' as const),
        })),
      )
      .execute();
    await sql`insert into workspace_provisioning_receipts(tenant_id,workspace_id,manifest_sha256,requested_by,change_reference,member_count)
      values(${manifest.tenant_id}::uuid,${manifest.workspace_id}::uuid,${digest},${manifest.requested_by},${manifest.change_reference},${ids.length})`.execute(
      tx,
    );
    return { ...result, status: 'applied' as const };
  });
}
