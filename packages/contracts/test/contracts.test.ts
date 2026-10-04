import { describe, expect, it, vi } from 'vitest';
import {
  assertContract,
  ContractValidationError,
  parseContract,
  validateContract,
} from '../src/validation.js';
import {
  definitions,
  JSON_SCHEMA_DIALECT,
  schemaDocument,
  schemaFor,
  schemaNames,
  type SchemaName,
} from '../src/schemas.js';
import { checkOpenApi, generateOpenApi, routeContracts } from '../src/openapi.js';

const id = '01929777-6d00-7000-8000-000000000001';
const id2 = '01929777-6d00-7000-8000-000000000002';
const now = '2026-10-04T00:00:00.000Z';
const view = {
  view_scope: id,
  authz_generation: '1',
  projection_id: id2,
  projection_revision: '2',
};
const message = {
  id,
  conversation_id: id2,
  client_message_id: id,
  actor: { id, kind: 'human', display_name: 'Test', status: 'active' },
  version: '9007199254740993',
  seq: '1',
  body: '你好',
  format: 'text',
  attachment_ids: [],
  created_at: now,
  deleted: false,
  ...view,
};

function invalid(name: SchemaName, value: unknown): void {
  const result = validateContract(name, value);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.issues.length).toBeGreaterThan(0);
}

describe('lossless wire values', () => {
  it.each(['1', '9007199254740993', '9223372036854775807'])(
    'accepts version %s without numeric coercion',
    (version) => {
      const result = validateContract('Version', version);
      expect(result).toEqual({ ok: true, value: version });
    },
  );

  it.each([
    '0',
    '-1',
    '01',
    '1.0',
    '1e3',
    '+1',
    ' 1',
    '9223372036854775808',
    '9999999999999999999',
    '10000000000000000000',
    1,
    9007199254740992,
  ])('rejects noncanonical/overflow version %s', (version) => {
    invalid('Version', version);
  });

  it('handles zero only for counters and keeps bigint JSON numeric values invalid', () => {
    expect(assertContract('Counter', '0')).toBe('0');
    invalid('Counter', -1);
    invalid('Counter', 1n);
    invalid('Counter', '9223372036854775808');
  });

  it('validates real UTC calendar dates rather than accepting offsets or invalid dates', () => {
    expect(assertContract('UtcTimestamp', now)).toBe(now);
    invalid('UtcTimestamp', '2026-02-30T12:00:00Z');
    invalid('UtcTimestamp', '2026-10-04T08:00:00+08:00');
    invalid('UtcTimestamp', '2026-10-04T00:00:00');
  });

  it('uses UUIDs and rejects illustrative prefixed documentation IDs', () => {
    expect(assertContract('Identifier', id)).toBe(id);
    invalid('Identifier', 'run_01');
    invalid('Identifier', 'not-a-uuid');
  });
});

