import type { RuntimeSourcePort } from '@imbox/application';
import type { Db } from '@imbox/db';
import { createActionService } from './service.js';
import { createFileJournal } from './journal.js';
import { createHttpToolRegistry } from './tools.js';

/** Process-owned demonstration connector configuration; user input never selects URLs. */
export async function configuredActions(
  db: Db,
  env: Record<string, string | undefined>,
  sources?: RuntimeSourcePort,
) {
  if (env.ENABLE_DEMO_TOOL !== 'true') return undefined;
  const required = (name: string) => {
    const value = env[name];
    if (!value || value.startsWith('replace-with-'))
      throw new Error(`Configure ${name} before enabling Actions`);
    return value;
  };
  const journal = await createFileJournal({
    directory: required('ACTION_JOURNAL_DIRECTORY'),
    signingKey: required('ACTION_JOURNAL_SIGNING_KEY'),
  });
  const registry = createHttpToolRegistry([
    {
      id: 'demo.delivery',
      version: '1',
      targetId: 'demo-provider',
      executeUrl: required('DEMO_TOOL_EXECUTE_URL'),
      lookupUrl: required('DEMO_TOOL_LOOKUP_URL'),
      approvalRequired: true,
      allowInsecureLoopback:
        ['test', 'development'].includes(env.APP_ENV ?? 'production') &&
        env.DEMO_TOOL_ALLOW_LOOPBACK === 'true',
      ...(env.DEMO_TOOL_AUTHORIZATION ? { authorizationHeader: env.DEMO_TOOL_AUTHORIZATION } : {}),
    },
  ]);
  return createActionService({
    db,
    ...(sources ? { sources } : {}),
    tools: registry,
    journal,
    cursorSecret: required('SESSION_SECRET'),
  });
}
