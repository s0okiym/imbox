# Imbox Web

This is a Chinese React 19/Vite 8 client for the real Imbox API. It provides
authenticated conversations, real workspace member selection, message history,
stable-key send/retry, edits/deletion, fixed-version quotes, threads, reactions
and conversation members. It renders all
message bodies as text, including messages marked Markdown by other clients.

```sh
pnpm --filter @imbox/web dev
```

The default development server is port 5173 and proxies `/v1` to
`http://localhost:4100`. Set `IMBOX_API_PROXY_TARGET` to another API origin and pass
Vite `--host`/`--port` options as needed. Production must serve the built static
files and API through the same trusted HTTPS origin.

`VITE_ENABLE_DEV_LOGIN=true` enables the test-user controls **only in a Vite
development build**. The API separately enforces its environment and principal
allowlist. Production uses `/v1/auth/login` and protected session cookies. The
development seed tenant can be overridden with `VITE_DEFAULT_TENANT_ID`. Only the
tenant selection is saved in localStorage; credentials and message bodies are not.

Current implementation boundaries:

- Opening a conversation reads a complete, stable projection snapshot before
  subscribing to its opaque cursor over WebSocket. Each event is applied before
  its transport ACK. Disconnects recover through HTTP events and backoff before
  reconnecting; resync and revoked access clear the corresponding view first.
- The client retains the latest 1,000 messages in memory and initially displays 50. Earlier messages in that window can be shown in batches. Snapshot pages are
  currently read in full even for a large conversation; bounded server-side
  history hydration and virtualized rendering remain future work. A running
  projection worker is required. Conversation and identity discovery still poll.
- Read cursors are independent of transport ACKs: only message bubbles inside
  the actual scroll viewport in a visible, unobscured tab can advance the cursor.
  Loading a snapshot or receiving an event alone never marks it read.
- Drafts, pending messages, history and cursors are in memory only. Reloading or
  changing conversations discards unsent drafts. Offline sending is disabled.
- A retry preserves the original `client_message_id`, body and idempotency key.
  A failed response is shown as unconfirmed, never as definitely unsent.
- Identity/view/authorization boundaries clear or replace content; stale responses
  cannot overwrite a newer redaction or reuse another viewer's content.
- The task workbench uses independent task ACLs and versioned collaboration
  proposals. Receipt is displayed separately from acceptance. Submission evidence
  binds an immutable Artifact version; reviews never silently follow the latest head.
- Run creation discloses selected inputs, purpose, destination and budget. Controls
  show server-confirmed states. Grants, human approvals and unknown-action
  reconciliation use versioned commands; ordinary users cannot call worker execution.
- Text uploads use the real signed PUT flow. Downloads recheck access through the
  same-origin API and verify size/hash. Messages and task evidence refer to fixed
  stored resources; withdrawing a source removes its current readable UI.
- Finite wakeup plans restore a selected paused task Run without resetting its
  lifetime, step count or budget. Schedule edits and disabling use exact versions.
  Escalations expose metadata before an administrator explicitly takes ownership;
  the UI never reads private task content just to acquire the takeover version.
- Promoting a terminal conversation Run requires a new, explicitly entered goal,
  reviewers and budget. The original context and Agent permissions are not copied.
  Origin details disappear when the original sources are no longer readable.
- Permission-aware search and explicit memories retain source versions and hashes.
  Confirmation/conflict, human confidence, expiry, disabling and deletion are explicit.
  Memory bodies are user content, never authorization. Current source checks refresh
  every three seconds; loss of access clears results, detail and an open edit draft.
- The recovery workspace is an administrator-only server-authorized interface for
  independent-journal reconciliation. Presence of a navigation button grants no
  recovery authority. It rechecks status and permissions before versioned decisions.
- Other members' read receipt displays, Push, persistent offline queues and PWA
  installation are not claimed as implemented yet.

The isolated browser frame parser is a transitional narrow validator. It avoids
runtime Ajv compilation/eval under a strict CSP; contracts-generated standalone
browser validators should replace it when available.

Vitest covers view isolation, tombstones, authorization generations, message
ordering, snapshot completeness, ACK ordering, reconnect cursors, viewport read
eligibility, optimistic reconciliation, IME safeguards and request identity/headers.
Real API/database and browser flows must be verified separately; unit test request
fixtures are not a simulated application backend.

Browser suites in `tests/e2e` cover real runtime/action HTTP effects,
S3 upload/download and immutable evidence, quote/thread/reaction interactions,
finite schedules/task promotion/escalations, and explicit-memory provenance.
Their isolated API fixtures forward to real services and databases; cleanup closes
the browser page before shutting down the API so polling cannot reach a fallback
server after request routing is removed. Run them with the repository Playwright
configuration and provisioned integration databases/storage.
