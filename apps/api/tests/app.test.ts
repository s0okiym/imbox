import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('API composition and response boundary', () => {
  it('serves liveness independently of the database and exposes readiness failure', async () => {
    const app = createApp({
      readiness: async () => {
        throw new Error('secret database URL');
      },
    });
    apps.push(app);
    expect((await app.inject('/healthz')).json()).toEqual({ status: 'ok', service: 'imbox-api' });
    const ready = await app.inject('/readyz');
    expect(ready.statusCode).toBe(503);
    expect(ready.body).not.toContain('secret');
    expect(ready.headers['cache-control']).toBe('no-store');
  });

  it('uses JSON Schema 2020-12 and rejects extra request properties', async () => {
    const app = createApp({ readiness: async () => {} });
    apps.push(app);
    app.post(
      '/contract-probe',
      {
        schema: {
          body: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            required: ['name'],
            additionalProperties: false,
            properties: { name: { type: 'string', minLength: 1 } },
          },
        },
      },
      async (request) => request.body,
    );
    const result = await app.inject({
      method: 'POST',
      url: '/contract-probe',
      payload: { name: 'A', actor: 'admin' },
    });
    expect(result.statusCode).toBe(400);
    expect(result.json().code).toBe('VALIDATION_FAILED');
  });

  it('rejects a response that leaks a field beyond its schema', async () => {
    const app = createApp({ readiness: async () => {} });
    apps.push(app);
    app.get(
      '/response-probe',
      {
        schema: {
          response: {
            200: {
              type: 'object',
              additionalProperties: false,
              properties: { visible: { type: 'string' } },
              required: ['visible'],
            },
          },
        },
      },
      async () => ({ visible: 'allowed', secret: 'private content' }),
    );
    const result = await app.inject('/response-probe');
    expect(result.statusCode).toBe(500);
    expect(result.body).not.toContain('private content');
  });
});
