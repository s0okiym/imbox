import { registerOrganizationRoutes } from './organization-routes.js';
import { registerNotificationRoutes } from './notification-routes.js';
import type { NotificationService } from '@imbox/notifications';
import { registerRunToolRoutes } from './run-tool-routes.js';
import { registerArtifactCollaborationRoutes } from './artifact-collaboration-routes.js';
import type { ArtifactCollaborationService } from '@imbox/resources';
import { registerRecoveryRoutes } from './recovery-routes.js';
import type { GovernanceService } from '@imbox/governance';
import { registerGovernanceRoutes } from './governance-routes.js';
import type { KnowledgeService } from '@imbox/knowledge';
import { registerKnowledgeRoutes } from './knowledge-routes.js';
import { registerKnowledgeMachineRoutes } from './knowledge-machine-routes.js';
import { registerMaintenanceRoutes } from './maintenance-routes.js';
import type { TaskMaintenance } from '@imbox/application';
import type { SchedulingService } from '@imbox/scheduling';
import { registerScheduleRoutes } from './schedule-routes.js';
import type { ResourceService } from '@imbox/resources';
import { registerResourceRoutes } from './resource-routes.js';
import type { AgentService } from '@imbox/agents';
import { registerAgentRoutes } from './agent-routes.js';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { ContractValidationError, routeContracts, schemas } from '@imbox/contracts';
import { ApplicationError } from '@imbox/application';
import { AuthError, registerAuthRoutes, type IdentityService } from '@imbox/auth';
import type {
  MessagingService,
  SyncService,
  TaskService,
  OrganizationService,
} from '@imbox/application';
import { registerSyncRoutes } from './sync-routes.js';
import { registerTaskRoutes } from './task-routes.js';
import { registerRuntimeRoutes } from './runtime-routes.js';
import type { RuntimeService } from '@imbox/runtime';
import type { ActionService } from '@imbox/actions';
import { registerActionRoutes } from './action-routes.js';
import { registerMessagingRoutes } from './messaging-routes.js';
import formatsPlugin, { type FormatsPlugin } from 'ajv-formats';
const addFormats = formatsPlugin as unknown as FormatsPlugin;
import { Ajv2020 } from 'ajv/dist/2020.js';

export interface AppOptions {
  readiness: () => Promise<void>;
  logger?: boolean;
  identity?: IdentityService;
  messaging?: MessagingService;
  sync?: SyncService;
  tasks?: TaskService;
  organization?: OrganizationService;
  runtime?: RuntimeService;
  actions?: ActionService;
  agents?: AgentService;
  resources?: ResourceService;
  scheduling?: SchedulingService;
  maintenance?: TaskMaintenance;
  knowledge?: KnowledgeService;
  notifications?: NotificationService;
  governance?: GovernanceService;
  collaboration?: ArtifactCollaborationService;
}

