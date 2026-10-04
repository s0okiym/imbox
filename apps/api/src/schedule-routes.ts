import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticationInput, type IdentityService } from '@imbox/auth';
import { ApplicationError } from '@imbox/application';
import { assertContract, schemas } from '@imbox/contracts';
import type { SchedulingService } from '@imbox/scheduling';

const header = (r: FastifyRequest, name: string): string => {
  const value = r.headers[name];
  if (typeof value !== 'string') throw new ApplicationError('VALIDATION_FAILED', 400);
  return value;
};
const key = (r: FastifyRequest) => assertContract('IdempotencyKey', header(r, 'idempotency-key'));
const id = (r: FastifyRequest) => assertContract('Identifier', (r.params as { id: string }).id);
const version = (r: FastifyRequest) => {
  const value = header(r, 'if-match');
  if (!/^"[1-9][0-9]{0,18}"$/.test(value)) throw new ApplicationError('VALIDATION_FAILED', 400);
  return assertContract('Version', value.slice(1, -1));
};
const cursor = (r: FastifyRequest) => {
  const value = (r.query as { cursor?: unknown }).cursor;
  return value === undefined ? undefined : assertContract('Cursor', value);
};
export async function registerScheduleRoutes(
  app: FastifyInstance,
  options: { identity: IdentityService; scheduling: SchedulingService },
): Promise<void> {
  const auth = (r: FastifyRequest) => options.identity.authenticate(authenticationInput(r));
  const { scheduling } = options;
  app.post(
    '/v1/schedules',
    { schema: { body: schemas.CreateScheduleInput, response: { 201: schemas.Schedule } } },
    async (r, reply) => {
      const schedule = await scheduling.create(
        await auth(r),
        assertContract('CreateScheduleInput', r.body),
        key(r),
      );
      return reply.code(201).header('ETag', `"${schedule.version}"`).send(schedule);
    },
  );
  app.get(
    '/v1/schedules',
    { schema: { querystring: schemas.CursorOnlyQuery, response: { 200: schemas.ScheduleList } } },
    async (r) => scheduling.list(await auth(r), cursor(r)),
  );
  app.get(
    '/v1/schedules/:id',
    { schema: { params: schemas.ResourceParams, response: { 200: schemas.Schedule } } },
    async (r, reply) => {
      const schedule = await scheduling.get(await auth(r), id(r));
      return reply.header('ETag', `"${schedule.version}"`).send(schedule);
    },
  );
  app.patch(
    '/v1/schedules/:id',
    {
      schema: {
        params: schemas.ResourceParams,
        body: schemas.ReviseScheduleInput,
        response: { 200: schemas.Schedule },
      },
    },
    async (r, reply) => {
      const schedule = await scheduling.revise(
        await auth(r),
        id(r),
        assertContract('ReviseScheduleInput', r.body),
        version(r),
        key(r),
      );
      return reply.header('ETag', `"${schedule.version}"`).send(schedule);
    },
  );
  app.delete(
    '/v1/schedules/:id',
    { schema: { params: schemas.ResourceParams, response: { 200: schemas.Schedule } } },
    async (r, reply) => {
      if (r.body !== undefined) throw new ApplicationError('VALIDATION_FAILED', 400);
      const schedule = await scheduling.disable(await auth(r), id(r), version(r), key(r));
      return reply.header('ETag', `"${schedule.version}"`).send(schedule);
    },
  );
  app.get(
    '/v1/schedules/:id/occurrences',
    {
      schema: {
        params: schemas.ResourceParams,
        querystring: schemas.CursorOnlyQuery,
        response: { 200: schemas.ScheduleOccurrenceList },
      },
    },
    async (r) => scheduling.occurrences(await auth(r), id(r), cursor(r)),
  );
}
