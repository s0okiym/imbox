import { createNotificationService, pushConfiguration } from '@imbox/notifications';
import {
  createKnowledgeService,
  knowledgeResourceIndex,
  knowledgeRuntimeSourcePort,
} from '@imbox/knowledge';
import { createGovernanceService, configuredRetentionPolicy } from '@imbox/governance';
import { createSchedulingService } from '@imbox/scheduling';
import {
  configuredResourceStore,
  createResourceService,
  createArtifactCollaborationService,
  resourceApplicationHooks,
} from '@imbox/resources';
import { createAgentService } from '@imbox/agents';
import { config } from 'dotenv';
import { assertRuntimeRole, createDatabase, sql } from '@imbox/db';
import {
  createMessagingService,
  createSyncService,
  createTaskService,
  createTaskMaintenance,
  configuredPolicyLedger,
  replayPolicyLedger,
} from '@imbox/application';
import { createIdentityService } from '@imbox/auth';
import { createRuntimeService, runtimeCompletionGate, runtimePromotionPort } from '@imbox/runtime';
import { requiredActionsClosed, configuredActions } from '@imbox/actions';
import { createApp } from './app.js';

config({ path: new URL('../../../.env', import.meta.url), quiet: true });
const databaseUrl = process.env['DATABASE_URL'];
const identityUrl = process.env['IDENTITY_DATABASE_URL'];
const secret = process.env['SESSION_SECRET'];
if (!databaseUrl || !identityUrl || !secret)
  throw new Error(
    'DATABASE_URL, IDENTITY_DATABASE_URL and SESSION_SECRET required. See .env.example.',
  );
if (secret.startsWith('replace-with-'))
  throw new Error('Set a unique SESSION_SECRET before starting the API.');
const db = createDatabase(databaseUrl);
const identityDb = createDatabase(identityUrl, { max: 5, applicationName: 'imbox-identity' });
await Promise.all([assertRuntimeRole(db), assertRuntimeRole(identityDb)]);
const policyLedger = await configuredPolicyLedger(process.env);
if (policyLedger) await replayPolicyLedger(db, policyLedger);
const policyOptions = policyLedger ? { policyLedger } : {};
const actions = await configuredActions(db, process.env);
const resourceStore = configuredResourceStore(process.env);
const resourceHooks = resourceStore ? resourceApplicationHooks() : null;
const knowledge = createKnowledgeService({ db, cursorSecret: secret, ...policyOptions });
const sources = knowledgeRuntimeSourcePort(knowledge);
const messaging = createMessagingService(db, secret, {
  ...policyOptions,
  ...(resourceHooks ? { resources: resourceHooks.messages } : {}),
});
const tasks = createTaskService(db, secret, {
  ...policyOptions,
  promotion: runtimePromotionPort({ sources }),
  ...(resourceHooks ? { artifacts: resourceHooks.artifacts } : {}),
  requiredActionsClosed: async (tx, id) =>
    (await runtimeCompletionGate(tx, id)) && (await requiredActionsClosed(tx, id)),
});
const resources = resourceStore
  ? createResourceService({
      db,
      ...policyOptions,
      store: resourceStore,
      textIndex: knowledgeResourceIndex(),
      cursorSecret: secret,
      maxUploadBytes: Number(process.env['MAX_UPLOAD_BYTES'] ?? '8388608'),
    })
  : undefined;
const collaboration = resourceStore
  ? createArtifactCollaborationService({
      db,
      store: resourceStore,
      cursorSecret: secret,
      ...policyOptions,
    })
  : undefined;
const governance = createGovernanceService({
  db,
  messaging,
  tasks,
  knowledge,
  ...(resources ? { resources } : {}),
  ...(collaboration ? { collaboration } : {}),
  independentLedger: !!policyLedger,
  offlineMessageCacheAllowed: process.env['OFFLINE_MESSAGE_CACHE_ALLOWED'] === 'true',
  offlineQueueAllowed: process.env['OFFLINE_QUEUE_ALLOWED'] !== 'false',
  ...configuredRetentionPolicy(process.env),
});
const app = createApp({
  logger: true,
  knowledge,
  governance,
  notifications: createNotificationService({
    db,
    push: pushConfiguration(),
    cursorSecret: secret,
    sessionActive: async (principalId, sessionId) =>
      (
        await sql<{
          live: boolean;
        }>`select exists(select 1 from sessions s join principals p on p.id=s.principal_id where s.id=${sessionId} and s.principal_id=${principalId} and s.revoked_at is null and s.expires_at>clock_timestamp() and p.status='active') as live`.execute(
          identityDb,
        )
      ).rows[0]!.live,
  }),
  ...(collaboration ? { collaboration } : {}),
  messaging,
  tasks,
  ...(resources ? { resources } : {}),
  scheduling: createSchedulingService({ db, cursorSecret: secret, sources }),
  maintenance: createTaskMaintenance(db, secret),
  readiness: async () => {
    await sql`SELECT 1`.execute(db);
    await sql`SELECT 1`.execute(identityDb);
  },
  sync: createSyncService({ db, cursorSecret: secret }),
  runtime: createRuntimeService({ db, cursorSecret: secret, sources }),
  agents: createAgentService({ db, identityDb, secret, ...policyOptions, sources }),
  ...(actions ? { actions } : {}),
  identity: createIdentityService({
    db,
    identityDb,
    publicOrigin: process.env['PUBLIC_ORIGIN'] ?? 'http://localhost:5173',
    sessionSecret: secret,
    environment:
      process.env['APP_ENV'] === 'development'
        ? 'development'
        : process.env['APP_ENV'] === 'test'
          ? 'test'
          : 'production',
    enableDevAuth: process.env['ENABLE_DEV_AUTH'] === 'true',
    devPrincipalIds: (process.env['DEV_AUTH_PRINCIPAL_IDS'] ?? '').split(',').filter(Boolean),
    ...(process.env['OIDC_ISSUER']
      ? {
          oidc: {
            issuer: process.env['OIDC_ISSUER'],
            clientId: process.env['OIDC_CLIENT_ID'] ?? '',
            clientSecret: process.env['OIDC_CLIENT_SECRET'] ?? '',
            allowInsecureLocalHttp: process.env['OIDC_ALLOW_LOCAL_HTTP'] === 'true',
          },
        }
      : {}),
  }),
});
app.addHook('onClose', async () => {
  resourceStore?.destroy();
  await Promise.all([db.destroy(), identityDb.destroy()]);
});
const shutdown = async () => {
  await app.close();
};
process.once('SIGTERM', () => {
  void shutdown();
});
process.once('SIGINT', () => {
  void shutdown();
});
await app.listen({
  port: Number(process.env['API_PORT'] ?? '4100'),
  host: process.env['API_HOST'] ?? '127.0.0.1',
});
