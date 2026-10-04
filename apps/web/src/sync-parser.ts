import type { Message, ProjectionEnvelope, WsServerFrame } from '@imbox/contracts';

export type CompatibleProjection = Omit<ProjectionEnvelope, 'entity'> & {
  entity: { type: string; id: string; version: string };
};
type BrowserServerFrame = Exclude<WsServerFrame, ProjectionEnvelope> | CompatibleProjection;

// Transitional browser boundary. Keep runtime Ajv compilation/eval out of the browser.
// Replace with contracts-generated standalone validators when those are available.
const decimal = /^(0|[1-9][0-9]{0,18})$/;
// Mirrors contracts WIRE_LIMITS.maxBytes. Server control-frame ingress is smaller.
const MAX_SERVER_FRAME_BYTES = 262_144;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === 'string';
}
function counter(value: unknown): value is string {
  return text(value) && decimal.test(value);
}
function timestamp(value: unknown): value is string {
  return text(value) && Number.isFinite(Date.parse(value));
}
function message(value: unknown): value is Message {
  if (!record(value) || !record(value['actor'])) return false;
  const actor = value['actor'];
  return (
    ['id', 'conversation_id', 'client_message_id', 'body', 'view_scope', 'projection_id'].every(
      (key) => text(value[key]),
    ) &&
    ['version', 'seq', 'authz_generation', 'projection_revision'].every((key) =>
      counter(value[key]),
    ) &&
    text(actor['id']) &&
    text(actor['display_name']) &&
    text(actor['kind']) &&
    ['human', 'agent', 'service'].includes(actor['kind']) &&
    text(actor['status']) &&
    ['active', 'disabled', 'deleted'].includes(actor['status']) &&
    (value['format'] === 'text' || value['format'] === 'markdown') &&
    typeof value['deleted'] === 'boolean' &&
    Array.isArray(value['attachment_ids']) &&
    value['attachment_ids'].every(text) &&
    timestamp(value['created_at']) &&
    (value['edited_at'] === undefined || timestamp(value['edited_at'])) &&
    (value['reply_to_id'] === undefined || text(value['reply_to_id'])) &&
    (value['thread_root_id'] === undefined || text(value['thread_root_id']))
  );
}

export function isProjectionEnvelope(value: unknown): value is CompatibleProjection {
  if (!record(value) || !record(value['entity']) || !record(value['payload'])) return false;
  const entity = value['entity'];
  const payload = value['payload'];
  if (
    (value['type'] !== 'projection.upsert' && value['type'] !== 'projection.remove') ||
    value['protocol_version'] !== 1 ||
    value['schema_version'] !== 1 ||
    !['stream_id', 'view_scope', 'projection_id', 'event_id', 'cursor'].every((key) =>
      text(value[key]),
    ) ||
    !counter(value['authz_generation']) ||
    !counter(value['projection_revision']) ||
    !text(entity['id']) ||
    !counter(entity['version']) ||
    !text(payload['summary']) ||
    [...payload['summary']].length > 4000 ||
    !text(entity['type']) ||
    !/^[a-z][a-z0-9_.-]{0,63}$/.test(entity['type'])
  )
    return false;
  if (entity['type'] === 'message') return message(payload['message']);
  // Projection frames are display-only. Unknown entities never become messages or commands.
  // The client displays a fixed local notice, never the unfamiliar payload or its summary.
  return true;
}

export function parseServerFrame(raw: unknown): BrowserServerFrame {
  if (!text(raw) || new TextEncoder().encode(raw).byteLength > MAX_SERVER_FRAME_BYTES)
    throw new Error('INVALID_SYNC_FRAME');
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('INVALID_SYNC_FRAME');
  }
  if (!record(value)) throw new Error('INVALID_SYNC_FRAME');
  if (isProjectionEnvelope(value)) return value;
  if ((value['type'] === 'ping' || value['type'] === 'pong') && text(value['nonce']))
    return { type: value['type'], nonce: value['nonce'] };
  if (
    value['type'] === 'welcome' &&
    value['protocol_version'] === 1 &&
    text(value['connection_id']) &&
    typeof value['heartbeat_seconds'] === 'number' &&
    Number.isFinite(value['heartbeat_seconds']) &&
    value['heartbeat_seconds'] > 0
  )
    return {
      type: 'welcome',
      protocol_version: 1,
      connection_id: value['connection_id'],
      heartbeat_seconds: value['heartbeat_seconds'],
    };
  if (
    value['type'] === 'subscribed' &&
    text(value['stream_id']) &&
    counter(value['authz_generation']) &&
    text(value['cursor'])
  )
    return {
      type: 'subscribed',
      stream_id: value['stream_id'],
      authz_generation: value['authz_generation'],
      cursor: value['cursor'],
    };
  if (
    (value['type'] === 'resync_required' || value['type'] === 'access_revoked') &&
    text(value['stream_id']) &&
    text(value['reason']) &&
    ['cursor_expired', 'authorization_changed', 'unsupported_schema', 'slow_consumer'].includes(
      value['reason'],
    )
  )
    return value as unknown as WsServerFrame;
  throw new Error('INVALID_SYNC_FRAME');
}

export function projectedMessage(
  envelope: CompatibleProjection,
  scopeId: string,
  generation: string,
): Message | null {
  if (
    !isProjectionEnvelope(envelope) ||
    envelope.stream_id !== scopeId ||
    envelope.view_scope !== scopeId ||
    envelope.authz_generation !== generation
  )
    throw new Error('INCONSISTENT_VIEW');
  if (envelope.entity.type !== 'message') return null;
  const value = envelope.payload.message;
  if (
    value === undefined ||
    value.conversation_id !== scopeId ||
    value.view_scope !== scopeId ||
    value.authz_generation !== generation ||
    value.projection_id !== envelope.projection_id ||
    value.projection_revision !== envelope.projection_revision ||
    value.id !== envelope.entity.id ||
    value.version !== envelope.entity.version
  )
    throw new Error('INCONSISTENT_VIEW');
  // A remove is authoritative even if a malformed server payload retained a body.
  return envelope.type === 'projection.remove' ? { ...value, deleted: true, body: '' } : value;
}
