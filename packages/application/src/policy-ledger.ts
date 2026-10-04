import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, lstat, readdir, link, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sql, type TenantTransaction } from '@imbox/db';
import type { AuthContext } from './common.js';

export const POLICY_KINDS = [
  'deletion.message',
  'deletion.resource',
  'deletion.memory',
  'deletion.run',
  'deletion.artifact_comment',
  'revocation.artifact_share',
  'revocation.conversation',
  'revocation.task',
  'revocation.workspace_member',
  'revocation.credential',
  'revocation.agent',
] as const;
export interface PolicyFact {
  kind: (typeof POLICY_KINDS)[number];
  target_id: string;
  /** Last authorized version before the destructive/revoking change. */
  target_version: string;
  subject_id?: string;
}
export interface PolicyRecord extends PolicyFact {
  id: string;
  tenant_id: string;
  actor_id: string;
  accepted_at: string;
}
/** This storage MUST be retained independently of the database recovery point. */
export interface PolicyLedger {
  append(record: PolicyRecord): Promise<void>;
  records(tenantId: string): Promise<PolicyRecord[]>;
  tenants(): Promise<string[]>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const safeId = (id: string) => {
  if (!uuid.test(id)) throw new Error('Invalid policy identity');
  return id;
};
function validate(record: PolicyRecord) {
  if (
    !record ||
    typeof record !== 'object' ||
    !POLICY_KINDS.includes(record.kind) ||
    !/^[1-9][0-9]{0,18}$/.test(record.target_version) ||
    !Number.isFinite(Date.parse(record.accepted_at))
  )
    throw new Error('Invalid policy record');
  for (const id of [record.id, record.tenant_id, record.actor_id, record.target_id]) safeId(id);
  if (record.subject_id !== undefined) safeId(record.subject_id);
  if (
    ['revocation.conversation', 'revocation.task', 'revocation.workspace_member'].includes(
      record.kind,
    ) &&
    !record.subject_id
  )
    throw new Error('Missing revocation subject');
  const keys = [
    'kind',
    'target_id',
    'target_version',
    'subject_id',
    'id',
    'tenant_id',
    'actor_id',
    'accepted_at',
  ];
  if (Object.keys(record).some((k) => !keys.includes(k))) throw new Error('Unexpected policy data');
}
const canonical = (record: PolicyRecord) =>
  JSON.stringify(Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b))));
export async function createFilePolicyLedger(options: {
  directory: string;
  signingKey: string;
}): Promise<PolicyLedger> {
  if (options.signingKey.length < 32 || options.signingKey.startsWith('replace-with-'))
    throw new Error('Policy signing key requires at least 32 characters');
  const base = resolve(options.directory);
  async function directory(path: string) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o022)
      throw new Error('Unsafe policy directory');
  }
  const sync = async (path: string) => {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  };
  await directory(base);
  const sign = (record: PolicyRecord) =>
    createHmac('sha256', options.signingKey).update(canonical(record)).digest('hex');
  async function tenantDir(tenant: string) {
    const path = join(base, safeId(tenant));
    await directory(path);
    await sync(base);
    return path;
  }
  async function read(path: string) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.mode & 0o022 || stat.size > 4096)
        throw new Error('Unsafe policy file');
      const envelope = JSON.parse(await file.readFile('utf8')) as {
        v: number;
        record: PolicyRecord;
        signature: string;
      };
      validate(envelope.record);
      if (
        envelope.v !== 1 ||
        !/^[a-f0-9]{64}$/.test(envelope.signature) ||
        !timingSafeEqual(
          Buffer.from(sign(envelope.record), 'hex'),
          Buffer.from(envelope.signature, 'hex'),
        )
      )
        throw new Error('Policy integrity verification failed');
      return envelope.record;
    } finally {
      await file.close();
    }
  }
  return {
    async append(record) {
      validate(record);
      const dir = await tenantDir(record.tenant_id);
      const final = join(dir, `${record.id}.json`),
        temporary = join(dir, `${record.id}.${randomUUID()}.tmp`);
      const file = await open(temporary, 'wx', 0o600);
      try {
        try {
          await file.writeFile(JSON.stringify({ v: 1, record, signature: sign(record) }));
          await file.sync();
        } finally {
          await file.close();
        }
        try {
          await link(temporary, final);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          if (canonical(await read(final)) !== canonical(record))
            throw new Error('Conflicting policy fact', { cause: error });
        }
        await sync(dir);
      } finally {
        await unlink(temporary).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== 'ENOENT') throw e;
        });
      }
    },
    async records(tenant) {
      const dir = await tenantDir(tenant),
        entries = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
      if (entries.length > 100000)
        throw new Error('Policy ledger requires archival/index maintenance');
      const records: PolicyRecord[] = [];
      for (const entry of entries) {
        safeId(entry.slice(0, -5));
        const record = await read(join(dir, entry));
        if (record.id !== entry.slice(0, -5) || record.tenant_id !== tenant)
          throw new Error('Policy identity mismatch');
        records.push(record);
      }
      return records;
    },
    async tenants() {
      const result = [];
      for (const entry of await readdir(base, { withFileTypes: true })) {
        if (!entry.isDirectory() || !uuid.test(entry.name))
          throw new Error('Unexpected policy directory entry');
        result.push(entry.name);
      }
      return result.sort();
    },
  };
}
/** Called AFTER authorization and version locking, BEFORE deletion. A committed independent
 * intent remains authoritative even if PG rolls back: privacy-safe replay completes it. */
export async function recordPolicy(
  tx: TenantTransaction,
  auth: AuthContext,
  ledger: PolicyLedger | undefined,
  fact: PolicyFact,
) {
  if (!ledger) return;
  const record: PolicyRecord = {
    ...fact,
    id: randomUUID(),
    tenant_id: auth.tenantId,
    actor_id: auth.principalId,
    accepted_at: new Date().toISOString(),
  };
  await sql`select pg_advisory_xact_lock(hashtextextended(${`policy:${record.id}`},0))`.execute(tx);
  await ledger.append(record);
  await sql`insert into policy_receipts(tenant_id,id,kind,target_id,actor_id,accepted_at) values(${auth.tenantId},${record.id},${record.kind},${record.target_id},${auth.principalId},${record.accepted_at}::timestamptz)`.execute(
    tx,
  );
  return record;
}
export async function configuredPolicyLedger(
  env: NodeJS.ProcessEnv,
): Promise<PolicyLedger | undefined> {
  const directory = env['POLICY_LEDGER_DIRECTORY'],
    signingKey = env['POLICY_LEDGER_SIGNING_KEY'];
  if (!directory && !signingKey && ['test', 'development'].includes(env['APP_ENV'] ?? ''))
    return undefined;
  if (!directory || !signingKey)
    throw new Error('Independent POLICY_LEDGER_DIRECTORY and POLICY_LEDGER_SIGNING_KEY required');
  return createFilePolicyLedger({ directory, signingKey });
}
