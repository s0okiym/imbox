import { assertContract, ContractValidationError, type ContractTypes } from '@imbox/contracts';
export interface ToolDefinition {
  id: string;
  version: string;
  targetId: string;
  approvalRequired: boolean;
  currency: string;
  estimateMicrounits: string;
  timeoutMs: number;
  maxAttempts: number;
  retryDelayMs: number;
}
export type ToolObservation =
  | {
      status: 'succeeded' | 'no_effect';
      receiptId: string;
      fingerprint: string;
      actualMicrounits: string;
      safeRetry: boolean;
    }
  | { status: 'unknown'; reason: 'timeout_or_disconnect' | 'invalid_response' | 'not_found' };
export interface ToolCall {
  businessKey: string;
  fingerprint: string;
  parameters: ContractTypes['ActionParameters'];
  identity?: RecoveryIdentity;
}
export interface RecoveryIdentity {
  tenantId: string;
  actionId: string;
  attemptId: string;
}
export interface ControlledTool {
  definition: ToolDefinition;
  execute(call: ToolCall): Promise<ToolObservation>;
  lookup(call: Pick<ToolCall, 'businessKey' | 'fingerprint'>): Promise<ToolObservation>;
  /** Exists only on the configured HTTP adapter; provider must echo all three identifiers. */
  recoveryTransport?: 'controlled_http_v1';
  lookupRecovery?(
    call: Pick<ToolCall, 'businessKey' | 'fingerprint'> & RecoveryIdentity,
  ): Promise<ToolObservation>;
}
export interface ToolRegistry {
  get(id: string, version: string, targetId: string): ControlledTool;
  list(): ToolDefinition[];
}
export interface HttpToolConfiguration {
  id: string;
  version: string;
  targetId: string;
  executeUrl: string;
  lookupUrl: string;
  currency?: string;
  estimateMicrounits?: string;
  approvalRequired?: boolean;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  authorizationHeader?: string;
  allowInsecureLoopback?: boolean;
}
function configuredUrl(value: string, allowInsecure = false) {
  const url = new URL(value);
  if (url.username || url.password || url.hash)
    throw new Error('Connector URLs must not include credentials or fragments');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(allowInsecure && loopback && url.protocol === 'http:'))
    throw new Error('Connector requires HTTPS or explicit local test HTTP');
  return url;
}
/** Registry is trusted process configuration, never a model-supplied destination. */
export function createHttpToolRegistry(configs: readonly HttpToolConfiguration[]): ToolRegistry {
  const tools = new Map<string, ControlledTool>();
  for (const config of configs) {
    const executeUrl = configuredUrl(config.executeUrl, config.allowInsecureLoopback);
    const lookupUrl = configuredUrl(config.lookupUrl, config.allowInsecureLoopback);
    if (executeUrl.origin !== lookupUrl.origin)
      throw new Error('Execution and lookup must share the configured provider origin');
    const definition: ToolDefinition = {
      id: config.id,
      version: assertContract('Version', config.version),
      targetId: config.targetId,
      approvalRequired: config.approvalRequired ?? true,
      currency: config.currency ?? 'USD',
      estimateMicrounits: assertContract('Counter', config.estimateMicrounits ?? '10'),
      timeoutMs: config.timeoutMs ?? 5000,
      maxAttempts: config.maxAttempts ?? 3,
      retryDelayMs: config.retryDelayMs ?? 1000,
    };
    if (
      !/^[A-Za-z0-9._-]{1,100}$/.test(definition.id) ||
      !/^[A-Za-z0-9._-]{1,100}$/.test(definition.targetId) ||
      !Number.isInteger(definition.timeoutMs) ||
      definition.timeoutMs < 20 ||
      definition.timeoutMs > 30000 ||
      !Number.isInteger(definition.maxAttempts) ||
      definition.maxAttempts < 1 ||
      definition.maxAttempts > 10 ||
      !Number.isInteger(definition.retryDelayMs) ||
      definition.retryDelayMs < 0 ||
      definition.retryDelayMs > 60000
    )
      throw new Error('Invalid controlled connector configuration');
    async function request(
      call: Pick<ToolCall, 'businessKey' | 'fingerprint' | 'identity'>,
      parameters?: ContractTypes['ActionParameters'],
      recovery = false,
    ): Promise<ToolObservation> {
      const url = new URL(parameters ? executeUrl : lookupUrl);
      if (!parameters) {
        url.searchParams.set('business_key', call.businessKey);
        url.searchParams.set('fingerprint', call.fingerprint);
        if (recovery && call.identity) {
          url.searchParams.set('tenant_id', call.identity.tenantId);
          url.searchParams.set('action_id', call.identity.actionId);
          url.searchParams.set('attempt_id', call.identity.attemptId);
        }
      }
      try {
        const response = await fetch(url, {
          method: parameters ? 'POST' : 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(definition.timeoutMs),
          headers: {
            Accept: 'application/json',
            ...(parameters
              ? { 'Content-Type': 'application/json', 'Idempotency-Key': call.businessKey }
              : {}),
            ...(config.authorizationHeader ? { Authorization: config.authorizationHeader } : {}),
          },
          ...(parameters
            ? {
                body: JSON.stringify({
                  business_key: call.businessKey,
                  fingerprint: call.fingerprint,
                  target_id: definition.targetId,
                  input: parameters,
                  ...(call.identity
                    ? {
                        tenant_id: call.identity.tenantId,
                        action_id: call.identity.actionId,
                        attempt_id: call.identity.attemptId,
                      }
                    : {}),
                }),
              }
            : {}),
        });
        if (
          !response.ok ||
          !response.headers.get('content-type')?.toLowerCase().startsWith('application/json') ||
          !response.body
        )
          return { status: 'unknown', reason: 'invalid_response' };
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 65536) {
              await reader.cancel();
              return { status: 'unknown', reason: 'invalid_response' };
            }
            chunks.push(chunk.value);
          }
        } finally {
          reader.releaseLock();
        }
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
          string,
          unknown
        >;
        if (parsed.status === 'not_found' && !parameters)
          return { status: 'unknown', reason: 'not_found' };
        const identity = call.identity;
        if (
          recovery &&
          (!identity ||
            parsed.tenant_id !== identity.tenantId ||
            parsed.action_id !== identity.actionId ||
            parsed.attempt_id !== identity.attemptId)
        )
          return { status: 'unknown', reason: 'invalid_response' };
        if (
          identity &&
          (['tenant_id', 'action_id', 'attempt_id'] as const).some(
            (field, index) =>
              parsed[field] !== undefined &&
              parsed[field] !== [identity.tenantId, identity.actionId, identity.attemptId][index],
          )
        )
          return { status: 'unknown', reason: 'invalid_response' };
        if (
          !['succeeded', 'no_effect'].includes(String(parsed.status)) ||
          typeof parsed.receipt_id !== 'string' ||
          !parsed.receipt_id.length ||
          parsed.receipt_id.length > 128 ||
          parsed.fingerprint !== call.fingerprint ||
          !Object.keys(parsed).every((k) =>
            [
              'status',
              'receipt_id',
              'fingerprint',
              'cost_microunits',
              'safe_retry',
              'tenant_id',
              'action_id',
              'attempt_id',
            ].includes(k),
          )
        )
          return { status: 'unknown', reason: 'invalid_response' };
        const actual = assertContract('Counter', parsed.cost_microunits);
        if (BigInt(actual) > 9223372036854775807n)
          return { status: 'unknown', reason: 'invalid_response' };
        if (parsed.status === 'no_effect' && actual !== '0')
          return { status: 'unknown', reason: 'invalid_response' };
        return {
          status: parsed.status as 'succeeded' | 'no_effect',
          receiptId: parsed.receipt_id,
          fingerprint: call.fingerprint,
          actualMicrounits: actual,
          safeRetry: parsed.status === 'no_effect' && parsed.safe_retry === true,
        };
      } catch (error) {
        return {
          status: 'unknown',
          reason:
            error instanceof SyntaxError || error instanceof ContractValidationError
              ? 'invalid_response'
              : 'timeout_or_disconnect',
        };
      }
    }
    const key = `${definition.id}:${definition.version}:${definition.targetId}`;
    if (tools.has(key)) throw new Error('Duplicate registered connector');
    tools.set(key, {
      definition,
      execute: (call) => request(call, assertContract('ActionParameters', call.parameters)),
      lookup: (call) => request(call),
      recoveryTransport: 'controlled_http_v1',
      lookupRecovery: (call) =>
        request(
          {
            ...call,
            identity: {
              tenantId: call.tenantId,
              actionId: call.actionId,
              attemptId: call.attemptId,
            },
          },
          undefined,
          true,
        ),
    });
  }
  return {
    get(id, version, targetId) {
      const tool = tools.get(`${id}:${version}:${targetId}`);
      if (!tool) throw new Error('Tool is not registered');
      return tool;
    },
    list() {
      return [...tools.values()].map((tool) => ({ ...tool.definition }));
    },
  };
}
