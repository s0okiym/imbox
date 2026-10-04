import { randomUUID } from 'node:crypto';
import { createDatabase, migrateToLatest, withTenant, type Db } from '@imbox/db';
import { bootstrapDevelopmentRole } from '@imbox/db/testing';

export async function testDatabases() {
  const ownerUrl = process.env['TEST_DATABASE_URL'];
  const appUrl = process.env['TEST_APP_DATABASE_URL'];
  const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];
  if (!ownerUrl || !appUrl || !identityUrl)
    throw new Error(
      'Dedicated TEST_DATABASE_URL, TEST_APP_DATABASE_URL and TEST_IDENTITY_DATABASE_URL required',
    );
  const owner = createDatabase(ownerUrl, { max: 5 });
  await migrateToLatest(owner);
  for (const [kind, url] of [
    ['application', appUrl],
    ['identity', identityUrl],
  ] as const) {
    const u = new URL(url);
    await bootstrapDevelopmentRole(owner, {
      environment: 'test',
      role: u.username,
      password: u.password,
      kind,
    });
  }
  const db = createDatabase(appUrl, { max: 12 });
  const identityDb = createDatabase(identityUrl, { max: 5 });
  return {
    owner,
    db,
    identityDb,
    close: async () => {
      await Promise.all([owner.destroy(), db.destroy(), identityDb.destroy()]);
    },
  };
}
export async function tenantFixture(owner: Db) {
  const tenantId = randomUUID();
  const workspaceId = randomUUID();
  const ids = [randomUUID(), randomUUID(), randomUUID()] as const;
  await owner
    .insertInto('principals')
    .values(
      ids.map((id, i) => ({
        id,
        kind: 'human' as const,
        display_name: ['Alice', 'Bob', 'Charlie'][i]!,
      })),
    )
    .execute();
  await withTenant(owner, tenantId, async (tx) => {
    await tx.insertInto('tenants').values({ id: tenantId, name: 'Integration tenant' }).execute();
    await tx
      .insertInto('tenant_principals')
      .values(
        ids.map((id, i) => ({
          tenant_id: tenantId,
          principal_id: id,
          role: i === 0 ? ('owner' as const) : ('member' as const),
        })),
      )
      .execute();
    await tx
      .insertInto('workspaces')
      .values({ tenant_id: tenantId, id: workspaceId, name: 'Team' })
      .execute();
    await tx
      .insertInto('memberships')
      .values(
        ids.map((id, i) => ({
          tenant_id: tenantId,
          workspace_id: workspaceId,
          principal_id: id,
          role: i === 0 ? ('admin' as const) : ('member' as const),
        })),
      )
      .execute();
  });
  const [alice, bob, charlie] = ids.map((principalId) => ({
    principalId,
    tenantId,
    kind: 'human' as const,
    authzRevision: '1',
  }));
  return { tenantId, workspaceId, ids, alice: alice!, bob: bob!, charlie: charlie! };
}
