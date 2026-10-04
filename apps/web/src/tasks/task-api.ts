import type {
  CollaborationRequest,
  CollaborationRequestPage,
  CreateTaskInput,
  CreateTaskRequestInput,
  RequestDecisionInput,
  RequestDecisionResult,
  ReopenTaskInput,
  ReviseTaskRequestInput,
  Submission,
  SubmissionInput,
  SubmissionPage,
  Task,
  TaskPage,
  TaskParticipantInput,
  RuntimeRun,
  TaskEscalationPage,
  TaskRunOrigin,
  TaskParticipantPage,
  TaskReview,
  TaskReviewInput,
  TaskReviewPage,
  TaskStateInput,
} from '@imbox/contracts';
import { ApiError } from '../api.js';
import type { FetchLike } from '../api.js';

/** Task transport stays independent of the currently deployed messaging UI. */
export class TaskApi {
  constructor(
    readonly tenantId: string,
    readonly csrfToken: string,
    private readonly fetcher: FetchLike = (input, init) => globalThis.fetch(input, init),
  ) {}
  private async request<T>(
    path: string,
    signal: AbortSignal,
    command?: {
      method?: 'POST' | 'PATCH' | 'DELETE';
      body?: unknown;
      key: string;
      version?: string;
    },
  ): Promise<T> {
    const headers = new Headers({ 'X-Imbox-Tenant-Id': this.tenantId, Accept: 'application/json' });
    if (command !== undefined) {
      headers.set('X-CSRF-Token', this.csrfToken);
      headers.set('Idempotency-Key', command.key);
      if (command.version !== undefined) headers.set('If-Match', `"${command.version}"`);
      if (command.body !== undefined) headers.set('Content-Type', 'application/json');
    }
    const response = await this.fetcher(path, {
      method: command?.method ?? (command === undefined ? 'GET' : 'POST'),
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
      const record =
        typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
      throw new ApiError(
        response.status,
        typeof record['code'] === 'string' ? record['code'] : 'REQUEST_FAILED',
        '任务操作未完成',
      );
    }
    return value as T;
  }
  tasks(signal: AbortSignal, cursor?: string): Promise<TaskPage> {
    return this.request(
      `/v1/tasks?${new URLSearchParams({ limit: '100', ...(cursor === undefined ? {} : { cursor }) })}`,
      signal,
    );
  }
  escalations(signal: AbortSignal, cursor?: string): Promise<TaskEscalationPage> {
    return this.request(
      `/v1/task-escalations${cursor ? `?${new URLSearchParams({ cursor })}` : ''}`,
      signal,
    );
  }
  origin(id: string, signal: AbortSignal): Promise<TaskRunOrigin> {
    return this.request(`/v1/tasks/${encodeURIComponent(id)}/run-origin`, signal);
  }
  promote(run: RuntimeRun, task: CreateTaskInput, key: string, signal: AbortSignal): Promise<Task> {
    return this.request(`/v1/agent-runs/${encodeURIComponent(run.id)}/promote`, signal, {
      body: { task, confirm_new_authorization: true },
      key,
      version: run.version,
    });
  }
  takeover(
    id: string,
    version: string,
    reason: string,
    key: string,
    signal: AbortSignal,
  ): Promise<Task> {
    return this.request(`/v1/tasks/${encodeURIComponent(id)}/takeover`, signal, {
      body: { reason },
      key,
      version,
    });
  }
  task(id: string, signal: AbortSignal): Promise<Task> {
    return this.request(`/v1/tasks/${encodeURIComponent(id)}`, signal);
  }
  create(input: CreateTaskInput, key: string, signal: AbortSignal): Promise<Task> {
    return this.request('/v1/tasks', signal, { body: input, key });
  }
  participants(id: string, signal: AbortSignal): Promise<TaskParticipantPage> {
    return this.request(`/v1/tasks/${encodeURIComponent(id)}/participants`, signal);
  }
  participant(
    task: Task,
    input: TaskParticipantInput,
    key: string,
    signal: AbortSignal,
  ): Promise<Task> {
    return this.request(`/v1/tasks/${encodeURIComponent(task.id)}/participants`, signal, {
      body: input,
      key,
      version: task.version,
    });
  }
  removeParticipant(
    task: Task,
    principalId: string,
    key: string,
    signal: AbortSignal,
  ): Promise<Task> {
    return this.request(
      `/v1/tasks/${encodeURIComponent(task.id)}/participants/${encodeURIComponent(principalId)}`,
      signal,
      { method: 'DELETE', key, version: task.version },
    );
  }
  state(task: Task, input: TaskStateInput, key: string, signal: AbortSignal): Promise<Task> {
    return this.request(`/v1/tasks/${encodeURIComponent(task.id)}/state`, signal, {
      body: input,
      key,
      version: task.version,
    });
  }
  lifecycle(
    task: Task,
    action: 'cancel' | 'reopen' | 'takeover',
    input: { reason: string } | ReopenTaskInput,
    key: string,
    signal: AbortSignal,
  ): Promise<Task> {
    return this.request(`/v1/tasks/${encodeURIComponent(task.id)}/${action}`, signal, {
      body: input,
      key,
      version: task.version,
    });
  }
  requests(signal: AbortSignal, cursor?: string): Promise<CollaborationRequestPage> {
    return this.request(
      `/v1/requests?${new URLSearchParams({ limit: '100', ...(cursor === undefined ? {} : { cursor }) })}`,
      signal,
    );
  }
  requestById(id: string, signal: AbortSignal): Promise<CollaborationRequest> {
    return this.request(`/v1/requests/${encodeURIComponent(id)}`, signal);
  }
  propose(
    task: Task,
    input: CreateTaskRequestInput,
    key: string,
    signal: AbortSignal,
  ): Promise<CollaborationRequest> {
    return this.request(`/v1/tasks/${encodeURIComponent(task.id)}/requests`, signal, {
      body: input,
      key,
      version: task.version,
    });
  }
  revise(
    request: CollaborationRequest,
    input: ReviseTaskRequestInput,
    key: string,
    signal: AbortSignal,
  ): Promise<CollaborationRequest> {
    return this.request(`/v1/requests/${encodeURIComponent(request.id)}`, signal, {
      method: 'PATCH',
      body: input,
      key,
      version: request.version,
    });
  }
  decide(
    request: CollaborationRequest,
    input: RequestDecisionInput,
    key: string,
    signal: AbortSignal,
  ): Promise<RequestDecisionResult> {
    return this.request(`/v1/requests/${encodeURIComponent(request.id)}/decisions`, signal, {
      body: input,
      key,
      version: request.version,
    });
  }
  withdraw(
    request: CollaborationRequest,
    reason: string,
    key: string,
    signal: AbortSignal,
  ): Promise<CollaborationRequest> {
    return this.request(`/v1/requests/${encodeURIComponent(request.id)}/withdraw`, signal, {
      body: { reason },
      key,
      version: request.version,
    });
  }
  submissions(id: string, signal: AbortSignal): Promise<SubmissionPage> {
    return this.request(`/v1/tasks/${encodeURIComponent(id)}/submissions`, signal);
  }
  submit(
    task: Task,
    input: SubmissionInput,
    key: string,
    signal: AbortSignal,
  ): Promise<Submission> {
    return this.request(`/v1/tasks/${encodeURIComponent(task.id)}/submissions`, signal, {
      body: input,
      key,
      version: task.version,
    });
  }
  reviews(id: string, signal: AbortSignal): Promise<TaskReviewPage> {
    return this.request(`/v1/tasks/${encodeURIComponent(id)}/reviews`, signal);
  }
  review(
    task: Task,
    input: TaskReviewInput,
    key: string,
    signal: AbortSignal,
  ): Promise<TaskReview> {
    return this.request(`/v1/tasks/${encodeURIComponent(task.id)}/reviews`, signal, {
      body: input,
      key,
      version: task.version,
    });
  }
}
