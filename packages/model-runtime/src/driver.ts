import { assertContract } from '@imbox/contracts';
import { createToolRunner, type ActionService } from '@imbox/actions';
import { setTimeout as delay } from 'node:timers/promises';
import type { RuntimeWorker, LeaseClaim, Reservation } from '@imbox/runtime';
import { ModelFailure, type ModelAdapter, type ModelResult } from './types.js';

export type DriverOutcome = 'completed' | 'waiting' | 'failed' | 'fenced' | 'unclaimed';
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function recoveredResult(
  checkpoint: Record<string, unknown> | undefined,
  manifestHash: string,
  stage: 'initial' | 'summary' = 'initial',
): ModelResult | null {
  const step = checkpoint?.model_step;
  if (
    !object(step) ||
    step.manifest_hash !== manifestHash ||
    !object(step.result) ||
    (step.stage ?? 'initial') !== stage
  )
    return null;
  const result = step.result;
  if (
    typeof result.output !== 'string' ||
    Buffer.byteLength(result.output) > 64000 ||
    !['stop', 'length'].includes(String(result.finishReason)) ||
    !object(result.usage) ||
    !object(result.receipt) ||
    result.receipt.provider !== 'ollama' ||
    result.receipt.billing_policy !== 'local-unmetered' ||
    result.receipt.actual_microunits !== '0'
  )
    return null;
  if (result.decision !== undefined) {
    try {
      assertContract('ModelToolDecision', result.decision);
    } catch {
      return null;
    }
  }
  return result as unknown as ModelResult;
}

