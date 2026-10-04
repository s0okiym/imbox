# Imbox projection worker

This process consumes PostgreSQL outbox rows and produces durable conversation/message projections. It does not use application memory or a websocket connection as the source of progress.

```sh
# Run from the repository root after migrations/seed. Use the restricted application role.
WORKER_TENANT_IDS=<tenant-uuid> pnpm exec dotenv run -f .env -- pnpm --filter @imbox/worker dev
```

`DATABASE_URL` must connect as a non-owner role without superuser/BYPASSRLS. `WORKER_TENANT_IDS` is an explicit comma-separated tenant allowlist; no global tenant-content bypass is granted. `WORKER_POLL_INTERVAL_MS` defaults to 250. SIGTERM/SIGINT finish the current short transaction and release the pool.

## Durable processing

1. Claim due `conversation:*` outbox targets using `FOR UPDATE SKIP LOCKED`, incrementing a lease generation and persisting holder/expiry. Other target families remain pending for their own projector.
2. In a tenant transaction, verify the current unexpired lease, read the persisted event, and lock its target/aggregate checkpoint. Process only the next aggregate version; out-of-order versions remain pending.
3. Read current authoritative message/conversation state. If a queued old event observes a newer version, attach the projection to the **actual newer persisted event/version**. The projector never emits current content labelled with an old version. Every original event still receives its own ordered checkpoint/receipt; domain history remains durable.
4. Lock the projection stream head, persist the materialized view, append its delivery, advance the aggregate checkpoint, write the consumer receipt, and finish the outbox lease in the same transaction. Replayed work cannot duplicate a delivery. An expired holder cannot commit.
5. Retry transaction failures with bounded delay. Ten failed attempts move the outbox row to `dead`; missing event gaps preserve the blocked aggregate rather than skipping history. Failures are logged without message bodies or credentials.

Message projection is a current-state view: multiple edits arriving before projection may result in one latest-version delivery, while each underlying event remains recorded and consumed. A deletion produces a tombstone. The messaging command immediately bumps the conversation authorization generation on content withdrawal; the sync layer also suppresses stale projected bodies before the deletion worker runs.

The current wakeup mechanism is bounded PostgreSQL scanning. **pg-boss and LISTEN/NOTIFY have not been integrated**; either can later reduce wakeup latency without becoming an authority for delivery or retries. Long-running Agent execution is a separate module.

## HTTP and WebSocket synchronization

`GET /v1/streams/:id/snapshot` materializes a fixed, authorized projection snapshot and head in a REPEATABLE READ transaction. Later pages read retained snapshot items, not live messages. `next_cursor` paginates that same snapshot; every page returns the same events `cursor`. The client finishes the snapshot before incremental reads or subscription. Snapshot TTL defaults to ten minutes, and this worker removes expired snapshots in bounded batches.

`GET /v1/streams/:id/events?cursor=...` returns projected deliveries and a new scanned cursor even when no visible item is returned. Cursors use the shared AES-GCM codec and are bound to tenant, principal, membership revision, stream, authorization/retention generations, history boundary and purpose. Cross-user, tampered, expired or outdated-generation tokens require resynchronization. Current workspace/conversation membership is checked on every page and batch. Since-join membership excludes older message content.

`/v1/ws?tenant_id=...` requires a current browser session and exact Origin. After `hello`/`welcome`, the client subscribes with a completed snapshot cursor or its last applied event cursor. The server delivers durable projection frames, checks identity and current ACLs before each batch, and emits `access_revoked` or `resync_required` when appropriate. Reconnecting uses the same persisted delivery history. Internal periodic database checks support this push transport and revocation detection; there is a real WebSocket protocol, not a client polling substitute.

ACK applies only to transport flow control and never updates a user's read cursor. The client marks messages read separately after they are actually displayed. Frame size, subscription count, queued inbound frames, socket buffered bytes and unacknowledged delivery windows are bounded; slow clients receive a resync control and close. Heartbeat timeout closes abandoned connections.

## Verification

`tests/integration/sync.test.ts` uses real PostgreSQL roles and actual TCP WebSockets. It verifies parallel workers, transactional projection rollback/retry, out-of-order and duplicate consumption, expired lease fencing, stable snapshot pages during edits, incremental recovery, immediate deletion suppression, history/ACL/TTL/retention boundaries, caller-bound/tamper-resistant cursors, HTTP serialization, WebSocket ACK/read separation, reconnect catch-up, revocation, cross-origin rejection and slow-consumer limits.
