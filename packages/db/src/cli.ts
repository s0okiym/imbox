import { createDatabase } from './database.js';
import { migrateToLatest } from './migrate.js';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error('MIGRATION_DATABASE_URL is required; application credentials are intentionally not used');
const database = createDatabase(url, { max: 1, applicationName: 'imbox-migrator', statementTimeoutMs: 120_000 });
try {
  const applied = await migrateToLatest(database);
  process.stdout.write(`${JSON.stringify({ applied })}\n`);
} finally {
  await database.destroy();
}
