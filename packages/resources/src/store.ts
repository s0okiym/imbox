import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';
export interface ObjectStore {
  signPut(
    key: string,
    input: { contentType: string; byteSize: number; sha256: string; expiresSeconds: number },
  ): Promise<{ url: string; headers: Record<string, string> }>;
  read(key: string): Promise<{ size: number; body: AsyncIterable<Uint8Array>; close(): void }>;
  putImmutable(key: string, bytes: Uint8Array, contentType: string, sha256: string): Promise<void>;
  delete(key: string): Promise<void>;
}
export function createS3ObjectStore(options: {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}) {
  const url = new URL(options.endpoint);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid configured S3 endpoint');
  const client = new S3Client({
    endpoint: options.endpoint,
    region: options.region,
    forcePathStyle: true,
    credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 3,
  });
  const store: ObjectStore = {
    async signPut(key, input) {
      const headers = {
        'content-type': input.contentType,
        'content-length': String(input.byteSize),
      };
      const command = new PutObjectCommand({
        Bucket: options.bucket,
        Key: key,
        ContentType: input.contentType,
        ContentLength: input.byteSize,
        ChecksumSHA256: Buffer.from(input.sha256, 'hex').toString('base64'),
      });
      return {
        url: await getSignedUrl(client, command, {
          expiresIn: input.expiresSeconds,
          signableHeaders: new Set(['content-type', 'content-length']),
        }),
        headers,
      };
    },
    async read(key) {
      const deadline = AbortSignal.timeout(30000);
      const result = await client.send(new GetObjectCommand({ Bucket: options.bucket, Key: key }), {
        abortSignal: deadline,
      });
      if (!result.Body || !Number.isSafeInteger(result.ContentLength))
        throw new Error('Invalid object response');
      const abort = () => {
        if (result.Body && 'destroy' in result.Body && typeof result.Body.destroy === 'function')
          result.Body.destroy(new Error('Object download deadline exceeded'));
      };
      deadline.addEventListener('abort', abort, { once: true });
      return {
        size: result.ContentLength!,
        body: result.Body as AsyncIterable<Uint8Array>,
        close() {
          deadline.removeEventListener('abort', abort);
          if (result.Body && 'destroy' in result.Body && typeof result.Body.destroy === 'function')
            result.Body.destroy();
        },
      };
    },
    async putImmutable(key, bytes, contentType, sha256) {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: options.bucket,
            Key: key,
            Body: bytes,
            ContentType: contentType,
            ContentLength: bytes.byteLength,
            IfNoneMatch: '*',
            Metadata: { sha256 },
          }),
          { abortSignal: AbortSignal.timeout(30000) },
        );
      } catch (error) {
        if (
          !error ||
          typeof error !== 'object' ||
          !('$metadata' in error) ||
          (error.$metadata as { httpStatusCode?: number }).httpStatusCode !== 412
        )
          throw error;
        const current = await store.read(key);
        try {
          const chunks: Uint8Array[] = [];
          let size = 0;
          for await (const chunk of current.body) {
            size += chunk.byteLength;
            if (size > bytes.byteLength)
              throw new Error('Immutable object mismatch', { cause: error });
            chunks.push(chunk);
          }
          if (
            size !== bytes.byteLength ||
            createHash('sha256').update(Buffer.concat(chunks)).digest('hex') !== sha256
          )
            throw new Error('Immutable object mismatch', { cause: error });
        } finally {
          current.close();
        }
      }
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key }), {
        abortSignal: AbortSignal.timeout(30000),
      });
    },
  };
  return {
    ...store,
    destroy() {
      client.destroy();
    },
    async ensureDevelopmentBucket(environment: 'development' | 'test') {
      if (
        !['development', 'test'].includes(environment) ||
        process.env['NODE_ENV'] === 'production' ||
        process.env['APP_ENV'] === 'production'
      )
        throw new Error('Bucket bootstrap forbidden in production');
      try {
        await client.send(new HeadBucketCommand({ Bucket: options.bucket }), {
          abortSignal: AbortSignal.timeout(30000),
        });
      } catch (error) {
        if (
          !error ||
          typeof error !== 'object' ||
          !('$metadata' in error) ||
          (error.$metadata as { httpStatusCode?: number }).httpStatusCode !== 404
        )
          throw error;
        await client.send(new CreateBucketCommand({ Bucket: options.bucket }), {
          abortSignal: AbortSignal.timeout(30000),
        });
      }
    },
    async configureDevelopmentCors(origins: readonly string[]) {
      if (process.env['NODE_ENV'] === 'production' || process.env['APP_ENV'] === 'production')
        throw new Error('Development CORS setup forbidden in production');
      if (
        !origins.length ||
        origins.some((value) => {
          try {
            return (
              new URL(value).origin !== value ||
              !['http:', 'https:'].includes(new URL(value).protocol)
            );
          } catch {
            return true;
          }
        })
      )
        throw new Error('Exact HTTP origins are required');
      await client.send(
        new PutBucketCorsCommand({
          Bucket: options.bucket,
          CORSConfiguration: {
            CORSRules: [
              {
                AllowedOrigins: [...new Set(origins)],
                AllowedMethods: ['PUT'],
                AllowedHeaders: ['content-type', 'content-length'],
                ExposeHeaders: ['ETag'],
                MaxAgeSeconds: 300,
              },
            ],
          },
        }),
        { abortSignal: AbortSignal.timeout(30000) },
      );
    },
    async head(key: string) {
      return client.send(new HeadObjectCommand({ Bucket: options.bucket, Key: key }), {
        abortSignal: AbortSignal.timeout(30000),
      });
    },
  };
}
