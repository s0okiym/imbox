import { sql, withTenant, type Db } from '@imbox/db';
import { sources, type Category } from './sources.js';
/** Trusted operations probe only; returns no SQL, identity, title or body. Never an HTTP capability. */
export async function measureNotificationSourceLookup(
  db: Db,
  tenantId: string,
  kind: Category,
  id: string,
) {
  return withTenant(db, tenantId, async (tx) => {
    const result = await sql<{
      'QUERY PLAN': Array<{ Plan: Record<string, unknown>; 'Execution Time': number }>;
    }>`explain (analyze,format json) ${sources} select * from notification_sources where source_kind=${kind} and source_id=${id}`.execute(
      tx,
    );
    const plan = result.rows[0]!['QUERY PLAN'][0]!;
    let examined = 0,
      materialized = false;
    const visit = (node: Record<string, unknown>) => {
      if (node['Relation Name'] === 'messages')
        examined +=
          (Number(node['Actual Rows'] ?? 0) + Number(node['Rows Removed by Filter'] ?? 0)) *
          Number(node['Actual Loops'] ?? 1);
      if (node['CTE Name'] === 'notification_sources') materialized = true;
      for (const child of (node['Plans'] ?? []) as Record<string, unknown>[]) visit(child);
    };
    visit(plan.Plan);
    return {
      execution_ms: plan['Execution Time'],
      messages_examined: examined,
      materialized_all_sources: materialized,
    };
  });
}
