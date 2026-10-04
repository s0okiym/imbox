import { config } from 'dotenv';
import { createS3ObjectStore } from '@imbox/resources';
config({ path: '.env', quiet: true });
if (process.env['APP_ENV'] === 'production' || process.env['NODE_ENV'] === 'production')
  throw new Error('Test storage bootstrap is forbidden in production');
const endpoint = process.env['TEST_S3_ENDPOINT'] ?? 'http://127.0.0.1:18333';
const parsed = new URL(endpoint);
if (
  parsed.protocol !== 'http:' ||
  !['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
  parsed.username ||
  parsed.password
)
  throw new Error('Test storage bootstrap only supports the local isolated fixture');
const store = createS3ObjectStore({
  endpoint,
  region: 'us-east-1',
  bucket: 'imbox-resources-test',
  accessKeyId: 'imbox_local_s3_admin',
  secretAccessKey: 'imbox_local_s3_admin_secret',
});
try {
  await store.ensureDevelopmentBucket('test');
  await store.configureDevelopmentCors(['http://127.0.0.1:4173']);
  process.stdout.write('Isolated test object bucket and exact browser origin ready\n');
} finally {
  store.destroy();
}