/** One finite text-generation step. Model text never changes ownership or executes a tool. */
export function createModelDriver(options: {
  worker: RuntimeWorker;
  models: ReadonlyMap<string, ModelAdapter>;
  actions?: ActionService;
  heartbeatMs?: number;
}) {
  const interval = options.heartbeatMs ?? 15_000;
  if (!Number.isInteger(interval) || interval < 25 || interval > 15_000)
    throw new Error('Invalid model heartbeat interval');
  return {
    async execute(tenantId: string, runId: string, signal?: AbortSignal): Promise<DriverOutcome> {
      let claim: LeaseClaim | null;
      try {
        claim = await options.worker.claim(tenantId, runId);
      } catch {
        return 'fenced';
      }
      if (!claim) return 'unclaimed';
      const leased = claim;
      const stop = new AbortController();
      const call = new AbortController();
      let interruption: 'pause' | 'cancel' | 'fenced' | undefined;
      let reservation: Reservation | undefined;
      let durableCheckpoint: Record<string, unknown> = {};
      const check = async () => {
        try {
          const state = await options.worker.heartbeat(leased);
          if (state.cancellation_requested || state.pause_requested) {
            interruption = state.cancellation_requested ? 'cancel' : 'pause';
            call.abort();
          }
        } catch {
          interruption = 'fenced';
          call.abort();
        }
      };
      const heartbeat = (async () => {
        while (!stop.signal.aborted) {
          try {
            await delay(interval, undefined, { signal: stop.signal });
          } catch {
            break;
          }
          await check();
          if (interruption) break;
        }
      })();
      const acknowledge = async (
        fallback: 'failed' | 'waiting_dependency',
        summary: string,
      ): Promise<DriverOutcome> => {
        await check();
        if (interruption === 'fenced') return 'fenced';
        const status =
          interruption === 'cancel' ? 'cancelled' : interruption === 'pause' ? 'paused' : fallback;
        try {
          await options.worker.report(
            leased,
            {
              status,
              summary,
              checkpoint: {
                ...durableCheckpoint,
                interruption: { state: 'stopped', reservation_id: reservation?.id ?? null },
              },
            },
            `model:stop:${leased.generation}`,
          );
          return status === 'failed' ? 'failed' : 'waiting';
        } catch {
          return 'fenced';
        }
      };
      try {
        await check();
        if (interruption)
          return await acknowledge('failed', 'Execution was stopped before model admission.');
        let execution = await options.worker.getExecution(leased);
        durableCheckpoint = execution.latest_checkpoint?.payload ?? {};
        const alias = execution.config.model_alias;
        const model = typeof alias === 'string' ? options.models.get(alias) : undefined;
        if (
          execution.mode !== 'hosted' ||
          !model ||
          execution.manifest.destination !== model.destination ||
          Object.keys(execution.config).some((key) => !['model_alias'].includes(key))
        )
          return await acknowledge(
            'failed',
            'The installed model configuration or destination is not available.',
          );
        if (execution.tool_grant_id && !options.actions)
          return await acknowledge('failed', 'The approved tool gateway is not configured.');
        if (execution.tool_intent?.status === 'ready') {
          const runner = createToolRunner({
            actions: options.actions!,
            workerId: `run-tool.${leased.runId}.${leased.generation}`,
          });
          await runner.runOnce(tenantId, execution.tool_intent.action_id, leased);
          execution = await options.worker.getExecution(leased);
        }
        if (
          execution.tool_intent &&
          !['succeeded', 'failed', 'cancelled'].includes(execution.tool_intent.status)
        )
          return await acknowledge(
            'waiting_dependency',
            'The existing Action outcome requires reconciliation. No tool was repeated.',
          );
        const stage = execution.tool_intent ? 'summary' : 'initial';
        const finish = async (result: ModelResult): Promise<DriverOutcome> => {
          await check();
          if (interruption)
            return await acknowledge(
              'waiting_dependency',
              'Generation finished; delivery was interrupted.',
            );
          try {
            if (result.decision?.kind === 'tool_intent') {
              if (stage !== 'initial' || !execution.tool_grant_id || !options.actions)
                return await acknowledge(
                  'failed',
                  'No tool authority exists for this proposed action.',
                );
              await options.actions.proposeForRun(leased, result.decision.text);
              return 'waiting';
            }
            await options.worker.report(
              leased,
              {
                status: 'completed',
                output: result.output,
                summary:
                  result.finishReason === 'length'
                    ? 'Generation reached the configured output limit.'
                    : 'Generation completed.',
                checkpoint: {
                  model_step: {
                    state: 'completed',
                    stage,
                    manifest_hash: execution.manifest.content_hash,
                    result,
                  },
                },
              },
              `model:complete:${leased.generation}`,
            );
            return 'completed';
          } catch {
            return 'fenced';
          }
        };
        const restored = recoveredResult(
          execution.latest_checkpoint?.payload,
          execution.manifest.content_hash,
          stage,
        );
        if (restored) return await finish(restored);
        const reserved = await options.worker.reserve(leased, {
          reservation_key: stage === 'summary' ? 'model:step:2' : 'model:step:1',
          amount_microunits: '0',
          currency: execution.budget.currency,
        });
        reservation = reserved;
        if (!reserved.newly_reserved)
          return await acknowledge(
            'waiting_dependency',
            'The previous invocation needs reconciliation; no model request was repeated.',
          );
        let result: ModelResult;
        try {
          result = await model.generate({
            invocationId: reserved.id,
            purpose: execution.manifest.purpose,
            context: execution.items,
            ...(stage === 'initial' && execution.tool_authorization
              ? { tool: execution.tool_authorization }
              : {}),
            ...(stage === 'summary' && execution.tool_intent
              ? { toolResult: execution.tool_intent }
              : {}),
            signal: signal ? AbortSignal.any([call.signal, signal]) : call.signal,
          });
        } catch (error) {
          if (error instanceof ModelFailure && error.outcome === 'not_sent') {
            await options.worker.release(tenantId, reserved.id, {
              confirmed_no_charge: true,
              reference: `model-not-sent:${reserved.id}:${error.code}`,
            });
            return await acknowledge('failed', `No model request was sent (${error.code}).`);
          }
          await options.worker.markUnknown(tenantId, reserved.id);
          return await acknowledge(
            'waiting_dependency',
            'Model outcome is unknown; usage remains reserved for reconciliation.',
          );
        }
        const usage = {
          usage_key: `ollama:${reserved.id}`,
          actual_microunits: result.receipt.actual_microunits,
          evidence: { ...result.receipt, usage: result.usage },
        };
        try {
          const checkpoint = {
            model_step: {
              state: 'generated',
              stage,
              manifest_hash: execution.manifest.content_hash,
              result,
            },
          };
          await options.worker.completeStep(leased, reserved.id, usage, checkpoint);
          durableCheckpoint = checkpoint;
        } catch {
          // A late factual receipt may settle costs, but stale execution never publishes content.
          await options.worker.settle(tenantId, reserved.id, usage);
          return await acknowledge(
            'waiting_dependency',
            'Usage was recorded after execution authority changed; no result was published.',
          );
        }
        return await finish(result);
      } catch {
        return 'fenced';
      } finally {
        stop.abort();
        call.abort();
        await heartbeat;
      }
    },
  };
}
