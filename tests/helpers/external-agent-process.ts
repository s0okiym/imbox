import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { ImboxAgentClient, ImboxApiError } from '@imbox/agent-sdk';

interface Setup {
  origin: string;
  tenantId: string;
  credential: string;
  runId: string;
}
const send = (value: unknown) =>
  new Promise<void>((resolve, reject) => {
    if (!process.send) return reject(new Error('IPC required'));
    process.send(value as object, (error) => (error ? reject(error) : resolve()));
  });
async function execute(config: Setup) {
  const client = new ImboxAgentClient({
    origin: config.origin,
    tenantId: config.tenantId,
    allowLoopbackHttp: true,
  });
  let work: ReturnType<typeof setInterval> | undefined;
  try {
    await client.exchange({
      credential: config.credential,
      scopes: ['runs.read', 'runs.execute', 'runs.report'],
    });
    const { lease } = await client.claim(config.runId, randomUUID());
    if (!lease) throw new Error('Lease required');
    const recovery = once(process, 'message');
    let units = 0;
    work = setInterval(() => {
      units++;
      if (units === 1)
        void send({ kind: 'claimed', generation: lease.generation, pid: process.pid }).catch(() => {
          process.exitCode = 1;
        });
    }, 20);
    const [message] = await recovery;
    if (
      !message ||
      typeof message !== 'object' ||
      !('kind' in message) ||
      message.kind !== 'recover'
    )
      throw new Error('Recovery command required');
    clearInterval(work);
    work = undefined;
    // Local work is stopped before asserting that fact to the platform.
    let blockedStatus: number | undefined;
    try {
      await client.report(
        config.runId,
        {
          generation: lease.generation,
          status: 'completed',
          checkpoint: {},
          output: 'STALE_OUTPUT_MUST_NOT_PUBLISH',
        },
        randomUUID(),
      );
    } catch (error) {
      if (!(error instanceof ImboxApiError)) throw error;
      blockedStatus = error.status;
    }
    if (blockedStatus !== 409) throw new Error('Stale execution was not fenced');
    const receipt = await client.acknowledgeCancellation(
      config.runId,
      lease.generation,
      randomUUID(),
    );
    await send({
      kind: 'acknowledged',
      stopped: true,
      work_units: units,
      blocked_status: blockedStatus,
      receipt,
    });
  } finally {
    if (work) clearInterval(work);
    client.clearToken();
  }
}
process.once('message', (config: Setup) => {
  void execute(config)
    .catch(async (error) => {
      process.exitCode = 1;
      await send({
        kind: 'failed',
        code: error instanceof ImboxApiError ? error.code : 'PROCESS_FAILED',
      }).catch(() => {});
    })
    .finally(() => {
      process.removeAllListeners('message');
      if (process.connected) process.disconnect();
    });
});
