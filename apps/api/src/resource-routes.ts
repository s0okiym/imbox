import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticationInput, type IdentityService } from '@imbox/auth';
import { ApplicationError } from '@imbox/application';
import { assertContract, schemas, type SchemaName, type ContractTypes } from '@imbox/contracts';
import type { ResourceService } from '@imbox/resources';
const key = (r: FastifyRequest) => assertContract('IdempotencyKey', r.headers['idempotency-key']);
const id = (r: FastifyRequest) => assertContract('Identifier', (r.params as { id: unknown }).id);
const version = (r: FastifyRequest) => {
  const value = r.headers['if-match'];
  if (typeof value !== 'string' || !/^"[1-9][0-9]*"$/.test(value))
    throw new ApplicationError('VALIDATION_FAILED', 400);
  return assertContract('Version', value.slice(1, -1));
};
export function registerResourceRoutes(
  app: FastifyInstance,
  options: { identity: IdentityService; resources: ResourceService },
) {
  const { identity, resources } = options;
  const auth = (request: FastifyRequest) => identity.authenticate(authenticationInput(request));
  const scopeQuery = (request: FastifyRequest) => {
    const query = request.query as {
      task_id?: string;
      conversation_id?: string;
      cursor?: string;
      limit?: string;
    };
    return assertContract('ResourceScopeQuery', {
      ...(query.task_id ? { task_id: query.task_id } : {}),
      ...(query.conversation_id ? { conversation_id: query.conversation_id } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      ...(query.limit !== undefined ? { limit: Number(query.limit) } : {}),
    });
  };
  const scopeQuerySchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      conversation_id: { type: 'string', format: 'uuid' },
      task_id: { type: 'string', format: 'uuid' },
      cursor: { type: 'string', minLength: 1, maxLength: 4096 },
      limit: { type: 'string', pattern: '^(?:[1-9][0-9]?|1[0-9]{2}|200)$' },
    },
  };
  app.get(
    '/v1/resources',
    {
      schema: {
        querystring: scopeQuerySchema,
        response: { 200: schemas.StoredResourcePage },
      },
    },
    async (request) =>
      assertContract(
        'StoredResourcePage',
        await resources.listResources(await auth(request), scopeQuery(request)),
      ),
  );
  app.get(
    '/v1/artifacts',
    {
      schema: {
        querystring: scopeQuerySchema,
        response: { 200: schemas.StoredArtifactPage },
      },
    },
    async (request) =>
      assertContract(
        'StoredArtifactPage',
        await resources.listArtifacts(await auth(request), scopeQuery(request)),
      ),
  );
  function post<N extends SchemaName>(
    path: string,
    input: N,
    output: SchemaName,
    handler: (r: FastifyRequest, body: ContractTypes[N]) => Promise<unknown>,
    status: 200 | 201 = 201,
  ) {
    app.post(
      path,
      {
        schema: {
          body: schemas[input],
          response: { [status]: schemas[output] },
          ...(path.includes(':id') ? { params: schemas.ResourceParams } : {}),
        },
      },
      async (request, reply) => {
        const result = assertContract(
          output,
          await handler(request, assertContract(input, request.body)),
        );
        return reply.code(status).header('Cache-Control', 'private, no-store').send(result);
      },
    );
  }
  post('/v1/uploads', 'CreateUploadInput', 'UploadTicket', async (r, input) =>
    resources.createUpload(await auth(r), input, key(r)),
  );
  app.post(
    '/v1/uploads/:id/complete',
    { schema: { params: schemas.ResourceParams, response: { 200: schemas.StoredResource } } },
    async (request) =>
      assertContract(
        'StoredResource',
        await resources.completeUpload(await auth(request), id(request), key(request)),
      ),
  );
  app.get(
    '/v1/resources/:id',
    { schema: { params: schemas.ResourceParams, response: { 200: schemas.StoredResource } } },
    async (request) =>
      assertContract(
        'StoredResource',
        await resources.getResource(await auth(request), id(request)),
      ),
  );
  app.get(
    '/v1/resources/:id/content',
    { schema: { params: schemas.ResourceParams } },
    async (request, reply) => {
      if (request.headers.range)
        throw new ApplicationError('VALIDATION_FAILED', 400, 'Range downloads are not implemented');
      const content = await resources.openDownload(await auth(request), id(request));
      return reply
        .header('Cache-Control', 'private, no-store')
        .header('Content-Type', content.metadata.content_type)
        .header('Content-Length', content.metadata.byte_size)
        .header(
          'Content-Disposition',
          `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(content.metadata.filename)}`,
        )
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('ETag', `"${content.metadata.sha256}"`)
        .send(content.stream);
    },
  );
  app.delete(
    '/v1/resources/:id',
    { schema: { params: schemas.ResourceParams, response: { 200: schemas.ResourceDeletion } } },
    async (request) =>
      assertContract(
        'ResourceDeletion',
        await resources.deleteResource(
          await auth(request),
          id(request),
          version(request),
          key(request),
        ),
      ),
  );
  post('/v1/artifacts', 'CreateStoredArtifactInput', 'StoredArtifact', async (r, input) =>
    resources.createArtifact(await auth(r), input, key(r)),
  );
  app.get(
    '/v1/artifacts/:id',
    { schema: { params: schemas.ResourceParams, response: { 200: schemas.StoredArtifact } } },
    async (request) =>
      assertContract(
        'StoredArtifact',
        await resources.getArtifact(await auth(request), id(request)),
      ),
  );
  post(
    '/v1/artifacts/:id/versions',
    'CreateStoredArtifactVersionInput',
    'StoredArtifact',
    async (r, input) =>
      resources.createArtifactVersion(await auth(r), id(r), input, version(r), key(r)),
  );
  app.get(
    '/v1/artifacts/:id/versions',
    {
      schema: {
        params: schemas.ResourceParams,
        response: { 200: schemas.StoredArtifactVersionPage },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            cursor: { type: 'string', maxLength: 4096 },
            limit: { type: 'string', pattern: '^(?:[1-9][0-9]?|1[0-9]{2}|200)$' },
          },
        },
      },
    },
    async (request) => {
      const q = request.query as { cursor?: string; limit?: string };
      return assertContract(
        'StoredArtifactVersionPage',
        await resources.listArtifactVersions(await auth(request), id(request), {
          ...(q.cursor ? { cursor: q.cursor } : {}),
          ...(q.limit ? { limit: Number(q.limit) } : {}),
        }),
      );
    },
  );
}