describe('authenticated command boundaries', () => {
  it('accepts a message without accepting any caller-selected actor or role', () => {
    const command = { client_message_id: id, body: 'hello' };
    expect(assertContract('CreateMessageInput', command)).toEqual(command);
    for (const field of ['actor', 'actor_id', 'principal_id', 'role', 'tenant_id', 'approved']) {
      invalid('CreateMessageInput', { ...command, [field]: id2 });
    }
  });

  it('does not coerce, strip unknown keys, or inject defaults', () => {
    const command = { client_message_id: id, body: 'hello', actor_id: id2 };
    const original = structuredClone(command);
    invalid('CreateMessageInput', command);
    expect(command).toEqual(original);
    invalid('PaginationQuery', { limit: '50' });
    expect(assertContract('PaginationQuery', {})).toEqual({});
  });

  it('bounds arrays and prevents duplicate conversation members/attachments', () => {
    const base = { workspace_id: id, kind: 'group', member_ids: [id2] };
    expect(validateContract('CreateConversationInput', base).ok).toBe(true);
    invalid('CreateConversationInput', { ...base, member_ids: [] });
    invalid('CreateConversationInput', { ...base, member_ids: [id2, id2] });
    invalid('CreateMessageInput', {
      client_message_id: id,
      body: 'hello',
      attachment_ids: Array(11).fill(id2),
    });
    invalid('PaginationQuery', { limit: 0 });
    invalid('PaginationQuery', { limit: 201 });
    invalid('PaginationQuery', { limit: 1.5 });
    expect(assertContract('PaginationQuery', { limit: 200 })).toEqual({ limit: 200 });
  });

  it('requires handoff/approval versions and rejects forged deciders', () => {
    const input = { decision: 'accept', proposal_version: '3', expected_task_version: '12' };
    expect(validateContract('RequestDecisionInput', input).ok).toBe(true);
    invalid('RequestDecisionInput', { decision: 'accept', proposal_version: '3' });
    invalid('RequestDecisionInput', { ...input, decided_by: id });
    invalid('ApprovalDecisionInput', { decision: 'approve', action_version: 1 });
    invalid('ApprovalDecisionInput', { decision: 'approve', action_version: '1', approver_id: id });
  });
});

describe('bounded JSON parsing', () => {
  it('enforces UTF-8 bytes before parsing and bounds strings afterwards', () => {
    const tooLarge = JSON.stringify({ client_message_id: id, body: '😀'.repeat(70_000) });
    const result = parseContract('CreateMessageInput', tooLarge);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.keyword).toBe('maxBytes');
    invalid('CreateMessageInput', { client_message_id: id, body: 'x'.repeat(16_385) });
    expect(parseContract('CreateMessageInput', '{broken').ok).toBe(false);
  });

  it('rejects deeply nested structures before schema evaluation', () => {
    let value: unknown = {};
    for (let i = 0; i < 30; i += 1) value = { child: value };
    const result = validateContract('Error', value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.keyword).toBe('maxDepth');
  });

  it('rejects cyclic values, functions, non-finite numbers and dangerous accessors', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    invalid('Error', cycle);
    invalid('Counter', Number.POSITIVE_INFINITY);
    invalid('Counter', Number.NaN);
    invalid('Error', { toJSON: () => ({}) });
    const getter = vi.fn(() => 'secret');
    const value = Object.defineProperty({}, 'body', { get: getter, enumerable: true });
    invalid('CreateMessageInput', value);
    expect(getter).not.toHaveBeenCalled();
  });

  it('does not report shared ordinary JSON subobjects as cycles', () => {
    const workspace = { id, name: 'Workspace', role: 'member' };
    const value = {
      principal: message.actor,
      tenant_id: id,
      csrf_token: 'test-csrf-token',
      authz_revision: '1',
      session_id: id2,
      session_expires_at: now,
      workspaces: [workspace, workspace],
      capabilities: [],
    };
    expect(validateContract('Me', value).ok).toBe(true);
  });

  it('returns safe schema errors without embedding rejected payload values', () => {
    const result = validateContract('CreateMessageInput', {
      client_message_id: id,
      body: 3,
      secret: 'never-echo-this',
    });
    expect(JSON.stringify(result)).not.toContain('never-echo-this');
    expect(() => assertContract('Version', '0')).toThrow(ContractValidationError);
  });
});

