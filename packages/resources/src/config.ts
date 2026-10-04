import { createS3ObjectStore } from './store.js';
/** Runtime composition only: configuration never performs bucket or schema creation. */
export function configuredResourceStore(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  if (env['ENABLE_RESOURCES'] === undefined || env['ENABLE_RESOURCES'] === 'false') return null;
  if (env['ENABLE_RESOURCES'] !== 'true') throw new Error('ENABLE_RESOURCES must be true or false');
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`Missing required resource setting ${name}`);
    return value;
  };
  const endpoint = required('S3_ENDPOINT');
  const environment = env['APP_ENV'] ?? env['NODE_ENV'] ?? 'production';
  const production =
    env['APP_ENV'] === 'production' ||
    env['NODE_ENV'] === 'production' ||
    !['development', 'test'].includes(environment);
  if (production && new URL(endpoint).protocol !== 'https:')
    throw new Error('Production object storage requires HTTPS');
  return createS3ObjectStore({
    endpoint,
    region: required('S3_REGION'),
    bucket: required('S3_BUCKET'),
    accessKeyId: required('S3_ACCESS_KEY_ID'),
    secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
  });
}
