export interface ModelInput {
  /** A platform invocation ID; never claim this is a supplier receipt. */
  invocationId: string;
  tool?: { tool_id: string; tool_version: string; target_id: string };
  toolResult?: { action_id: string; status: string; tool_id: string; target_id: string };
  purpose: string;
  context: readonly {
    source_type: string;
    source_id: string;
    source_version: string;
    content_hash: string;
    payload: Record<string, unknown>;
  }[];
  signal: AbortSignal;
}
export interface ModelResult {
  output: string;
  decision?: { kind: 'final' | 'tool_intent'; text: string };
  finishReason: 'stop' | 'length';
  usage: { inputTokens: number; outputTokens: number };
  receipt: {
    invocation_id: string;
    model: string;
    model_digest: string;
    provider: 'ollama';
    billing_policy: 'local-unmetered';
    actual_microunits: '0';
  };
}
export interface ModelAdapter {
  readonly destination: string;
  readonly capabilities: {
    text: true;
    streaming: false;
    toolCalls: false;
    structuredOutput: true;
    images: false;
    cancellation: true;
  };
  generate(input: ModelInput): Promise<ModelResult>;
}
export class ModelFailure extends Error {
  constructor(
    readonly code: 'CONFIGURATION' | 'UNAVAILABLE' | 'PROTOCOL' | 'CANCELLED' | 'SIZE_LIMIT',
    readonly outcome: 'not_sent' | 'unknown',
  ) {
    super(`Model request failed: ${code}`);
    this.name = 'ModelFailure';
  }
}
