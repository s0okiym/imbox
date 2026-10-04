import Dexie, { type Table } from 'dexie';
import type { Conversation, GovernancePolicy, Principal, Workspace } from '@imbox/contracts';
import type { ChatMessage, Session } from '../api.js';

export const OFFLINE_RETENTION_MS = 7 * 86_400_000;
export const OUTBOX_LEASE_MS = 30_000;
export interface OfflineIdentity {
  readonly tenantId: string;
  readonly principalId: string;
}
export interface OfflineScope extends OfflineIdentity {
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly viewScope: string;
  readonly authzGeneration: string;
}
export type OfflinePolicy = Pick<
  GovernancePolicy,
  'offline_message_cache_allowed' | 'offline_queue_allowed' | 'offline_queue_max_days'
>;
export interface OfflinePreferences {
  key: string;
  queue: boolean;
  history: boolean;
  policy: OfflinePolicy;
  updatedAt: number;
}
/** Deliberately contains no session identifier, cookie, CSRF token or other credential. */
export interface OfflineProfile {
  key: string;
  tenantId: string;
  principal: Principal;
  workspaces: Workspace[];
  authzRevision: string;
  sessionExpiresAt: string;
  checkedAt: number;
}
export interface OfflineHistory {
  key: string;
  namespace: string;
  baseScope: string;
  scope: OfflineScope;
  conversation: Conversation;
  messages: ChatMessage[];
  savedAt: number;
  expiresAt: number;
}
export interface OfflineDraft {
  key: string;
  namespace: string;
  baseScope: string;
  scope: OfflineScope;
  body: string;
  updatedAt: number;
  expiresAt: number;
}
export interface QueuedMessage {
  id: string;
  namespace: string;
  baseScope: string;
  scope: OfflineScope;
  actorAuthzRevision: string;
  idempotencyKey: string;
  body: string;
  attachmentIds: readonly string[];
  reply?: { readonly id: string; readonly version: string };
  createdAt: number;
  expiresAt: number;
  status: 'queued' | 'sending' | 'failed' | 'rejected' | 'expired';
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseUntil: number;
  error: string | null;
}
export interface QueueIntent {
  readonly clientMessageId: string;
  readonly idempotencyKey: string;
  readonly body: string;
  readonly attachmentIds?: readonly string[];
  readonly reply?: { readonly id: string; readonly version: string };
  readonly createdAt: number;
}
export const namespaceKey = (identity: OfflineIdentity) =>
  JSON.stringify([identity.tenantId, identity.principalId]);
export const conversationKey = (scope: OfflineScope) =>
  JSON.stringify([scope.tenantId, scope.principalId, scope.workspaceId, scope.conversationId]);
export const offlineScopeKey = (scope: OfflineScope) =>
  JSON.stringify([
    scope.tenantId,
    scope.principalId,
    scope.workspaceId,
    scope.conversationId,
    scope.viewScope,
    scope.authzGeneration,
  ]);
export function conversationScope(session: Session, conversation: Conversation): OfflineScope {
  return {
    tenantId: session.tenant_id,
    principalId: session.principal.id,
    workspaceId: conversation.workspace_id,
    conversationId: conversation.id,
    viewScope: conversation.view_scope,
    authzGeneration: conversation.authz_generation,
  };
}
function expiry(created: number, policy: OfflinePolicy) {
  return created + Math.min(7, Math.max(0, policy.offline_queue_max_days)) * 86_400_000;
}
function redacted(
  row: QueuedMessage,
  status: 'rejected' | 'expired',
  error: string,
): QueuedMessage {
  const { reply: _reply, ...safe } = row;
  return {
    ...safe,
    body: '',
    attachmentIds: [],
    status,
    error,
    leaseOwner: null,
    leaseToken: null,
    leaseUntil: 0,
  };
}

