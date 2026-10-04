import {
  assertContract,
  type SchemaName,
  type RegisterAgentInput,
  type IssueAgentCredentialInput,
} from '@imbox/contracts';
import { ApiError, type FetchLike } from '../api.js';
export class AgentApi {
  constructor(
    readonly tenantId: string,
    readonly csrfToken: string,
    private readonly fetcher: FetchLike = (url, init) => globalThis.fetch(url, init),
  ) {}
  private async request<N extends SchemaName>(
    name: N,
    path: string,
    signal: AbortSignal,
    command?: { body: unknown; key: string },
  ) {
    const headers = new Headers({ 'X-Imbox-Tenant-Id': this.tenantId, Accept: 'application/json' });
    if (command) {
      headers.set('Content-Type', 'application/json');
      headers.set('X-CSRF-Token', this.csrfToken);
      headers.set('Idempotency-Key', command.key);
    }
    const response = await this.fetcher(path, {
      method: command ? 'POST' : 'GET',
      headers,
      signal,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(command ? { body: JSON.stringify(command.body) } : {}),
    });
    if (!response.ok)
      throw new ApiError(
        response.status,
        'AGENT_OPERATION_FAILED',
        response.status === 403
          ? '当前身份没有 Agent 管理权限。'
          : 'Agent 操作未完成，请刷新后重试。',
      );
    return assertContract(name, await response.json());
  }
  directory(workspace: string, signal: AbortSignal) {
    return this.request(
      'AgentDirectory',
      `/v1/agents?workspace_id=${encodeURIComponent(workspace)}`,
      signal,
    );
  }
  access(signal: AbortSignal) {
    return this.request('AgentManagementAccess', '/v1/agent-management', signal);
  }
  credentials(id: string, signal: AbortSignal, cursor?: string) {
    return this.request(
      'AgentCredentialPage',
      `/v1/agents/${encodeURIComponent(id)}/credentials${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      signal,
    );
  }
  register(body: RegisterAgentInput, key: string, signal: AbortSignal) {
    return this.request('RegisteredAgent', '/v1/agents', signal, { body, key });
  }
  issue(id: string, body: IssueAgentCredentialInput, key: string, signal: AbortSignal) {
    return this.request(
      'IssuedAgentCredential',
      `/v1/agents/${encodeURIComponent(id)}/credentials`,
      signal,
      { body, key },
    );
  }
  disable(id: string, key: string, signal: AbortSignal) {
    return this.request('RegisteredAgent', `/v1/agents/${encodeURIComponent(id)}/disable`, signal, {
      body: {},
      key,
    });
  }
  revoke(id: string, key: string, signal: AbortSignal) {
    return this.request(
      'AgentCredential',
      `/v1/agent-credentials/${encodeURIComponent(id)}/revoke`,
      signal,
      { body: {}, key },
    );
  }
}
