import { createDatabase } from './database.js';
import { migrateToLatest } from './migrate.js';
import { bootstrapDevelopmentRole } from './testing.js';

const environment = process.argv.find((argument) => argument.startsWith('--environment='))?.split('=')[1];
if (environment !== 'test' && environment !== 'development') {
  throw new Error('Explicit --environment=test or --environment=development required');
}
if (process.env.NODE_ENV === 'production') throw new Error('Development setup is forbidden in production');
const migrationUrl = environment === 'test' ? process.env.TEST_DATABASE_URL : process.env.MIGRATION_DATABASE_URL;
const applicationUrl = environment === 'test' ? process.env.TEST_APP_DATABASE_URL : process.env.DATABASE_URL;
const identityUrl = environment === 'test' ? process.env.TEST_IDENTITY_DATABASE_URL : process.env.IDENTITY_DATABASE_URL;
if (!migrationUrl || !applicationUrl || !identityUrl) throw new Error('Explicit migration, application, and identity database URLs are required');
const database = createDatabase(migrationUrl, { max: 1, applicationName: 'imbox-dev-setup', statementTimeoutMs: 120_000 });
try {
  const applied = await migrateToLatest(database);
  for (const [kind, url] of [['application', applicationUrl], ['identity', identityUrl]] as const) {
    const credentials = new URL(url);
    await bootstrapDevelopmentRole(database, { environment, kind, role: decodeURIComponent(credentials.username), password: decodeURIComponent(credentials.password) });
  }
  process.stdout.write(`${JSON.stringify({ applied, environment, roles: ['application', 'identity'] })}\n`);
} finally {
  await database.destroy();
}
