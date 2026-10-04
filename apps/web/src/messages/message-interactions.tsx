import { useEffect, useRef, useState } from 'react';
import type { MessageQuote, ReactionPage } from '@imbox/contracts';
import { ApiClient, describeError, isAccessLoss } from '../api.js';
import type { ChatMessage, Member, Session } from '../api.js';
import { ErrorNotice, fullTime, IdentityTag, Modal, Spinner } from '../components.js';
import { commandIdentity } from '../tasks/task-state.js';
import type { CommandIdentity } from '../tasks/task-state.js';
import { ResourceApi } from '../resources/resource-api.js';
import { AttachmentLinks } from '../resources/resource-components.js';
import { sortMessages } from '../message-state.js';
import './messages.css';

export const REACTION_EMOJIS = ['👍', '❤️', '🎉', '😄', '👀', '🙏'] as const;
export function Quote({ quote }: { readonly quote: MessageQuote }) {
  return (
    <blockquote className="message-quote">
      <span>引用固定版本 {quote.source_version}</span>
      <p>{quote.unavailable ? '原消息不可用或无权查看' : (quote.body ?? '原消息不可用')}</p>
    </blockquote>
  );
}
export function MessageActions({
  message,
  session,
  onReply,
  onThread,
  onReactions,
}: {
  readonly message: ChatMessage;
  readonly session: Session;
  readonly onReply: () => void;
  readonly onThread: () => void;
  readonly onReactions: () => void;
}) {
  return (
    <div className="message-interactions">
      {session.capabilities.includes('messaging.reactions') && (
        <>
          {(message.reactions ?? []).map((item) => (
            <button
              className="reaction-pill"
              key={item.emoji}
              aria-label={`查看 ${item.emoji} 回应，共 ${item.count} 人`}
              onClick={onReactions}
            >
              {item.emoji}
              <span>{item.count}</span>
            </button>
          ))}
          <button className="text-button" onClick={onReactions}>
            回应
          </button>
        </>
      )}
      {session.capabilities.includes('messaging.quotes') && (
        <button className="text-button" onClick={onReply}>
          引用回复
        </button>
      )}
      {session.capabilities.includes('messaging.threads') && (
        <button className="text-button" onClick={onThread}>
          查看线程
        </button>
      )}
    </div>
  );
}
export function ReactionsDialog({
  client,
  message,
  principalId,
  members,
  onChanged,
  onClose,
  accessLost,
}: {
  readonly client: ApiClient;
  readonly message: ChatMessage;
  readonly principalId: string;
  readonly members: readonly Member[];
  readonly onChanged: (message: ChatMessage) => void;
  readonly onClose: () => void;
  readonly accessLost: (error: unknown) => void;
}) {
  const [items, setItems] = useState<ReactionPage['items']>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const flight = useRef<AbortController | null>(null);
  const identity = useRef<CommandIdentity | null>(null);
  useEffect(() => () => flight.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void (async () => {
      const all: ReactionPage['items'] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await client.reactions(message.id, controller.signal, cursor);
        all.push(...page.items);
        cursor = page.next_cursor;
        if (cursor) {
          if (seen.has(cursor)) throw new Error('Invalid pagination');
          seen.add(cursor);
        }
      } while (cursor && !controller.signal.aborted);
      if (!controller.signal.aborted) setItems(all);
    })()
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) {
          if (isAccessLoss(failure)) accessLost(failure);
          else setError(describeError(failure));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [client, message.id, message.version, tick, accessLost]);
  const decide = async (emoji: string, present: boolean) => {
    if (flight.current) return;
    const controller = new AbortController();
    flight.current = controller;
    setBusy(true);
    setError(null);
    identity.current = commandIdentity(
      identity.current,
      { id: message.id, emoji, present },
      'reaction',
      () => crypto.randomUUID(),
    );
    try {
      const saved = await client.react(
        message.id,
        emoji,
        present,
        identity.current.key,
        controller.signal,
      );
      if (!controller.signal.aborted) {
        onChanged(saved);
        identity.current = null;
        setTick((value) => value + 1);
      }
    } catch (failure: unknown) {
      if (!controller.signal.aborted) {
        if (isAccessLoss(failure)) accessLost(failure);
        else setError(describeError(failure));
      }
    } finally {
      if (!controller.signal.aborted) {
        flight.current = null;
        setBusy(false);
      }
    }
  };
  return (
    <Modal title="消息回应" onClose={onClose}>
      <p className="dialog-intro">{message.body}</p>
      {loading ? (
        <Spinner />
      ) : (
        <div className="reaction-choices">
          {REACTION_EMOJIS.map((emoji) => {
            const existing = items.filter((item) => item.emoji === emoji);
            const mine = existing.some((item) => item.principal_id === principalId);
            return (
              <div key={emoji}>
                <button
                  className={`button ${mine ? 'primary' : 'subtle'}`}
                  disabled={busy}
                  onClick={() => {
                    void decide(emoji, !mine);
                  }}
                >
                  {mine ? `撤销我的 ${emoji}` : `添加 ${emoji}`}
                </button>
                <p>
                  {existing
                    .map(
                      (item) =>
                        members.find((member) => member.principal.id === item.principal_id)
                          ?.principal.display_name ?? '成员',
                    )
                    .join('、') || '暂无回应'}
                </p>
              </div>
            );
          })}
        </div>
      )}
      {error && <ErrorNotice>{error}</ErrorNotice>}
    </Modal>
  );
}
export function ThreadDialog({
  client,
  resources,
  rootId,
  session,
  onChanged,
  onClose,
  accessLost,
}: {
  readonly client: ApiClient;
  readonly resources: ResourceApi;
  readonly rootId: string;
  readonly session: Session;
  readonly onChanged: (message: ChatMessage) => void;
  readonly onClose: () => void;
  readonly accessLost: (error: unknown) => void;
}) {
  const [root, setRoot] = useState<ChatMessage | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [target, setTarget] = useState<ChatMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const flight = useRef<AbortController | null>(null);
  const identity = useRef<CommandIdentity | null>(null);
  useEffect(() => () => flight.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const head = await client.message(rootId, controller.signal);
        const replies: ChatMessage[] = [];
        const seen = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = await client.thread(rootId, controller.signal, cursor);
          replies.push(...page.items);
          cursor = page.next_cursor;
          if (cursor) {
            if (seen.has(cursor)) throw new Error('Invalid pagination');
            seen.add(cursor);
          }
        } while (cursor && !controller.signal.aborted);
        if (!controller.signal.aborted) {
          setRoot(head);
          setMessages(sortMessages(replies));
          setError(null);
        }
      } catch (failure: unknown) {
        if (!controller.signal.aborted) {
          if (isAccessLoss(failure)) {
            setRoot(null);
            setMessages([]);
            setTarget(null);
            setDraft('');
            accessLost(failure);
          } else setError(describeError(failure));
        }
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => {
            void poll();
          }, 3_000);
      }
    };
    void poll();
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, rootId, tick, accessLost]);
  const reply = target ?? root;
  const send = async () => {
    if (flight.current || !draft.trim() || !root || !reply || reply.deleted) return;
    const controller = new AbortController();
    flight.current = controller;
    setBusy(true);
    setError(null);
    const body = { body: draft.trim(), reply: { id: reply.id, version: reply.version } };
    identity.current = commandIdentity(identity.current, body, 'thread-reply', () =>
      crypto.randomUUID(),
    );
    try {
      const saved = await client.sendMessage(
        root.conversation_id,
        identity.current.key,
        body.body,
        identity.current.key,
        controller.signal,
        [],
        body.reply,
      );
      if (!controller.signal.aborted) {
        onChanged(saved);
        setMessages((items) =>
          sortMessages([saved, ...items.filter((item) => item.id !== saved.id)]),
        );
        setDraft('');
        setTarget(null);
        identity.current = null;
        setTick((value) => value + 1);
      }
    } catch (failure: unknown) {
      if (!controller.signal.aborted) {
        if (isAccessLoss(failure)) accessLost(failure);
        else setError(describeError(failure));
      }
    } finally {
      if (!controller.signal.aborted) {
        flight.current = null;
        setBusy(false);
      }
    }
  };
  return (
    <Modal title="消息线程" onClose={onClose}>
      <div className="thread-messages">
        {root === null ? (
          <Spinner />
        ) : (
          [root, ...messages].map((message) => (
            <article
              key={message.id}
              className={`thread-message ${message.id === root.id ? 'thread-root' : ''}`}
              aria-label={`${message.actor.display_name}的线程消息`}
            >
              <header>
                <strong>{message.actor.display_name}</strong>
                <IdentityTag principal={message.actor} />
                <time>{fullTime(message.created_at)}</time>
              </header>
              {!message.deleted && message.quote && <Quote quote={message.quote} />}
              <p className="task-prose">{message.deleted ? '这条消息已被删除' : message.body}</p>
              {!message.deleted && message.attachment_ids.length > 0 && (
                <AttachmentLinks api={resources} ids={message.attachment_ids} />
              )}
              {!message.deleted && session.capabilities.includes('messaging.quotes') && (
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => setTarget(message)}
                >
                  回复这一条
                </button>
              )}
            </article>
          ))
        )}
      </div>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {reply && !reply.deleted && (
        <form
          className="thread-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <p>
            回复 {reply.actor.display_name} · 固定版本 {reply.version}
            {target && (
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => setTarget(null)}
              >
                改为回复主消息
              </button>
            )}
          </p>
          <textarea
            className="text-input"
            aria-label="线程回复内容"
            rows={3}
            required
            maxLength={16384}
            value={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="dialog-actions">
            <button className="button primary" disabled={busy || !draft.trim()}>
              {busy ? '正在发送…' : '发送线程回复'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
