import type { ChatMessage } from './api.js';

export interface ViewIdentity {
  readonly tenantId: string;
  readonly principalId: string;
  readonly scopeId: string;
  readonly authzGeneration: string;
}
export interface MessageSnapshot {
  readonly view: ViewIdentity;
  readonly messages: readonly ChatMessage[];
}
export interface PendingMessage {
  readonly clientMessageId: string;
  readonly idempotencyKey: string;
  readonly body: string;
  readonly attachmentIds?: readonly string[];
  readonly reply?: { readonly id: string; readonly version: string };
  readonly createdAt: string;
  readonly state: 'sending' | 'failed';
  readonly error: string | null;
}

export function viewKey(view: ViewIdentity): string {
  return JSON.stringify([view.tenantId, view.principalId, view.scopeId, view.authzGeneration]);
}

export function compareDecimal(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return [...messages].sort(
    (left, right) => compareDecimal(left.seq, right.seq) || left.id.localeCompare(right.id),
  );
}

/** A refresh replaces its loaded window. Never merge another viewer or authorization epoch. */
export function applyMessageSnapshot(
  current: MessageSnapshot | null,
  view: ViewIdentity,
  incoming: readonly ChatMessage[],
): MessageSnapshot {
  if (
    incoming.some(
      (message) =>
        message.view_scope !== view.scopeId || message.authz_generation !== view.authzGeneration,
    )
  ) {
    throw new Error('INCONSISTENT_VIEW');
  }
  const sameViewer =
    current !== null &&
    current.view.tenantId === view.tenantId &&
    current.view.principalId === view.principalId &&
    current.view.scopeId === view.scopeId;
  if (sameViewer && compareDecimal(view.authzGeneration, current.view.authzGeneration) < 0)
    return current;
  const sameGeneration = sameViewer && current.view.authzGeneration === view.authzGeneration;
  const old = new Map(
    sameGeneration ? current.messages.map((message) => [message.id, message]) : [],
  );
  const result = new Map<string, ChatMessage>();
  for (const message of incoming) {
    const previous = old.get(message.id);
    result.set(message.id, previous !== undefined ? newerMessage(previous, message) : message);
  }
  // Preserve a successful send received after a concurrent polling snapshot was taken.
  const newest = sortMessages(incoming).at(-1);
  if (sameGeneration && newest !== undefined) {
    for (const message of current.messages) {
      if (compareDecimal(message.seq, newest.seq) > 0) result.set(message.id, message);
    }
  }
  return { view: { ...view }, messages: sortMessages([...result.values()]) };
}

export function applyMessageMutation(
  current: MessageSnapshot,
  message: ChatMessage,
): MessageSnapshot {
  if (
    message.view_scope !== current.view.scopeId ||
    message.authz_generation !== current.view.authzGeneration
  )
    return current;
  const existing = current.messages.find((entry) => entry.id === message.id);
  const updated = existing === undefined ? message : newerMessage(existing, message);
  return {
    view: current.view,
    messages: sortMessages([
      ...current.messages.filter((entry) => entry.id !== message.id),
      updated,
    ]),
  };
}

function newerMessage(current: ChatMessage, incoming: ChatMessage): ChatMessage {
  if (current.projection_id !== incoming.projection_id) return incoming;
  const revision = compareDecimal(incoming.projection_revision, current.projection_revision);
  if (revision < 0) return current;
  if (revision > 0) return incoming;
  if (current.deleted && !incoming.deleted) return current;
  return compareDecimal(incoming.version, current.version) >= 0 ? incoming : current;
}

export function remainingPending(
  pending: readonly PendingMessage[],
  messages: readonly ChatMessage[],
): PendingMessage[] {
  const savedIds = new Set(messages.map((message) => message.client_message_id));
  return pending.filter((message) => !savedIds.has(message.clientMessageId));
}

export function failPending(
  pending: readonly PendingMessage[],
  clientMessageId: string,
  error: string,
): PendingMessage[] {
  return pending.map((message) =>
    message.clientMessageId === clientMessageId ? { ...message, state: 'failed', error } : message,
  );
}

export function shouldSendOnEnter(input: {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly isComposing: boolean;
  readonly keyCode: number;
  readonly compositionActive: boolean;
}): boolean {
  return (
    input.key === 'Enter' &&
    !input.shiftKey &&
    !input.isComposing &&
    !input.compositionActive &&
    input.keyCode !== 229
  );
}
