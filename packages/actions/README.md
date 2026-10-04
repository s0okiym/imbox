# Controlled actions and independent journal

The Action service admits a fixed tool, target, parameters, disclosure grant,
approval, task ancestry and budget before the worker invokes an external tool.
An uncertain response remains `unknown`; reconciliation queries the configured
tool using the original business key instead of blindly sending the action again.

Before dispatch, `persistIntent` validates the current lease and its attempt. Its
immutable journal identity is the attempt ID; its timestamp comes from the stored
attempt creation time, so retrying after a lost journal acknowledgement produces
the same signed record. The lease is checked again before attaching that record
to the database attempt. Dispatch requires the attachment and independently
rechecks admission and the recovery fence.

The file journal requires a separately retained POSIX filesystem with hard-link
and fsync support, outside PostgreSQL backup/restore rollback. It writes and
fsyncs a private temporary file, publishes the complete fact with an atomic
non-overwriting link, then fsyncs the tenant directory before acknowledging it.
An identical retry also syncs the directory. Temporary files left by a crash are
unpublished facts and are ignored; corrupt published facts are never overwritten.
Record signatures, tenant/file identities, symlink rejection and directory write
permissions are checked on reads.

Recovery first persists an independent tenant freeze, then records a database
fence and reconciliation cases. A terminal database attempt counts as a match
only when its Action ID, attempt ID, fingerprint and lease generation match the
intent. Missing or conflicting identities remain open cases. Recovery does not
automatically unfreeze execution or treat journal receipts as permission to
resend a business action.

The recovery API now closes a specific supported case: an independent intent
survives while its Action/Attempt has been lost, but its original Task ancestry
and budget accounts remain verifiable. It does not reconstruct executable
Actions. A current human tenant owner/admin must query the configured HTTP
provider, review its bound evidence and explicitly confirm accounting. The
original business key and attempt are permanently reserved by a tombstone.
Repeated confirmation cannot charge twice or send the action again.

Recovery lookup is GET-only and requires the provider to echo tenant_id,
action_id, attempt_id and the exact fingerprint. A not_found response, missing
identity, conflict, malformed response or unavailable provider remains unknown;
it never becomes a zero-cost no-effect result. Provider receipt identifiers
share a uniqueness registry with normal Action receipts. Actual confirmed
costs are added once to each original ancestor budget account; an overrun
blocks those accounts instead of hiding the charge.

New intents include the exact tool version and original budget account path.
Legacy orphan intents lacking those fields, missing budget accounts, changed
ancestry, conflicting retained attempts, or contradictory terminal receipts
stay unresolved and frozen. Intact executing/unknown attempts continue through
the existing Action reconciliation endpoint. Restoring missing business data
is an operator responsibility; this implementation does not promise arbitrary
database disaster reconstruction.

Human unfreeze requires the displayed database revision, independent freeze
digest and journal digest, no open cases or executing/unknown Actions, and
completed independent accounting proofs. Authorization is rechecked when
finalizing. The database fence remains frozen while a signed unfreeze record is
durably appended; only then can the database commit permission to resume.
Lost journal acknowledgements are retried with the same operation identity.
Every new independent freeze changes the covered freeze-set digest and
invalidates old unfreeze records. Receipt writes and recovery fence updates
share the same database lock boundary. Unknown database/system failures retain
the fence rather than pretending to have reconciled.

The immutable journal must retain freeze, recovery and unfreeze records with
their intents. There is no journal compaction/retention implementation yet, and
the file adapter refuses more than 100,000 records per tenant. A restore must
run the journal audit before enabling external execution.

The service exposes actions.recovery.status/refresh/list/get/lookup/confirm/
unfreeze. API routes live under /v1/action-recovery. Confirmation and unfreeze
require explicit human confirmation, reason, stable idempotency key and
If-Match. The standalone RecoveryWorkspace UI displays evidence and exact
costs, keeps unknown amounts visibly unknown, and clears cached records after
authorization loss. No endpoint accepts caller-supplied provider receipts,
lookup URLs or fabricated external results.

`src/journal.test.ts` exercises real filesystem publication, concurrent retries,
tampering and freeze persistence. `tests/integration/action-journal.test.ts` and
`tests/integration/actions.test.ts` at the repository root exercise the real
PostgreSQL boundaries, including lost acknowledgements and restore mismatches.
`tests/integration/action-recovery.test.ts` adds real HTTP/PG orphan restore,
concurrent confirmation, receipt reuse, admin authorization and lost unfreeze
acknowledgement scenarios; every recovery test asserts the external POST count.

## Run 绑定的有限工具行动

工具提案只在当前 Run 的 holder、generation、数据库租约期限、完整祖先 fence、身份/安装/上下文均有效时准入。模型/机器只能提出文字，不能传执行者、目标 URL、grant 或业务键。唯一 `(tenant,run)` 意图和 `run.<id>.tool.1` 永久键连接原 Action；该 Action 参数不可修订，修改意图需要明确的新 Run 和授权。审批后仍需人显式恢复，新租约下才可发送；普通扫描器只领取无 Run 绑定的 Action。

外部 Agent 使用 `runs.tools` scope，通过 `POST /v1/machine/agent-runs/:id/tool-intents` 提交 `{generation,text}`，`POST .../tool-execution` 提交 `{generation}`。凭证持有者必须与 Run lease holder 对应，token/安装/全局身份在事务内重验。两路由必须带幂等键；持久 Run 意图和 Action 业务键决定业务去重。没有机器审批或隐式恢复接口；等待/暂停状态下执行请求返回冲突。`GET .../tool-intent` 返回当前可读的 Action。

原有 Task 祖先预算与 Run 预算由同一 ActionAttempt 预占/结算，unknown 保持两者预占。独立 intent 额外保存 `run_id`；孤立恢复须校验原 Run 与 Task、币种和预算账户仍可核对，然后将费用同时补记。原 Run 缺失时保持冻结，不能把原 Run 费用遗漏后解冻。026 为旧人工 Action 保留可空 Run 绑定，不改变其审批/核对规则。