describe('DTO and WebSocket distinctions', () => {
  it('requires the session/CSRF restoration context and uses the human principal kind', () => {
    const value = {
      principal: message.actor,
      tenant_id: id,
      csrf_token: 'test-csrf-token',
      authz_revision: '1',
      session_id: id2,
      session_expires_at: now,
      workspaces: [],
      capabilities: [],
    };
    expect(validateContract('Me', value).ok).toBe(true);
    invalid('Me', { ...value, principal: { ...message.actor, kind: 'user' } });
    for (const name of [
      'tenant_id',
      'csrf_token',
      'authz_revision',
      'session_id',
      'session_expires_at',
    ]) {
      const omitted: Record<string, unknown> = { ...value };
      delete omitted[name];
      invalid('Me', omitted);
    }
    invalid('Me', { ...value, csrf_token: 'x'.repeat(129) });
  });

  it('bounds member roles, reactions and lossless read cursors', () => {
    expect(
      validateContract('WorkspaceMemberPage', {
        items: [{ principal: message.actor, role: 'admin' }],
      }).ok,
    ).toBe(true);
    invalid('WorkspaceMemberPage', { items: [{ principal: message.actor, role: 'owner' }] });
    expect(
      validateContract('ConversationMemberPage', {
        items: [{ principal: message.actor, role: 'owner' }],
      }).ok,
    ).toBe(true);
    invalid('AddConversationMemberInput', { principal_id: id, role: 'owner' });
    expect(validateContract('ReactionInput', { emoji: '👍' }).ok).toBe(true);
    invalid('ReactionInput', { emoji: 'x'.repeat(33) });
    invalid('ReadCursorInput', { last_read_seq: 42 });
    expect(assertContract('ReadCursor', { last_read_seq: '9007199254740993' }).last_read_seq).toBe(
      '9007199254740993',
    );
  });

  it('preserves lossless entity and independent projection versions', () => {
    expect(assertContract('Message', message).version).toBe('9007199254740993');
    invalid('Message', { ...message, version: 9007199254740992 });
    invalid('Message', { ...message, seq: 1 });
    invalid('Message', { ...message, authz_generation: '0' });
    invalid('Message', { ...message, unexpected_private_context: 'secret' });
  });

  it('keeps transport ACK separate from task acceptance', () => {
    expect(
      validateContract('WsClientFrame', { type: 'ack', stream_id: id, cursor: 'opaque.token' }).ok,
    ).toBe(true);
    invalid('WsClientFrame', {
      type: 'ack',
      stream_id: id,
      cursor: 'opaque.token',
      decision: 'accept',
    });
    invalid('WsClientFrame', { type: 'hello', protocol_version: 2, client_id: id });
    invalid('WsClientFrame', { type: 'hello', protocol_version: 1, client_id: id, actor: id2 });
  });

  it('accepts a bounded projection summary but not unversioned or arbitrary payloads', () => {
    const projection = {
      type: 'projection.upsert',
      protocol_version: 1,
      stream_id: id,
      ...view,
      event_id: id2,
      entity: { type: 'agent_run', id, version: '9' },
      cursor: 'opaque.token',
      schema_version: 1,
      payload: { status: 'waiting_approval', summary: 'Awaiting a decision', approval_ref: id2 },
    };
    expect(validateContract('WsServerFrame', projection).ok).toBe(true);
    invalid('ProjectionEnvelope', { ...projection, projection_revision: 2 });
    invalid('ProjectionEnvelope', {
      ...projection,
      payload: { summary: 'hi', html: '<script>bad()</script>' },
    });
  });

  it('accepts materialized snapshot content and preserves opaque empty-page progress', () => {
    const projection = {
      type: 'projection.upsert',
      protocol_version: 1,
      stream_id: id,
      ...view,
      event_id: id2,
      entity: { type: 'message', id, version: '9007199254740993' },
      cursor: 'fixed.head',
      schema_version: 1,
      payload: { summary: 'hello', message },
    };
    const snapshot = {
      stream_id: id,
      view_scope: id,
      authz_generation: '1',
      snapshot_id: id2,
      items: [projection],
      cursor: 'fixed.head',
      next_cursor: 'snapshot.next',
      complete: false,
    };
    expect(validateContract('StreamSnapshot', snapshot).ok).toBe(true);
    expect(
      validateContract('StreamEvents', {
        stream_id: id,
        view_scope: id,
        authz_generation: '1',
        items: [],
        cursor: 'scanned.progress',
        has_more: false,
      }).ok,
    ).toBe(true);
    invalid('StreamSnapshot', { ...snapshot, head_seq: '123' });
    invalid('StreamSnapshot', { ...snapshot, items: Array(201).fill(projection) });
  });

  it('does not apply the request-byte cap to bounded message pages', () => {
    const page = {
      items: Array.from({ length: 50 }, () => ({ ...message, body: 'x'.repeat(16_384) })),
    };
    expect(validateContract('MessagePage', page).ok).toBe(true);
  });
});

