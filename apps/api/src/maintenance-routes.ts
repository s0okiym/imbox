import type { FastifyInstance } from 'fastify';
import { authenticationInput, type IdentityService } from '@imbox/auth';
import type { TaskMaintenance } from '@imbox/application';
import { assertContract, schemas } from '@imbox/contracts';
export function registerMaintenanceRoutes(
  app: FastifyInstance,
  identity: IdentityService,
  maintenance: TaskMaintenance,
) {
  app.get(
    '/v1/task-escalations',
    {
      schema: {
        querystring: schemas.CursorOnlyQuery,
        response: { 200: schemas.TaskEscalationPage },
      },
    },
    async (request) => {
      const query = assertContract('CursorOnlyQuery', request.query);
      return maintenance.listEscalations(
        await identity.authenticate(authenticationInput(request)),
        query.cursor,
      );
    },
  );
}
