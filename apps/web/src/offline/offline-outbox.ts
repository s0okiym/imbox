import type { Conversation } from '@imbox/contracts';
import { ApiError, type ChatMessage, type Session } from '../api.js';
import {
  conversationScope,
  namespaceKey,
  offlineScopeKey,
  type OfflineIdentity,
  type OfflinePolicy,
  type OfflineStore,
  type QueuedMessage,
} from './offline-store.js';

export interface OutboxGateway {
  session(signal: AbortSignal): Promise<Session>;
  policy(signal: AbortSignal): Promise<OfflinePolicy>;
  conversation(id: string, signal: AbortSignal): Promise<Conversation>;
  send(message: QueuedMessage, session: Session, signal: AbortSignal): Promise<ChatMessage>;
}
export interface OutboxCallbacks {
  saved(message: ChatMessage, queued: QueuedMessage): void;
  rejected(message: QueuedMessage, reason: string): void;
  sessionLost(): void;
}
/** Foreground-only replay of explicitly queued message commands; no task/approval commands. */
export async function drainOutbox(
  store: OfflineStore,
  identity: OfflineIdentity,
  gateway: OutboxGateway,
  signal: AbortSignal,
  callbacks: OutboxCallbacks,
  holder = crypto.randomUUID(),
) {
  const namespace = namespaceKey(identity),
    pref = await store.preferences.get(namespace);
  if (!pref?.queue || signal.aborted) return;
  let session: Session;
  try {
    session = await gateway.session(signal);
  } catch (error: unknown) {
    if (error instanceof ApiError && error.status === 401 && !signal.aborted)
      callbacks.sessionLost();
    return;
  }
  if (signal.aborted) return;
  if (session.tenant_id !== identity.tenantId || session.principal.id !== identity.principalId) {
    await store.eraseIdentity(identity);
    callbacks.sessionLost();
    return;
  }
  let policy: OfflinePolicy;
  try {
    policy = await gateway.policy(signal);
  } catch {
    return;
  }
  if (signal.aborted) return;
  await store.setPreferences(identity, pref, policy);
  if (!policy.offline_queue_allowed) return;
  await store.rememberSession(session);
  for (const pending of await store.pending(identity)) {
    if (signal.aborted) return;
    if (pending.actorAuthzRevision !== session.authz_revision) {
      await store.invalidateScope(pending.scope, 'AUTHORIZATION_CHANGED');
      callbacks.rejected(pending, 'AUTHORIZATION_CHANGED');
      continue;
    }
    let conversation: Conversation;
    try {
      conversation = await gateway.conversation(pending.scope.conversationId, signal);
    } catch (error: unknown) {
      if (signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) {
        callbacks.sessionLost();
        return;
      }
      if (error instanceof ApiError && [403, 404].includes(error.status)) {
        await store.invalidateScope(pending.scope, 'ACCESS_REVOKED');
        callbacks.rejected(pending, 'ACCESS_REVOKED');
        continue;
      }
      return;
    }
    if (signal.aborted) return;
    const scope = conversationScope(session, conversation);
    if (offlineScopeKey(scope) !== offlineScopeKey(pending.scope)) {
      await store.invalidateScope(pending.scope, 'AUTHORIZATION_CHANGED');
      callbacks.rejected(pending, 'AUTHORIZATION_CHANGED');
      continue;
    }
    const claim = await store.claim(pending.id, scope, holder);
    if (!claim || signal.aborted) return;
    try {
      // The fresh session's CSRF token binds the send to this authenticated actor,
      // even if another tab replaces the browser cookie after the session read.
      const saved = await gateway.send(claim, session, signal);
      if (signal.aborted) return;
      if (
        saved.client_message_id !== claim.id ||
        saved.conversation_id !== scope.conversationId ||
        saved.actor.id !== identity.principalId ||
        saved.view_scope !== scope.viewScope ||
        saved.authz_generation !== scope.authzGeneration
      )
        throw new ApiError(
          502,
          'INVALID_RESPONSE',
          'Message response does not match queued authority',
        );
      await store.acknowledge(claim);
      callbacks.saved(saved, claim);
    } catch (error: unknown) {
      if (signal.aborted) return; // A later owner reclaims the same key after lease expiry.
      if (error instanceof ApiError && error.status === 401) {
        await store.release(claim, true, 'AUTHENTICATION_REQUIRED');
        callbacks.sessionLost();
        return;
      }
      if (error instanceof ApiError && [403, 404].includes(error.status)) {
        await store.invalidateScope(scope, 'ACCESS_REVOKED');
        callbacks.rejected(claim, 'ACCESS_REVOKED');
        continue;
      }
      const retryable = !(error instanceof ApiError) || error.status >= 500 || error.status === 429;
      await store.release(
        claim,
        retryable,
        retryable ? 'RESPONSE_UNCONFIRMED' : 'REQUIRES_NEW_REVIEW',
      );
      if (retryable) return; // Never loop immediately on an uncertain network response.
    }
  }
}
