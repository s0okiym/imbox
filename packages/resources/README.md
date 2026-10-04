# Resources and immutable Artifacts

The resource package stores metadata and authorization in PostgreSQL and private bytes in S3. It currently admits UTF-8 `text/plain`, `text/markdown` and `application/json`, up to 8 MiB per object. `scanRestrictedText` validates encoding, rejects control bytes and the EICAR test marker, and parses JSON. This is an explicit text admission policy, not an antivirus guarantee for arbitrary binary files. An additional scanner and a reviewed media-type contract are required before enabling other formats.

`createResourceService({ db, store, cursorSecret, maxUploadBytes? })` provides upload tickets, finalization, resource reads/downloads/deletion and immutable Artifact versions. `registerResourceRoutes(app, { identity, resources })` mounts the HTTP routes. Browser credentials use the existing session/Origin/CSRF checks; machine access is not implicitly enabled by adding these routes.

Uploads receive a 15-minute signed PUT capability for a tenant-specific staging key. The signature binds content type, declared byte count and SHA-256. Completion independently streams and hashes at most the configured byte limit, applies the scanner and copies those exact verified bytes into an immutable final key. Network/storage work occurs outside database transactions. A final short transaction checks the upload generation, expiry, global identity and current tenant/workspace/conversation or Task authorization again. Removing and re-adding the uploader does not restore a prior upload ticket. A still-valid staging URL cannot overwrite the published final object.

Downloads expose only `/v1/resources/{id}/content`. Every request authenticates and checks current scope permissions; every emitted chunk, at most 64 KiB, rechecks authorization. Revocation stops subsequent chunks, while bytes already sent cannot be recalled. The route sends attachment disposition, no-store, nosniff and a restrictive content policy. Conversation history beginning at join time also applies to resource locators. S3 GET URLs and internal object keys never appear in resource DTOs. Range downloads are not implemented.

An Artifact has immutable, numbered versions referencing resources within the same scope. Each version preserves its resource hash and reverse source link. Version creation requires a current `If-Match` and command idempotency key. PostgreSQL rejects updates/deletes of existing Artifact version rows. Resource deletion commits a tombstone first; the download gateway denies access immediately and a persisted cleanup job removes the object later.

`GET /v1/resources` and `GET /v1/artifacts` require exactly one `conversation_id` or `task_id`. They filter current visibility before pagination, return no private counts, and bind opaque cursors to the caller and current scope authorization generation. Resource locators from before a `since_join` member joined remain hidden unless a new visible message explicitly shares that same-conversation resource.

`resourceApplicationHooks()` supplies `messages` for `createMessagingService(db, secret, {resources: hooks.messages})` and `artifacts` for `createTaskService(db, secret, {artifacts: hooks.artifacts})`. These hooks run in the existing command transaction. A message accepts at most ten unique resources from its own conversation, preserving each source version. Deleting an attached resource also advances the conversation visibility generation, invalidates old sync snapshots/cursors and emits a replacement message projection without the attachment. A current read never resurrects the removed source while the worker catches up.

Task Artifact evidence fixes the Artifact ID, immutable version ID and verified SHA-256. The source must belong to that exact Task, and every evidence read and acceptance rechecks current Task/source access. Changing the Artifact head cannot change a submitted version. A deleted source prevents later evidence reads and acceptance; reviewers can still return the submission for replacement. An Artifact reference does not grant Task access to a collaboration-request recipient: that recipient must already be a participant to read Artifact-backed inputs. No cross-scope sharing is inferred from the submitter being able to read both scopes.

`createResourceCleanup({ db, store })(tenantId, limit)` is an internal reconciliation function for configured worker tenants. It expires abandoned uploads and claims bounded, lease-based cleanup jobs with retry. Successful uploads keep staging cleanup deferred until the signed PUT capability expires, preventing an upload URL from recreating a staging orphan after early cleanup. Expired/rejected unpublished final objects and tombstoned published objects are deleted idempotently. The storage lifecycle policy should independently retain a staging-prefix TTL as a second line of defense.

## Local S3

