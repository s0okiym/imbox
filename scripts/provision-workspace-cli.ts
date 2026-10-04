import { readFile } from 'node:fs/promises';
import { config } from 'dotenv';
import { createDatabase } from '@imbox/db';
import { provisionWorkspace } from './provision-workspace.js';
config({ path: '.env', quiet: true });
const [file, mode, ...extra] = process.argv.slice(2);
if (!file || (mode !== undefined && mode !== '--apply') || extra.length)
  throw new Error('Usage: pnpm workspace:provision manifest.json [--apply]');
const url = process.env['MIGRATION_DATABASE_URL'];
if (!url) throw new Error('MIGRATION_DATABASE_URL required; never use application credentials');
const db = createDatabase(url, { max: 1, applicationName: 'imbox-workspace-provisioning' });
try {
  const bytes = await readFile(file);
  if (bytes.length > 64 * 1024) throw new Error('Manifest too large');
  const result = await provisionWorkspace(
    db,
    JSON.parse(bytes.toString('utf8')),
    mode === '--apply',
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  // Neither database detail nor identity manifest belongs in terminal/CI logs.
  process.stderr.write(
    'Workspace provisioning failed. Check manifest, existing active identities, migration 030 and migration-owner credentials. No partial provisioning is committed.\n',
  );
  process.exitCode = 1;
} finally {
  await db.destroy();
}