describe('schema/OpenAPI generation foundation', () => {
  it('publishes self-contained schemas with stable IDs and a 2020-12 dialect', () => {
    expect(schemaDocument.$schema).toBe(JSON_SCHEMA_DIALECT);
    for (const name of schemaNames) {
      expect(schemaFor(name).$id).toBe(`https://imbox.local/schemas/v1/${name}.json`);
    }
    const boundedMaps=new Set([
      '/UploadTicket/properties/upload_headers',
      '/MachineReportInput/properties/checkpoint',
      '/InstallRuntimeAgentInput/properties/config',
      '/RuntimeContextItem/properties/payload',
      '/RuntimeContextItem/properties/authorization_snapshot',
    ]);
    function walk(value: unknown,path=''): void {
      if (Array.isArray(value)) {value.forEach((v,i)=>walk(v,`${path}/${i}`));return;}
      if (!value || typeof value !== 'object') return;
      const node = value as Record<string, unknown>;
      if(node.type==='object'){
        if(boundedMaps.has(path)){expect(typeof node.maxProperties).toBe('number');expect(Number(node.maxProperties)).toBeLessThanOrEqual(100);}
        else expect(node.additionalProperties,`Unexpected open object at ${path}`).toBe(false);
      }
      if (node.type === 'array') expect(typeof node.maxItems).toBe('number');
      Object.entries(node).forEach(([key,v])=>walk(v,`${path}/${key}`));
    }
    walk(definitions);
  });

  it('generates OpenAPI 3.1.1 distinguishing implemented and modeled route contracts', () => {
    const document = generateOpenApi();
    expect(document.openapi).toBe('3.1.1');
    expect(checkOpenApi(document)).toEqual([]);
    const paths = document.paths as Record<string, Record<string, Record<string, unknown>>>;
    for (const route of routeContracts)
      expect(paths[route.path]?.[route.method]?.['x-imbox-implementation-status']).toBe(
        route.status ?? 'implemented',
      );
    expect(paths['/v1/auth/dev-login']?.post?.['x-imbox-implementation-status']).toBe(
      'development-only',
    );
    expect(paths['/v1/streams/{id}/events']?.get?.['x-imbox-implementation-status']).toBe(
      'implemented',
    );
    expect(paths['/v1/conversations/{id}/members']?.post?.responses).toMatchObject({
      '200': {
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Conversation' } } },
      },
    });
    expect(paths['/v1/actions']?.post?.['x-imbox-implementation-status']).toBe('implemented');
    expect(paths['/v1/machine/agent-runs/{id}/reports']?.post?.security).toEqual([{agentBearer:[]}]);
    const machineHeaders=paths['/v1/machine/agent-runs/{id}/reports']?.post?.parameters as Array<{name:string}>;
    expect(machineHeaders.map(p=>p.name)).not.toContain('X-CSRF-Token');
    expect(machineHeaders.map(p=>p.name)).not.toContain('Origin');
    expect(paths['/v1/actions/{id}/dispatch']).toBeUndefined();
    expect(JSON.stringify(document)).not.toContain('#/$defs/');
  });

  it('requires the headers enforced by member mutations and models no-content auth results', () => {
    const document = generateOpenApi();
    const paths = document.paths as Record<string, Record<string, Record<string, unknown>>>;
    const parameters = paths['/v1/conversations/{id}/members']?.post?.parameters as Array<{
      name: string;
      required: boolean;
    }>;
    expect(parameters.filter((p) => p.required).map((p) => p.name)).toEqual(
      expect.arrayContaining(['If-Match', 'Idempotency-Key', 'X-CSRF-Token', 'X-Imbox-Tenant-Id']),
    );
    expect(paths['/v1/auth/logout']?.post?.responses).toMatchObject({
      '204': { description: 'Authorized response' },
    });
    const response = (paths['/v1/auth/logout']?.post?.responses as Record<string, unknown>)['204'];
    expect(response).not.toHaveProperty('content');
  });

  it('catches deleted components, broken references and duplicate operation IDs', () => {
    const document = generateOpenApi();
    const components = document.components as { schemas: Record<string, unknown> };
    delete components.schemas.Message;
    expect(checkOpenApi(document).some((error) => error.includes('Message'))).toBe(true);
    const broken = generateOpenApi();
    broken.bad = { $ref: '#/components/schemas/Missing' };
    expect(checkOpenApi(broken)).not.toEqual([]);
    const duplicate = generateOpenApi();
    duplicate.paths = {
      '/first': { get: { operationId: 'same' } },
      '/second': { get: { operationId: 'same' } },
    };
    expect(checkOpenApi(duplicate)).toContain('Duplicate operationId: same');
  });
});

