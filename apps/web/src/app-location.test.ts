import { expect, it } from 'vitest';
import { appLocationPath, parseAppLocation, type AppLocation } from './app-location.js';
const tenant = '10000000-0000-4000-8000-000000000001';
const first = '20000000-0000-4000-8000-000000000001';
const second = '30000000-0000-4000-8000-000000000001';
it('round trips explicit resource locations without putting credentials or private text in URLs', () => {
  const routes: AppLocation[] = [
    { section: 'messages', tenantId: tenant, conversationId: first, messageId: second },
    { section: 'tasks', tenantId: tenant, taskId: first },
    { section: 'tasks', tenantId: tenant, requestId: second },
    { section: 'execution', tenantId: tenant, runId: first },
    { section: 'execution', tenantId: tenant, actionId: first },
    { section: 'execution', tenantId: tenant, grantId: first },
    { section: 'resources', tenantId: tenant, shareId: second },
  ];
  for (const route of routes) expect(parseAppLocation(new URL(appLocationPath(route), 'https://imbox.test'))).toEqual(route);
});
it('does not accept forged scope or authority fields from a URL', () => {
  expect(parseAppLocation(new URL('https://imbox.test/tasks/not-an-id?actor=admin&version=9&csrf_token=secret'))).toEqual({ section: 'tasks' });
  expect(parseAppLocation(new URL(`https://imbox.test/resources?share=${first}&token=secret`))).toEqual({ section: 'resources', shareId: first });
  expect(appLocationPath(parseAppLocation(new URL(`https://imbox.test/resources?share=${first}&token=secret`)))).not.toContain('token');
});
