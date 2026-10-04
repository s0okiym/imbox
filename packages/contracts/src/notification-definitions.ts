const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const nullable = (schema: unknown) => ({ anyOf: [schema, { type: 'null' }] });
const category = { type: 'string', enum: ['message', 'task', 'request', 'action', 'run'] };
const boolean = { type: 'boolean' };
const clock = { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' };
const preferences = {
  categories: obj({
    message: boolean,
    task: boolean,
    request: boolean,
    action: boolean,
    run: boolean,
  }),
  dnd: obj({
    enabled: boolean,
    time_zone: { type: 'string', minLength: 1, maxLength: 100 },
    start: clock,
    end: clock,
  }),
};
const device = obj({ id: ref('Identifier'), enabled: boolean, version: ref('Version') });
export const notificationDefinitions = {
  NotificationPushKey: obj({ enabled: boolean, public_key: nullable({ type:'string', pattern:'^[A-Za-z0-9_-]{87}$' }) }),
  NotificationSubscription: obj({ endpoint: {type:'string',format:'uri',maxLength:2048}, keys: obj({p256dh:{type:'string',pattern:'^[A-Za-z0-9_-]{87}$'},auth:{type:'string',pattern:'^[A-Za-z0-9_-]{22}$'}}) }),
  NotificationItem: obj({
    id: ref('Identifier'),
    category,
    hint: { type: 'string', const: '你有新的待查看事项' },
    version: ref('Version'),
    unread: boolean,
    silent: boolean,
    created_at: ref('UtcTimestamp'),
    updated_at: ref('UtcTimestamp'),
  }),
  NotificationPage: obj(
    {
      items: { type: 'array', items: ref('NotificationItem'), maxItems: 100 },
      next_cursor: ref('Cursor'),
    },
    ['items'],
  ),
  NotificationUnread: obj({ unread_count: { type: 'integer', minimum: 0 } }),
  NotificationLocation: obj({
    notification_id: ref('Identifier'),
    version: ref('Version'),
    target: obj({ type: category, id: ref('Identifier'), version: ref('Version') }),
    conversation_id: nullable(ref('Identifier')),
    task_id: nullable(ref('Identifier')),
  }),
  NotificationRead: obj({
    id: ref('Identifier'),
    version: ref('Version'),
    read: { type: 'boolean', const: true },
  }),
  NotificationPreferences: obj({ version: ref('Version'), ...preferences }),
  NotificationPreferencesInput: obj(preferences),
  NotificationMuteInput: obj({ muted: boolean }),
  NotificationMute: obj({ conversation_id: ref('Identifier'), muted: boolean }),
  NotificationDeviceInput: obj({ enabled: boolean }),
  NotificationDevice: device,
  NotificationDevicePage: obj({
    items: { type: 'array', items: ref('NotificationDevice'), maxItems: 100 },
  }),
};
