# @imbox/contracts

M0 contract foundation, not a declaration that V1 endpoints or business permissions are implemented.

`src/schemas.ts` is the authoritative JSON Schema 2020-12 source. `generate` emits TypeScript DTOs, a portable schema document and OpenAPI 3.1.1. Generated DTOs must not be edited manually. No hand-maintained duplicate request/response interfaces are used.

```bash
pnpm --filter @imbox/contracts generate
pnpm --filter @imbox/contracts check:generated
pnpm --filter @imbox/contracts typecheck
pnpm --filter @imbox/contracts test
pnpm --filter @imbox/contracts build
```

The root workspace supplies catalog versions and installs dependencies. Generation must precede the first build. The check command compares deterministic artifacts without writing files or relying on Git state.

## Usage

```ts
import { assertContract, parseContract, schemas } from '@imbox/contracts';
import type { CreateMessageInput, Message } from '@imbox/contracts';

const input = assertContract('CreateMessageInput', unknownBody);
const frame = parseContract('WsClientFrame', websocketText);
```

HTTP transport must cap the raw body at 256 KiB before parsing. `parseContract` applies that byte bound to request/frame JSON; both validation APIs bound JSON depth (16), node count (10,000), and serialized UTF-8 size. Bounded bulk response schemas (`MessagePage`, `StreamSnapshot`, `StreamEvents`) instead permit 16 MiB and 50,000 nodes, so a valid page is not rejected using a request-body cap. Only JSON values are accepted. No coercion, default insertion, field stripping, arbitrary schema upload or accessors are allowed.

Frameworks compiling a route schema independently can use `schemas.Name`, which includes its referenced definitions. They must use an Ajv 2020-12 instance and retain the same transport/depth guard; direct schema compilation does not implement authentication, byte limits, CSRF, tenant scope or business authorization. See [Ajv dialect documentation](https://ajv.js.org/json-schema.html#draft-2020-12-breaking).

Entity IDs are UUIDs. Versions are canonical positive decimal strings bounded by PostgreSQL signed bigint; counters allow zero. No version is converted through JavaScript Number. Time values require valid UTC RFC3339 with `Z`.

All object schemas reject additional fields. Actor identity is present only in response DTOs; commands do not accept actor, tenant role, approver or equivalent identity claims. Member IDs and decision targets remain subject to service-side authorization. Principal kinds are `human`, `agent`, and `service`. Me includes tenant/session context and a CSRF token for authenticated session restoration; token derivation and request tenant membership checks belong to the authentication service.

DTOs carrying a view include `view_scope`, `authz_generation`, `projection_id`, and `projection_revision`. These fields prevent accidental cross-view cache merging but do not themselves authorize a caller. An ACK only acknowledges a stream cursor; it does not accept a task.

## M0 scope and limits

Implemented schema coverage includes identity/error, conversations and plain-text/Markdown message commands, membership/reactions/read cursors, Task/Request/Handoff/Run/Approval/Artifact summaries, projection summaries, and hello/subscribe/ack/control/heartbeat frames. Message `seq` is a decimal counter. Request state names match the database: `clarification_requested` corresponds to the product document's `needs_clarification`, and `cancelled` corresponds to `withdrawn`; domain adapters must map explicitly if they retain product terminology.

The generated OpenAPI distinguishes `implemented`, `development-only`, and `contract-only` operations, checked against API/auth route sources. Implemented means code exists, not that a deployment enables it. Authentication currently uses browser sessions; machine bearer support remains future work. Runtime capability discovery must come from enabled application routes, not this inventory. Structural/reference checks are a foundation, not a claim of full OpenAPI meta-schema validation. Ajv separately compiles the authoritative JSON Schemas in strict mode.

The first message command requires nonempty text. Markdown and attachment-reference fields reserve the contract shape; an API implementing only text must reject non-text format/nonempty attachments until the corresponding capability is enabled. Attachment-only messages, typed rich-text bodies, full artifact payloads, presence/typing, token deltas, Action and schedule commands, and remaining endpoint definitions are intentionally not advertised yet. Projection payloads support closed summary cards and materialized message/conversation DTOs. Snapshot pages carry a fixed-head cursor and optional snapshot-pagination cursor; events pages always carry scan progress, including empty pages. Snapshot/session correctness and authorization remain server responsibilities.

Schema validation proves shape only. Direct-chat member cardinality, accepted contracts, transition legality, budget arithmetic, relation integrity, deleted-body redaction, approval authority, and disclosure of content remain domain/policy responsibilities.

## M2 work contracts and currently enabled behavior

M2 adds Task creation/read/update/participants/state/dependencies, explicit conversation summaries, versioned collaboration proposals and decisions, immutable text submissions, and authorized reviews. Initial owner and accountable are the creator; ownership changes through recipient-accepted handoff or the audited administrator takeover command. Delegate acceptance creates a child, leaving the parent owner unchanged. No conversation membership or summary link grants the Task ACL. Request content is readable only by its proposer and recipient with current workspace membership; Task participants do not automatically gain another recipient's proposal.

`If-Match` on Task commands identifies `Task.version`; on Request commands it identifies `CollaborationRequest.version`. A decision additionally names `proposal_version` and `expected_task_version`. Goal changes create a new `goal_version` and execution epoch. Accepted agreements preserve their terms; cancelling work never rewrites an accepted decision. The service saves complete ancestor epochs in proposals/submissions and checks them again on acceptance/review. Request status vocabulary maps explicitly to the pure domain model in `tasks.ts`.

A `WorkProposal` contains inputs, output schema, acceptance criteria/reviewers, initial budget, due/execution dates, disclosure, dependencies, cancellation, escalation and an explicit handoff package when applicable. Its allowed-actions list is empty in M2: accepting work grants no external-tool capability, credentials, model runtime, or resource-read authority. M3 adds bounded execution and budgets; M4 adds Action authorization. Initial budget limits are persisted for every Task; M2 does not reserve, spend, or settle usage. Child limits cannot exceed the parent limit, while future spending must also pass all ancestor reservations.

M2 submissions use typed immutable `text` evidence with server IDs and SHA-256 content hashes, explicit source Task/version references, and a fixed goal version. `artifact_version` is modeled with artifact/version IDs and hash, but the service rejects it until M5 can validate stored bytes and resource permissions. Task completion requires an applicable submission, a designated active reviewer, and all child tasks closed. `createTaskService` accepts a future `requiredActionsClosed` gate; if an Action table exists without that gate, completion fails closed. Run completion never calls Task review.

Task/Request HTTP routes and conversation sync routes are marked `implemented` because route code is mounted; this does not advertise model providers, external agents, hosted execution, tools, binary artifacts, or scheduled automation. Tasks currently expose their query/command HTTP API; Task/private-inbox realtime projection consumers remain separate work. Bounded Task, Request, and Submission pages use the 16 MiB response cap rather than the request-body cap.
