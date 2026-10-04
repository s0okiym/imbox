import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFilePolicyLedger, type PolicyRecord } from './policy-ledger.js';
const dirs: string[] = [];
const secret = 'test-policy-signing-key-longer-than-thirty-two-characters';
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'imbox-policy-'));
  dirs.push(directory);
  const ledger = await createFilePolicyLedger({ directory, signingKey: secret });
  const record: PolicyRecord = {
    kind: 'deletion.message',
    id: randomUUID(),
    tenant_id: randomUUID(),
    target_id: randomUUID(),
    target_version: '1',
    actor_id: randomUUID(),
    accepted_at: new Date().toISOString(),
  };
  return {
    directory,
    ledger,
    record,
    path: join(directory, record.tenant_id, `${record.id}.json`),
  };
}
describe('independent signed policy ledger', () => {
  it('publishes one immutable complete fact under concurrent retries and reopens it', async () => {
    const f = await fixture();
    await Promise.all(Array.from({ length: 12 }, () => f.ledger.append(f.record)));
    const reopened = await createFilePolicyLedger({ directory: f.directory, signingKey: secret });
    expect(await reopened.records(f.record.tenant_id)).toEqual([f.record]);
    expect(await reopened.tenants()).toEqual([f.record.tenant_id]);
    await expect(reopened.append({ ...f.record, target_id: randomUUID() })).rejects.toThrow(
      'Conflicting',
    );
  });
  it('rejects tampering, malformed metadata, and a changed signing key', async () => {
    const f = await fixture();
    await f.ledger.append(f.record);
    const wrong = await createFilePolicyLedger({
      directory: f.directory,
      signingKey: secret + 'wrong',
    });
    await expect(wrong.records(f.record.tenant_id)).rejects.toThrow('integrity');
    const original = await readFile(f.path, 'utf8');
    await writeFile(f.path, original.replace(f.record.target_id, randomUUID()), { mode: 0o600 });
    await expect(f.ledger.records(f.record.tenant_id)).rejects.toThrow('integrity');
    await expect(f.ledger.append({ ...f.record, target_id: '../escape' })).rejects.toThrow(
      'identity',
    );
    await expect(f.ledger.append({ ...f.record, kind: 'revocation.task' })).rejects.toThrow(
      'subject',
    );
  });
  it('rejects writable directories and symlinked records', async () => {
    const f = await fixture();
    await f.ledger.append(f.record);
    const other = join(f.directory, 'external');
    await writeFile(other, await readFile(f.path));
    await rm(f.path);
    await symlink(other, f.path);
    await expect(f.ledger.records(f.record.tenant_id)).rejects.toThrow();
    await chmod(f.directory, 0o777);
    await expect(
      createFilePolicyLedger({ directory: f.directory, signingKey: secret }),
    ).rejects.toThrow('Unsafe');
  });
});