/** All persistence requires both server policy and explicit device consent. */
export class OfflineStore extends Dexie {
  readonly preferences!: Table<OfflinePreferences, string>;
  readonly profiles!: Table<OfflineProfile, string>;
  readonly history!: Table<OfflineHistory, string>;
  readonly drafts!: Table<OfflineDraft, string>;
  readonly outbox!: Table<QueuedMessage, string>;
  constructor(name = 'imbox-device-v1') {
    super(name);
    this.version(1).stores({
      preferences: 'key',
      profiles: 'key',
      history: 'key,namespace,baseScope,expiresAt',
      drafts: 'key,namespace,baseScope,expiresAt',
      outbox: 'id,namespace,baseScope,status,createdAt,expiresAt',
    });
  }
  async rememberSession(session: Session, now = Date.now()): Promise<void> {
    const identity = { tenantId: session.tenant_id, principalId: session.principal.id },
      key = namespaceKey(identity);
    await this.transaction(
      'rw',
      this.preferences,
      this.profiles,
      this.history,
      this.drafts,
      this.outbox,
      async () => {
        const pref = await this.preferences.get(key);
        if (!pref || (!pref.history && !pref.queue)) return;
        const old = await this.profiles.get(key);
        if (old && old.authzRevision !== session.authz_revision)
          await this.invalidateIdentity(identity, 'AUTHORIZATION_CHANGED');
        await this.profiles.put({
          key,
          tenantId: session.tenant_id,
          principal: session.principal,
          workspaces: session.workspaces,
          authzRevision: session.authz_revision,
          sessionExpiresAt: session.session_expires_at,
          checkedAt: now,
        });
      },
    );
  }
  async setPreferences(
    identity: OfflineIdentity,
    consent: { queue: boolean; history: boolean },
    policy: OfflinePolicy,
    now = Date.now(),
  ): Promise<OfflinePreferences> {
    const key = namespaceKey(identity),
      value = {
        key,
        queue: consent.queue && policy.offline_queue_allowed,
        history: consent.history && policy.offline_message_cache_allowed,
        policy: { ...policy },
        updatedAt: now,
      };
    await this.transaction(
      'rw',
      this.preferences,
      this.history,
      this.drafts,
      this.outbox,
      async () => {
        await this.preferences.put(value);
        if (!value.history) await this.history.where('namespace').equals(key).delete();
        if (!value.queue) {
          await this.drafts.where('namespace').equals(key).delete();
          const rows = await this.outbox.where('namespace').equals(key).toArray();
          await this.outbox.bulkPut(
            rows.map((row) => redacted(row, 'rejected', 'DEVICE_OR_POLICY_DISABLED')),
          );
        }
      },
    );
    return value;
  }
  async saveHistory(
    session: Session,
    conversation: Conversation,
    messages: readonly ChatMessage[],
    now = Date.now(),
  ): Promise<void> {
    const scope = conversationScope(session, conversation),
      namespace = namespaceKey(scope);
    if (
      messages.some(
        (message) =>
          message.conversation_id !== scope.conversationId ||
          message.view_scope !== scope.viewScope ||
          message.authz_generation !== scope.authzGeneration,
      )
    )
      throw new Error('OFFLINE_SCOPE_MISMATCH');
    await this.transaction(
      'rw',
      this.preferences,
      this.history,
      this.drafts,
      this.outbox,
      async () => {
        const pref = await this.preferences.get(namespace);
        if (!pref?.history || !pref.policy.offline_message_cache_allowed) return;
        await this.invalidateOldGeneration(scope);
        await this.history.put({
          key: offlineScopeKey(scope),
          namespace,
          baseScope: conversationKey(scope),
          scope,
          conversation,
          messages: [...messages].slice(-200),
          savedAt: now,
          expiresAt: now + OFFLINE_RETENTION_MS,
        });
        const records = (await this.history.where('namespace').equals(namespace).toArray()).sort(
          (a, b) => b.savedAt - a.savedAt,
        );
        await this.history.bulkDelete(records.slice(20).map((item) => item.key));
      },
    );
  }
  private async invalidateOldGeneration(scope: OfflineScope) {
    const base = conversationKey(scope),
      key = offlineScopeKey(scope);
    const old = (await this.history.where('baseScope').equals(base).toArray()).filter(
      (item) => item.key !== key,
    );
    await this.history.bulkDelete(old.map((item) => item.key));
    const drafts = (await this.drafts.where('baseScope').equals(base).toArray()).filter(
      (item) => item.key !== key,
    );
    await this.drafts.bulkDelete(drafts.map((item) => item.key));
    const records = (await this.outbox.where('baseScope').equals(base).toArray()).filter(
      (item) => offlineScopeKey(item.scope) !== key,
    );
    await this.outbox.bulkPut(
      records.map((item) => redacted(item, 'rejected', 'AUTHORIZATION_CHANGED')),
    );
  }
  async saveDraft(scope: OfflineScope, body: string, now = Date.now()): Promise<void> {
    await this.transaction('rw', this.preferences, this.drafts, async () => {
      const namespace = namespaceKey(scope),
        pref = await this.preferences.get(namespace);
      if (!pref?.queue || !pref.policy.offline_queue_allowed) return;
      if (!body) {
        await this.drafts.delete(offlineScopeKey(scope));
        return;
      }
      await this.drafts.put({
        key: offlineScopeKey(scope),
        namespace,
        baseScope: conversationKey(scope),
        scope,
        body,
        updatedAt: now,
        expiresAt: expiry(now, pref.policy),
      });
    });
  }
  async enqueue(
    scope: OfflineScope,
    authzRevision: string,
    intent: QueueIntent,
    now = Date.now(),
  ): Promise<QueuedMessage> {
    const namespace = namespaceKey(scope);
    return this.transaction(
      'rw',
      this.preferences,
      this.outbox,
      this.drafts,
      this.history,
      async () => {
        const pref = await this.preferences.get(namespace);
        if (!pref?.queue || !pref.policy.offline_queue_allowed)
          throw new Error('OFFLINE_QUEUE_NOT_ALLOWED');
        if (
          !intent.body.trim() ||
          !Number.isFinite(intent.createdAt) ||
          intent.body.length > 32000 ||
          intent.createdAt > now ||
          expiry(intent.createdAt, pref.policy) <= now
        )
          throw new Error('INVALID_OFFLINE_INTENT');
        const existing = await this.outbox.get(intent.clientMessageId);
        if (existing) {
          if (
            existing.namespace !== namespace ||
            offlineScopeKey(existing.scope) !== offlineScopeKey(scope) ||
            existing.idempotencyKey !== intent.idempotencyKey ||
            existing.body !== intent.body ||
            JSON.stringify(existing.attachmentIds) !== JSON.stringify(intent.attachmentIds ?? []) ||
            JSON.stringify(existing.reply) !== JSON.stringify(intent.reply)
          )
            throw new Error('OFFLINE_INTENT_CHANGED');
          return existing;
        }
        const active = await this.outbox
          .where('namespace')
          .equals(namespace)
          .filter((item) => item.status === 'queued' || item.status === 'sending')
          .count();
        if (active >= 100) throw new Error('OFFLINE_QUEUE_FULL');
        await this.invalidateOldGeneration(scope);
        const record: QueuedMessage = {
          id: intent.clientMessageId,
          namespace,
          baseScope: conversationKey(scope),
          scope: { ...scope },
          actorAuthzRevision: authzRevision,
          idempotencyKey: intent.idempotencyKey,
          body: intent.body,
          attachmentIds: [...(intent.attachmentIds ?? [])],
          ...(intent.reply ? { reply: { ...intent.reply } } : {}),
          createdAt: intent.createdAt,
          expiresAt: expiry(intent.createdAt, pref.policy),
          status: 'queued',
          leaseOwner: null,
          leaseToken: null,
          leaseUntil: 0,
          error: null,
        };
        await this.outbox.add(record);
        await this.drafts.delete(offlineScopeKey(scope));
        return record;
      },
    );
  }
  async pending(identity: OfflineIdentity, now = Date.now()): Promise<QueuedMessage[]> {
    await this.expire(now);
    return (await this.outbox.where('namespace').equals(namespaceKey(identity)).toArray())
      .filter(
        (item) => item.status === 'queued' || (item.status === 'sending' && item.leaseUntil <= now),
      )
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  async claim(
    id: string,
    scope: OfflineScope,
    holder: string,
    now = Date.now(),
  ): Promise<QueuedMessage | null> {
    return this.transaction('rw', this.outbox, this.preferences, async () => {
      const pref = await this.preferences.get(namespaceKey(scope)),
        row = await this.outbox.get(id);
      if (
        !pref?.queue ||
        !pref.policy.offline_queue_allowed ||
        !row ||
        offlineScopeKey(row.scope) !== offlineScopeKey(scope) ||
        row.expiresAt <= now ||
        !(row.status === 'queued' || (row.status === 'sending' && row.leaseUntil <= now))
      )
        return null;
      const claim = {
        ...row,
        status: 'sending' as const,
        leaseOwner: holder,
        leaseToken: crypto.randomUUID(),
        leaseUntil: now + OUTBOX_LEASE_MS,
        error: null,
      };
      await this.outbox.put(claim);
      return claim;
    });
  }
  async release(claim: QueuedMessage, retryable: boolean, error: string): Promise<void> {
    await this.transaction('rw', this.outbox, async () => {
      const row = await this.outbox.get(claim.id);
      if (row && row.leaseToken === claim.leaseToken && row.namespace === claim.namespace)
        await this.outbox.put({
          ...row,
          status: retryable ? 'queued' : 'failed',
          error,
          leaseOwner: null,
          leaseToken: null,
          leaseUntil: 0,
        });
    });
  }
  async acknowledge(claim: QueuedMessage): Promise<void> {
    await this.transaction('rw', this.outbox, async () => {
      const row = await this.outbox.get(claim.id);
      if (row && row.leaseToken === claim.leaseToken && row.namespace === claim.namespace)
        await this.outbox.delete(row.id);
    });
  }
  async reconcile(scope: OfflineScope, messages: readonly ChatMessage[]): Promise<void> {
    const saved = new Set(
      messages
        .filter(
          (item) =>
            item.actor.id === scope.principalId &&
            item.conversation_id === scope.conversationId &&
            item.authz_generation === scope.authzGeneration,
        )
        .map((item) => item.client_message_id),
    );
    const rows = await this.outbox.where('baseScope').equals(conversationKey(scope)).toArray();
    await this.outbox.bulkDelete(rows.filter((item) => saved.has(item.id)).map((item) => item.id));
  }
  async invalidateScope(scope: OfflineScope, reason: string): Promise<void> {
    await this.transaction('rw', this.history, this.drafts, this.outbox, async () => {
      const base = conversationKey(scope);
      await this.history.where('baseScope').equals(base).delete();
      await this.drafts.where('baseScope').equals(base).delete();
      const rows = await this.outbox.where('baseScope').equals(base).toArray();
      await this.outbox.bulkPut(rows.map((item) => redacted(item, 'rejected', reason)));
    });
  }
  async invalidateIdentity(identity: OfflineIdentity, reason: string): Promise<void> {
    await this.transaction('rw', this.history, this.drafts, this.outbox, async () => {
      const namespace = namespaceKey(identity);
      await this.history.where('namespace').equals(namespace).delete();
      await this.drafts.where('namespace').equals(namespace).delete();
      const rows = await this.outbox.where('namespace').equals(namespace).toArray();
      await this.outbox.bulkPut(rows.map((item) => redacted(item, 'rejected', reason)));
    });
  }
  async eraseIdentity(identity: OfflineIdentity): Promise<void> {
    const namespace = namespaceKey(identity);
    await this.transaction(
      'rw',
      this.history,
      this.drafts,
      this.outbox,
      this.preferences,
      this.profiles,
      async () => {
        await this.history.where('namespace').equals(namespace).delete();
        await this.drafts.where('namespace').equals(namespace).delete();
        await this.outbox.where('namespace').equals(namespace).delete();
        await this.preferences.delete(namespace);
        await this.profiles.delete(namespace);
      },
    );
  }
  async expire(now = Date.now()): Promise<void> {
    await this.transaction('rw', this.history, this.drafts, this.outbox, async () => {
      await this.history.where('expiresAt').belowOrEqual(now).delete();
      await this.drafts.where('expiresAt').belowOrEqual(now).delete();
      const expired = await this.outbox.where('expiresAt').belowOrEqual(now).toArray();
      await this.outbox.bulkPut(
        expired.map((item) => redacted(item, 'expired', 'OFFLINE_QUEUE_EXPIRED')),
      );
      await this.outbox
        .where('createdAt')
        .below(now - 2 * OFFLINE_RETENTION_MS)
        .delete();
    });
  }
}
