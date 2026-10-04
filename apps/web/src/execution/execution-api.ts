import type {
  Action,
  PublicationSource,
  ActionApprovalDecisionInput,
  ActionPage,
  ActionReconciliation,
  AgentDirectory,
  CapabilityGrant,
  CapabilityGrantPage,
  CreateActionInput,
  CreateGrantInput,
  CreateRuntimeRunInput,
  ReviseActionInput,
  RuntimeContextManifest,
  RuntimeRun,
  RuntimeRunPage,
  CreateScheduleInput,
  ReviseScheduleInput,
  Schedule,
  ScheduleList,
  ScheduleOccurrenceList,
} from '@imbox/contracts';
import { ApiError } from '../api.js';
import type { FetchLike } from '../api.js';

/** Browser commands never expose worker claim, dispatch, retry or receipt APIs. */
export class ExecutionApi {
  constructor(
    readonly tenantId: string,
    readonly csrfToken: string,
    private readonly fetcher: FetchLike = (url, init) => globalThis.fetch(url, init),
  ) {}
  private async request<T>(
    path: string,
    signal: AbortSignal,
    command?: { body?: unknown; key: string; version?: string; method?: 'PATCH' | 'DELETE' },
  ): Promise<T> {
    const headers = new Headers({ 'X-Imbox-Tenant-Id': this.tenantId, Accept: 'application/json' });
    if (command) {
      headers.set('X-CSRF-Token', this.csrfToken);
      headers.set('Idempotency-Key', command.key);
      if (command.version !== undefined) headers.set('If-Match', `"${command.version}"`);
      if (command.body !== undefined) headers.set('Content-Type', 'application/json');
    }
    const response = await this.fetcher(path, {
      method: command?.method ?? (command ? 'POST' : 'GET'),
      headers,
      signal,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(command?.body === undefined ? {} : { body: JSON.stringify(command.body) }),
    });
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new ApiError(response.ok ? 502 : response.status, 'INVALID_RESPONSE', '无法读取响应');
    }
    if (!response.ok) {
      const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
      throw new ApiError(
        response.status,
        typeof record['code'] === 'string' ? record['code'] : 'REQUEST_FAILED',
        '运行或行动操作未完成',
      );
    }
    return value as T;
  }
  publicationSource(
    grantId: string,
    versionId: string,
    signal: AbortSignal,
  ): Promise<PublicationSource> {
    return this.request(
      `/v1/grants/${encodeURIComponent(grantId)}/publication-sources/${encodeURIComponent(versionId)}`,
      signal,
    );
  }
  agents(workspace: string, signal: AbortSignal): Promise<AgentDirectory> {
    return this.request(`/v1/agents?${new URLSearchParams({ workspace_id: workspace })}`, signal);
  }
  schedules(signal: AbortSignal, cursor?: string): Promise<ScheduleList> {
    return this.request(
      `/v1/schedules${cursor ? `?${new URLSearchParams({ cursor })}` : ''}`,
      signal,
    );
  }
  schedule(id: string, signal: AbortSignal): Promise<Schedule> {
    return this.request(`/v1/schedules/${encodeURIComponent(id)}`, signal);
  }
  occurrences(id: string, signal: AbortSignal, cursor?: string): Promise<ScheduleOccurrenceList> {
    return this.request(
      `/v1/schedules/${encodeURIComponent(id)}/occurrences${cursor ? `?${new URLSearchParams({ cursor })}` : ''}`,
      signal,
    );
  }
  createSchedule(body: CreateScheduleInput, key: string, signal: AbortSignal): Promise<Schedule> {
    return this.request('/v1/schedules', signal, { body, key });
  }
  reviseSchedule(
    schedule: Schedule,
    body: ReviseScheduleInput,
    key: string,
    signal: AbortSignal,
  ): Promise<Schedule> {
    return this.request(`/v1/schedules/${encodeURIComponent(schedule.id)}`, signal, {
      body,
      key,
      version: schedule.version,
      method: 'PATCH',
    });
  }
  disableSchedule(schedule: Schedule, key: string, signal: AbortSignal): Promise<Schedule> {
    return this.request(`/v1/schedules/${encodeURIComponent(schedule.id)}`, signal, {
      key,
      version: schedule.version,
      method: 'DELETE',
    });
  }
  run(id: string, signal: AbortSignal): Promise<RuntimeRun> {
    return this.request(`/v1/agent-runs/${encodeURIComponent(id)}`, signal);
  }
  runs(
    scope: { type: 'task' | 'conversation'; id: string },
    signal: AbortSignal,
    cursor?: string,
  ): Promise<RuntimeRunPage> {
    return this.request(
      `/v1/agent-runs?${new URLSearchParams({ [scope.type === 'task' ? 'task_id' : 'conversation_id']: scope.id, limit: '100', ...(cursor ? { cursor } : {}) })}`,
      signal,
    );
  }
  runToolIntent(id: string, signal: AbortSignal): Promise<Action> {
    return this.request(`/v1/agent-runs/${encodeURIComponent(id)}/tool-intent`, signal);
  }
  context(id: string, signal: AbortSignal): Promise<RuntimeContextManifest> {
    return this.request(`/v1/agent-runs/${encodeURIComponent(id)}/context-manifest`, signal);
  }
  createRun(body: CreateRuntimeRunInput, key: string, signal: AbortSignal): Promise<RuntimeRun> {
    return this.request('/v1/agent-runs', signal, { body, key });
  }
  control(
    run: RuntimeRun,
    operation: 'pause' | 'resume' | 'cancel',
    key: string,
    signal: AbortSignal,
  ): Promise<RuntimeRun> {
    return this.request(`/v1/agent-runs/${encodeURIComponent(run.id)}/${operation}`, signal, {
      key,
      version: run.version,
    });
  }
  actions(signal: AbortSignal, cursor?: string): Promise<ActionPage> {
    return this.request(
      `/v1/actions?${new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) })}`,
      signal,
    );
  }
  action(id: string, signal: AbortSignal): Promise<Action> {
    return this.request(`/v1/actions/${encodeURIComponent(id)}`, signal);
  }
  createAction(body: CreateActionInput, key: string, signal: AbortSignal): Promise<Action> {
    return this.request('/v1/actions', signal, { body, key });
  }
  revise(
    action: Action,
    body: ReviseActionInput,
    key: string,
    signal: AbortSignal,
  ): Promise<Action> {
    return this.request(`/v1/actions/${encodeURIComponent(action.id)}`, signal, {
      body,
      key,
      version: action.version,
      method: 'PATCH',
    });
  }
  decide(
    action: Action,
    body: ActionApprovalDecisionInput,
    key: string,
    signal: AbortSignal,
  ): Promise<Action> {
    return this.request(
      `/v1/actions/${encodeURIComponent(action.id)}/approvals/decisions`,
      signal,
      { body, key, version: action.version },
    );
  }
  reconcile(
    action: Action,
    reason: string,
    key: string,
    signal: AbortSignal,
  ): Promise<ActionReconciliation> {
    return this.request(`/v1/actions/${encodeURIComponent(action.id)}/reconcile`, signal, {
      body: { reason },
      key,
      version: action.version,
    });
  }
  cancel(action: Action, reason: string, key: string, signal: AbortSignal): Promise<Action> {
    return this.request(`/v1/actions/${encodeURIComponent(action.id)}/cancel`, signal, {
      body: { reason },
      key,
      version: action.version,
    });
  }
  grants(signal: AbortSignal): Promise<CapabilityGrantPage> {
    return this.request('/v1/grants', signal);
  }
  grant(id: string, signal: AbortSignal): Promise<CapabilityGrant> {
    return this.request(`/v1/grants/${encodeURIComponent(id)}`, signal);
  }
  createGrant(body: CreateGrantInput, key: string, signal: AbortSignal): Promise<CapabilityGrant> {
    return this.request('/v1/grants', signal, { body, key });
  }
  revoke(
    grant: CapabilityGrant,
    reason: string,
    key: string,
    signal: AbortSignal,
  ): Promise<CapabilityGrant> {
    return this.request(`/v1/grants/${encodeURIComponent(grant.id)}/revoke`, signal, {
      body: { reason },
      key,
      version: grant.revision,
    });
  }
}