Start the checked-in SeaweedFS 4.48 image with `docker compose -f infra/compose.yaml up -d --wait seaweedfs`. It listens only on `127.0.0.1:18333`; master/filer/volume ports are not published. Its credential configuration denies anonymous access, separates bucket setup from application access, and restricts the application identity to the development/test buckets. The checked-in credentials are local fixtures only.

Runtime settings (the composition root passes MAX_UPLOAD_BYTES as the strictly bounded maxUploadBytes option):

```dotenv
APP_ENV=development
ENABLE_RESOURCES=true
S3_ENDPOINT=http://127.0.0.1:18333
S3_REGION=us-east-1
S3_BUCKET=imbox-resources-dev
S3_ACCESS_KEY_ID=imbox_local_s3_app
S3_SECRET_ACCESS_KEY=imbox_local_s3_app_secret
MAX_UPLOAD_BYTES=8388608
```

`configuredResourceStore(env)` returns null when disabled, otherwise requires all S3 settings and requires HTTPS whenever APP_ENV or NODE_ENV is production, or no explicit development/test environment is selected. It does not create buckets. Explicit local bootstrap uses `S3_SETUP_ACCESS_KEY_ID=imbox_local_s3_admin` and `S3_SETUP_SECRET_ACCESS_KEY=imbox_local_s3_admin_secret` with `pnpm --filter @imbox/resources setup:dev`; the above endpoint/region/bucket and an exact `PUBLIC_ORIGIN` must also be supplied. Setup installs CORS permitting PUT only from that origin. Browser uploads omit cookies and app headers, preserve the signed content type and let the browser supply Content-Length from the File. Setup is forbidden in production. Production provisioning must supply a private bucket, exact application CORS origins and separate reviewed IAM credentials. Every S3 operation has a 30-second deadline; download deadlines remain active through body consumption.

Integration tests use real PostgreSQL roles and real SeaweedFS, with no storage mock or silent skip. Run `pnpm exec vitest run tests/integration/resources.test.ts tests/integration/resource-links.test.ts --config vitest.integration.config.ts`; `TEST_S3_ENDPOINT` can override the local endpoint. The test fixture creates only `imbox-resources-test` using the local setup identity.

This package does not provide general binary antivirus or multipart uploads. Artifact versions can be selected explicitly through the knowledge Runtime source port; they retain fixed hashes and current source permissions. API setup does not advertise unsupported media types or treat an inbox acknowledgement as authorization to publish.

Protocol references: [AWS SDK S3 streaming behavior](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/migrate-s3.html) and [SeaweedFS credential configuration](https://github.com/seaweedfs/seaweedfs/blob/master/weed/command/s3.go).

## Fixed-version comments and controlled sharing

`createArtifactCollaborationService({ db, store, cursorSecret, policyLedger? })` supplies the separately mounted `registerArtifactCollaborationRoutes`. Comments address an immutable Artifact version and SHA-256, with either a whole-version anchor or a validated Unicode scalar text range. Editing never moves the anchor. Authors may withdraw their own comment; deletion blanks its body and records the independent deletion intent before committing. Version history does not give access to a deleted or unauthorized source.

A human who created the Artifact and uploaded its source can explicitly share one fixed version with one current tenant member, one conversation, or one Task for at most 24 hours. Read permission alone cannot create this disclosure. The grant captures source-owner authority and the target audience generation, and changing either invalidates the grant, including removal and re-add. It grants only access through `/v1/artifact-shares/{id}/content`: original resource permissions, other versions and comments remain unchanged. Each chunk rechecks current source/target authority, expiry and revocation. The recipient never receives an anonymous or signed storage GET URL. Creators may inspect minimal grant summaries and revoke them even after losing source access.

The share and comment deletion policy facts replay after a database restore. Resource withdrawal also scrubs derived comments and withdraws shares. Already downloaded bytes remain outside server control. Tests in `tests/integration/artifact-collaboration.test.ts` cover real PostgreSQL and SeaweedFS, source and recipient removal/re-add, audience changes, chunk-boundary revocation, fixed anchors, expiry, restore replay and authenticated HTTP downloads.
