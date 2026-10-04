import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticationInput, type IdentityService } from '@imbox/auth';
import { ApplicationError } from '@imbox/application';
import { schemas, assertContract } from '@imbox/contracts';
import type { NotificationService } from '@imbox/notifications';
const id = (r: FastifyRequest) => assertContract('Identifier', (r.params as { id: unknown }).id);
const version = (r: FastifyRequest) => {
  const value = r.headers['if-match'];
  if (typeof value !== 'string' || !/^"[1-9][0-9]*"$/.test(value))
    throw new ApplicationError('VALIDATION_FAILED', 400);
  return assertContract('Version', value.slice(1, -1));
};
export function registerNotificationRoutes(
  app: FastifyInstance,
  options: { identity: IdentityService; notifications: NotificationService },
) {
  const { identity, notifications } = options;
  const auth = (r: FastifyRequest) => identity.authenticate(authenticationInput(r));
  app.get(
    '/v1/notification-push-key',
    { schema: { response: { 200: schemas.NotificationPushKey } } },
    async (r) => assertContract('NotificationPushKey', await notifications.pushKey(await auth(r))),
  );
  app.put(
    '/v1/notification-subscription',
    {
      schema: {
        body: schemas.NotificationSubscription,
        response: { 200: schemas.NotificationDevice },
      },
    },
    async (r) =>
      assertContract(
        'NotificationDevice',
        await notifications.subscribe(
          await auth(r),
          assertContract('NotificationSubscription', r.body),
        ),
      ),
  );
  app.get(
    '/v1/notifications',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            cursor: { type: 'string', maxLength: 4096 },
            limit: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$' },
          },
        },
        response: { 200: schemas.NotificationPage },
      },
    },
    async (r) => {
      const q = r.query as { cursor?: string; limit?: string };
      return assertContract(
        'NotificationPage',
        await notifications.list(await auth(r), {
          ...(q.cursor ? { cursor: q.cursor } : {}),
          ...(q.limit ? { limit: Number(q.limit) } : {}),
        }),
      );
    },
  );
  app.get(
    '/v1/notifications/unread',
    { schema: { response: { 200: schemas.NotificationUnread } } },
    async (r) => assertContract('NotificationUnread', await notifications.unread(await auth(r))),
  );
  app.get(
    '/v1/notifications/:id/open',
    { schema: { params: schemas.ResourceParams, response: { 200: schemas.NotificationLocation } } },
    async (r) =>
      assertContract('NotificationLocation', await notifications.open(await auth(r), id(r))),
  );
  app.post(
    '/v1/notifications/:id/read',
    { schema: { params: schemas.ResourceParams, response: { 200: schemas.NotificationRead } } },
    async (r) =>
      assertContract(
        'NotificationRead',
        await notifications.markRead(await auth(r), id(r), version(r)),
      ),
  );
  app.get(
    '/v1/notification-preferences',
    { schema: { response: { 200: schemas.NotificationPreferences } } },
    async (r) =>
      assertContract('NotificationPreferences', await notifications.getPreferences(await auth(r))),
  );
  app.put(
    '/v1/notification-preferences',
    {
      schema: {
        body: schemas.NotificationPreferencesInput,
        response: { 200: schemas.NotificationPreferences },
      },
    },
    async (r) =>
      assertContract(
        'NotificationPreferences',
        await notifications.setPreferences(
          await auth(r),
          assertContract('NotificationPreferencesInput', r.body),
          version(r),
        ),
      ),
  );
  app.put(
    '/v1/notification-mutes/:id',
    {
      schema: {
        params: schemas.ResourceParams,
        body: schemas.NotificationMuteInput,
        response: { 200: schemas.NotificationMute },
      },
    },
    async (r) =>
      assertContract(
        'NotificationMute',
        await notifications.mute(
          await auth(r),
          id(r),
          assertContract('NotificationMuteInput', r.body).muted,
        ),
      ),
  );
  app.get(
    '/v1/notification-devices',
    { schema: { response: { 200: schemas.NotificationDevicePage } } },
    async (r) =>
      assertContract('NotificationDevicePage', await notifications.devices(await auth(r))),
  );
  app.put(
    '/v1/notification-devices/current',
    {
      schema: {
        body: schemas.NotificationDeviceInput,
        response: { 200: schemas.NotificationDevice },
      },
    },
    async (r) =>
      assertContract(
        'NotificationDevice',
        await notifications.setDevice(
          await auth(r),
          assertContract('NotificationDeviceInput', r.body).enabled,
        ),
      ),
  );
  app.delete(
    '/v1/notification-devices/:id',
    { schema: { params: schemas.ResourceParams, response: { 200: schemas.NotificationDevice } } },
    async (r) =>
      assertContract('NotificationDevice', await notifications.disableDevice(await auth(r), id(r))),
  );
}
