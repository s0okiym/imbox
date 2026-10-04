import {
  assertContract,
  type SchemaName,
  type ContractTypes,
  type MachineTokenInput,
  type MachineReportInput,
  type RequestDecisionInput,
  type CreateMessageInput,
  type CreateRuntimeRunInput,
} from '@imbox/contracts';

export class ImboxApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly requestId: string | undefined,
  ) {
    super(`${code} (${status})`);
    this.name = 'ImboxApiError';
  }
}
export interface ClientOptions {
  origin: string;
  tenantId: string;
  allowLoopbackHttp?: boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxTransportRetries?: number;
}
/** Server and SDK validate the same schemas. Tokens stay in memory; commands never retry implicitly. */
export class ImboxAgentClient {
  private token: string | null = null;
  private readonly origin: string;
  private readonly fetcher: typeof fetch;
  private readonly timeout: number;
  private readonly retries: number;
  constructor(private readonly options: ClientOptions) {
    const u = new URL(options.origin);
    if (
      u.username ||
      u.password ||
      u.pathname !== '/' ||
      u.search ||
      u.hash ||
      !(
        u.protocol === 'https:' ||
        (options.allowLoopbackHttp &&
          u.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
      )
    )
      throw new Error('A trusted HTTPS API origin is required');
    assertContract('Identifier', options.tenantId);
    this.origin = u.origin;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeout = options.timeoutMs ?? 30000;
    if (!Number.isInteger(this.timeout) || this.timeout < 1 || this.timeout > 120000)
      throw new Error('Invalid timeout');
    this.retries = options.maxTransportRetries ?? 2;
    if (!Number.isInteger(this.retries) || this.retries < 0 || this.retries > 3)
      throw new Error('Transport retries must be 0..3');
  }
  private async call<N extends SchemaName>(
    path: string,
    schema: N,
    opts: {
      method?: 'GET' | 'POST';
      body?: unknown;
      key?: string;
      version?: string;
      anonymous?: boolean;
    } = {},
  ): Promise<ContractTypes[N]> {
    if (!opts.anonymous && !this.token)
      throw new Error('Exchange a credential before calling machine endpoints');
    const headers: Record<string, string> = {
      'X-Imbox-Tenant-Id': this.options.tenantId,
      Accept: 'application/json',
    };
    if (!opts.anonymous) headers.Authorization = `Bearer ${this.token!}`;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.key) headers['Idempotency-Key'] = assertContract('IdempotencyKey', opts.key);
    if (opts.version) headers['If-Match'] = `"${assertContract('Version', opts.version)}"`;
    const signal = AbortSignal.timeout(this.timeout);
    const init: RequestInit = {
      method: opts.method ?? 'GET',
      headers,
      credentials: 'omit',
      redirect: 'error',
      signal,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    };
    const safeToRetry = !opts.anonymous && (init.method === 'GET' || opts.key !== undefined);
    let response: Response | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await this.fetcher(`${this.origin}${path}`, init);
        if (!safeToRetry || attempt >= this.retries || ![502, 503, 504].includes(response.status))
          break;
        await response.body?.cancel();
      } catch (error) {
        if (!safeToRetry || attempt >= this.retries || signal.aborted) throw error;
      }
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(
          () => {
            signal.removeEventListener('abort', abort);
            resolve();
          },
          100 * 2 ** attempt,
        );
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener('abort', abort, { once: true });
      });
    }
    if (!response) throw new Error('No API response');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing API response');
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > 16 * 1024 * 1024) {
          await reader.cancel();
          throw new Error('API response exceeds limit');
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!response.ok) {
      const e = parsed as { code?: unknown; request_id?: unknown };
      throw new ImboxApiError(
        response.status,
        typeof e?.code === 'string' ? e.code : 'INVALID_ERROR_RESPONSE',
        typeof e?.request_id === 'string' ? e.request_id : undefined,
      );
    }
    return assertContract(schema, parsed);
  }
  async exchange(input: MachineTokenInput) {
    const result = await this.call('/v1/machine-tokens', 'MachineToken', {
      method: 'POST',
      body: assertContract('MachineTokenInput', input),
      anonymous: true,
    });
    this.token = result.access_token;
    return { expires_at: result.expires_at, scopes: result.scopes };
  }
  clearToken() {
    this.token = null;
  }
  private id(id: string) {
    return assertContract('Identifier', id);
  }
  directory(workspaceId: string) {
    return this.call(`/v1/machine/agents?workspace_id=${this.id(workspaceId)}`, 'AgentDirectory');
  }
  getMemory(memoryId: string) {
    return this.call(`/v1/machine/memories/${this.id(memoryId)}`, 'ExplicitMemory');
  }
  search(input: ContractTypes['KnowledgeSearchQuery']) {
    const validated = assertContract('KnowledgeSearchQuery', input);
    const query = new URLSearchParams(
      Object.entries(validated).map(([key, value]): [string, string] => [key, String(value)]),
    );
    return this.call(`/v1/machine/search?${query}`, 'KnowledgeSearchPage');
  }
  listMemories(
    input: { conversation_id?: string; task_id?: string; cursor?: string; limit?: number } = {},
  ) {
    const query = new URLSearchParams();
    for (const field of ['conversation_id', 'task_id'] as const)
      if (input[field]) query.set(field, this.id(input[field]));
    if (input.cursor) query.set('cursor', assertContract('Cursor', input.cursor));
    if (input.limit !== undefined) {
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50)
        throw new Error('Invalid memory page limit');
      query.set('limit', String(input.limit));
    }
    return this.call(`/v1/machine/memories?${query}`, 'ExplicitMemoryPage');
  }
  listRuns() {
    return this.call('/v1/machine/agent-runs', 'MachineRunPage');
  }
  getRun(runId: string) {
    return this.call(`/v1/machine/agent-runs/${this.id(runId)}`, 'RuntimeRun');
  }
  getContext(runId: string) {
    return this.call(
      `/v1/machine/agent-runs/${this.id(runId)}/context-manifest`,
      'RuntimeContextManifest',
    );
  }
  createRun(input: CreateRuntimeRunInput, key: string) {
    return this.call('/v1/machine/agent-runs', 'RuntimeRun', {
      method: 'POST',
      body: assertContract('CreateRuntimeRunInput', input),
      key,
    });
  }
  claim(runId: string, key: string) {
    return this.call(`/v1/machine/agent-runs/${this.id(runId)}/claim`, 'MachineClaim', {
      method: 'POST',
      body: {},
      key,
    });
  }
  heartbeat(runId: string, generation: string) {
    return this.call(`/v1/machine/agent-runs/${this.id(runId)}/heartbeat`, 'MachineHeartbeat', {
      method: 'POST',
      body: assertContract('MachineHeartbeatInput', { generation }),
    });
  }
  report(runId: string, input: MachineReportInput, key: string) {
    return this.call(`/v1/machine/agent-runs/${this.id(runId)}/reports`, 'RuntimeRun', {
      method: 'POST',
      body: assertContract('MachineReportInput', input),
      key,
    });
  }
  listRequests(cursor?: string) {
    return this.call(
      `/v1/machine/requests${cursor ? `?cursor=${encodeURIComponent(assertContract('Cursor', cursor))}` : ''}`,
      'CollaborationRequestPage',
    );
  }
  getRequest(requestId: string) {
    return this.call(`/v1/machine/requests/${this.id(requestId)}`, 'CollaborationRequest');
  }
  acknowledgeRequest(requestId: string, proposalVersion: string, key: string) {
    return this.call(`/v1/machine/requests/${this.id(requestId)}/ack`, 'AgentDeliveryReceipt', {
      method: 'POST',
      body: assertContract('AgentDeliveryInput', { proposal_version: proposalVersion }),
      key,
    });
  }
  decideRequest(requestId: string, version: string, input: RequestDecisionInput, key: string) {
    return this.call(
      `/v1/machine/requests/${this.id(requestId)}/decisions`,
      'RequestDecisionResult',
      { method: 'POST', body: assertContract('RequestDecisionInput', input), key, version },
    );
  }
  getTask(taskId: string) {
    return this.call(`/v1/machine/tasks/${this.id(taskId)}`, 'Task');
  }
  listMessages(conversationId: string, cursor?: string) {
    return this.call(
      `/v1/machine/conversations/${this.id(conversationId)}/messages${cursor ? `?cursor=${encodeURIComponent(assertContract('Cursor', cursor))}` : ''}`,
      'MessagePage',
    );
  }
  sendMessage(conversationId: string, input: CreateMessageInput, key: string) {
    return this.call(`/v1/machine/conversations/${this.id(conversationId)}/messages`, 'Message', {
      method: 'POST',
      body: assertContract('CreateMessageInput', input),
      key,
    });
  }
}
