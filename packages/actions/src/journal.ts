import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, lstat, link, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface IntentRecord {
  kind: 'intent';
  id: string;
  tenant_id: string;
  action_id: string;
  attempt_id: string;
  task_id: string;
  action_version: string;
  lease_generation: string;
  fingerprint: string;
  business_key: string;
  tool_id: string;
  /** Absent only on legacy intents, which cannot be automatically repaired if orphaned. */
  tool_version?: string;
  /** Exact connector configuration; legacy records without it cannot query a provider. */
  tool_binding?: string;
  budget_account_ids?: string[];
  run_id?: string;
  target_id: string;
  currency: string;
  estimate_microunits: string;
  created_at: string;
}
export interface ReceiptRecord {
  kind: 'receipt';
  id: string;
  tenant_id: string;
  action_id: string;
  attempt_id: string;
  fingerprint: string;
  outcome: 'succeeded' | 'no_effect' | 'unknown';
  receipt_id?: string;
  actual_microunits?: string;
  created_at: string;
}
export interface FreezeRecord {
  kind: 'freeze';
  id: string;
  tenant_id: string;
  reason: 'restore' | 'missing_action' | 'journal_conflict';
  created_at: string;
}
export interface RecoveryRecord {
  kind: 'recovery';
  id: string;
  tenant_id: string;
  action_id: string;
  attempt_id: string;
  intent_hash: string;
  evidence_hash: string;
  receipt_id: string;
  outcome: 'succeeded' | 'no_effect';
  actual_microunits: string;
  confirmed_by: string;
  created_at: string;
}
export interface UnfreezeRecord {
  kind: 'unfreeze';
  id: string;
  tenant_id: string;
  freeze_digest: string;
  journal_digest: string;
  authorized_by: string;
  created_at: string;
}
export type JournalRecord =
  IntentRecord | ReceiptRecord | FreezeRecord | RecoveryRecord | UnfreezeRecord;
/** Implementations must acknowledge only after durable, independently retained storage succeeds. */
export interface JournalPort {
  append(record: JournalRecord): Promise<void>;
  records(tenantId: string): Promise<JournalRecord[]>;
  frozen(tenantId: string): Promise<boolean>;
  freeze(tenantId: string, reason: FreezeRecord['reason']): Promise<void>;
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function safeId(id: string) {
  if (!uuid.test(id)) throw new Error('Journal requires UUID identifiers');
  return id;
}
/** One fsync'ed immutable signed file per fact, plus directory fsync. Keep this volume outside PG backups. */
export async function createFileJournal(options: {
  directory: string;
  signingKey: string;
}): Promise<JournalPort> {
  if (options.signingKey.length < 32)
    throw new Error('Independent journal signing key must contain at least 32 characters');
  const base = resolve(options.directory);
  await mkdir(base, { recursive: true, mode: 0o700 });
  const state = await lstat(base);
  if (!state.isDirectory() || state.isSymbolicLink() || (state.mode & 0o022) !== 0)
    throw new Error('Journal directory must be private and must not be a symbolic link');
  const sign = (record: JournalRecord) =>
    createHmac('sha256', options.signingKey).update(canonical(record)).digest('hex');
  async function syncDirectory(path: string) {
    const dir = await open(path, 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
  async function tenantDirectory(tenantId: string) {
    const path = join(base, safeId(tenantId));
    await mkdir(path, { recursive: true, mode: 0o700 });
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o022) !== 0)
      throw new Error('Unsafe journal tenant directory');
    await syncDirectory(base);
    return path;
  }
  function parse(text: string): JournalRecord {
    const wrapped = JSON.parse(text) as {
      v?: unknown;
      record?: JournalRecord;
      signature?: unknown;
    };
    if (
      wrapped.v !== 1 ||
      !wrapped.record ||
      typeof wrapped.signature !== 'string' ||
      !/^[0-9a-f]{64}$/.test(wrapped.signature)
    )
      throw new Error('Journal integrity verification failed');
    const expected = Buffer.from(sign(wrapped.record), 'hex');
    const supplied = Buffer.from(wrapped.signature, 'hex');
    if (!timingSafeEqual(expected, supplied))
      throw new Error('Journal integrity verification failed');
    safeId(wrapped.record.id);
    safeId(wrapped.record.tenant_id);
    if (!['intent', 'receipt', 'freeze', 'recovery', 'unfreeze'].includes(wrapped.record.kind))
      throw new Error('Unsupported journal record');
    return wrapped.record;
  }
  async function readRecord(path: string): Promise<JournalRecord> {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o022) !== 0)
        throw new Error('Unsafe journal record file');
      if (stat.size > 16384) throw new Error('Journal record is too large');
      return parse(await file.readFile('utf8'));
    } finally {
      await file.close();
    }
  }
  const journal: JournalPort = {
    async append(record) {
      const dir = await tenantDirectory(record.tenant_id);
      const path = join(dir, `${safeId(record.id)}.json`);
      const text = JSON.stringify({ v: 1, record, signature: sign(record) });
      if (Buffer.byteLength(text) > 16384) throw new Error('Journal record is too large');
      const temporary = join(dir, `${safeId(record.id)}.${randomUUID()}.tmp`);
      const handle = await open(temporary, 'wx', 0o600);
      try {
        try {
          await handle.writeFile(text, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        // Publish only a completely written/fsync'ed record. link never overwrites a fact.
        try {
          await link(temporary, path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const existing = await readRecord(path);
          if (canonical(existing) !== canonical(record))
            throw new Error('Conflicting journal record identity', { cause: error });
        }
        // A retry may win this race before the other writer syncs the directory.
        // It must establish durability itself before authorizing any external send.
        await syncDirectory(dir);
      } finally {
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    },
    async records(tenantId) {
      const dir = await tenantDirectory(tenantId);
      const entries = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
      if (entries.length > 100000) throw new Error('Journal requires archival/index maintenance');
      const results: JournalRecord[] = [];
      for (const file of entries) {
        if (!uuid.test(file.slice(0, -5))) throw new Error('Unexpected journal filename');
        const record = await readRecord(join(dir, file));
        if (record.tenant_id !== tenantId || record.id !== file.slice(0, -5))
          throw new Error('Journal identity mismatch');
        results.push(record);
      }
      return results;
    },
    async frozen(tenantId) {
      const records = await journal.records(tenantId);
      const ids = records
        .filter((r) => r.kind === 'freeze')
        .map((r) => r.id)
        .sort();
      if (!ids.length) return false;
      const digest = createHash('sha256').update(canonical(ids)).digest('hex');
      return !records.some((r) => r.kind === 'unfreeze' && r.freeze_digest === digest);
    },
    async freeze(tenantId, reason) {
      await journal.append({
        kind: 'freeze',
        id: randomUUID(),
        tenant_id: tenantId,
        reason,
        created_at: new Date().toISOString(),
      });
    },
  };
  return journal;
}
