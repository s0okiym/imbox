# @imbox/application

Tenant-aware application commands and authorized views. HTTP and worker adapters call these use cases; they do not update domain tables directly.

## Message transaction boundaries

`createMessagingService(db, cursorSecret)` uses the restricted application role. Each operation validates the active tenant and membership revision inside its transaction. Conversation access additionally validates current workspace and conversation membership. Revoking workspace access therefore closes direct conversation lookup and message operations as well as workspace enumeration.

Mutations claim a scoped command receipt, lock the affected conversation, recheck authorization and expected version, persist the change with its event/outbox, and complete the receipt atomically. Retries return a resource reference and build a fresh authorized view. Changed input under the same key, a reused client message identity under another key, and expired command receipts are rejected. No external service call runs in this transaction.

History pagination is newest-page-first with each page in ascending message order. AES-GCM cursors bind tenant, caller, scope, authorization revision, generation and purpose. Message edits preserve immutable old revisions. Retraction immediately increments the conversation/stream generation, invalidating old snapshots before the projector catches up. A delivery ACK is never a user read receipt.

The current message command supports plain text. Markdown, attachments and other reserved contract options are rejected until their full storage, disclosure and rendering paths exist.

## Verification

Real database and HTTP regression cases live in `tests/integration/messaging.test.ts` and `tests/integration/http.test.ts`. Cursor confidentiality and tampering checks live in this package. They complement, rather than replace, the database package's RLS and transaction tests.

Task, execution and realtime additions must preserve the lock order and invariants documented in `docs/development`. A package build alone does not demonstrate those end-to-end properties.
