import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDatabase, sql, type DatabaseObservation } from '@imbox/db';
import { testDatabases } from '../helpers/database.js';
let setup: Awaited<ReturnType<typeof testDatabases>>;
beforeAll(async () => {
  setup = await testDatabases();
});
afterAll(async () => {
  await setup?.close();
});

it('measures real acquisition contention and query failures without emitting SQL, values or callback errors', async () => {
  const events: DatabaseObservation[] = [];
  const marker = 'PRIVATE_QUERY_VALUE_NEVER_IN_OBSERVATIONS';
  const db = createDatabase(process.env['TEST_APP_DATABASE_URL']!, {
    max: 1,
    observe: (event) => {
      events.push(event);
    },
  });
  let unlock: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  let entered: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    const holder = db.transaction().execute(async (tx) => {
      await sql`select 1`.execute(tx);
      entered();
      await gate;
    });
    await ready;
    const waiter = sql<{ value: string }>`select ${marker}::text as value`.execute(db);
    await new Promise((resolve) => setTimeout(resolve, 200));
    unlock();
    await holder;
    expect((await waiter).rows[0]?.value).toBe(marker);
    expect(events.some((event) => event.kind === 'acquire' && event.durationMs >= 100)).toBe(true);
    expect(events.some((event) => event.waiting > 0)).toBe(true);
    const before = events.filter((event) => event.failed).length;
    await expect(sql`select 1 / 0`.execute(db)).rejects.toMatchObject({ code: '22012' });
    expect(events.filter((event) => event.failed)).toHaveLength(before + 1);
    expect(events.every((event) => event.durationMs >= 0 && event.total <= 1)).toBe(true);
    expect(
      events
        .filter((event) => event.kind === 'query')
        .every((event) => /^[0-9a-f]{64}$/.test(event.fingerprint ?? '')),
    ).toBe(true);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(marker);
    expect(serialized).not.toContain('select 1 / 0');
    expect(serialized).not.toContain('parameters');
  } finally {
    unlock();
    await db.destroy();
  }
  const throwing = createDatabase(process.env['TEST_APP_DATABASE_URL']!, {
    observe: () => {
      throw new Error(marker);
    },
  });
  try {
    expect((await sql<{ one: number }>`select 1 as one`.execute(throwing)).rows[0]?.one).toBe(1);
  } finally {
    await throwing.destroy();
  }
});

it('isolates asynchronous diagnostic rejection from successful database work', async () => {
  const db = createDatabase(process.env['TEST_APP_DATABASE_URL']!, {
    observe: async () => {
      await Promise.resolve();
      throw new Error('private asynchronous observer failure');
    },
  });
  try {
    expect((await sql<{ one: number }>`select 1 as one`.execute(db)).rows[0]?.one).toBe(1);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    await db.destroy();
  }
});
