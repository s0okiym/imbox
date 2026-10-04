import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticationInput, type IdentityService } from '@imbox/auth';
import { ApplicationError } from '@imbox/application';
import { assertContract, schemas } from '@imbox/contracts';
import type { ArtifactCollaborationService } from '@imbox/resources';
const key = (r: FastifyRequest) => assertContract('IdempotencyKey', r.headers['idempotency-key']);
const id = (r: FastifyRequest) => assertContract('Identifier', (r.params as { id: unknown }).id);
const version = (r: FastifyRequest) => {
  const v = r.headers['if-match'];
  if (typeof v !== 'string' || !/^"[1-9][0-9]*"$/.test(v))
    throw new ApplicationError('VALIDATION_FAILED', 400);
  return assertContract('Version', v.slice(1, -1));
};
const page = {
  cursor: { type: 'string', minLength: 1, maxLength: 4096 },
  limit: { type: 'string', pattern: '^(?:[1-9][0-9]?|100)$' },
};
export function registerArtifactCollaborationRoutes(
  app: FastifyInstance,
  options: { identity: IdentityService; collaboration: ArtifactCollaborationService },
) {
  const { identity, collaboration } = options;
  const auth = (r: FastifyRequest) => identity.authenticate(authenticationInput(r));
  app.post(
    '/v1/artifacts/:id/comments',
    {
      schema: {
        params: schemas.ResourceParams,
        body: schemas.CreateArtifactCommentInput,
        response: { 201: schemas.ArtifactComment },
      },
    },
    async (r, reply) =>
      reply
        .code(201)
        .send(
          assertContract(
            'ArtifactComment',
            await collaboration.createComment(
              await auth(r),
              id(r),
              assertContract('CreateArtifactCommentInput', r.body),
              key(r),
            ),
          ),
        ),
  );
  app.get(
    '/v1/artifacts/:id/comments',
    {
      schema: {
        params: schemas.ResourceParams,
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['version_id'],
          properties: { ...page, version_id: { type: 'string', format: 'uuid' } },
        },
        response: { 200: schemas.ArtifactCommentPage },
      },
    },
    async (r) => {
      const q = r.query as { version_id: string; cursor?: string; limit?: string };
      return assertContract(
        'ArtifactCommentPage',
        await collaboration.listComments(await auth(r), id(r), {
          version_id: q.version_id,
          ...(q.cursor ? { cursor: q.cursor } : {}),
          ...(q.limit ? { limit: Number(q.limit) } : {}),
        }),
      );
    },
  );
  app.patch(
    '/v1/artifact-comments/:id',
    {
      schema: {
        params: schemas.ResourceParams,
        body: schemas.EditArtifactCommentInput,
        response: { 200: schemas.ArtifactComment },
      },
    },
    async (r) =>
      assertContract(
        'ArtifactComment',
        await collaboration.editComment(
          await auth(r),
          id(r),
          assertContract('EditArtifactCommentInput', r.body).body,
          version(r),
          key(r),
        ),
      ),
  );
  app.delete(
    '/v1/artifact-comments/:id',
    {
      schema: {
        params: schemas.ResourceParams,
        response: { 200: schemas.ArtifactCommentDeletion },
      },
    },
    async (r) =>
      assertContract(
        'ArtifactCommentDeletion',
        await collaboration.deleteComment(await auth(r), id(r), version(r), key(r)),
      ),
  );
  app.post(
    '/v1/artifacts/:id/shares',
    {
      schema: {
        params: schemas.ResourceParams,
        body: schemas.CreateArtifactShareInput,
        response: { 201: schemas.ArtifactShare },
      },
    },
    async (r, reply) =>
      reply
        .code(201)
        .send(
          assertContract(
            'ArtifactShare',
            await collaboration.createShare(
              await auth(r),
              id(r),
              assertContract('CreateArtifactShareInput', r.body),
              key(r),
            ),
          ),
        ),
  );
  app.get(
    '/v1/artifacts/:id/shares',
    {
      schema: {
        params: schemas.ResourceParams,
        querystring: { type: 'object', additionalProperties: false, properties: page },
        response: { 200: schemas.ArtifactSharePage },
      },
    },
    async (r) => {
      const q = r.query as { cursor?: string; limit?: string };
      return assertContract(
        'ArtifactSharePage',
        await collaboration.listShares(await auth(r), id(r), {
          ...(q.cursor ? { cursor: q.cursor } : {}),
          ...(q.limit ? { limit: Number(q.limit) } : {}),
        }),
      );
    },
  );
  app.get(
    '/v1/artifact-shares/:id',
    { schema: { params: schemas.ResourceParams, response: { 200: schemas.ArtifactShare } } },
    async (r) =>
      assertContract('ArtifactShare', await collaboration.getShare(await auth(r), id(r))),
  );
  app.delete(
    '/v1/artifact-shares/:id',
    {
      schema: {
        params: schemas.ResourceParams,
        response: { 200: schemas.ArtifactShareRevocation },
      },
    },
    async (r) =>
      assertContract(
        'ArtifactShareRevocation',
        await collaboration.revokeShare(await auth(r), id(r), version(r), key(r)),
      ),
  );
  app.get(
    '/v1/artifact-shares/:id/content',
    { schema: { params: schemas.ResourceParams } },
    async (r, reply) => {
      if (r.headers.range) throw new ApplicationError('VALIDATION_FAILED', 400);
      const content = await collaboration.openShareDownload(await auth(r), id(r));
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
}
