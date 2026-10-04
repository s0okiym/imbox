import { useEffect, useState } from 'react';
import type { ChatMessage } from '../api.js';
import { ApiClient, ApiError } from '../api.js';
/** A deep-link is a locator only; resolve its current body and scope independently. */
export function LinkedMessage({
  client,
  id,
  conversationId,
  generation,
  sessionLost,
}: {
  client: ApiClient;
  id: string;
  conversationId: string;
  generation: string;
  sessionLost: (error: unknown) => void;
}) {
  const [message, setMessage] = useState<ChatMessage | null>(null),
    [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    let active = false;
    const refresh = async () => {
      if (active) return;
      active = true;
      try {
        const item = await client.message(id, abort.signal);
        if (abort.signal.aborted) return;
        if (
          item.conversation_id !== conversationId ||
          item.view_scope !== conversationId ||
          item.authz_generation !== generation ||
          item.deleted
        ) {
          setMessage(null);
          setUnavailable(true);
          return;
        }
        setMessage(item);
        setUnavailable(false);
      } catch (error) {
        if (!abort.signal.aborted) {
          setMessage(null);
          setUnavailable(true);
          if (error instanceof ApiError && error.status === 401) sessionLost(error);
        }
      } finally {
        active = false;
      }
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 3000);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [client, id, conversationId, generation, sessionLost]);
  return (
    <aside className="connection-banner" aria-label="链接指向的消息">
      {message ? (
        <div>
          <strong>链接指向的消息 · {message.actor.display_name}</strong>
          <p>{message.body}</p>
        </div>
      ) : (
        <span>{unavailable ? '此消息不可用或当前无权查看。' : '正在核对链接消息…'}</span>
      )}
    </aside>
  );
}
