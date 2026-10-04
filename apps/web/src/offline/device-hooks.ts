import { useEffect, useState } from 'react';
import type { Conversation } from '@imbox/contracts';
import { ApiClient, ApiError, type ChatMessage, type Session } from '../api.js';
import { GovernanceApi } from '../governance/governance-api.js';
import { drainOutbox } from './offline-outbox.js';
import {
  adoptDeviceSession,
  deviceChanged,
  deviceGeneration,
  deviceStore,
} from './device-store.js';
import { conversationScope, namespaceKey, offlineScopeKey } from './offline-store.js';
export function useDeviceSession(
  session: Session | null,
  sessionLost: (message: string | null) => void,
) {
  useEffect(() => {
    if (!session) return;
    const abort = new AbortController();
    let busy = false;
    const identity = { tenantId: session.tenant_id, principalId: session.principal.id };
    const work = async () => {
      if (busy || abort.signal.aborted || !navigator.onLine) return;
      busy = true;
      const epoch = deviceGeneration();
      try {
        const store = deviceStore();
        await adoptDeviceSession(session, epoch);
        if (abort.signal.aborted || epoch !== deviceGeneration()) return;
        await store.expire();
        const pref = await store.preferences.get(namespaceKey(identity));
        if (!pref?.queue && !pref?.history) return;
        const base = new ApiClient(session.tenant_id, session.csrf_token);
        const policy = await new GovernanceApi(session.tenant_id, session.csrf_token).policy(
          abort.signal,
        );
        if (abort.signal.aborted || epoch !== deviceGeneration()) return;
        const current = await store.transaction('rw', store.tables, async () => {
          if (epoch !== deviceGeneration()) return null;
          const latest = await store.preferences.get(namespaceKey(identity));
          if (!latest) return null;
          return store.setPreferences(identity, latest, policy);
        });
        if (!current || abort.signal.aborted || epoch !== deviceGeneration()) return;
        if (current.history !== pref.history || current.queue !== pref.queue) deviceChanged();
        for (const cached of await store.history
          .where('namespace')
          .equals(namespaceKey(identity))
          .toArray()) {
          if (abort.signal.aborted) return;
          try {
            const currentConversation = await base.conversation(
              cached.scope.conversationId,
              abort.signal,
            );
            if (currentConversation.authz_generation !== cached.scope.authzGeneration) {
              await store.invalidateScope(cached.scope, 'AUTHORIZATION_CHANGED');
              deviceChanged();
            }
          } catch (failure) {
            if (abort.signal.aborted) return;
            if (failure instanceof ApiError && [403, 404].includes(failure.status)) {
              await store.invalidateScope(cached.scope, 'ACCESS_REVOKED');
              deviceChanged();
            } else throw failure;
          }
        }
        await drainOutbox(
          store,
          identity,
          {
            session: (signal) => base.me(signal),
            policy: async () => policy,
            conversation: (id, signal) => base.conversation(id, signal),
            send: (message, fresh, signal) =>
              new ApiClient(fresh.tenant_id, fresh.csrf_token).sendMessage(
                message.scope.conversationId,
                message.id,
                message.body,
                message.idempotencyKey,
                signal,
                message.attachmentIds,
                message.reply,
              ),
          },
          abort.signal,
          {
            saved: (message) =>
              window.dispatchEvent(new CustomEvent('imbox:offline-saved', { detail: message })),
            rejected: (message) =>
              window.dispatchEvent(
                new CustomEvent('imbox:offline-rejected', { detail: { id: message.id } }),
              ),
            sessionLost: () => sessionLost('登录已失效。待发消息已暂停，请用原身份重新登录。'),
          },
        );
      } catch (failure) {
        if (!abort.signal.aborted && failure instanceof ApiError && failure.status === 401)
          sessionLost('登录已失效。待发消息已暂停，请用原身份重新登录。');
        if (!abort.signal.aborted && failure instanceof ApiError && failure.status === 403) {
          await deviceStore().invalidateIdentity(identity, 'ACCESS_REVOKED');
          if (!abort.signal.aborted) sessionLost('当前身份已无权访问，已清除本机受限内容。');
        }
        // Transient failures retain the original commands for a later foreground attempt.
      } finally {
        busy = false;
      }
    };
    const wake = () => {
      void work();
    };
    wake();
    const timer = setInterval(wake, 3000);
    window.addEventListener('online', wake);
    window.addEventListener('imbox:device-data', wake);
    return () => {
      abort.abort();
      clearInterval(timer);
      window.removeEventListener('online', wake);
      window.removeEventListener('imbox:device-data', wake);
    };
  }, [session, sessionLost]);
}
export function useConversationDevice(
  session: Session,
  conversation: Conversation,
  messages: readonly ChatMessage[] | undefined,
) {
  const [queueAllowed, setQueueAllowed] = useState(false),
    [historySaved, setHistorySaved] = useState(false),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    const changed = () => setRevision((n) => n + 1);
    window.addEventListener('imbox:device-data', changed);
    return () => window.removeEventListener('imbox:device-data', changed);
  }, []);
  useEffect(() => {
    let active = true;
    setHistorySaved(false);
    const timer = setTimeout(() => {
      void (async () => {
        const store = deviceStore(),
          pref = await store.preferences.get(
            namespaceKey({ tenantId: session.tenant_id, principalId: session.principal.id }),
          );
        if (active) setQueueAllowed(!!pref?.queue && pref.policy.offline_queue_allowed);
        if (messages && active) {
          await store.saveHistory(session, conversation, messages);
          const cached = await store.history.get(
            offlineScopeKey(conversationScope(session, conversation)),
          );
          if (active) setHistorySaved(!!cached);
          await store.reconcile(conversationScope(session, conversation), messages);
        }
      })().catch(() => {
        if (active) setQueueAllowed(false);
      });
    }, 150);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [session, conversation, messages, revision]);
  return { queueAllowed, historySaved };
}
