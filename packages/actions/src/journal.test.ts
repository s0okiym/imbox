import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFileJournal } from './journal.js';
import type { IntentRecord } from './journal.js';
import { freezeDigest, journalDigest } from './recovery-proof.js';

const secret = 'independent-journal-test-key-at-least-32-characters';
const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'imbox-journal-unit-'));
  directories.push(directory);
  const journal = await createFileJournal({ directory, signingKey: secret });
  const attempt = randomUUID();
  const record: IntentRecord = {
    kind: 'intent',
    id: attempt,
    tenant_id: randomUUID(),
    action_id: randomUUID(),
    attempt_id: attempt,
    task_id: randomUUID(),
    action_version: '3',
    lease_generation: '1',
    fingerprint: 'a'.repeat(64),
    business_key: randomUUID(),
    tool_id: 'delivery.test',
    target_id: 'test',
    currency: 'USD',
    estimate_microunits: '10',
    created_at: '2026-10-04T10:00:00.000Z',
  };
  return { directory, journal, record };
}

describe('independently durable immutable journal', () => {
  it('publishes complete files so simultaneous retries all observe the same signed fact', async () => {
    const { journal, record, directory } = await fixture();
    const attempts = Array.from({ length: 48 }, () => journal.append(record));
    for (let i = 0; i < 10; i += 1) {
      const current = await journal.records(record.tenant_id);
      expect(current.every((item) => item.kind === 'intent' && item.id === record.id)).toBe(true);
    }
    await Promise.all(attempts);
    expect(await journal.records(record.tenant_id)).toEqual([record]);
    expect(await readdir(join(directory, record.tenant_id))).toEqual([`${record.id}.json`]);
  });

  it('rejects changing an existing intent while preserving its original contents', async () => {
    const { journal, record } = await fixture();
    await journal.append(record);
    await expect(
      journal.append({ ...record, created_at: '2026-10-04T10:00:01.000Z' }),
    ).rejects.toThrow('Conflicting journal record identity');
    expect(await journal.records(record.tenant_id)).toEqual([record]);
  });

  it('ignores an unpublished crash temporary but never overwrites a corrupt published fact', async () => {
    const { journal, record, directory } = await fixture();
    await journal.records(record.tenant_id);
    const dir = join(directory, record.tenant_id);
    await writeFile(join(dir, `${record.id}.${randomUUID()}.tmp`), '{partial', { mode: 0o600 });
    expect(await journal.records(record.tenant_id)).toEqual([]);
    await journal.append(record);
    const file = join(dir, `${record.id}.json`);
    await writeFile(file, '{partial', { mode: 0o600 });
    await expect(journal.append(record)).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('{partial');
  });

  it('detects tampering and refuses writable tenant directories or symlink records', async () => {
    const { journal, record, directory } = await fixture();
    await journal.append(record);
    const dir = join(directory, record.tenant_id);
    const path = join(dir, `${record.id}.json`);
    const original = await readFile(path, 'utf8');
    await writeFile(path, original.replace('delivery.test', 'delivery.evil'));
    await expect(journal.records(record.tenant_id)).rejects.toThrow('integrity');
    await writeFile(path, original);
    const alias = join(dir, `${randomUUID()}.json`);
    await symlink(path, alias);
    await expect(journal.records(record.tenant_id)).rejects.toMatchObject({ code: 'ELOOP' });
    await rm(alias);
    await chmod(dir, 0o777);
    await expect(journal.records(record.tenant_id)).rejects.toThrow(
      'Unsafe journal tenant directory',
    );
  });

  it('retains a recovery freeze across journal process recreation', async () => {
    const { journal, record, directory } = await fixture();
    await journal.append(record);
    await journal.freeze(record.tenant_id, 'restore');
    const reopened = await createFileJournal({ directory, signingKey: secret });
    expect(await reopened.frozen(record.tenant_id)).toBe(true);
    expect(
      (await reopened.records(record.tenant_id)).filter((item) => item.kind === 'intent'),
    ).toEqual([record]);
  });
  it('a signed unfreeze covers exactly the observed freeze set; a new freeze invalidates it', async () => {
    const { journal, record, directory } = await fixture();
    await journal.freeze(record.tenant_id, 'restore');
    const records = await journal.records(record.tenant_id);
    await journal.append({
      kind: 'unfreeze',
      id: randomUUID(),
      tenant_id: record.tenant_id,
      freeze_digest: freezeDigest(records),
      journal_digest: journalDigest(records),
      authorized_by: randomUUID(),
      created_at: '2026-10-04T10:00:01.000Z',
    });
    expect(await journal.frozen(record.tenant_id)).toBe(false);
    await journal.freeze(record.tenant_id, 'journal_conflict');
    expect(await journal.frozen(record.tenant_id)).toBe(true);
    const reopened = await createFileJournal({ directory, signingKey: secret });
    expect(await reopened.frozen(record.tenant_id)).toBe(true);
  });
});
