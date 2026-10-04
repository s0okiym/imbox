# 回归用例静态索引

由 `pnpm test:catalog` 从 TypeScript 测试声明生成。参数化用例在此只登记声明，实际展开数量以测试运行报告为准；测试路径存在和标题登记不等于测试已通过，也不等于 AC/INV 已完整覆盖。

共 88 个测试文件、532 个具名声明。执行入口、环境和限制见 [回归说明](README.md)，产品验收映射见 [coverage.json](../../tests/acceptance/coverage.json)。

## apps/api/src/coalesced-read.test.ts

| 声明 | 用例 |
|---|---|
| [it:3](../../apps/api/src/coalesced-read.test.ts#L3) | shares overlapping reads but rechecks authority on the next completed read |
| [it:25](../../apps/api/src/coalesced-read.test.ts#L25) | separates identities and bounds retained in-flight keys |

## apps/api/tests/app.test.ts

| 声明 | 用例 |
|---|---|
| [it:11](../../apps/api/tests/app.test.ts#L11) | API composition and response boundary → serves liveness independently of the database and exposes readiness failure |
| [it:25](../../apps/api/tests/app.test.ts#L25) | API composition and response boundary → uses JSON Schema 2020-12 and rejects extra request properties |
| [it:52](../../apps/api/tests/app.test.ts#L52) | API composition and response boundary → rejects a response that leaks a field beyond its schema |

## apps/web/src/api.test.ts

| 声明 | 用例 |
|---|---|
| [it:6](../../apps/web/src/api.test.ts#L6) | same-origin API commands → binds a reply to its displayed string version and reactions are explicit set/remove commands |
| [it:30](../../apps/web/src/api.test.ts#L30) | same-origin API commands → retries an attachment message with the same fixed identifiers instead of uploading again |
| [it:48](../../apps/web/src/api.test.ts#L48) | same-origin API commands → preserves a stable send identity, tenant boundary and CSRF on retries |
| [it:77](../../apps/web/src/api.test.ts#L77) | same-origin API commands → edits bind the precise string version using a quoted If-Match |
| [it:88](../../apps/web/src/api.test.ts#L88) | same-origin API commands → development login sends only the chosen principal and keeps tenant in its header |
| [it:99](../../apps/web/src/api.test.ts#L99) | same-origin API commands → distinguishes access loss and conflicts without displaying server internals |

## apps/web/src/app-location.test.ts

| 声明 | 用例 |
|---|---|
| [it:6](../../apps/web/src/app-location.test.ts#L6) | round trips explicit resource locations without putting credentials or private text in URLs |
| [it:18](../../apps/web/src/app-location.test.ts#L18) | does not accept forged scope or authority fields from a URL |

## apps/web/src/conversation-sync.test.ts

| 声明 | 用例 |
|---|---|
| [it:134](../../apps/web/src/conversation-sync.test.ts#L134) | ordered snapshot and WebSocket synchronization → preserves the recent snapshot history boundary for explicit older-message loading |
| [it:142](../../apps/web/src/conversation-sync.test.ts#L142) | ordered snapshot and WebSocket synchronization → does not expose a partial snapshot or subscribe before the last stable page |
| [it:164](../../apps/web/src/conversation-sync.test.ts#L164) | ordered snapshot and WebSocket synchronization → ACKs only after applying the event and answers heartbeat without marking read |
| [it:182](../../apps/web/src/conversation-sync.test.ts#L182) | ordered snapshot and WebSocket synchronization → clears the view before restarting snapshot on authorization resync |
| [it:196](../../apps/web/src/conversation-sync.test.ts#L196) | ordered snapshot and WebSocket synchronization → stops and clears content on revoked access, without acknowledging the revocation as read |
| [it:210](../../apps/web/src/conversation-sync.test.ts#L210) | ordered snapshot and WebSocket synchronization → uses the last applied opaque cursor for HTTP catchup after disconnect |
| [it:233](../../apps/web/src/conversation-sync.test.ts#L233) | ordered snapshot and WebSocket synchronization → closes a silently stalled socket after 45 seconds without server frames |
| [it:249](../../apps/web/src/conversation-sync.test.ts#L249) | narrow browser projection parser → accepts a valid long Unicode message above the smaller client control-frame limit |
| [it:263](../../apps/web/src/conversation-sync.test.ts#L263) | narrow browser projection parser → never coerces malformed actor kinds, statuses or control reasons into valid strings |
| [it:289](../../apps/web/src/conversation-sync.test.ts#L289) | narrow browser projection parser → rejects unsupported schema and mismatched projection identities |
| [it:298](../../apps/web/src/conversation-sync.test.ts#L298) | narrow browser projection parser → removes body content whenever the authoritative envelope says remove |
| [it:314](../../apps/web/src/conversation-sync.test.ts#L314) | forward-compatible display projections → acknowledges an unknown display entity without interpreting its payload and keeps receiving known messages |
| [it:334](../../apps/web/src/conversation-sync.test.ts#L334) | forward-compatible display projections → handles unknown snapshot entities without persisting their payload or restarting the snapshot |
| [it:344](../../apps/web/src/conversation-sync.test.ts#L344) | forward-compatible display projections → counts summary length as Unicode characters like the wire schema |
| [it:351](../../apps/web/src/conversation-sync.test.ts#L351) | forward-compatible display projections → rejects unfamiliar control frames, incompatible versions, malformed known messages and scope mismatches |

## apps/web/src/execution/execution-api.test.ts

| 声明 | 用例 |
|---|---|
| [it:5](../../apps/web/src/execution/execution-api.test.ts#L5) | runtime and action HTTP boundaries → binds approval to exact integer-string versions and reuses a caller command key after a lost response |
| [it:34](../../apps/web/src/execution/execution-api.test.ts#L34) | runtime and action HTTP boundaries → routes unknown lookup through reconcile and has no worker execution methods |
| [it:50](../../apps/web/src/execution/execution-api.test.ts#L50) | runtime and action HTTP boundaries → keeps listing cursors opaque and binds history to exactly one scope |
| [it:69](../../apps/web/src/execution/execution-api.test.ts#L69) | runtime and action HTTP boundaries → uses the cursor-only schedule contract and versioned disable without a cancellation body |

## apps/web/src/execution/execution-state.test.ts

| 声明 | 用例 |
|---|---|
| [it:30](../../apps/web/src/execution/execution-state.test.ts#L30) | execution controls preserve authority and uncertainty → waits for actual pause and cancellation acknowledgement and never resumes terminal runs |
| [it:37](../../apps/web/src/execution/execution-state.test.ts#L37) | execution controls preserve authority and uncertainty → only nominated humans can decide an unexpired exact approval binding under its current grant |
| [it:63](../../apps/web/src/execution/execution-state.test.ts#L63) | execution controls preserve authority and uncertainty → an unknown result has only lookup controls even for its original requester |
| [it:83](../../apps/web/src/execution/execution-state.test.ts#L83) | execution controls preserve authority and uncertainty → reports capacity and expiry without exposing internal error text |

## apps/web/src/governance/governance-api.test.ts

| 声明 | 用例 |
|---|---|
| [it:18](../../apps/web/src/governance/governance-api.test.ts#L18) | complete export verification → accepts correct byte hash and rejects truncated, interrupted, corrupt and duplicate footers |
| [it:29](../../apps/web/src/governance/governance-api.test.ts#L29) | complete export verification → uses the authenticated same-origin resource path and never an export-controlled URL |

## apps/web/src/knowledge/knowledge-api.test.ts

| 声明 | 用例 |
|---|---|
| [it:5](../../apps/web/src/knowledge/knowledge-api.test.ts#L5) | keeps source versions and hashes unchanged when a human updates confirmation after response loss |
| [it:38](../../apps/web/src/knowledge/knowledge-api.test.ts#L38) | encodes literal search and opaque cursors and only deletes the selected memory |

## apps/web/src/message-state.test.ts

| 声明 | 用例 |
|---|---|
| [it:42](../../apps/web/src/message-state.test.ts#L42) | message view boundaries → cannot retain old body content after the authorization generation changes |
| [it:51](../../apps/web/src/message-state.test.ts#L51) | message view boundaries → never merges an account, tenant or scope into another view |
| [it:69](../../apps/web/src/message-state.test.ts#L69) | message view boundaries → a newer redaction revision wins even with a lower entity version |
| [it:85](../../apps/web/src/message-state.test.ts#L85) | message view boundaries → orders large sequence values without converting them to floating point |
| [it:93](../../apps/web/src/message-state.test.ts#L93) | message view boundaries → a successful concurrent send survives an earlier polling snapshot |
| [it:109](../../apps/web/src/message-state.test.ts#L109) | message view boundaries → response-loss retry and late network failure cannot create duplicate bubbles |
| [it:134](../../apps/web/src/message-state.test.ts#L134) | Chinese composition and Enter shortcuts → does not send when any IME composition signal is active |
| [it:143](../../apps/web/src/message-state.test.ts#L143) | Chinese composition and Enter shortcuts → preserves Shift+Enter and sends only a normal Enter |

## apps/web/src/messages/message-interactions.test.tsx

| 声明 | 用例 |
|---|---|
| [it:5](../../apps/web/src/messages/message-interactions.test.tsx#L5) | fixed message references → never renders an unavailable source body even if a malformed response still includes it |
| [it:20](../../apps/web/src/messages/message-interactions.test.tsx#L20) | fixed message references → renders visible fixed content as text, without activating markup |

## apps/web/src/notifications/notification-api.test.ts

| 声明 | 用例 |
|---|---|
| [it:4](../../apps/web/src/notifications/notification-api.test.ts#L4) | marks only the displayed notification version as read with the authenticated tenant and CSRF token |
| [it:18](../../apps/web/src/notifications/notification-api.test.ts#L18) | rejects stale authority and malformed deep-link responses |

## apps/web/src/offline/offline-store.test.ts

| 声明 | 用例 |
|---|---|
| [it:84](../../apps/web/src/offline/offline-store.test.ts#L84) | IndexedDB queue authority and crash recovery → does not resurrect cached content or profile after local erasure races pending writes |
| [it:100](../../apps/web/src/offline/offline-store.test.ts#L100) | IndexedDB queue authority and crash recovery → requires both device consent and server policy and persists no credentials |
| [it:118](../../apps/web/src/offline/offline-store.test.ts#L118) | IndexedDB queue authority and crash recovery → serializes competing tab claims and reclaims a crashed sender with the original key |
| [it:147](../../apps/web/src/offline/offline-store.test.ts#L147) | IndexedDB queue authority and crash recovery → isolates tenants and principals even when a caller supplies a real queued identifier |
| [it:158](../../apps/web/src/offline/offline-store.test.ts#L158) | IndexedDB queue authority and crash recovery → rejects changed commands and stops seven-day-old messages instead of creating fresh keys |
| [it:173](../../apps/web/src/offline/offline-store.test.ts#L173) | IndexedDB queue authority and crash recovery → redacts histories, drafts and unsent command content when the authorization generation changes |
| [it:189](../../apps/web/src/offline/offline-store.test.ts#L189) | IndexedDB queue authority and crash recovery → keeps uncertain delivery on the same key and reconciles a single remote effect |
| [it:213](../../apps/web/src/offline/offline-store.test.ts#L213) | IndexedDB queue authority and crash recovery → does not send when membership was revoked and removes local plaintext immediately |
| [it:235](../../apps/web/src/offline/offline-store.test.ts#L235) | IndexedDB queue authority and crash recovery → pauses on 401 and only resumes after the same authenticated principal returns |

## apps/web/src/read-state.test.ts

| 声明 | 用例 |
|---|---|
| [it:6](../../apps/web/src/read-state.test.ts#L6) | human read cursor → does not treat fetched or offscreen messages as read |
| [it:18](../../apps/web/src/read-state.test.ts#L18) | human read cursor → does not advance in a hidden tab or behind a dialog |
| [it:23](../../apps/web/src/read-state.test.ts#L23) | human read cursor → requires an actual visible part and preserves bigint message sequence precision |

## apps/web/src/recovery/recovery.test.ts

| 声明 | 用例 |
|---|---|
| [it:52](../../apps/web/src/recovery/recovery.test.ts#L52) | recovery review controls and transport → never offers orphan accounting for unknown, foreign, legacy or intact/conflicting records |
| [it:70](../../apps/web/src/recovery/recovery.test.ts#L70) | recovery review controls and transport → requires re-review if the independent log changes even before the database fence changes |
| [it:76](../../apps/web/src/recovery/recovery.test.ts#L76) | recovery review controls and transport → sends stable idempotency/version/tenant/CSRF bindings, while lookups accept no fabricated evidence |

## apps/web/src/resources/artifact-collaboration-api.test.ts

| 声明 | 用例 |
|---|---|
| [it:9](../../apps/web/src/resources/artifact-collaboration-api.test.ts#L9) | maps browser text selection to fixed Unicode character offsets without splitting a surrogate pair |
| [it:15](../../apps/web/src/resources/artifact-collaboration-api.test.ts#L15) | downloads only the share endpoint and validates length and immutable hash |

## apps/web/src/resources/resource-api.test.ts

| 声明 | 用例 |
|---|---|
| [it:19](../../apps/web/src/resources/resource-api.test.ts#L19) | browser private resources → allows only bounded text formats before requesting an upload |
| [it:27](../../apps/web/src/resources/resource-api.test.ts#L27) | browser private resources → direct upload omits session/tenant/CSRF credentials and lets the browser set signed byte length |
| [it:48](../../apps/web/src/resources/resource-api.test.ts#L48) | browser private resources → a lost completion response retries the same complete command without PUT or upload creation again |
| [it:76](../../apps/web/src/resources/resource-api.test.ts#L76) | browser private resources → downloads through the fixed gateway, verifies bytes and rejects tampered content |

## apps/web/src/resources/version-difference.test.ts

| 声明 | 用例 |
|---|---|
| [it:4](../../apps/web/src/resources/version-difference.test.ts#L4) | fixed version text comparison → keeps shared edges separate and preserves intervening unchanged lines |
| [it:22](../../apps/web/src/resources/version-difference.test.ts#L22) | fixed version text comparison → distinguishes empty content, line endings, trailing newline and BOM |
| [it:36](../../apps/web/src/resources/version-difference.test.ts#L36) | fixed version text comparison → bounds previews by Unicode characters without splitting surrogate pairs or claiming completeness |

## apps/web/src/session-sync.test.ts

| 声明 | 用例 |
|---|---|
| [it:5](../../apps/web/src/session-sync.test.ts#L5) | cross-tab session ownership → ignores its own publication even after BroadcastChannel structured cloning |
| [it:11](../../apps/web/src/session-sync.test.ts#L11) | cross-tab session ownership → invalidates other tabs on the same login or logout publication |
| [it:16](../../apps/web/src/session-sync.test.ts#L16) | cross-tab session ownership → ignores notifications without a valid session type and source ownership |

## apps/web/src/tasks/task-api.test.ts

| 声明 | 用例 |
|---|---|
| [it:5](../../apps/web/src/tasks/task-api.test.ts#L5) | promotes with fresh explicit task input and never copies run output into the command |
| [it:39](../../apps/web/src/tasks/task-api.test.ts#L39) | takes over from escalation metadata without first reading private task content |

## apps/web/src/tasks/task-state.test.ts

| 声明 | 用例 |
|---|---|
| [it:5](../../apps/web/src/tasks/task-state.test.ts#L5) | task command boundaries → does not lose precision when converting money across the safe-number boundary |
| [it:14](../../apps/web/src/tasks/task-state.test.ts#L14) | task command boundaries → retries the same terms/version under the same key and changes it on deliberate rebase |
| [it:20](../../apps/web/src/tasks/task-state.test.ts#L20) | task command boundaries → requires explicit nonempty acceptance criteria and bounds their count |

## apps/worker/src/notification-loop.test.ts

| 声明 | 用例 |
|---|---|
| [it:5](../../apps/worker/src/notification-loop.test.ts#L5) | notification dispatcher pacing → visits every tenant before draining another full batch and waits only once idle |
| [it:30](../../apps/worker/src/notification-loop.test.ts#L30) | notification dispatcher pacing → backs off a failed round while still giving another tenant its bounded batch |
| [it:53](../../apps/worker/src/notification-loop.test.ts#L53) | notification dispatcher pacing → stops at the in-flight batch boundary without scheduling another tenant or cleanup |

## packages/actions/src/journal.test.ts

| 声明 | 用例 |
|---|---|
| [it:41](../../packages/actions/src/journal.test.ts#L41) | independently durable immutable journal → publishes complete files so simultaneous retries all observe the same signed fact |
| [it:53](../../packages/actions/src/journal.test.ts#L53) | independently durable immutable journal → rejects changing an existing intent while preserving its original contents |
| [it:62](../../packages/actions/src/journal.test.ts#L62) | independently durable immutable journal → ignores an unpublished crash temporary but never overwrites a corrupt published fact |
| [it:75](../../packages/actions/src/journal.test.ts#L75) | independently durable immutable journal → detects tampering and refuses writable tenant directories or symlink records |
| [it:94](../../packages/actions/src/journal.test.ts#L94) | independently durable immutable journal → retains a recovery freeze across journal process recreation |
| [it:104](../../packages/actions/src/journal.test.ts#L104) | independently durable immutable journal → a signed unfreeze covers exactly the observed freeze set; a new freeze invalidates it |

## packages/actions/src/recovery-tools.test.ts

| 声明 | 用例 |
|---|---|
| [it:6](../../packages/actions/src/recovery-tools.test.ts#L6) | bound recovery HTTP lookup → uses only GET and binds provider evidence to tenant/action/attempt/fingerprint |
| [it:60](../../packages/actions/src/recovery-tools.test.ts#L60) | bound recovery HTTP lookup → preserves unknown for not_found, absent binding and an out-of-range amount |

## packages/application/src/policy-ledger.test.ts

| 声明 | 用例 |
|---|---|
| [it:33](../../packages/application/src/policy-ledger.test.ts#L33) | independent signed policy ledger → publishes one immutable complete fact under concurrent retries and reopens it |
| [it:43](../../packages/application/src/policy-ledger.test.ts#L43) | independent signed policy ledger → rejects tampering, malformed metadata, and a changed signing key |
| [it:61](../../packages/application/src/policy-ledger.test.ts#L61) | independent signed policy ledger → rejects writable directories and symlinked records |

## packages/application/test/cursor.test.ts

| 声明 | 用例 |
|---|---|
| [it:6](../../packages/application/test/cursor.test.ts#L6) | opaque, authenticated cursor boundaries → round trips exact bigint positions without exposing position or authorization binding |
| [it:15](../../packages/application/test/cursor.test.ts#L15) | opaque, authenticated cursor boundaries → rejects user/scope/generation changes, corruption and a different server secret |

## packages/auth/test/auth.integration.test.ts

| 声明 | 用例 |
|---|---|
| [it:118](../../packages/auth/test/auth.integration.test.ts#L118) | Opaque browser sessions with real database roles → identity and application roles cannot access each other’s private data |
| [it:136](../../packages/auth/test/auth.integration.test.ts#L136) | Opaque browser sessions with real database roles → persists only token digests, uses an opaque secure cookie, and returns authorized me data |
| [it:174](../../packages/auth/test/auth.integration.test.ts#L174) | Opaque browser sessions with real database roles → requires both the exact origin and matching CSRF token for unsafe methods |
| [it:201](../../packages/auth/test/auth.integration.test.ts#L201) | Opaque browser sessions with real database roles → rejects unjoined tenants, revoked membership and suspended tenants on every request |
| [it:247](../../packages/auth/test/auth.integration.test.ts#L247) | Opaque browser sessions with real database roles → rotates sessions on login and enforces expiry, logout and global principal disable |
| [it:291](../../packages/auth/test/auth.integration.test.ts#L291) | Opaque browser sessions with real database roles → allows only own session inspection/revocation and does not expose hashes |
| [it:307](../../packages/auth/test/auth.integration.test.ts#L307) | Opaque browser sessions with real database roles → development login is closed by default, denies nonallowlisted identities and is forbidden in production |
| [it:345](../../packages/auth/test/auth.integration.test.ts#L345) | OIDC authorization code flow over real HTTP → sets a bound login cookie and rotates to a session through the actual callback route |
| [it:390](../../packages/auth/test/auth.integration.test.ts#L390) | OIDC authorization code flow over real HTTP → validates PKCE/state/nonce and JWT signature, maps issuer+subject, and consumes attempt exactly once |
| [it:415](../../packages/auth/test/auth.integration.test.ts#L415) | OIDC authorization code flow over real HTTP → rejects incorrect state, wrong browser binding, wrong callback URL and expired attempts before token exchange |
| [it.each:442](../../packages/auth/test/auth.integration.test.ts#L442) | OIDC authorization code flow over real HTTP → rejects invalid token %s |
| [it:453](../../packages/auth/test/auth.integration.test.ts#L453) | OIDC authorization code flow over real HTTP → rejects open redirects and concurrent callback replay |

## packages/contracts/test/contracts.test.ts

| 声明 | 用例 |
|---|---|
| [it.each:49](../../packages/contracts/test/contracts.test.ts#L49) | lossless wire values → accepts version %s without numeric coercion |
| [it.each:57](../../packages/contracts/test/contracts.test.ts#L57) | lossless wire values → rejects noncanonical/overflow version %s |
| [it:74](../../packages/contracts/test/contracts.test.ts#L74) | lossless wire values → handles zero only for counters and keeps bigint JSON numeric values invalid |
| [it:81](../../packages/contracts/test/contracts.test.ts#L81) | lossless wire values → validates real UTC calendar dates rather than accepting offsets or invalid dates |
| [it:88](../../packages/contracts/test/contracts.test.ts#L88) | lossless wire values → uses UUIDs and rejects illustrative prefixed documentation IDs |
| [it:96](../../packages/contracts/test/contracts.test.ts#L96) | authenticated command boundaries → accepts a message without accepting any caller-selected actor or role |
| [it:104](../../packages/contracts/test/contracts.test.ts#L104) | authenticated command boundaries → does not coerce, strip unknown keys, or inject defaults |
| [it:113](../../packages/contracts/test/contracts.test.ts#L113) | authenticated command boundaries → bounds arrays and prevents duplicate conversation members/attachments |
| [it:129](../../packages/contracts/test/contracts.test.ts#L129) | authenticated command boundaries → requires handoff/approval versions and rejects forged deciders |
| [it:140](../../packages/contracts/test/contracts.test.ts#L140) | bounded JSON parsing → enforces UTF-8 bytes before parsing and bounds strings afterwards |
| [it:149](../../packages/contracts/test/contracts.test.ts#L149) | bounded JSON parsing → rejects deeply nested structures before schema evaluation |
| [it:157](../../packages/contracts/test/contracts.test.ts#L157) | bounded JSON parsing → rejects cyclic values, functions, non-finite numbers and dangerous accessors |
| [it:170](../../packages/contracts/test/contracts.test.ts#L170) | bounded JSON parsing → does not report shared ordinary JSON subobjects as cycles |
| [it:185](../../packages/contracts/test/contracts.test.ts#L185) | bounded JSON parsing → returns safe schema errors without embedding rejected payload values |
| [it:197](../../packages/contracts/test/contracts.test.ts#L197) | DTO and WebSocket distinctions → requires the session/CSRF restoration context and uses the human principal kind |
| [it:224](../../packages/contracts/test/contracts.test.ts#L224) | DTO and WebSocket distinctions → bounds member roles, reactions and lossless read cursors |
| [it:245](../../packages/contracts/test/contracts.test.ts#L245) | DTO and WebSocket distinctions → preserves lossless entity and independent projection versions |
| [it:253](../../packages/contracts/test/contracts.test.ts#L253) | DTO and WebSocket distinctions → keeps transport ACK separate from task acceptance |
| [it:267](../../packages/contracts/test/contracts.test.ts#L267) | DTO and WebSocket distinctions → accepts a bounded projection summary but not unversioned or arbitrary payloads |
| [it:287](../../packages/contracts/test/contracts.test.ts#L287) | DTO and WebSocket distinctions → accepts materialized snapshot content and preserves opaque empty-page progress |
| [it:324](../../packages/contracts/test/contracts.test.ts#L324) | DTO and WebSocket distinctions → does not apply the request-byte cap to bounded message pages |
| [it:333](../../packages/contracts/test/contracts.test.ts#L333) | schema/OpenAPI generation foundation → publishes self-contained schemas with stable IDs and a 2020-12 dialect |
| [it:364](../../packages/contracts/test/contracts.test.ts#L364) | schema/OpenAPI generation foundation → generates OpenAPI 3.1.1 distinguishing implemented and modeled route contracts |
| [it:397](../../packages/contracts/test/contracts.test.ts#L397) | schema/OpenAPI generation foundation → requires the headers enforced by member mutations and models no-content auth results |
| [it:414](../../packages/contracts/test/contracts.test.ts#L414) | schema/OpenAPI generation foundation → catches deleted components, broken references and duplicate operation IDs |
| [it:440](../../packages/contracts/test/contracts.test.ts#L440) | M2 explicit work commands and disclosure boundaries → does not permit callers to set owner, actor, execution epoch, or numeric budgets |
| [it:453](../../packages/contracts/test/contracts.test.ts#L453) | M2 explicit work commands and disclosure boundaries → pins evidence identity and rejects ambiguous artifact references and decision impersonation |
| [it:478](../../packages/contracts/test/contracts.test.ts#L478) | M2 explicit work commands and disclosure boundaries → does not silently authorize external tools through a work proposal |
| [it:502](../../packages/contracts/test/contracts.test.ts#L502) | bounds handoff manifests, rejects duplicates and preserves opaque references |

## packages/db/test/postgres.integration.test.ts

| 声明 | 用例 |
|---|---|
| [it:158](../../packages/db/test/postgres.integration.test.ts#L158) | PostgreSQL isolation and persistence invariants → runs migrations idempotently and forces RLS on every tenant table |
| [it:192](../../packages/db/test/postgres.integration.test.ts#L192) | PostgreSQL isolation and persistence invariants → fails closed without tenant context and never grants credential reads to application role |
| [it:211](../../packages/db/test/postgres.integration.test.ts#L211) | PostgreSQL isolation and persistence invariants → resets transaction-local tenant context on a reused pool connection after commit and rollback |
| [it:237](../../packages/db/test/postgres.integration.test.ts#L237) | PostgreSQL isolation and persistence invariants → rejects cross-tenant writes and composite FK references even when UUIDs are known |
| [it:277](../../packages/db/test/postgres.integration.test.ts#L277) | PostgreSQL isolation and persistence invariants → keeps stream sequence allocation in commit order when the first transaction stalls |
| [it:318](../../packages/db/test/postgres.integration.test.ts#L318) | PostgreSQL isolation and persistence invariants → rolls back sequence reservations and preserves bigint precision |
| [it:344](../../packages/db/test/postgres.integration.test.ts#L344) | PostgreSQL isolation and persistence invariants → atomically rolls back business mutation, domain event, and outbox intent |
| [it:400](../../packages/db/test/postgres.integration.test.ts#L400) | PostgreSQL isolation and persistence invariants → enforces root ancestry and prevents moving a task tree after creation |

## packages/domain/tests/action.test.ts

| 声明 | 用例 |
|---|---|
| [it:29](../../packages/domain/tests/action.test.ts#L29) | action and attempt separation → an action awaiting approval cannot be dispatched |
| [it:41](../../packages/domain/tests/action.test.ts#L41) | action and attempt separation → unknown outcomes never enter the ordinary retry path and cannot be cancelled away |
| [it:76](../../packages/domain/tests/action.test.ts#L76) | action and attempt separation → a safe retry preserves business identity, respects delay, and creates a fresh attempt |
| [it:123](../../packages/domain/tests/action.test.ts#L123) | action and attempt separation → partial effects and revoked authority prohibit ordinary retries |
| [it:154](../../packages/domain/tests/action.test.ts#L154) | action and attempt separation → a receipt for another action or old attempt cannot settle the current action |

## packages/domain/tests/budget-and-dependency.test.ts

| 声明 | 用例 |
|---|---|
| [it:23](../../packages/domain/tests/budget-and-dependency.test.ts#L23) | hierarchical budget ledger → siblings share root capacity instead of each receiving the whole allowance |
| [it:43](../../packages/domain/tests/budget-and-dependency.test.ts#L43) | hierarchical budget ledger → enforces narrower child limits even when the root has funds |
| [it:58](../../packages/domain/tests/budget-and-dependency.test.ts#L58) | hierarchical budget ledger → retains unknown cost reservations independently of worker lifetime |
| [it:85](../../packages/domain/tests/budget-and-dependency.test.ts#L85) | hierarchical budget ledger → records real over-estimate charges and blocks new work without inventing a hard cap |
| [it:112](../../packages/domain/tests/budget-and-dependency.test.ts#L112) | hierarchical budget ledger → same keys are idempotent but cannot acquire different business meanings |
| [it:139](../../packages/domain/tests/budget-and-dependency.test.ts#L139) | hierarchical budget ledger → preserves exact bigint costs beyond JavaScript number precision |
| [it:155](../../packages/domain/tests/budget-and-dependency.test.ts#L155) | hierarchical budget ledger → reservations and unique settlements conserve the root ledger under repetition |
| [it:201](../../packages/domain/tests/budget-and-dependency.test.ts#L201) | task dependency graph → detects a cross-root cycle closed by previously disjoint edges |
| [it:213](../../packages/domain/tests/budget-and-dependency.test.ts#L213) | task dependency graph → handles duplicate edges, self-loops and long chains without recursion |
| [it:224](../../packages/domain/tests/budget-and-dependency.test.ts#L224) | task dependency graph → arbitrary ordered DAG edges remain acyclic; adding the reverse of an edge closes a cycle |

## packages/domain/tests/lease-and-request.test.ts

| 声明 | 用例 |
|---|---|
| [it:14](../../packages/domain/tests/lease-and-request.test.ts#L14) | execution leases → rejects an expired worker before another worker has claimed its lease |
| [it:31](../../packages/domain/tests/lease-and-request.test.ts#L31) | execution leases → requires matching run, holder and generation independently |
| [it:48](../../packages/domain/tests/lease-and-request.test.ts#L48) | execution leases → expiry is a strict boundary for every generated lease |
| [it:88](../../packages/domain/tests/lease-and-request.test.ts#L88) | collaboration requests → accepted proposal versions are fixed and accepted facts cannot be withdrawn |
| [it:120](../../packages/domain/tests/lease-and-request.test.ts#L120) | collaboration requests → cannot accept an expired request even before the expiry worker runs |
| [it:138](../../packages/domain/tests/lease-and-request.test.ts#L138) | collaboration requests → clarification does not itself become acceptance |

## packages/domain/tests/task-and-run.test.ts

| 声明 | 用例 |
|---|---|
| [it:30](../../packages/domain/tests/task-and-run.test.ts#L30) | task responsibility and fencing → handoff changes exactly one owner and preserves the accountable principal |
| [it:60](../../packages/domain/tests/task-and-run.test.ts#L60) | task responsibility and fencing → completion requires independent acceptance, closed required work and evidence |
| [it:104](../../packages/domain/tests/task-and-run.test.ts#L104) | task responsibility and fencing → block/resume restores the recorded state and never changes ownership |
| [it:115](../../packages/domain/tests/task-and-run.test.ts#L115) | task responsibility and fencing → ancestor cancellation blocks a child before child state propagation |
| [it:141](../../packages/domain/tests/task-and-run.test.ts#L141) | task responsibility and fencing → every cancellation/reopen cycle permanently fences all previous generations |
| [it:171](../../packages/domain/tests/task-and-run.test.ts#L171) | run lifecycle → a lightweight reply needs no task, while persistent actions do |
| [it:193](../../packages/domain/tests/task-and-run.test.ts#L193) | run lifecycle → a finished run cannot be resumed, even when its task is reopened |
| [it:204](../../packages/domain/tests/task-and-run.test.ts#L204) | run lifecycle → waiting, paused and cancelling runs can expire without losing cancellation intent |
| [it:224](../../packages/domain/tests/task-and-run.test.ts#L224) | run lifecycle → cancelled requires platform execution revocation and registration of unresolved actions |
| [it:242](../../packages/domain/tests/task-and-run.test.ts#L242) | run lifecycle → pause is only confirmed at a safe checkpoint |
| [it:253](../../packages/domain/tests/task-and-run.test.ts#L253) | run lifecycle → errors retain machine-readable code/status and safe explicit details |

## packages/notifications/src/push-transport.test.ts

| 声明 | 用例 |
|---|---|
| [it.each:39](../../packages/notifications/src/push-transport.test.ts#L39) | classifies provider HTTP %s without redirect or response-body processing |
| [it:86](../../packages/notifications/src/push-transport.test.ts#L86) | blocks mixed private DNS answers and revoked authority before starting HTTP |

## packages/notifications/src/push.test.ts

| 声明 | 用例 |
|---|---|
| [it:19](../../packages/notifications/src/push.test.ts#L19) | Web Push subscription secrecy and endpoint policy → encrypts at rest with randomized ciphertext and authenticates the complete device binding |
| [it:31](../../packages/notifications/src/push.test.ts#L31) | Web Push subscription secrecy and endpoint policy → rejects unsafe endpoint forms and non-public DNS results |
| [it:59](../../packages/notifications/src/push.test.ts#L59) | Web Push subscription secrecy and endpoint policy → requires complete configuration and generates encrypted VAPID protocol requests without disclosing plaintext |

## packages/notifications/src/time.test.ts

| 声明 | 用例 |
|---|---|
| [it:4](../../packages/notifications/src/time.test.ts#L4) | IANA do-not-disturb wall clock windows → covers both fall-back hours and skips nonexistent spring wall times |
| [it:11](../../packages/notifications/src/time.test.ts#L11) | IANA do-not-disturb wall clock windows → defines overnight, end-exclusive, all-day and disabled windows |
| [it:18](../../packages/notifications/src/time.test.ts#L18) | IANA do-not-disturb wall clock windows → rejects unknown zones and malformed clocks |

## packages/scheduling/src/calendar.test.ts

| 声明 | 用例 |
|---|---|
| [it:11](../../packages/scheduling/src/calendar.test.ts#L11) | IANA daily calendar → skips the New York spring gap and selects only the first fall-fold instant |
| [it:26](../../packages/scheduling/src/calendar.test.ts#L26) | IANA daily calendar → handles half-hour DST and a skipped civil date without coercing nonexistent wall times |
| [it:33](../../packages/scheduling/src/calendar.test.ts#L33) | IANA daily calendar → coalesces several due days once, while skip advances the persisted cursor without catch-up |
| [it:53](../../packages/scheduling/src/calendar.test.ts#L53) | IANA daily calendar → uses inclusive start and an exclusive absolute deadline for one-off and daily schedules |
| [it:71](../../packages/scheduling/src/calendar.test.ts#L71) | IANA daily calendar → rejects numeric offsets and invalid zones or local times |

## tests/compatibility/historical-web.spec.ts

| 声明 | 用例 |
|---|---|
| [test:30](../../tests/compatibility/historical-web.spec.ts#L30) | historical compiled client and current client exchange live messages and safely render future display events |
| [test:130](../../tests/compatibility/historical-web.spec.ts#L130) | historical and current clients keep their sessions and messages across API cutover and rollback |

## tests/deployment/containers.test.ts

| 声明 | 用例 |
|---|---|
| [it:204](../../tests/deployment/containers.test.ts#L204) | runs the pinned production dependency tree as a non-root user on a read-only root filesystem |
| [it:244](../../tests/deployment/containers.test.ts#L244) | serves the production SPA over TLS, preserves cache policy and keeps API and dev login outside the SPA fallback |
| [it:268](../../tests/deployment/containers.test.ts#L268) | carries authenticated commands and WebSockets through TLS and lets the container worker commit the message projection |

## tests/e2e/agent-management.spec.ts

| 声明 | 用例 |
|---|---|
| [test:2](../../tests/e2e/agent-management.spec.ts#L2) | administrator registers an external Agent, issues a one-time credential, revokes it after reload and disables the installation |

## tests/e2e/governance.spec.ts

| 声明 | 用例 |
|---|---|
| [test:11](../../tests/e2e/governance.spec.ts#L11) | exports only the selected live scope, verifies a complete file, and shows deployed privacy policy |

## tests/e2e/invitations.spec.ts

| 声明 | 用例 |
|---|---|
| [test:8](../../tests/e2e/invitations.spec.ts#L8) | a logged-in unjoined person uses their own account identity to accept a bound invitation; owners can revoke unused codes |

## tests/e2e/knowledge.spec.ts

| 声明 | 用例 |
|---|---|
| [test:156](../../tests/e2e/knowledge.spec.ts#L156) | search excludes private content and explicit memory supports human confirmation, conflict, disable and deletion |
| [test:228](../../tests/e2e/knowledge.spec.ts#L228) | source membership revocation clears personal derived memory, visible details and an open editing draft |

## tests/e2e/message-interactions.spec.ts

| 声明 | 用例 |
|---|---|
| [test:19](../../tests/e2e/message-interactions.spec.ts#L19) | human replies bind fixed text, thread replies share the root, and reaction removal affects only oneself |

## tests/e2e/messaging.spec.ts

| 声明 | 用例 |
|---|---|
| [test:23](../../tests/e2e/messaging.spec.ts#L23) | two people exchange messages, see edits/retractions, and never execute message markup |
| [test:71](../../tests/e2e/messaging.spec.ts#L71) | a lost POST response reconciles to one persisted message and mobile layout remains usable |
| [test:112](../../tests/e2e/messaging.spec.ts#L112) | the current client safely displays an unfamiliar projection notice and continues normal messaging |

## tests/e2e/notifications.spec.ts

| 声明 | 用例 |
|---|---|
| [test:9](../../tests/e2e/notifications.spec.ts#L9) | opens a notification under current authority, marks it read, and saves reminder preferences |

## tests/e2e/offline.spec.ts

| 声明 | 用例 |
|---|---|
| [test:2](../../tests/e2e/offline.spec.ts#L2) | explicit device consent queues a message while offline, sends once after reauthorization and erases local data on logout |

## tests/e2e/organization.spec.ts

| 声明 | 用例 |
|---|---|
| [test:27](../../tests/e2e/organization.spec.ts#L27) | organization owner creates a workspace and explicitly adds, disables and restores an existing member |
| [test:88](../../tests/e2e/organization.spec.ts#L88) | ordinary human sees the organization management boundary |
| [test:98](../../tests/e2e/organization.spec.ts#L98) | organization owner changes tenant roles, disables and restores a person while the last owner stays protected |

## tests/e2e/pwa.spec.ts

| 声明 | 用例 |
|---|---|
| [test:20](../../tests/e2e/pwa.spec.ts#L20) | production shell reloads offline and CacheStorage never contains API or cached message bodies |

## tests/e2e/recent-history.spec.ts

| 声明 | 用例 |
|---|---|
| [test:13](../../tests/e2e/recent-history.spec.ts#L13) | loads older messages beyond the bounded recent snapshot and resolves a deep link outside that window |

## tests/e2e/resources.spec.ts

| 声明 | 用例 |
|---|---|
| [test:186](../../tests/e2e/resources.spec.ts#L186) | real browser S3 upload creates immutable versions and submits the selected version as task evidence |
| [test:285](../../tests/e2e/resources.spec.ts#L285) | conversation attachments publish after verification and deletion removes the usable attachment |
| [test:341](../../tests/e2e/resources.spec.ts#L341) | fixed-version comments anchor selected Unicode text and a controlled share grants only its download until revoked |
| [test:419](../../tests/e2e/resources.spec.ts#L419) | task contributor appends an Artifact version and loses the edit entry after demotion |

## tests/e2e/runtime-actions.spec.ts

| 声明 | 用例 |
|---|---|
| [test:364](../../tests/e2e/runtime-actions.spec.ts#L364) | runtime UI discloses fixed context and budget, controls real runs, and restores scoped history |
| [test:398](../../tests/e2e/runtime-actions.spec.ts#L398) | runtime UI shows worker stop confirmation separately from the cancellation request |
| [test:433](../../tests/e2e/runtime-actions.spec.ts#L433) | task cancellation signals the running worker and displays its later stop acknowledgement |
| [test:474](../../tests/e2e/runtime-actions.spec.ts#L474) | grant → proposal → exact human approval → lost response → lookup has one external effect |
| [test:541](../../tests/e2e/runtime-actions.spec.ts#L541) | fixed artifact selection → new head → original approved publication → receipt lookup without resending |
| [test:630](../../tests/e2e/runtime-actions.spec.ts#L630) | a revoked source removes previously visible run context from the browser |
| [test:651](../../tests/e2e/runtime-actions.spec.ts#L651) | Run-bound tool UI requires human approval and explicit resume, reconciles one unknown effect, then only summarizes |
| [test:732](../../tests/e2e/runtime-actions.spec.ts#L732) | artifact Run UI discloses fixed text, requires approval and resume, and reconciles once |
| [test:823](../../tests/e2e/runtime-actions.spec.ts#L823) | handoff UI requires explicit disclosure of the outstanding action manifest |
| [test:902](../../tests/e2e/runtime-actions.spec.ts#L902) | recovery UI freezes, verifies an orphan through read-only provider evidence, accounts once and explicitly unfreezes |

## tests/e2e/scheduling-promotion.spec.ts

| 声明 | 用例 |
|---|---|
| [test:114](../../tests/e2e/scheduling-promotion.spec.ts#L114) | finite wakeup UI creates, revises and disables a plan without resetting or resuming the original run |
| [test:215](../../tests/e2e/scheduling-promotion.spec.ts#L215) | conversation run promotion requires a new goal and explicit authorization; revoked origin disappears |
| [test:276](../../tests/e2e/scheduling-promotion.spec.ts#L276) | administrator sees escalation metadata only until explicitly taking responsibility for the private task |

## tests/e2e/tasks.spec.ts

| 声明 | 用例 |
|---|---|
| [test:24](../../tests/e2e/tasks.spec.ts#L24) | a human explicitly submits fixed evidence and separately accepts it before a task completes |
| [test:45](../../tests/e2e/tasks.spec.ts#L45) | reading a handoff proposal does not change ownership; explicit acceptance changes both views |
| [test:99](../../tests/e2e/tasks.spec.ts#L99) | a rejected delegation leaves the parent owned and lets its owner delegate to another person |
| [test:204](../../tests/e2e/tasks.spec.ts#L204) | creating a task retains its selection across an older list response and a page reload |

## tests/integration/action-journal.test.ts

| 声明 | 用例 |
|---|---|
| [it:127](../../tests/integration/action-journal.test.ts#L127) | intent retry and restore fencing with real PostgreSQL and signed files → retries a durable intent after its acknowledgement is lost without changing its timestamp |
| [it:166](../../tests/integration/action-journal.test.ts#L166) | intent retry and restore fencing with real PostgreSQL and signed files → rejects an expired claimant before writing any independent intent |
| [it:177](../../tests/integration/action-journal.test.ts#L177) | intent retry and restore fencing with real PostgreSQL and signed files → opens a restore case for a terminal attempt with the wrong lease generation |
| [it:202](../../tests/integration/action-journal.test.ts#L202) | intent retry and restore fencing with real PostgreSQL and signed files → does not accept a terminal attempt attached to another action as a recovered match |

## tests/integration/action-recovery.test.ts

| 声明 | 用例 |
|---|---|
| [it.each:240](../../tests/integration/action-recovery.test.ts#L240) | orphan intent accounting and explicit safe unfreeze → keeps orphan recovery frozen without the original connector binding: %s |
| [it:290](../../tests/integration/action-recovery.test.ts#L290) | orphan intent accounting and explicit safe unfreeze → accepts a bound terminal no-effect receipt without charging or retrying the old business action |
| [it:323](../../tests/integration/action-recovery.test.ts#L323) | orphan intent accounting and explicit safe unfreeze → compensates every original ancestor budget exactly once for a restored child task |
| [it:389](../../tests/integration/action-recovery.test.ts#L389) | orphan intent accounting and explicit safe unfreeze → performs read-only provider reconciliation, charges once, preserves old keys and explicitly unfreezes |
| [it:444](../../tests/integration/action-recovery.test.ts#L444) | orphan intent accounting and explicit safe unfreeze → does not turn missing or incorrectly bound provider evidence into zero cost or permission to unfreeze |
| [it:469](../../tests/integration/action-recovery.test.ts#L469) | orphan intent accounting and explicit safe unfreeze → retains the freeze when a signed intent lacks legacy version/budget bindings or its account is missing |
| [it:511](../../tests/integration/action-recovery.test.ts#L511) | orphan intent accounting and explicit safe unfreeze → retries lost independent unfreeze acknowledgements without repeating accounting or external sends |
| [it:544](../../tests/integration/action-recovery.test.ts#L544) | orphan intent accounting and explicit safe unfreeze → requires a fresh human confirmation after a newer freeze and detects conflicting late durable receipts |
| [it:583](../../tests/integration/action-recovery.test.ts#L583) | orphan intent accounting and explicit safe unfreeze → does not reuse a provider receipt across orphan actions and keeps the second charge unresolved |
| [it:617](../../tests/integration/action-recovery.test.ts#L617) | orphan intent accounting and explicit safe unfreeze → requires a current human tenant admin and does not expose another tenant recovery case |
| [it:634](../../tests/integration/action-recovery.test.ts#L634) | orphan intent accounting and explicit safe unfreeze → exposes explicit HTTP review without accepting caller-supplied provider evidence |

## tests/integration/actions.test.ts

| 声明 | 用例 |
|---|---|
| [it.each:341](../../tests/integration/actions.test.ts#L341) | controlled actions with real PostgreSQL, HTTP and independent signed journal → rejects an artifact reference with an incorrect %s before issuing authority |
| [it:360](../../tests/integration/actions.test.ts#L360) | controlled actions with real PostgreSQL, HTTP and independent signed journal → rejects cross-task publication even when issuer and executor can read both tasks |
| [it.each:388](../../tests/integration/actions.test.ts#L388) | controlled actions with real PostgreSQL, HTTP and independent signed journal → rejects artifact delivery when the executor is removed %s |
| [it.each:418](../../tests/integration/actions.test.ts#L418) | controlled actions with real PostgreSQL, HTTP and independent signed journal → rejects an existing grant after connector %s changes without changing logical IDs |
| [it:442](../../tests/integration/actions.test.ts#L442) | controlled actions with real PostgreSQL, HTTP and independent signed journal → rechecks connector binding after durable intent and rejects unbound legacy authority |
| [it:476](../../tests/integration/actions.test.ts#L476) | controlled actions with real PostgreSQL, HTTP and independent signed journal → keeps unknown effects unresolved until the original connector binding is restored |
| [it:507](../../tests/integration/actions.test.ts#L507) | controlled actions with real PostgreSQL, HTTP and independent signed journal → rejects legacy grant insertion at commit without inventing a historical connector binding |
| [it.each:520](../../tests/integration/actions.test.ts#L520) | controlled actions with real PostgreSQL, HTTP and independent signed journal → database fences a legacy worker using unbound authority: %s |
| [it:561](../../tests/integration/actions.test.ts#L561) | controlled actions with real PostgreSQL, HTTP and independent signed journal → rejects oversized publication previews without returning truncated content |
| [it:584](../../tests/integration/actions.test.ts#L584) | controlled actions with real PostgreSQL, HTTP and independent signed journal → publishes the approved immutable artifact despite a new head and requires new authority for the new version |
| [it:636](../../tests/integration/actions.test.ts#L636) | controlled actions with real PostgreSQL, HTTP and independent signed journal → requires a fresh approval when revising to another explicitly granted artifact version |
| [it.each:699](../../tests/integration/actions.test.ts#L699) | controlled actions with real PostgreSQL, HTTP and independent signed journal → blocks deleted artifact disclosure %s and hides retained action text |
| [it:724](../../tests/integration/actions.test.ts#L724) | controlled actions with real PostgreSQL, HTTP and independent signed journal → reconciles an unknown artifact publication after source deletion without revealing or resending its body |
| [it:747](../../tests/integration/actions.test.ts#L747) | controlled actions with real PostgreSQL, HTTP and independent signed journal → cancels pending task actions and revokes approvals while preserving unknown effects |
| [it:773](../../tests/integration/actions.test.ts#L773) | controlled actions with real PostgreSQL, HTTP and independent signed journal → requires explicit approval, records durable intent before the effect, and settles once |
| [it:803](../../tests/integration/actions.test.ts#L803) | controlled actions with real PostgreSQL, HTTP and independent signed journal → retains an unknown result after response loss, queries it, and never resends the business action |
| [it:847](../../tests/integration/actions.test.ts#L847) | controlled actions with real PostgreSQL, HTTP and independent signed journal → discloses only explicit same-task action references and rejects omitted or foreign references |
| [it:904](../../tests/integration/actions.test.ts#L904) | controlled actions with real PostgreSQL, HTTP and independent signed journal → refuses oversized outstanding manifests instead of silently dropping action references |
| [it:938](../../tests/integration/actions.test.ts#L938) | controlled actions with real PostgreSQL, HTTP and independent signed journal → requires renewed agreement for actions added after a handoff offer and permits already completed references |
| [it:998](../../tests/integration/actions.test.ts#L998) | controlled actions with real PostgreSQL, HTTP and independent signed journal → serializes accepting a handoff against creating newly undisclosed work |
| [it:1021](../../tests/integration/actions.test.ts#L1021) | controlled actions with real PostgreSQL, HTTP and independent signed journal → fences a prepared dispatch after real handoff and releases its unused reservation |
| [it:1047](../../tests/integration/actions.test.ts#L1047) | controlled actions with real PostgreSQL, HTTP and independent signed journal → hands off during a committed external effect and lets the new owner reconcile without resending |
| [it:1096](../../tests/integration/actions.test.ts#L1096) | controlled actions with real PostgreSQL, HTTP and independent signed journal → retries confirmed no-effect attempts under the same action, fingerprint and business key |
| [it:1114](../../tests/integration/actions.test.ts#L1114) | controlled actions with real PostgreSQL, HTTP and independent signed journal → invalidates old approval after changing parameters and refuses revoked grants before effects |
| [it.each:1132](../../tests/integration/actions.test.ts#L1132) | controlled actions with real PostgreSQL, HTTP and independent signed journal → revokes a fixed artifact grant %s without sending or charging |
| [it:1161](../../tests/integration/actions.test.ts#L1161) | controlled actions with real PostgreSQL, HTTP and independent signed journal → preserves and reconciles a committed effect when its grant is revoked before the response |
| [it:1206](../../tests/integration/actions.test.ts#L1206) | controlled actions with real PostgreSQL, HTTP and independent signed journal → rejects an approved stale task version before claim and permits newly authorized work |
| [it:1232](../../tests/integration/actions.test.ts#L1232) | controlled actions with real PostgreSQL, HTTP and independent signed journal → rechecks the task version after durable intent and releases an unsent reservation |
| [it:1261](../../tests/integration/actions.test.ts#L1261) | controlled actions with real PostgreSQL, HTTP and independent signed journal → rejects expired leases even before takeover and retains unresolved attempts |
| [it:1276](../../tests/integration/actions.test.ts#L1276) | controlled actions with real PostgreSQL, HTTP and independent signed journal → does not revive a grant or action when a disabled global identity is re-enabled |
| [it:1297](../../tests/integration/actions.test.ts#L1297) | controlled actions with real PostgreSQL, HTTP and independent signed journal → does not revive old authority after task membership removal/reinvitation or epoch changes |
| [it.each:1340](../../tests/integration/actions.test.ts#L1340) | controlled actions with real PostgreSQL, HTTP and independent signed journal → rejects stale independent approver authority %s / %s |
| [it.each:1401](../../tests/integration/actions.test.ts#L1401) | controlled actions with real PostgreSQL, HTTP and independent signed journal → rejects an expired %s at %s before network dispatch |
| [it:1432](../../tests/integration/actions.test.ts#L1432) | controlled actions with real PostgreSQL, HTTP and independent signed journal → deduplicates the same receipt and preserves a conflicting late receipt as an open case |
| [it:1456](../../tests/integration/actions.test.ts#L1456) | controlled actions with real PostgreSQL, HTTP and independent signed journal → enforces human HTTP approval contracts and never exposes internal execution/report capabilities |
| [it:1595](../../tests/integration/actions.test.ts#L1595) | controlled actions with real PostgreSQL, HTTP and independent signed journal → finds a whole action lost across a simulated database recovery and freezes new execution |

## tests/integration/agents.test.ts

| 声明 | 用例 |
|---|---|
| [it:139](../../tests/integration/agents.test.ts#L139) | M4 machine identity and real HTTP external execution → provisions one identity across concurrent retries and does not grant conversation or task access |
| [it:161](../../tests/integration/agents.test.ts#L161) | M4 machine identity and real HTTP external execution → stores only credential/token hashes and withholds one-time secrets on replay |
| [it:190](../../tests/integration/agents.test.ts#L190) | M4 machine identity and real HTTP external execution → binds message authors server-side, deduplicates writes and enforces token scope and tenant |
| [it:224](../../tests/integration/agents.test.ts#L224) | M4 machine identity and real HTTP external execution → revokes already-authenticated contexts inside business transactions and expires tokens by database clock |
| [it:244](../../tests/integration/agents.test.ts#L244) | M4 machine identity and real HTTP external execution → idempotently claims a lease, rejects other agents and fences expired/rotated workers |
| [it:273](../../tests/integration/agents.test.ts#L273) | M4 machine identity and real HTTP external execution → marks completed external reports as unverified and rechecks authorization on report replay |
| [it:296](../../tests/integration/agents.test.ts#L296) | M4 machine identity and real HTTP external execution → distinguishes platform cancellation from a reconnected external worker acknowledgement and retries a lost receipt once |
| [it:399](../../tests/integration/agents.test.ts#L399) | M4 machine identity and real HTTP external execution → accepts only the last external worker late stop acknowledgement without restoring execution or publishing output |
| [it:524](../../tests/integration/agents.test.ts#L524) | M4 machine identity and real HTTP external execution → records late confirmation after platform expiry without replacing the expired state or its generation fence |
| [it.skipIf.each:550](../../tests/integration/agents.test.ts#L550) | M4 machine identity and real HTTP external execution → recovers an independently suspended external process after %s cancellation and real lease expiry without publishing stale output |
| [it:699](../../tests/integration/agents.test.ts#L699) | M4 machine identity and real HTTP external execution → does not revive old tokens after global disable/re-enable or installation disable |
| [it:718](../../tests/integration/agents.test.ts#L718) | M4 machine identity and real HTTP external execution → requires explicit handoff acceptance for human→agent and agent→agent ownership changes |
| [it:825](../../tests/integration/agents.test.ts#L825) | SDK retries a lost command response with identical key/body and produces one message |
| [it:863](../../tests/integration/agents.test.ts#L863) | human Agent management read boundaries → lists credential metadata with actor-bound paging, never hashes or recoverable secrets |

## tests/integration/artifact-collaboration.test.ts

| 声明 | 用例 |
|---|---|
| [it:126](../../tests/integration/artifact-collaboration.test.ts#L126) | version-anchored Artifact comments and bounded explicit sharing → fixes comments to the selected version/hash and validates Unicode scalar anchors without moving them on edit |
| [it:198](../../tests/integration/artifact-collaboration.test.ts#L198) | version-anchored Artifact comments and bounded explicit sharing → lets the explicitly named recipient read only the share while leaving source ACL and other recipients unchanged |
| [it:232](../../tests/integration/artifact-collaboration.test.ts#L232) | version-anchored Artifact comments and bounded explicit sharing → keeps an existing disclosure pinned when a newer head is published and requires exact new-version consent |
| [it:298](../../tests/integration/artifact-collaboration.test.ts#L298) | version-anchored Artifact comments and bounded explicit sharing → requires original ownership plus live source and recipient fences, including removal and re-add |
| [it:352](../../tests/integration/artifact-collaboration.test.ts#L352) | version-anchored Artifact comments and bounded explicit sharing → binds a group disclosure to its current audience generation and does not automatically extend it to a new member |
| [it:383](../../tests/integration/artifact-collaboration.test.ts#L383) | version-anchored Artifact comments and bounded explicit sharing → stops an in-flight shared download after revoke and denies expired or deleted-source grants |
| [it:421](../../tests/integration/artifact-collaboration.test.ts#L421) | version-anchored Artifact comments and bounded explicit sharing → replays independent share revocation and comment deletion after a simulated database restore |
| [it:469](../../tests/integration/artifact-collaboration.test.ts#L469) | version-anchored Artifact comments and bounded explicit sharing → authenticates share HTTP downloads and never redirects to storage or returns the underlying resource locator |

## tests/integration/database-observation.test.ts

| 声明 | 用例 |
|---|---|
| [it:12](../../tests/integration/database-observation.test.ts#L12) | measures real acquisition contention and query failures without emitting SQL, values or callback errors |
| [it:72](../../tests/integration/database-observation.test.ts#L72) | isolates asynchronous diagnostic rejection from successful database work |

## tests/integration/direct-messaging.test.ts

| 声明 | 用例 |
|---|---|
| [it:13](../../tests/integration/direct-messaging.test.ts#L13) | keeps direct conversations to two authorized participants and prevents conversion through member mutation |

## tests/integration/exports.test.ts

| 声明 | 用例 |
|---|---|
| [it:48](../../tests/integration/exports.test.ts#L48) | scoped live exports → exports current authorized messages with integrity marker; creation is idempotent and actor bound |
| [it:70](../../tests/integration/exports.test.ts#L70) | scoped live exports → stops a download at revocation and never emits a successful complete marker |
| [it:103](../../tests/integration/exports.test.ts#L103) | scoped live exports → personal export excludes shared memories and respects expiry and invalid scopes |
| [it:138](../../tests/integration/exports.test.ts#L138) | scoped live exports → HTTP exposes policy, guarded creation, and an attachment stream with current-session checks |

## tests/integration/governance.test.ts

| 声明 | 用例 |
|---|---|
| [it:53](../../tests/integration/governance.test.ts#L53) | deletion and permission recovery → records only authorized deletion and synchronously removes derived memory and projection bodies |
| [it:110](../../tests/integration/governance.test.ts#L110) | deletion and permission recovery → replays the independent accepted intent after an interrupted database transaction |
| [it:133](../../tests/integration/governance.test.ts#L133) | deletion and permission recovery → restored old message and memory bodies are erased before reads resume, with concurrent replay once |
| [it:187](../../tests/integration/governance.test.ts#L187) | deletion and permission recovery → restores revocations while preserving a later explicit regrant |
| [it:216](../../tests/integration/governance.test.ts#L216) | deletion and permission recovery → ledger failure prevents acknowledgment and database mutation |

## tests/integration/http.test.ts

| 声明 | 用例 |
|---|---|
| [it:60](../../tests/integration/http.test.ts#L60) | HTTP contracts, real sessions and persisted messaging → requires a current session, exposes only active capabilities and preserves security headers |
| [it:78](../../tests/integration/http.test.ts#L78) | HTTP contracts, real sessions and persisted messaging → rejects unsafe cross-origin requests and forged actor fields before persistence |
| [it:101](../../tests/integration/http.test.ts#L101) | HTTP contracts, real sessions and persisted messaging → sends, reads, edits and retracts messages with strong ETags and server-authoritative authors |
| [it:161](../../tests/integration/http.test.ts#L161) | HTTP contracts, real sessions and persisted messaging → normalizes malformed, oversized and unknown endpoint errors without stack or credential leaks |

## tests/integration/invitations.test.ts

| 声明 | 用例 |
|---|---|
| [it:61](../../tests/integration/invitations.test.ts#L61) | issues only principal-bound human invitations, retains no plaintext code, and retries creation with the same credential |
| [it:114](../../tests/integration/invitations.test.ts#L114) | joins once under concurrent acceptance and never restores a later disabled membership on receipt retry |
| [it:142](../../tests/integration/invitations.test.ts#L142) | uses database expiry, permits explicit revocation of expired invitations, and never silently replaces a pending grant |
| [it:169](../../tests/integration/invitations.test.ts#L169) | fences invitations after issuer authority is changed and restored |
| [it:201](../../tests/integration/invitations.test.ts#L201) | serializes invitation acceptance against revocation without a partial membership grant |
| [it:217](../../tests/integration/invitations.test.ts#L217) | independently persists consumption before database commit and prevents regrant after rollback |
| [it:246](../../tests/integration/invitations.test.ts#L246) | fails closed before granting membership when the independent consumption ledger is unavailable |
| [it:262](../../tests/integration/invitations.test.ts#L262) | allows a session-only account to inspect its own identity, requires CSRF to join, and rechecks tenant access afterward |
| [it:349](../../tests/integration/invitations.test.ts#L349) | previews only the bound recipient’s grant without joining, and rejects metadata after access is disabled |
| [it:378](../../tests/integration/invitations.test.ts#L378) | rechecks expiry after slow durable consumption and rolls back the entire membership grant |

## tests/integration/knowledge.test.ts

| 声明 | 用例 |
|---|---|
| [it:141](../../tests/integration/knowledge.test.ts#L141) | current-authorized mixed-language search and explicit source-bound memory → matches Chinese, English and NFKC text in message bodies and private Task goals without leaking hidden candidates |
| [it:156](../../tests/integration/knowledge.test.ts#L156) | current-authorized mixed-language search and explicit source-bound memory → searches verified Artifact text, returns fixed version/hash and retracts its document immediately after source deletion |
| [it:190](../../tests/integration/knowledge.test.ts#L190) | current-authorized mixed-language search and explicit source-bound memory → saves private memory explicitly, preserves revisions and never interprets its content as authority |
| [it:240](../../tests/integration/knowledge.test.ts#L240) | current-authorized mixed-language search and explicit source-bound memory → rejects cross-scope derived memories and only permits confirmed active items as Runtime input |
| [it:292](../../tests/integration/knowledge.test.ts#L292) | current-authorized mixed-language search and explicit source-bound memory → does not revive derived memory after source edit or membership removal and re-add, and reconciles redacted revisions |
| [it:347](../../tests/integration/knowledge.test.ts#L347) | current-authorized mixed-language search and explicit source-bound memory → excludes expired memory and forbids Agent/service callers from self-confirming a new item |
| [it:379](../../tests/integration/knowledge.test.ts#L379) | current-authorized mixed-language search and explicit source-bound memory → binds opaque pagination to the caller/query/current ACL and enforces since-join history before matching |
| [it:405](../../tests/integration/knowledge.test.ts#L405) | current-authorized mixed-language search and explicit source-bound memory → serves authenticated HTTP search and requires session Origin/CSRF for explicit writes |

## tests/integration/machine-knowledge.test.ts

| 声明 | 用例 |
|---|---|
| [it:11](../../tests/integration/machine-knowledge.test.ts#L11) | machine knowledge HTTP and SDK require explicit scope and current source membership without exposing personal memory |

## tests/integration/machine-run-tools.test.ts

| 声明 | 用例 |
|---|---|
| [it:323](../../tests/integration/machine-run-tools.test.ts#L323) | machine tool intention and execution HTTP leases → publishes a fixed artifact through the external machine lease after exact approval and explicit resume |
| [it:356](../../tests/integration/machine-run-tools.test.ts#L356) | machine tool intention and execution HTTP leases → refuses an approved external artifact after source deletion even with the current machine lease |
| [it:370](../../tests/integration/machine-run-tools.test.ts#L370) | machine tool intention and execution HTTP leases → rejects artifact publication through an approval-free tool for both direct and machine actions |
| [it:401](../../tests/integration/machine-run-tools.test.ts#L401) | machine tool intention and execution HTTP leases → cannot execute merely because a human approved; explicit human resume and new lease are required |
| [it:430](../../tests/integration/machine-run-tools.test.ts#L430) | machine tool intention and execution HTTP leases → requires scope, matching credential holder and unexpired DB lease for every proposal |
| [it:484](../../tests/integration/machine-run-tools.test.ts#L484) | machine tool intention and execution HTTP leases → rejects payload authority injection and blocks execution after token revocation |

## tests/integration/maintenance.test.ts

| 声明 | 用例 |
|---|---|
| [it:84](../../tests/integration/maintenance.test.ts#L84) | durable task maintenance and escalation → blocks an unavailable owner once under concurrent scans and audits the service identity |
| [it:139](../../tests/integration/maintenance.test.ts#L139) | durable task maintenance and escalation → detects loss of the owner participant independently of global identity or workspace membership |
| [it:151](../../tests/integration/maintenance.test.ts#L151) | durable task maintenance and escalation → blocks an execution deadline using database time and does not execute or complete work |
| [it:167](../../tests/integration/maintenance.test.ts#L167) | durable task maintenance and escalation → expires requests durably without implying acceptance or changing the owner |
| [it:191](../../tests/integration/maintenance.test.ts#L191) | durable task maintenance and escalation → routes unresolved escalation to active workspace administrators after the assignee leaves |

## tests/integration/message-interactions.test.ts

| 声明 | 用例 |
|---|---|
| [it:50](../../tests/integration/message-interactions.test.ts#L50) | message threads, fixed quotes and reactions → freezes quote version across edits and redacts/deletes retained source revisions on withdrawal |
| [it:114](../../tests/integration/message-interactions.test.ts#L114) | message threads, fixed quotes and reactions → keeps paged row metadata separate and redacts fixed quotes after their source is deleted |
| [it:176](../../tests/integration/message-interactions.test.ts#L176) | message threads, fixed quotes and reactions → requires precise quote versions, same-conversation sources and canonical thread roots |
| [it:240](../../tests/integration/message-interactions.test.ts#L240) | message threads, fixed quotes and reactions → never leaks older quoted text or thread identifiers to members whose history starts later, including sync |
| [it:277](../../tests/integration/message-interactions.test.ts#L277) | message threads, fixed quotes and reactions → deduplicates reactions under concurrency without changing message order and only removes the actor’s own reaction |
| [it:311](../../tests/integration/message-interactions.test.ts#L311) | message threads, fixed quotes and reactions → denies reaction and quote reads after workspace or conversation revocation |

## tests/integration/messaging.test.ts

| 声明 | 用例 |
|---|---|
| [it:40](../../tests/integration/messaging.test.ts#L40) | real PostgreSQL messaging commands and current permissions → concurrent command retries commit one conversation and one event/outbox |
| [it:62](../../tests/integration/messaging.test.ts#L62) | real PostgreSQL messaging commands and current permissions → bounds database round trips as a plain history page grows without skipping message rows |
| [it:95](../../tests/integration/messaging.test.ts#L95) | real PostgreSQL messaging commands and current permissions → membership and tenant isolation apply to both lookup and enumeration |
| [it:109](../../tests/integration/messaging.test.ts#L109) | real PostgreSQL messaging commands and current permissions → concurrent repeated sends allocate once and reject reused client message identity |
| [it:123](../../tests/integration/messaging.test.ts#L123) | real PostgreSQL messaging commands and current permissions → latest-first pagination is caller-bound, and stale authorization cursors require resync |
| [it:152](../../tests/integration/messaging.test.ts#L152) | real PostgreSQL messaging commands and current permissions → since-join history blocks earlier bodies and reply references |
| [it:181](../../tests/integration/messaging.test.ts#L181) | real PostgreSQL messaging commands and current permissions → concurrent edits require the same current version and retain the old revision |
| [it:212](../../tests/integration/messaging.test.ts#L212) | real PostgreSQL messaging commands and current permissions → revocation blocks reads, new sends, and previously successful command replays |
| [it:240](../../tests/integration/messaging.test.ts#L240) | real PostgreSQL messaging commands and current permissions → workspace membership revocation closes old conversation access and enumeration |
| [it:267](../../tests/integration/messaging.test.ts#L267) | real PostgreSQL messaging commands and current permissions → read cursors remain monotonic and reject positions outside the visible stream |

## tests/integration/model-adapter.test.ts

| 声明 | 用例 |
|---|---|
| [it:69](../../tests/integration/model-adapter.test.ts#L69) | native model HTTP boundary → pins the model before transmitting explicit context and records actual usage without fabricated supplier receipts |
| [it:106](../../tests/integration/model-adapter.test.ts#L106) | native model HTTP boundary → rejects a changed model tag before sending any prompt |
| [it:118](../../tests/integration/model-adapter.test.ts#L118) | native model HTTP boundary → records response loss as unknown without retrying the model request |
| [it:129](../../tests/integration/model-adapter.test.ts#L129) | native model HTTP boundary → aborts in flight and treats provider execution as unknown |
| [it:144](../../tests/integration/model-adapter.test.ts#L144) | native model HTTP boundary → refuses redirects and oversized results without trusting remote output |
| [it:170](../../tests/integration/model-adapter.test.ts#L170) | native model HTTP boundary → refuses silent context truncation and deployment URLs outside loopback |

## tests/integration/model-driver.test.ts

| 声明 | 用例 |
|---|---|
| [it:78](../../tests/integration/model-driver.test.ts#L78) | durable model execution against PostgreSQL and HTTP → saves the authorized result and settles measured tokens once before completion |
| [it:98](../../tests/integration/model-driver.test.ts#L98) | durable model execution against PostgreSQL and HTTP → holds unknown usage after a lost response and never blindly resends the invocation |
| [it:118](../../tests/integration/model-driver.test.ts#L118) | durable model execution against PostgreSQL and HTTP → records late billing facts without publishing output after source membership is revoked |
| [it:149](../../tests/integration/model-driver.test.ts#L149) | durable model execution against PostgreSQL and HTTP → restores a settled checkpoint after a worker crash without another model call |
| [it:190](../../tests/integration/model-driver.test.ts#L190) | durable model execution against PostgreSQL and HTTP → preserves a finished result through pause and resume instead of executing a second step |
| [it:212](../../tests/integration/model-driver.test.ts#L212) | durable model execution against PostgreSQL and HTTP → refuses destination mismatch before transmitting context to the model |

## tests/integration/notifications.test.ts

| 声明 | 用例 |
|---|---|
| [it:111](../../tests/integration/notifications.test.ts#L111) | durable authorization-aware notification intents → reports a full partial-fanout batch until every current recipient is handled exactly once |
| [it:134](../../tests/integration/notifications.test.ts#L134) | durable authorization-aware notification intents → coalesces conversation notifications, tolerates duplicates and late older work without taking projector outbox rows |
| [it:188](../../tests/integration/notifications.test.ts#L188) | durable authorization-aware notification intents → closes non-conversation outbox with explicit invalidation receipts, and read never resolves a Task blocker |
| [it:227](../../tests/integration/notifications.test.ts#L227) | durable authorization-aware notification intents → checks workspace and conversation ACL before paging, unread counts and opening, including removal and re-add |
| [it:256](../../tests/integration/notifications.test.ts#L256) | durable authorization-aware notification intents → does not lose an earlier-started event that commits after a newer event was dispatched |
| [it:289](../../tests/integration/notifications.test.ts#L289) | durable authorization-aware notification intents → fans out large audiences in bounded resumable pages and receipts make retries harmless |
| [it:303](../../tests/integration/notifications.test.ts#L303) | durable authorization-aware notification intents → backfills old audit facts without generating stale reminders and still closes their non-conversation outbox |
| [it:317](../../tests/integration/notifications.test.ts#L317) | durable authorization-aware notification intents → keeps unread during DND, mute and category suppression, with per-device gating and sensitive-free payloads |
| [it:377](../../tests/integration/notifications.test.ts#L377) | durable authorization-aware notification intents → rechecks ACL and revoked sessions before transport, cleans only that device binding, and denies other users device mutation |
| [it:413](../../tests/integration/notifications.test.ts#L413) | durable authorization-aware notification intents → binds cursors to the caller and enforces real HTTP session/CSRF with opaque click resolution |
| [it:491](../../tests/integration/notifications.test.ts#L491) | encrypted Web Push subscription and bounded durable delivery → encrypts the endpoint and keys, replaces the session binding, and removes ciphertext when disabled |
| [it:527](../../tests/integration/notifications.test.ts#L527) | encrypted Web Push subscription and bounded durable delivery → caps retries across worker restarts and removes expired subscriptions on 410 outcomes |
| [it:583](../../tests/integration/notifications.test.ts#L583) | encrypted Web Push subscription and bounded durable delivery → rechecks authority immediately before transport and fences old delivery settlement after subscription rotation |
| [it:624](../../tests/integration/notifications.test.ts#L624) | Web Push public HTTP boundary → requires session CSRF and validates configured provider endpoints without exposing private keys |

## tests/integration/organization.test.ts

| 声明 | 用例 |
|---|---|
| [it:56](../../tests/integration/organization.test.ts#L56) | restricts organization administration and candidates to the tenant, without granting resource access |
| [it:89](../../tests/integration/organization.test.ts#L89) | creates idempotently, paginates rosters, rejects cross-scope and stale cursors |
| [it:125](../../tests/integration/organization.test.ts#L125) | fences old authorization on disable and reactivation; preserves last administrator |
| [it:167](../../tests/integration/organization.test.ts#L167) | serializes competing administrators and emits exactly one successful change for a workspace version |
| [it:201](../../tests/integration/organization.test.ts#L201) | replays independent membership revocation after database rollback, but preserves an explicit newer grant |
| [it:245](../../tests/integration/organization.test.ts#L245) | fails closed on ledger errors before changing membership or version |
| [it:270](../../tests/integration/organization.test.ts#L270) | exposes cookie-authenticated, CSRF-protected organization commands with version and idempotency headers |
| [it:357](../../tests/integration/organization.test.ts#L357) | keeps a captured Run fenced after its creator is demoted and restored |
| [it:411](../../tests/integration/organization.test.ts#L411) | restricts organization owner grants, administrator targets, historical identities and cross-tenant members |
| [it:451](../../tests/integration/organization.test.ts#L451) | disables and restores organization membership without reviving old auth and keeps late retries from undoing restoration |
| [it:483](../../tests/integration/organization.test.ts#L483) | preserves the last organization owner and each workspace administrator when disabling an organization member |
| [it:516](../../tests/integration/organization.test.ts#L516) | serializes opposing owner demotions and rejects a concurrent stale tenant member version |
| [it:556](../../tests/integration/organization.test.ts#L556) | replays tenant revocation across unrelated workspace version changes while preserving an explicit newer tenant grant |
| [it:589](../../tests/integration/organization.test.ts#L589) | rolls back a tenant membership mutation when its independent ledger cannot be written |

## tests/integration/promotion.test.ts

| 声明 | 用例 |
|---|---|
| [it:54](../../tests/integration/promotion.test.ts#L54) | conversation Run promotion creates new authority without rewriting history → atomically promotes once, preserves the original scope/budget and requires fresh Agent access for continuation |
| [it:106](../../tests/integration/promotion.test.ts#L106) | conversation Run promotion creates new authority without rewriting history → serializes distinct promotion commands for the same original Run |
| [it:118](../../tests/integration/promotion.test.ts#L118) | conversation Run promotion creates new authority without rewriting history → does not promote an unfinished run, stale version, other actor or expanded reviewer audience |
| [it:139](../../tests/integration/promotion.test.ts#L139) | conversation Run promotion creates new authority without rewriting history → rechecks original sources on replay and hides origin metadata when access is revoked |
| [it:153](../../tests/integration/promotion.test.ts#L153) | exposes promotion and origin through strict HTTP contracts with fresh explicit authorization |

## tests/integration/recovery-drill.test.ts

| 声明 | 用例 |
|---|---|
| [it:3](../../tests/integration/recovery-drill.test.ts#L3) | restores a real database/object backup and reapplies independent deletion and revocation facts before reopening |

## tests/integration/resource-links.test.ts

| 声明 | 用例 |
|---|---|
| [it:155](../../tests/integration/resource-links.test.ts#L155) | transactional message attachments and fixed Task Artifact evidence → persists one fixed same-scope attachment across retries and projects it through snapshots |
| [it:177](../../tests/integration/resource-links.test.ts#L177) | transactional message attachments and fixed Task Artifact evidence → does not disclose another readable conversation or Task resource by attaching its ID |
| [it:197](../../tests/integration/resource-links.test.ts#L197) | transactional message attachments and fixed Task Artifact evidence → invalidates old snapshots immediately on source deletion and emits an attachment-free replacement |
| [it:225](../../tests/integration/resource-links.test.ts#L225) | transactional message attachments and fixed Task Artifact evidence → allows only an explicit new message to disclose an older same-conversation upload to a new member |
| [it:250](../../tests/integration/resource-links.test.ts#L250) | transactional message attachments and fixed Task Artifact evidence → keeps the submitted Artifact version fixed when its head changes and refuses deleted-source acceptance |
| [it:317](../../tests/integration/resource-links.test.ts#L317) | transactional message attachments and fixed Task Artifact evidence → allows current task contributors to append with explicit authorship, rejects stale competing edits and fences demotion |
| [it:424](../../tests/integration/resource-links.test.ts#L424) | transactional message attachments and fixed Task Artifact evidence → preserves a contributor branch independently and merges resolved bytes once against the explicit current head |
| [it:529](../../tests/integration/resource-links.test.ts#L529) | transactional message attachments and fixed Task Artifact evidence → serializes competing branch merges, rejects foreign bases and paginates only currently visible drafts |
| [it:603](../../tests/integration/resource-links.test.ts#L603) | transactional message attachments and fixed Task Artifact evidence → bounds live branch drafts and frees capacity after their resource is tombstoned |
| [it:640](../../tests/integration/resource-links.test.ts#L640) | transactional message attachments and fixed Task Artifact evidence → keeps conversation artifacts creator-only even for another conversation writer |
| [it:659](../../tests/integration/resource-links.test.ts#L659) | transactional message attachments and fixed Task Artifact evidence → serializes competing Artifact versions without replacing the evidence already submitted to two reviewers |
| [it:737](../../tests/integration/resource-links.test.ts#L737) | transactional message attachments and fixed Task Artifact evidence → commits exactly one reviewer decision while an Artifact head update races with acceptance |
| [it:828](../../tests/integration/resource-links.test.ts#L828) | transactional message attachments and fixed Task Artifact evidence → requires the exact Task and SHA-256, even when the submitter can read both Tasks |
| [it:877](../../tests/integration/resource-links.test.ts#L877) | transactional message attachments and fixed Task Artifact evidence → filters discovery before paging and binds cursors to the current reader and scope generation |

## tests/integration/resources.test.ts

| 声明 | 用例 |
|---|---|
| [it:96](../../tests/integration/resources.test.ts#L96) | real private S3 upload and authorization gateway → allows browser PUT preflight only from the configured application origin |
| [it:113](../../tests/integration/resources.test.ts#L113) | real private S3 upload and authorization gateway → requires authenticated bucket access and verifies staged bytes before publishing immutable content |
| [it:136](../../tests/integration/resources.test.ts#L136) | real private S3 upload and authorization gateway → binds upload authorization to exact byte count/checksum and rejects oversized declarations |
| [it:173](../../tests/integration/resources.test.ts#L173) | real private S3 upload and authorization gateway → quarantines unsupported binary content, malformed JSON, and the EICAR test signature |
| [it:216](../../tests/integration/resources.test.ts#L216) | real private S3 upload and authorization gateway → rechecks current ACL after the storage/scan step and never publishes after revocation |
| [it:257](../../tests/integration/resources.test.ts#L257) | real private S3 upload and authorization gateway → stops a long download at the next 64 KiB boundary when access is revoked |
| [it:277](../../tests/integration/resources.test.ts#L277) | real private S3 upload and authorization gateway → enforces tenant isolation and from-join history for resource locators |
| [it:314](../../tests/integration/resources.test.ts#L314) | real private S3 upload and authorization gateway → tombstones before physical deletion and retries persisted cleanup |
| [it:349](../../tests/integration/resources.test.ts#L349) | immutable Artifact versions and resource HTTP routes → preserves every Artifact version, rejects cross-scope publication and binds pagination to the caller |
| [it:408](../../tests/integration/resources.test.ts#L408) | immutable Artifact versions and resource HTTP routes → serves authenticated attachment bytes with no-store/nosniff and never exposes an S3 GET URL |

## tests/integration/retention.test.ts

| 声明 | 用例 |
|---|---|
| [it:39](../../tests/integration/retention.test.ts#L39) | bounded retention and Run lifetime maintenance → deletes expired content once, persists a recovery tombstone, and leaves subsequent outbox processing usable |
| [it:83](../../tests/integration/retention.test.ts#L83) | bounded retention and Run lifetime maintenance → removes terminal Run input, output and checkpoint bodies after retention without deleting usage evidence |
| [it:137](../../tests/integration/retention.test.ts#L137) | bounded retention and Run lifetime maintenance → expires work at the durable lifetime and keeps unresolved reservations unknown |
| [it:177](../../tests/integration/retention.test.ts#L177) | bounded retention and Run lifetime maintenance → rejects invalid policy configuration and batch sizes |

## tests/integration/run-tool-intents.test.ts

| 声明 | 用例 |
|---|---|
| [it:319](../../tests/integration/run-tool-intents.test.ts#L319) | bounded structured model intention, explicit human approval and fresh leased execution → publishes a fixed artifact from the hosted structured model path only after human approval and resume |
| [it:337](../../tests/integration/run-tool-intents.test.ts#L337) | bounded structured model intention, explicit human approval and fresh leased execution → persists one Action then requires human resume and charges both Run and Task exactly once |
| [it:371](../../tests/integration/run-tool-intents.test.ts#L371) | bounded structured model intention, explicit human approval and fresh leased execution → replays a lost proposal response without a second Action but rejects a changed intent |
| [it:396](../../tests/integration/run-tool-intents.test.ts#L396) | bounded structured model intention, explicit human approval and fresh leased execution → holds unknown tool cost and blocks resume and any blind redispatch |
| [it:431](../../tests/integration/run-tool-intents.test.ts#L431) | bounded structured model intention, explicit human approval and fresh leased execution → rejects scheduling a tool-authorized Run so approval cannot be followed by an automatic resume |
| [it:453](../../tests/integration/run-tool-intents.test.ts#L453) | bounded structured model intention, explicit human approval and fresh leased execution → cancels an approved but undispatched bound Action with the Run |
| [it:469](../../tests/integration/run-tool-intents.test.ts#L469) | bounded structured model intention, explicit human approval and fresh leased execution → finishes a structured final response without manufacturing a tool effect |
| [it:477](../../tests/integration/run-tool-intents.test.ts#L477) | bounded structured model intention, explicit human approval and fresh leased execution → rejects mixed source disclosure before a tool-enabled Run is queued |

## tests/integration/runtime-knowledge.test.ts

| 声明 | 用例 |
|---|---|
| [it:217](../../tests/integration/runtime-knowledge.test.ts#L217) | Runtime fixed Memory/Artifact source port on all execution boundaries → persists exact source hashes and supplies verified untrusted content through a real worker claim |
| [it:276](../../tests/integration/runtime-knowledge.test.ts#L276) | Runtime fixed Memory/Artifact source port on all execution boundaries → rejects hash forgery, private memory disclosure, another conversation scope and an Agent missing source access |
| [it:313](../../tests/integration/runtime-knowledge.test.ts#L313) | Runtime fixed Memory/Artifact source port on all execution boundaries → rechecks memory confirmation and expiry when claiming, reading, resuming and dispatching a scheduled Run |
| [it:389](../../tests/integration/runtime-knowledge.test.ts#L389) | Runtime fixed Memory/Artifact source port on all execution boundaries → validates extended references at HTTP ingress and denies a stale context after current source removal |

## tests/integration/runtime.test.ts

| 声明 | 用例 |
|---|---|
| [it.each:167](../../tests/integration/runtime.test.ts#L167) | durable runtime identity, leases and context → propagates task %s through descendant runs without fabricating acknowledgements or releasing holds |
| [it:257](../../tests/integration/runtime.test.ts#L257) | durable runtime identity, leases and context → rejects owner credentials, binds immutable agent revisions, and creates an idempotent task-free conversation run |
| [it:301](../../tests/integration/runtime.test.ts#L301) | durable runtime identity, leases and context → scans hosted durable candidates and exposes only the fixed execution revision and explicit manifest |
| [it:317](../../tests/integration/runtime.test.ts#L317) | durable runtime identity, leases and context → rejects old worker heartbeat, budget reservation and completion after real handoff |
| [it:402](../../tests/integration/runtime.test.ts#L402) | durable runtime identity, leases and context → rejects heartbeat/report after expiry even before takeover, increments generation on recovery, and rejects the old holder |
| [it:422](../../tests/integration/runtime.test.ts#L422) | durable runtime identity, leases and context → invalidates old runs after an ancestor closes and reopens, and checks all ancestor deadlines |
| [it:453](../../tests/integration/runtime.test.ts#L453) | durable runtime identity, leases and context → captures only explicit source versions/hashes and refuses context use/submission after source revocation |
| [it:491](../../tests/integration/runtime.test.ts#L491) | durable runtime identity, leases and context → rejects private task input in conversation runs, oversized context and stale source versions without persisting partial runs |
| [it:533](../../tests/integration/runtime.test.ts#L533) | durable runtime identity, leases and context → freezes global creator and agent identity revisions so disabling and re-enabling never revives an old run |
| [it:564](../../tests/integration/runtime.test.ts#L564) | durable runtime identity, leases and context → rejects prior task participation after removal and reinvitation even with current tenant membership |
| [it:580](../../tests/integration/runtime.test.ts#L580) | durable runtime identity, leases and context → withholds previously generated output when a separate context source is later revoked |
| [it:609](../../tests/integration/runtime.test.ts#L609) | durable runtime identity, leases and context → persists pause/checkpoint/resume and requires an explicit worker cancellation acknowledgement |
| [it:663](../../tests/integration/runtime.test.ts#L663) | atomic root-shared budget and late accounting facts → concurrent child reservations share the root limit without double counting usage |
| [it:713](../../tests/integration/runtime.test.ts#L713) | atomic root-shared budget and late accounting facts → retains unknown reservations, refuses unproven release, and records overspend after task cancellation |
| [it:773](../../tests/integration/runtime.test.ts#L773) | atomic root-shared budget and late accounting facts → gates completion on live runs and unresolved accounting across the complete task subtree |
| [it:797](../../tests/integration/runtime.test.ts#L797) | atomic root-shared budget and late accounting facts → atomically persists usage and a result checkpoint, then resumes after a crash without dispatching again |
| [it:847](../../tests/integration/runtime.test.ts#L847) | atomic root-shared budget and late accounting facts → refuses expired result checkpoints while accepting the late accounting fact separately |
| [it:877](../../tests/integration/runtime.test.ts#L877) | atomic root-shared budget and late accounting facts → does not blindly reclaim a crashed model step with outstanding usage |
| [it:903](../../tests/integration/runtime.test.ts#L903) | exposes only human authorization/control routes; worker completion and budget writes have no public endpoint |
| [it:974](../../tests/integration/runtime.test.ts#L974) | retries a real PostgreSQL deadlock without duplicating committed transaction writes |
| [it:1007](../../tests/integration/runtime.test.ts#L1007) | bounded V1 execution → serializes concurrent claims across the entire root tree and releases a slot on terminal report |
| [it:1023](../../tests/integration/runtime.test.ts#L1023) | bounded V1 execution → bounds zero-cost invocations and durable progress steps without blocking final completion |
| [it:1055](../../tests/integration/runtime.test.ts#L1055) | bounded V1 execution → does not renew an execution beyond its absolute lifetime even when its lease is current |
| [it:1074](../../tests/integration/runtime.test.ts#L1074) | paginates authorized run history with cursors bound to the current scope |

## tests/integration/scheduling.test.ts

| 声明 | 用例 |
|---|---|
| [it:152](../../tests/integration/scheduling.test.ts#L152) | durable bounded schedule dispatch → creates one occurrence/outbox and one Run wake under simultaneous scanners and dispatchers |
| [it:189](../../tests/integration/scheduling.test.ts#L189) | durable bounded schedule dispatch → bounds a multi-agent wake burst across duplicate scans, disabled plans, root concurrency and shared budget |
| [it:289](../../tests/integration/scheduling.test.ts#L289) | durable bounded schedule dispatch → revalidates disabled revision after an occurrence was queued, including a concurrent blocked dispatcher |
| [it:308](../../tests/integration/scheduling.test.ts#L308) | durable bounded schedule dispatch → never trusts client clocks, allows no dispatch before due and enforces a hard deadline |
| [it:332](../../tests/integration/scheduling.test.ts#L332) | durable bounded schedule dispatch → persists skip versus coalesce and counts finite occurrence allowance across revisions |
| [it:363](../../tests/integration/scheduling.test.ts#L363) | durable bounded schedule dispatch → skips overlap without resuming a queued Run or resetting its lifecycle |
| [it:375](../../tests/integration/scheduling.test.ts#L375) | durable bounded schedule dispatch → invalidates descendants after ancestor epoch change before dispatch |
| [it:392](../../tests/integration/scheduling.test.ts#L392) | durable bounded schedule dispatch → denies global identity disable/re-enable and tenant or installation revocation |
| [it:420](../../tests/integration/scheduling.test.ts#L420) | durable bounded schedule dispatch → denies held or unknown usage, blocked budgets, exhausted steps and expired Run lifetime |
| [it:446](../../tests/integration/scheduling.test.ts#L446) | durable bounded schedule dispatch → never revives a completed Run and rejects Agent-authored recursive schedules or substituted bindings |
| [it:471](../../tests/integration/scheduling.test.ts#L471) | durable bounded schedule dispatch → enforces tenant RLS and owner-only plan visibility independently of task participation |
| [it:484](../../tests/integration/scheduling.test.ts#L484) | durable bounded schedule dispatch → hides Task/Run source identifiers from detail, occurrence history and lists after live ACL revocation |
| [it:497](../../tests/integration/scheduling.test.ts#L497) | durable bounded schedule dispatch → validates real HTTP contracts, CSRF/version headers and explicit delete-as-disable |

## tests/integration/sync.test.ts

| 声明 | 用例 |
|---|---|
| [it:159](../../tests/integration/sync.test.ts#L159) | durable outbox projection and caller-bound fixed snapshots → skips delivery queries only at an authenticated current head and still rejects revoked members |
| [it:200](../../tests/integration/sync.test.ts#L200) | durable outbox projection and caller-bound fixed snapshots → projects an independent conversation while another conversation is locked |
| [it:247](../../tests/integration/sync.test.ts#L247) | durable outbox projection and caller-bound fixed snapshots → lets multiple workers share SKIP LOCKED leases while preserving committed stream order |
| [it:274](../../tests/integration/sync.test.ts#L274) | durable outbox projection and caller-bound fixed snapshots → rolls back failed projection/checkpoint/receipt together and retries from durable outbox |
| [it:324](../../tests/integration/sync.test.ts#L324) | durable outbox projection and caller-bound fixed snapshots → defers out-of-order events and attributes current content to its real authoritative event/version |
| [it:388](../../tests/integration/sync.test.ts#L388) | durable outbox projection and caller-bound fixed snapshots → deduplicates replayed delivery and fences an expired/stolen worker lease |
| [it:426](../../tests/integration/sync.test.ts#L426) | durable outbox projection and caller-bound fixed snapshots → keeps all snapshot pages at one materialized view while edits/new messages arrive, then catches up from its fixed head |
| [it:459](../../tests/integration/sync.test.ts#L459) | durable outbox projection and caller-bound fixed snapshots → invalidates snapshots/cursors immediately on content withdrawal and never exposes stale projected bodies |
| [it:482](../../tests/integration/sync.test.ts#L482) | durable outbox projection and caller-bound fixed snapshots → enforces since-join history, workspace membership, permission generation, snapshot TTL and retention generation |
| [it:540](../../tests/integration/sync.test.ts#L540) | HTTP snapshots and real WebSocket delivery/recovery → delivers persistent events, accepts transport ACK without changing read state, and resumes after disconnection |
| [it:589](../../tests/integration/sync.test.ts#L589) | HTTP snapshots and real WebSocket delivery/recovery → notifies revoked subscribers and rejects a cross-origin upgrade |
| [it:628](../../tests/integration/sync.test.ts#L628) | HTTP snapshots and real WebSocket delivery/recovery → rejects an ACK never delivered on this socket without granting read state |
| [it:654](../../tests/integration/sync.test.ts#L654) | HTTP snapshots and real WebSocket delivery/recovery → bounds unacknowledged deliveries and closes slow consumers with a resync signal |
| [it:678](../../tests/integration/sync.test.ts#L678) | materializes at most 200 recent visible messages at a fixed head and binds snapshot cursors to their window |

## tests/integration/tasks.test.ts

| 声明 | 用例 |
|---|---|
| [it:137](../../tests/integration/tasks.test.ts#L137) | real PostgreSQL M2 collaboration and task fences → creates one independent task with self owner, exact bigint budget and one durable event |
| [it:164](../../tests/integration/tasks.test.ts#L164) | real PostgreSQL M2 collaboration and task fences → conversation summary discloses only its explicit text and never grants task ACL, including another tenant |
| [it:189](../../tests/integration/tasks.test.ts#L189) | real PostgreSQL M2 collaboration and task fences → revoked task and workspace membership defeat existing task references and idempotent replays |
| [it:217](../../tests/integration/tasks.test.ts#L217) | real PostgreSQL M2 collaboration and task fences → only the actual recipient accepts; concurrent competing handoffs yield one owner and fixed agreement |
| [it:247](../../tests/integration/tasks.test.ts#L247) | real PostgreSQL M2 collaboration and task fences → same acceptance idempotency key returns exactly one accepted version and never a second handoff |
| [it:267](../../tests/integration/tasks.test.ts#L267) | real PostgreSQL M2 collaboration and task fences → clarification and revision retain immutable proposals and reject a stale proposal number |
| [it:305](../../tests/integration/tasks.test.ts#L305) | real PostgreSQL M2 collaboration and task fences → rejection and expiry never create a child or transfer ownership |
| [it:322](../../tests/integration/tasks.test.ts#L322) | real PostgreSQL M2 collaboration and task fences → bounds real recursive delegation at five levels and leaves no child or agreement when deeper acceptance races |
| [it:384](../../tests/integration/tasks.test.ts#L384) | real PostgreSQL M2 collaboration and task fences → serializes the final task-tree slot and refuses further accepted delegations at 200 nodes |
| [it:430](../../tests/integration/tasks.test.ts#L430) | real PostgreSQL M2 collaboration and task fences → delegation creates one child only after acceptance and preserves parent ownership |
| [it:452](../../tests/integration/tasks.test.ts#L452) | real PostgreSQL M2 collaboration and task fences → terminal and reopen advance epochs and make old pending proposals permanently unusable |
| [it:475](../../tests/integration/tasks.test.ts#L475) | real PostgreSQL M2 collaboration and task fences → a parent close/reopen invalidates a previously issued child proposal through complete ancestor fences |
| [it:499](../../tests/integration/tasks.test.ts#L499) | real PostgreSQL M2 collaboration and task fences → serializes cross-root dependency mutation before sorted root locks and rejects the combined cycle |
| [it:514](../../tests/integration/tasks.test.ts#L514) | real PostgreSQL M2 collaboration and task fences → pins submission text/hash/goal version, restricts acceptance to designated reviewers and completes separately |
| [it:554](../../tests/integration/tasks.test.ts#L554) | real PostgreSQL M2 collaboration and task fences → does not complete a parent while an accepted child remains open |
| [it:572](../../tests/integration/tasks.test.ts#L572) | real PostgreSQL M2 collaboration and task fences → rejects old goal submissions and artifact refs until their storage/authorization implementation exists |
| [it:609](../../tests/integration/tasks.test.ts#L609) | real PostgreSQL M2 collaboration and task fences → takeover is an explicit admin command with a reason, new owner and epoch |
| [it:627](../../tests/integration/tasks.test.ts#L627) | M2 HTTP commands with real cookie authentication and contracts → creates, reads, proposes and accepts with authoritative identity, version headers and CSRF |

## tests/integration/workspace-provisioning.test.ts

| 声明 | 用例 |
|---|---|
| [it:29](../../tests/integration/workspace-provisioning.test.ts#L29) | operator workspace provisioning → plans without writes and atomically provisions current human identities with restricted roles and an operator receipt |
| [it:69](../../tests/integration/workspace-provisioning.test.ts#L69) | operator workspace provisioning → serializes concurrent retries and never reactivates revoked grants on replay |
| [it:99](../../tests/integration/workspace-provisioning.test.ts#L99) | operator workspace provisioning → refuses existing tenants and missing identities without leaving a tenant or receipt |
| [it:120](../../tests/integration/workspace-provisioning.test.ts#L120) | operator workspace provisioning → rejects runtime credentials, duplicate principals, unknown fields and disabled identities |
| [it:147](../../tests/integration/workspace-provisioning.test.ts#L147) | operator workspace provisioning → admits provisioned members through normal session and conversation APIs while rejecting an unlisted human |

## tests/model/ollama.test.ts

| 声明 | 用例 |
|---|---|
| [it:14](../../tests/model/ollama.test.ts#L14) | completes an authorized durable run using a real pinned local Qwen model |
