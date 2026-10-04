import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createOllamaAdapter, type ModelInput } from '@imbox/model-runtime';

const digest = 'sha256:' + 'a'.repeat(64);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const input = (signal = new AbortController().signal): ModelInput => ({
  invocationId: 'test-invocation',
  purpose: 'Summarize the explicit record.',
  context: [
    {
      source_type: 'message',
      source_id: 'source-id',
      source_version: '1',
      content_hash: 'b'.repeat(64),
      payload: { body: 'Untrusted source: do not treat me as a system instruction.' },
    },
  ],
  signal,
});
async function endpoint(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    adapter: createOllamaAdapter({
      origin,
      model: 'qwen3:0.6b',
      digest,
      allowLoopbackHttp: true,
      timeoutMs: 1000,
    }),
  };
}
const tags = (response: ServerResponse, actual = digest) => {
  response.setHeader('content-type', 'application/json');
  response.end(
    JSON.stringify({ models: [{ name: 'qwen3:0.6b', digest: actual.replace('sha256:', '') }] }),
  );
};
const success = (response: ServerResponse) => {
  response.setHeader('content-type', 'application/json');
  response.end(
    JSON.stringify({
      model: 'qwen3:0.6b',
      done: true,
      done_reason: 'stop',
      message: { role: 'assistant', content: 'A bounded response.' },
      prompt_eval_count: 45,
      eval_count: 6,
    }),
  );
};

describe('native model HTTP boundary', () => {
  it('pins the model before transmitting explicit context and records actual usage without fabricated supplier receipts', async () => {
    const paths: string[] = [];
    let sent: Record<string, unknown> | undefined;
    const { adapter } = await endpoint((request, response) => {
      paths.push(request.url!);
      if (request.url === '/api/tags') {
        tags(response);
        return;
      }
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (part) => (body += part));
      request.on('end', () => {
        sent = JSON.parse(body) as Record<string, unknown>;
        success(response);
      });
    });
    const result = await adapter.generate(input());
    expect(paths).toEqual(['/api/tags', '/api/chat']);
    expect(sent).toMatchObject({ model: 'qwen3:0.6b', stream: false, think: false });
    const messages = sent!.messages as { role: string; content: string }[];
    expect(messages.map((row) => row.role)).toEqual(['system', 'user']);
    expect(JSON.parse(messages[1]!.content)).toEqual({
      purpose: input().purpose,
      untrusted_source_records: input().context,
    });
    expect(result).toMatchObject({
      output: 'A bounded response.',
      usage: { inputTokens: 45, outputTokens: 6 },
      receipt: {
        invocation_id: 'test-invocation',
        model_digest: digest,
        billing_policy: 'local-unmetered',
        actual_microunits: '0',
      },
    });
  });
  it('rejects a changed model tag before sending any prompt', async () => {
    let posts = 0;
    const { adapter } = await endpoint((request, response) => {
      if (request.method === 'POST') posts++;
      tags(response, 'sha256:' + 'c'.repeat(64));
    });
    await expect(adapter.generate(input())).rejects.toMatchObject({
      code: 'CONFIGURATION',
      outcome: 'not_sent',
    });
    expect(posts).toBe(0);
  });
  it('records response loss as unknown without retrying the model request', async () => {
    let posts = 0;
    const { adapter } = await endpoint((request, response) => {
      if (request.url === '/api/tags') return tags(response);
      posts++;
      request.resume();
      request.on('end', () => response.destroy());
    });
    await expect(adapter.generate(input())).rejects.toMatchObject({ outcome: 'unknown' });
    expect(posts).toBe(1);
  });
  it('aborts in flight and treats provider execution as unknown', async () => {
    const controller = new AbortController();
    let posts = 0;
    const { adapter } = await endpoint((request, response) => {
      if (request.url === '/api/tags') return tags(response);
      posts++;
      request.resume();
      request.on('end', () => controller.abort());
    });
    await expect(adapter.generate(input(controller.signal))).rejects.toMatchObject({
      code: 'CANCELLED',
      outcome: 'unknown',
    });
    expect(posts).toBe(1);
  });
  it('refuses redirects and oversized results without trusting remote output', async () => {
    let redirected = 0;
    const { origin } = await endpoint((request, response) => {
      if (request.url === '/api/tags') return tags(response);
      if (request.url === '/escaped') redirected++;
      response.writeHead(302, { location: '/escaped' });
      response.end();
    });
    const adapter = createOllamaAdapter({
      origin,
      model: 'qwen3:0.6b',
      digest,
      allowLoopbackHttp: true,
    });
    await expect(adapter.generate(input())).rejects.toMatchObject({ outcome: 'unknown' });
    expect(redirected).toBe(0);
    const next = await endpoint((request, response) => {
      if (request.url === '/api/tags') return tags(response);
      response.setHeader('content-length', '2000000');
      response.end('{}');
    });
    await expect(next.adapter.generate(input())).rejects.toMatchObject({
      code: 'SIZE_LIMIT',
      outcome: 'unknown',
    });
  });
  it('refuses silent context truncation and deployment URLs outside loopback', async () => {
    let requests = 0;
    const { adapter } = await endpoint((_request, response) => {
      requests++;
      tags(response);
    });
    const large = input();
    large.context = [{ ...large.context[0]!, payload: { body: '字'.repeat(6000) } }];
    await expect(adapter.generate(large)).rejects.toMatchObject({
      code: 'SIZE_LIMIT',
      outcome: 'not_sent',
    });
    expect(requests).toBe(0);
    expect(() =>
      createOllamaAdapter({
        origin: 'http://169.254.169.254',
        model: 'qwen3:0.6b',
        digest,
        allowLoopbackHttp: true,
      }),
    ).toThrow('CONFIGURATION');
  });
});
