const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
const str = (maxLength: number, minLength = 1) => ({ type: 'string', minLength, maxLength });
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const arr = (items: unknown, maxItems: number, minItems = 0) => ({
  type: 'array',
  items,
  maxItems,
  minItems,
  uniqueItems: true,
});
const en = (...values: string[]) => ({ type: 'string', enum: values });
export const MACHINE_SCOPES = [
  'agents.read',
  'knowledge.read',
  'knowledge.search',
  'messages.read',
  'messages.write',
  'tasks.read',
  'tasks.create',
  'tasks.write',
  'requests.read',
  'requests.ack',
  'requests.decide',
  'runs.create',
  'runs.read',
  'runs.execute',
  'runs.report',
  'runs.tools',
] as const;
const scopes = arr(en(...MACHINE_SCOPES), MACHINE_SCOPES.length, 1);
export const agentDefinitions = {
  AgentManagementAccess: obj({ can_manage: { type: 'boolean' } }),
  AgentCredentialPage: obj(
    { items: arr(ref('AgentCredential'), 200), next_cursor: ref('Cursor') },
    ['items'],
  ),
  AgentDeliveryInput: obj({ proposal_version: ref('Version') }),
  AgentDeliveryReceipt: obj({
    request_id: ref('Identifier'),
    proposal_version: ref('Version'),
    received_at: ref('UtcTimestamp'),
  }),
  RegisterAgentInput: obj({
    workspace_id: ref('Identifier'),
    display_name: str(120),
    mode: en('hosted', 'external'),
    scopes,
    capabilities: arr(str(100), 100),
    config: {
      type: 'object',
      additionalProperties: false,
      properties: { model_alias: { const: 'local' } },
    },
  }),
  RegisteredAgent: obj({
    id: ref('Identifier'),
    principal_id: ref('Identifier'),
    display_name: str(120),
    mode: en('hosted', 'device', 'external'),
    status: en('active', 'disabled'),
    revision: ref('Version'),
    version: ref('Version'),
    scopes: arr(en(...MACHINE_SCOPES), MACHINE_SCOPES.length),
    capabilities: arr(str(100), 100),
  }),
  AgentDirectory: obj({ items: arr(ref('RegisteredAgent'), 200) }),
  AgentDirectoryQuery: obj({ workspace_id: ref('Identifier') }),
  IssueAgentCredentialInput: obj({
    scopes,
    lifetime_seconds: { type: 'integer', minimum: 60, maximum: 2592000 },
  }),
  AgentCredential: obj({
    id: ref('Identifier'),
    installation_id: ref('Identifier'),
    scopes,
    status: en('active', 'revoked'),
    revision: ref('Version'),
    expires_at: ref('UtcTimestamp'),
  }),
  IssuedAgentCredential: obj({
    credential: ref('AgentCredential'),
    secret: { anyOf: [str(256), { type: 'null' }] },
    secret_returned: { type: 'boolean' },
  }),
  MachineTokenInput: obj({ credential: str(256), scopes }),
  MachineToken: obj({
    access_token: str(256),
    token_type: { const: 'Bearer' },
    expires_at: ref('UtcTimestamp'),
    scopes,
  }),
  MachineLease: obj({ run_id: ref('Identifier'), generation: ref('Version') }),
  MachineClaim: obj({ lease: { anyOf: [ref('MachineLease'), { type: 'null' }] } }),
  MachineHeartbeatInput: obj({ generation: ref('Version') }),
  MachineHeartbeat: obj({
    expires_at: ref('UtcTimestamp'),
    cancellation_requested: { type: 'boolean' },
    pause_requested: { type: 'boolean' },
  }),
  MachineCancellationAckInput: obj({ generation: ref('Version') }),
  MachineCancellationAck: obj({
    run_id: ref('Identifier'),
    generation: ref('Version'),
    acknowledged_at: ref('UtcTimestamp'),
    report_source: { type: 'string', const: 'external_report' },
  }),
  MachineReportInput: obj(
    {
      generation: ref('Version'),
      status: en(
        'running',
        'waiting_input',
        'waiting_approval',
        'waiting_dependency',
        'paused',
        'completed',
        'failed',
        'cancelled',
      ),
      checkpoint: { type: 'object', maxProperties: 100, additionalProperties: true },
      summary: str(2000, 0),
      output: str(64000, 0),
    },
    ['generation', 'status', 'checkpoint'],
  ),
  MachineRunPage: obj({ items: arr(ref('RuntimeRun'), 100) }),
};
