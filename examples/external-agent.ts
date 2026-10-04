import { randomUUID } from 'node:crypto';
import { ImboxAgentClient } from '@imbox/agent-sdk';
// This example is an explicit protocol exerciser, not a model or an autonomous approval policy.
const origin = process.env.IMBOX_ORIGIN;
const tenantId = process.env.IMBOX_TENANT_ID;
const credential = process.env.IMBOX_AGENT_CREDENTIAL;
if (!origin || !tenantId || !credential)
  throw new Error('IMBOX_ORIGIN, IMBOX_TENANT_ID and IMBOX_AGENT_CREDENTIAL are required');
const client = new ImboxAgentClient({
  origin,
  tenantId,
  allowLoopbackHttp: process.env.IMBOX_ALLOW_LOOPBACK === 'true',
});
await client.exchange({
  credential,
  scopes: ['requests.read', 'requests.ack', 'runs.read', 'runs.execute', 'runs.report'],
});
for (const request of (await client.listRequests()).items) {
  if (request.status !== 'pending') continue;
  await client.acknowledgeRequest(request.id, request.proposal_version, randomUUID());
  process.stdout.write(
    `${JSON.stringify({ event: 'request_received', request_id: request.id, proposal_version: request.proposal_version, accepted: false })}\n`,
  );
}
const runId = process.env.IMBOX_RUN_ID;
if (runId) {
  const { lease } = await client.claim(runId, randomUUID());
  if (lease) {
    const context = await client.getContext(runId);
    await client.report(
      runId,
      {
        generation: lease.generation,
        status: 'completed',
        checkpoint: { example: 'protocol-only' },
        summary: 'External protocol example completed',
        output: `Protocol example received ${context.items.length} explicitly shared context items. No model reasoning or external action was performed.`,
      },
      randomUUID(),
    );
    process.stdout.write(
      `${JSON.stringify({ event: 'external_report_submitted', run_id: runId, task_accepted: false })}\n`,
    );
  }
}
client.clearToken();