/** Composition root. Domain commands are mounted as separate route plugins. */
export function createApp(options: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 256 * 1024,
    requestTimeout: 30_000,
    logController: new LogController({ disableRequestLogging: true }),
  });
  const ajv = new Ajv2020({ strict: true, allErrors: false, coerceTypes: false });
  addFormats(ajv);
  app.setValidatorCompiler(({ schema }) => ajv.compile(schema));
  app.setSerializerCompiler(({ schema }) => {
    const validate = ajv.compile(schema);
    return (data) => {
      if (!validate(data)) throw new Error('Response contract violation');
      return JSON.stringify(data);
    };
  });
  app.addHook('onRoute', (route) => {
    const path = route.url.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, '{$1}');
    const contract = routeContracts.find(
      (item) => item.path === path && item.method.toUpperCase() === route.method,
    );
    if (contract?.response) {
      route.schema = {
        ...route.schema,
        response: {
          ...(route.schema?.response as Record<string, unknown> | undefined),
          [contract.success]: schemas[contract.response],
        },
      };
    }
  });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
  });
  app.setErrorHandler((error, request, reply) => {
    const malformed =
      error instanceof Error &&
      'code' in error &&
      [
        'FST_ERR_CTP_INVALID_JSON_BODY',
        'FST_ERR_CTP_EMPTY_JSON_BODY',
        'FST_ERR_CTP_INVALID_MEDIA_TYPE',
      ].includes(String(error.code));
    const invalid =
      malformed ||
      error instanceof ContractValidationError ||
      (error instanceof Error && 'validation' in error);
    const known = error instanceof ApplicationError || error instanceof AuthError;
    const oversized =
      error instanceof Error && 'code' in error && error.code === 'FST_ERR_CTP_BODY_TOO_LARGE';
    const status =
      error instanceof ApplicationError
        ? error.status
        : error instanceof AuthError
          ? error.statusCode
          : invalid
            ? 400
            : oversized
              ? 413
              : 500;
    if (status >= 500)
      request.log.error(
        { request_id: request.id, error_type: error instanceof Error ? error.name : 'Unknown' },
        'Request failed',
      );
    return reply.code(status).send({
      code: known ? error.code : invalid || oversized ? 'VALIDATION_FAILED' : 'INTERNAL_ERROR',
      message: known
        ? error.code
        : invalid || oversized
          ? 'Request does not match the contract.'
          : 'The request could not be completed.',
      request_id: request.id,
      retryable: status === 503,
    });
  });
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      code: 'NOT_FOUND',
      message: 'Resource not found.',
      request_id: request.id,
      retryable: false,
    }),
  );
  if (options.identity) {
    app.register(async (scope) => {
      await registerAuthRoutes(scope, {
        identity: options.identity!,
        capabilities: [
          ...(options.messaging
            ? [
                'messaging.text',
                'messaging.edit',
                'messaging.members',
                'messaging.threads',
                'messaging.quotes',
                'messaging.reactions',
              ]
            : []),
          ...(options.sync ? ['sync.websocket', 'sync.snapshot'] : []),
          ...(options.tasks ? ['tasks.collaboration'] : []),
          ...(options.tasks?.supportsRunPromotion ? ['tasks.run_promotion'] : []),
          ...(options.maintenance ? ['tasks.escalations'] : []),
          ...(options.knowledge ? ['knowledge.memory', 'knowledge.search'] : []),
          ...(options.governance ? ['governance.exports', 'governance.policy'] : []),
          ...(options.organization ? ['organization.management'] : []),
          ...(options.notifications ? ['notifications.inbox', 'notifications.preferences'] : []),
          ...(options.collaboration ? ['artifacts.comments', 'artifacts.shares'] : []),
          ...(options.scheduling ? ['agents.schedules'] : []),
          ...(options.resources ? ['resources.text_uploads', 'resources.artifact_versions'] : []),
          ...(options.resources && options.messaging ? ['resources.message_attachments'] : []),
          ...(options.resources && options.tasks ? ['artifacts.evidence'] : []),
          ...(options.agents ? ['agents.directory', 'agents.machine_identity'] : []),
          ...(options.agents && options.actions ? ['agents.run_tools'] : []),
          ...(options.runtime ? ['agents.runs', 'agents.context', 'agents.controls'] : []),
          ...(options.actions
            ? ['actions.approvals', 'actions.reconciliation', 'actions.grants', 'actions.recovery']
            : []),
        ],
      });
      if (options.agents && options.actions)
        registerRunToolRoutes(scope, {
          identity: options.identity!,
          agents: options.agents,
          actions: options.actions,
        });
      if (options.collaboration)
        registerArtifactCollaborationRoutes(scope, {
          identity: options.identity!,
          collaboration: options.collaboration,
        });
      if (options.notifications)
        registerNotificationRoutes(scope, {
          identity: options.identity!,
          notifications: options.notifications,
        });
      if (options.governance)
        registerGovernanceRoutes(scope, options.identity!, options.governance);
      if (options.knowledge) {
        registerKnowledgeRoutes(scope, {
          identity: options.identity!,
          knowledge: options.knowledge,
        });
        if (options.agents)
          registerKnowledgeMachineRoutes(scope, options.agents, options.knowledge);
      }
      if (options.maintenance)
        registerMaintenanceRoutes(scope, options.identity!, options.maintenance);
      if (options.scheduling)
        await registerScheduleRoutes(scope, {
          identity: options.identity!,
          scheduling: options.scheduling,
        });
      if (options.resources)
        registerResourceRoutes(scope, {
          identity: options.identity!,
          resources: options.resources,
        });
      if (options.agents)
        registerAgentRoutes(scope, {
          identity: options.identity!,
          agents: options.agents,
          ...(options.runtime ? { runtime: options.runtime } : {}),
          ...(options.tasks ? { tasks: options.tasks } : {}),
          ...(options.messaging ? { messaging: options.messaging } : {}),
        });
      if (options.messaging)
        await registerMessagingRoutes(scope, {
          identity: options.identity!,
          messaging: options.messaging,
        });
      if (options.organization)
        registerOrganizationRoutes(scope, options.identity!, options.organization);
      if (options.tasks) await registerTaskRoutes(scope, options.identity!, options.tasks);
      if (options.runtime)
        await registerRuntimeRoutes(scope, {
          identity: options.identity!,
          runtime: options.runtime,
        });
      if (options.actions) {
        registerActionRoutes(scope, options.identity!, options.actions);
        await registerRecoveryRoutes(scope, {
          identity: options.identity!,
          actions: options.actions,
        });
      }
      if (options.sync)
        await registerSyncRoutes(scope, { identity: options.identity!, sync: options.sync });
    });
  }
  app.get(
    '/healthz',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['status', 'service'],
            properties: { status: { const: 'ok' }, service: { const: 'imbox-api' } },
          },
        },
      },
    },
    async () => ({ status: 'ok', service: 'imbox-api' }),
  );

  app.get('/readyz', async (_request, reply) => {
    try {
      await options.readiness();
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
  return app;
}