describe('M2 explicit work commands and disclosure boundaries', () => {
  const create = {
    workspace_id: id,
    title: 'Work',
    goal: 'Deliver evidence',
    acceptance_criteria: ['Verified'],
    reviewer_principal_ids: [id],
    budget: { currency: 'USD', limit_microunits: '9007199254740993' },
  };
  it('does not permit callers to set owner, actor, execution epoch, or numeric budgets', () => {
    expect(validateContract('CreateTaskInput', create).ok).toBe(true);
    for (const field of [
      'owner_principal_id',
      'actor',
      'execution_epoch',
      'accountable_principal_id',
    ])
      invalid('CreateTaskInput', { ...create, [field]: id2 });
    invalid('CreateTaskInput', { ...create, budget: { currency: 'USD', limit_microunits: 12 } });
    invalid('TaskParticipantInput', { principal_id: id2, role: 'owner' });
    invalid('UpdateTaskInput', { owner_principal_id: id2 });
  });
  it('pins evidence identity and rejects ambiguous artifact references and decision impersonation', () => {
    expect(
      validateContract('SubmissionInput', {
        goal_version: '2',
        summary: 'Fixed evidence',
        evidence: [
          { type: 'text', text: 'Evidence', source_refs: [{ type: 'task', id, version: '2' }] },
        ],
      }).ok,
    ).toBe(true);
    invalid('SubmissionInput', { goal_version: 2, summary: 'Not lossless', evidence: [] });
    invalid('ArtifactEvidenceRef', { type: 'artifact_version', artifact_id: id, version_id: id2 });
    invalid('RequestDecisionInput', {
      decision: 'accept',
      proposal_version: '1',
      expected_task_version: '1',
      actor_id: id2,
    });
    invalid('TaskReviewInput', {
      submission_id: id,
      decision: 'accept',
      comment: 'OK',
      reviewer_id: id2,
    });
  });
  it('does not silently authorize external tools through a work proposal', () => {
    const proposal = {
      title: 'Bounded request',
      goal: 'Deliver evidence',
      inputs: [],
      deliverable_schema: 'imbox.text-evidence.v1',
      acceptance: { criteria: ['Verified'], reviewer_principal_ids: [id] },
      budget: create.budget,
      allowed_actions: [],
      disclosure: { scope: 'request_recipients', summary: 'Only the explicit proposal' },
      dependencies: [],
      cancellation_rule: 'owner_or_accountable',
      escalation_principal_id: id,
    };
    expect(validateContract('WorkProposal', proposal).ok).toBe(true);
    invalid('WorkProposal', { ...proposal, allowed_actions: ['payments.send'] });
    invalid('WorkProposal', {
      ...proposal,
      disclosure: { scope: 'all_workspace', summary: 'Not authorized' },
    });
    invalid('WorkProposal', { ...proposal, credential: 'never-a-proposal-field' });
  });
});
