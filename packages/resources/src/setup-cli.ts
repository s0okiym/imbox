import { createS3ObjectStore } from './store.js';
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
if (process.env['NODE_ENV'] === 'production' || process.env['APP_ENV'] === 'production')
  throw new Error('Development bucket setup is forbidden in production');
const store = createS3ObjectStore({
  endpoint: required('S3_ENDPOINT'),
  region: required('S3_REGION'),
  bucket: required('S3_BUCKET'),
  accessKeyId: required('S3_SETUP_ACCESS_KEY_ID'),
  secretAccessKey: required('S3_SETUP_SECRET_ACCESS_KEY'),
});
try {
  await store.ensureDevelopmentBucket('development');
  await store.configureDevelopmentCors([required('PUBLIC_ORIGIN')]);
  process.stdout.write('Development resource bucket ready\n');
} finally {
  store.destroy();
}
