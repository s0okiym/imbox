import { config } from 'dotenv';
import { createDatabase, withTenant } from '@imbox/db';
config({ path: '.env', quiet: true });
const test = process.argv.includes('--test');
if ((!test && process.env['APP_ENV'] !== 'development') || process.env['NODE_ENV'] === 'production')
  throw new Error('Development seed requires APP_ENV=development');
const url = process.env[test ? 'TEST_DATABASE_URL' : 'MIGRATION_DATABASE_URL'];
if (!url) throw new Error('MIGRATION_DATABASE_URL required for explicit seed');
const db = createDatabase(url, { max: 1 });
const tenantId = '10000000-0000-4000-8000-000000000001';
const workspaceId = '20000000-0000-4000-8000-000000000001';
const members = [
  { id: '30000000-0000-4000-8000-000000000001', display_name: 'Alice' },
  { id: '30000000-0000-4000-8000-000000000002', display_name: 'Bob' },
  { id: '30000000-0000-4000-8000-000000000003', display_name: 'Charlie' },
];
try {
  await db
    .insertInto('principals')
    .values(members.map((member) => ({ ...member, kind: 'human' as const })))
    .onConflict((c) => c.column('id').doNothing())
    .execute();
  await withTenant(db, tenantId, async (tx) => {
    await tx
      .insertInto('tenants')
      .values({ id: tenantId, name: 'Imbox 开发空间' })
      .onConflict((c) => c.column('id').doNothing())
      .execute();
    await tx
      .insertInto('tenant_principals')
      .values(
        members.map((member, index) => ({
          tenant_id: tenantId,
          principal_id: member.id,
          role: index === 0 ? ('owner' as const) : ('member' as const),
        })),
      )
      .onConflict((c) => c.columns(['tenant_id', 'principal_id']).doNothing())
      .execute();
    await tx
      .insertInto('workspaces')
      .values({ tenant_id: tenantId, id: workspaceId, name: '协作工作区' })
      .onConflict((c) => c.columns(['tenant_id', 'id']).doNothing())
      .execute();
    await tx
      .insertInto('memberships')
      .values(
        members.map((member, index) => ({
          tenant_id: tenantId,
          workspace_id: workspaceId,
          principal_id: member.id,
          role: index === 0 ? ('admin' as const) : ('member' as const),
        })),
      )
      .onConflict((c) => c.columns(['tenant_id', 'workspace_id', 'principal_id']).doNothing())
      .execute();
  });
  process.stdout.write(
    `${JSON.stringify({ tenant_id: tenantId, workspace_id: workspaceId, members })}\n`,
  );
} finally {
  await db.destroy();
}
