import { expect, it } from 'vitest';
import type { CreateTaskInput, RuntimeRun } from '@imbox/contracts';
import { TaskApi } from './task-api.js';

it('promotes with fresh explicit task input and never copies run output into the command', async () => {
  const calls: { path: string; init: RequestInit }[] = [];
  const api = new TaskApi('tenant', 'csrf', async (path, init) => {
    calls.push({ path: String(path), init: init! });
    return new Response('{}');
  });
  const task: CreateTaskInput = {
    workspace_id: 'workspace',
    title: 'A new target',
    goal: 'Explicitly written',
    acceptance_criteria: ['Reviewed'],
    reviewer_principal_ids: ['human'],
    budget: { currency: 'USD', limit_microunits: '0' },
  };
  await api.promote(
    {
      id: 'run',
      version: '9007199254740993',
      output: 'Untrusted preliminary answer',
    } as unknown as RuntimeRun,
    task,
    'stable',
    new AbortController().signal,
  );
  expect(calls[0]!.path).toBe('/v1/agent-runs/run/promote');
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
    task,
    confirm_new_authorization: true,
  });
  expect(new Headers(calls[0]!.init.headers).get('If-Match')).toBe('"9007199254740993"');
  expect(calls[0]!.init.credentials).toBe('same-origin');
  expect(calls[0]!.init.cache).toBe('no-store');
});

it('takes over from escalation metadata without first reading private task content', async () => {
  const calls: { path: string; init: RequestInit }[] = [];
  const api = new TaskApi('tenant', 'csrf', async (path, init) => {
    calls.push({ path: String(path), init: init! });
    return new Response('{}');
  });
  const signal = new AbortController().signal;
  await api.escalations(signal, 'signed+/=');
  expect([...new URL(calls[0]!.path, 'https://imbox.test').searchParams]).toEqual([
    ['cursor', 'signed+/='],
  ]);
  await api.takeover(
    'private-task',
    '9007199254740993',
    'Owner unavailable',
    'takeover-once',
    signal,
  );
  expect(calls.map((call) => call.path)).toEqual([
    '/v1/task-escalations?cursor=signed%2B%2F%3D',
    '/v1/tasks/private-task/takeover',
  ]);
  expect(new Headers(calls[1]!.init.headers).get('If-Match')).toBe('"9007199254740993"');
});
