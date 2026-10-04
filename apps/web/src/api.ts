import type {
  Conversation,
  ConversationMemberPage,
  ConversationPage,
  CreateConversationInput,
  Me,
  Message,
  MessagePage,
  ReadCursor,
  ReactionPage,
  StreamEvents,
  StreamSnapshot,
  WorkspaceMemberPage,
} from '@imbox/contracts';

export type Session = Me;
export type ChatMessage = Message;
export type ChatMessagePage = MessagePage;
export type Member = WorkspaceMemberPage['items'][number] | ConversationMemberPage['items'][number];

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Same-origin requests only. Credentials and response bodies never enter localStorage. */
export class ApiClient {
  constructor(
    readonly tenantId: string,
    readonly csrfToken: string | null = null,
    private readonly fetcher: FetchLike = (input, init) => globalThis.fetch(input, init),
  ) {}

  private async request<T>(
    path: string,
    options: {
      method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
      body?: unknown;
      idempotencyKey?: string;
      version?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    const headers = new Headers({ 'X-Imbox-Tenant-Id': this.tenantId, Accept: 'application/json' });
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    if (this.csrfToken !== null) headers.set('X-CSRF-Token', this.csrfToken);
    if (options.idempotencyKey !== undefined)
      headers.set('Idempotency-Key', options.idempotencyKey);
    if (options.version !== undefined) headers.set('If-Match', `"${options.version}"`);
    const response = await this.fetcher(path, {
      method: options.method ?? 'GET',
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    let payload: unknown = null;
    if (response.status !== 204) {
      try {
        payload = await response.json();
      } catch {
        /* Report a controlled protocol error below. */
      }
    }
    if (!response.ok) {
      const record = isRecord(payload) ? payload : {};
      throw new ApiError(
        response.status,
        typeof record['code'] === 'string' ? record['code'] : 'REQUEST_FAILED',
        typeof record['message'] === 'string' ? record['message'] : '请求未能完成',
        typeof record['request_id'] === 'string' ? record['request_id'] : null,
      );
    }
    if (response.status !== 204 && payload === null) {
      throw new ApiError(502, 'INVALID_RESPONSE', '服务器返回了无法读取的响应');
    }
    // The API validates outgoing DTOs using the shared contract. Keep their shape intact.
    return payload as T;
  }

  me(signal?: AbortSignal): Promise<Session> {
    return this.request('/v1/me', signal === undefined ? {} : { signal });
  }
  devLogin(principalId: string): Promise<unknown> {
    return this.request('/v1/auth/dev-login', {
      method: 'POST',
      body: { principal_id: principalId },
    });
  }
  logout(): Promise<unknown> {
    return this.request('/v1/auth/logout', { method: 'POST', idempotencyKey: crypto.randomUUID() });
  }
  conversations(signal?: AbortSignal, cursor?: string): Promise<ConversationPage> {
    const query = new URLSearchParams({ limit: '100' });
    if (cursor !== undefined) query.set('cursor', cursor);
    return this.request(`/v1/conversations?${query}`, signal === undefined ? {} : { signal });
  }
  conversation(id: string, signal: AbortSignal): Promise<Conversation> {
    return this.request(`/v1/conversations/${encodeURIComponent(id)}`, { signal });
  }
  createConversation(
    input: CreateConversationInput,
    idempotencyKey: string,
  ): Promise<Conversation> {
    return this.request('/v1/conversations', { method: 'POST', body: input, idempotencyKey });
  }
  messages(id: string, signal: AbortSignal, cursor?: string): Promise<ChatMessagePage> {
    const query = new URLSearchParams({ limit: '50' });
    if (cursor !== undefined) query.set('cursor', cursor);
    return this.request(`/v1/conversations/${encodeURIComponent(id)}/messages?${query}`, {
      signal,
    });
  }
  message(id: string, signal: AbortSignal): Promise<ChatMessage> {
    return this.request(`/v1/messages/${encodeURIComponent(id)}`, { signal });
  }
  thread(id: string, signal: AbortSignal, cursor?: string): Promise<ChatMessagePage> {
    return this.request(
      `/v1/messages/${encodeURIComponent(id)}/thread?${new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) })}`,
      { signal },
    );
  }
  reactions(id: string, signal: AbortSignal, cursor?: string): Promise<ReactionPage> {
    return this.request(
      `/v1/messages/${encodeURIComponent(id)}/reactions?${new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) })}`,
      { signal },
    );
  }
  react(
    id: string,
    emoji: string,
    present: boolean,
    key: string,
    signal: AbortSignal,
  ): Promise<ChatMessage> {
    return this.request(
      `/v1/messages/${encodeURIComponent(id)}/reactions${present ? '' : '/remove'}`,
      { method: 'POST', body: { emoji }, idempotencyKey: key, signal },
    );
  }
  sendMessage(
    id: string,
    clientMessageId: string,
    body: string,
    idempotencyKey: string,
    signal: AbortSignal,
    attachmentIds: readonly string[] = [],
    reply?: { readonly id: string; readonly version: string },
  ): Promise<ChatMessage> {
    return this.request(`/v1/conversations/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      body: {
        client_message_id: clientMessageId,
        body,
        ...(attachmentIds.length ? { attachment_ids: attachmentIds } : {}),
        ...(reply ? { reply_to_id: reply.id, reply_to_version: reply.version } : {}),
      },
      idempotencyKey,
      signal,
    });
  }
  editMessage(
    message: ChatMessage,
    body: string,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<ChatMessage> {
    return this.request(`/v1/messages/${encodeURIComponent(message.id)}`, {
      method: 'PATCH',
      body: { body },
      version: message.version,
      idempotencyKey,
      signal,
    });
  }
  deleteMessage(
    message: ChatMessage,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    return this.request(`/v1/messages/${encodeURIComponent(message.id)}`, {
      method: 'DELETE',
      version: message.version,
      idempotencyKey,
      signal,
    });
  }
  workspaceMembers(id: string, signal: AbortSignal): Promise<WorkspaceMemberPage> {
    return this.request(`/v1/workspaces/${encodeURIComponent(id)}/members`, { signal });
  }
  conversationMembers(id: string, signal: AbortSignal): Promise<ConversationMemberPage> {
    return this.request(`/v1/conversations/${encodeURIComponent(id)}/members`, { signal });
  }
  streamSnapshot(id: string, signal: AbortSignal, cursor?: string): Promise<StreamSnapshot> {
    const query = new URLSearchParams({ limit: '200', window: 'recent' });
    if (cursor !== undefined) query.set('cursor', cursor);
    return this.request(`/v1/streams/${encodeURIComponent(id)}/snapshot?${query}`, { signal });
  }
  streamEvents(id: string, cursor: string, signal: AbortSignal): Promise<StreamEvents> {
    const query = new URLSearchParams({ limit: '200', cursor });
    return this.request(`/v1/streams/${encodeURIComponent(id)}/events?${query}`, { signal });
  }
  markRead(
    id: string,
    seq: string,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<ReadCursor> {
    return this.request(`/v1/conversations/${encodeURIComponent(id)}/read-cursor`, {
      method: 'POST',
      body: { last_read_seq: seq },
      idempotencyKey,
      signal,
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) return '连接暂时中断。请检查网络后重试。';
  const messages: Record<string, string> = {
    UNAUTHENTICATED: '登录已失效，请重新登录。',
    FORBIDDEN: '当前身份无法访问此内容，已清除相关视图。',
    NOT_FOUND: '此内容不可用或你已失去访问权限。',
    VERSION_CONFLICT: '内容已被更新。请查看最新版本后重新编辑。',
    IDEMPOTENCY_CONFLICT: '这个请求的内容已经改变，请核对后重新操作。',
    RATE_LIMITED: '操作有些频繁，请稍后重试。',
    VALIDATION_FAILED: '请检查填写的内容和成员选择。',
    SERVICE_UNAVAILABLE: '服务暂时不可用，请稍后重试。',
  };
  return messages[error.code] ?? '请求未能完成。请稍后重试。';
}

export function isAccessLoss(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 401 || error.status === 403 || error.status === 404)
  );
}
