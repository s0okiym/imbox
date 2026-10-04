# 03 接口与 Agent Runtime 开发设计

版本：1.0 · 2026-10-04 · 上级：[开发设计索引](README.md)

## 1. 契约实现原则

HTTP 负责命令和查询，WebSocket 负责订阅、确认与临时在线事件。Agent 与人使用相同业务命令，但认证方式和可用能力不同。外部客户端不能直接写领域事件、数据库状态、owner 或审批结果字段。

`packages/contracts` 保存 JSON Schema 2020-12、OpenAPI 3.1.1、事件和错误码；由此生成 TS 类型、客户端调用器及兼容性检查。所有公开 schema 有稳定 `$id` 和版本，API `/v1` 与单个事件的 schema_version 独立演进。下面是待实现的接口规范，M0 开始形成可执行定义并持续补全。

请求先校验大小、结构和认证，授权查询在 application 层。响应先构建字段白名单 DTO，再使用同方言 schema 验证并序列化；不得将数据库实体整体返回。schema 不授予权限，客户端类型也不替代服务端检查。

## 2. 认证与通用 HTTP 约定

### 2.1 人类与 Agent

人类用户使用同源 Web → API 的 OIDC 登录，会话 Cookie 为 HttpOnly、Secure、适当的 SameSite，状态修改请求验证 CSRF token 与 Origin。登录验证 state、nonce、PKCE、issuer、audience、有效期和回调地址。浏览器不持有 IdP refresh token 或 Agent 凭证。

外部 Agent 通过管理员创建 installation，获得可轮换的安装凭证；凭证仅换取限定 audience、tenant、installation、scope 和短有效期的 opaque access token。凭证与 token 在库中存不可逆的加盐/带服务端密钥摘要，原始值只在创建时显示，日志不得记录。每次请求查主体、安装状态、授权 revision 和有效期，即时撤销不能只等 token 自然过期。

V1 机器 token 默认 15 分钟，安装凭证默认 30 天且可立即撤销；这些是可配置开发默认值，不代表必须允许该长度的生产凭证。托管 Worker 使用短期运行身份调用受控工具接口，不复用管理员 token。

### 2.2 Header 与幂等

| 项目 | 规范 |
|---|---|
| Content-Type | `application/json`；文件按专门上传协议，普通 JSON 请求默认上限 256 KiB。 |
| Authorization | 机器接口 `Bearer` token；浏览器使用会话 Cookie。 |
| Idempotency-Key | 创建、接单、审批、提交、取消、动作等变更必须携带；作用域含 tenant+actor+operation。 |
| If-Match | 修改已有实体时携带服务器返回的强 ETag，绑定该实体版本。 |
| Trace | 接受规范 traceparent 并生成 request_id；不把用户输入作为可信审计标识。 |
| Cache-Control | 认证响应默认 `private, no-store`；明确允许的本地应用缓存由客户端协议管理。 |

HTTP 202 表示请求已持久接受或排队，不表示任务接单或行动完成。POST 幂等返回原资源引用，但重新检查当前主体是否可查看结果。普通命令去重记录默认保留 30 天，离线发送队列最长 7 天；超过期限须由用户明确重新发起。Action 业务去重和 unknown 记录不随普通命令缓存淘汰。

### 2.3 错误、分页与版本

错误采用稳定的 `code/message/request_id/retryable/details`；details 只包含允许披露的版本与字段。未知资源与不可见资源按策略统一为 404，不能泄漏跨租户对象存在性。

| 错误码 | HTTP | 客户端/Agent 行为 |
|---|---|---|
| UNAUTHENTICATED | 401 | 重新认证或更换机器 token。 |
| FORBIDDEN / DISCLOSURE_DENIED | 403 | 停止，申请具体授权；不可自行扩大范围。 |
| VALIDATION_FAILED | 400 | 修正输入，不重试相同请求。 |
| VERSION_CONFLICT / IDEMPOTENCY_CONFLICT | 409 | 拉取当前授权视图并重新决定，不能覆盖。 |
| REQUEST_EXPIRED | 410 | 重新提出契约，不接受旧版本。 |
| RESYNC_REQUIRED | 409 | 清理相应流的旧状态并取新快照。 |
| BUDGET_EXCEEDED / DEPENDENCY_BLOCKED | 409 | 等待有权者或依赖恢复。 |
| RATE_LIMITED | 429 | 遵守 Retry-After，带抖动退避。 |
| ACTION_OUTCOME_UNKNOWN | 409 | 核对既有 Action，禁止重建动作盲重试。 |
| SERVICE_UNAVAILABLE | 503 | 仅对声明可重试且幂等的操作退避。 |

列表使用不透明 cursor、默认 50/最大 200 条。投影序号、数据库 bigint 版本和微单位金额在 wire 上为十进制字符串，时间为 UTC。schema 中数值上限、枚举和字符串长度均显式限制。

## 3. V1 接口目录

### 3.1 身份、会话与通信

| 接口 | 输入与约束 | 结果 |
|---|---|---|
| `GET /v1/me`、`GET /v1/workspaces` | 当前身份与成员关系 | 可见身份、空间、功能能力。 |
| `GET/DELETE /v1/sessions/{id}` | 本人或有权管理员 | 设备会话状态/撤销。 |
| `POST /v1/conversations` | 类型、允许邀请成员、历史策略 | 会话及 version。 |
| `GET /v1/conversations`、`GET /v1/conversations/{id}` | 授权分页 | 当前可见摘要。 |
| `POST /v1/conversations/{id}/members`、`DELETE /v1/conversations/{id}/members/{principal_id}` | 成员、角色、历史范围 | 成员变化与权限 generation。 |
| `POST /v1/conversations/{id}/messages` | 内容、附件、reply/thread、客户端 ID | 已持久化消息，不表示已读。 |
| `PATCH/DELETE /v1/messages/{id}` | If-Match、正文或删除理由 | 新版本或墓碑。 |
| `POST /v1/messages/{id}/reactions`、`DELETE /v1/messages/{id}/reactions/{reaction_id}` | 允许的反应类型及当前主体 | 幂等反应状态。 |
| `POST /v1/conversations/{id}/read-cursor` | 已授权且实际展示的位置 | 用户已读更新，与 transport ACK 分离。 |
| `GET /v1/streams/{id}/snapshot`、`GET /v1/streams/{id}/events` | 身份绑定 cursor/快照 token | 固定投影快照或增量。 |
| `GET /v1/inbox`、`POST /v1/inbox/{id}/dismiss` | 当前主体，分页 | 待处理事项；dismiss 不替代审批等业务动作。 |

### 3.2 工作、接单与验收

| 接口 | 必需业务语义 |
|---|---|
| `POST /v1/tasks` | 目标、初始 owner、accountable、输入、验收、预算、期限；指定他人须授权或待接单。 |
| `GET/PATCH /v1/tasks/{id}` | 当前 ACL、If-Match；变更目标生成新版本并评估授权是否失效。 |
| `POST /v1/tasks/{id}/conversation-links` | 明确公开内容与 scope，不授予任务本体权限。 |
| `POST /v1/tasks/{id}/participants`、`DELETE /v1/tasks/{id}/participants/{principal_id}` | 角色和允许范围；参与者不成为 owner。 |
| `POST /v1/tasks/{id}/dependencies` | 同租户、无环、有规模上限；跨根变更按租户 dependency_graph 锁串行查环。 |
| `POST /v1/tasks/{id}/requests` | consult/review/delegate/handoff 与完整提案。 |
| `POST /v1/requests/{id}/decisions` | 提案版本、accept/reject/clarify；身份不能由 body 指定。 |
| `POST /v1/tasks/{id}/submissions` | 固定产物版本、来源、证据、适用目标版本。 |
| `POST /v1/tasks/{id}/reviews` | 具备验收权限者接受或退回指定 submission。 |
| `POST /v1/tasks/{id}/cancel`、`.../reopen`、`.../takeover` | 显式命令、理由、If-Match；同步处理 epoch。 |

owner 不能通过通用 PATCH 任意改写；负责权只经接受的交接、符合契约的委派接受或有权接管更新。验收、审批、请求决定的不可变历史记录不允许通用 PATCH。

### 3.3 Agent、执行与行动

| 接口 | 必需业务语义 |
|---|---|
| `GET /v1/agents`、`GET /v1/agents/{id}/capabilities` | 按安装与可发现范围过滤。 |
| `POST /v1/agent-installations`、`.../{id}/credentials`、`.../{id}/revoke` | 管理安装、能力与凭证，不自动授予全部会话。 |
| `POST /v1/machine-tokens` | 安装凭证交换短期 token，scope 取允许范围交集。 |
| `POST /v1/agent-runs` | task 或 conversation scope、Agent revision、触发来源、预算。 |
| `GET /v1/agent-runs/{id}`、`GET /v1/agent-runs/{id}/context` | 分开公开状态与有权查看的 ContextManifest。 |
| `POST /v1/agent-runs/{id}/inputs`、`.../pause`、`.../resume`、`.../cancel` | 等待条件、状态版本和命令幂等；不重开终结 Run。 |
| `POST /v1/agent-runs/{id}/reports`、`.../heartbeat` | 外部报告验证 lease_generation、契约和字段白名单。 |
| `POST /v1/actions`、`GET /v1/actions/{id}` | 固定 Task、工具、输入版本、影响、参数指纹与业务键。 |
| `POST /v1/approvals/{id}/decisions` | 人/组织明确授予的批准者、动作版本、一次性决定。 |
| `POST /v1/actions/{id}/receipts`、`.../reconcile` | 验证回执来源；核对不重新执行原动作。 |
| `POST /v1/grants/{id}/revoke` | 更新权威授权 fence，后续动作失效。 |

### 3.4 资源、搜索与治理

| 接口 | 必需业务语义 |
|---|---|
| `POST /v1/uploads`、`POST /v1/uploads/{id}/complete` | 限定对象、大小、类型、校验；服务端扫描前不可使用。 |
| `GET /v1/resources/{id}/content` | 当前读取/披露权限，受控内容出口。 |
| `POST /v1/artifacts`、`POST /v1/artifacts/{id}/versions` | Artifact 身份与不可变内容版本分离。 |
| `GET /v1/artifacts/{id}/versions`、`POST /v1/artifacts/{id}/comments` | 授权读取、版本化评论锚点。 |
| `POST /v1/memories`、`PATCH/DELETE /v1/memories/{id}` | 范围、来源、确认、期限；修改使用 If-Match。 |
| `GET /v1/search` | 租户、可见对象、语言与分页；禁止泄漏受限计数和摘要。 |
| `POST /v1/schedules`、`PATCH/DELETE /v1/schedules/{id}` | 时区、触发、期限、预算、错过/重叠策略。 |
| `POST /v1/notification-subscriptions`、`DELETE /v1/notification-subscriptions/{id}` | 设备绑定、许可与安全目的地检查。 |
| `POST /v1/exports`、`GET /v1/exports/{id}`、`POST /v1/deletion-requests` | 持久处理与回执，导出在下载时再次验权。 |

完整 OpenAPI 在对应工作包完成时必须包含所有实际启用端点、schema、权限、错误和示例；未实现端点不能在能力发现中宣称可用。

## 4. 结构化请求与事件示例

### 4.1 接受交接

```json
{
  "decision": "accept",
  "proposal_version": "3",
  "expected_task_version": "12",
  "comment": "已确认待处理行动和资料范围"
}
```

服务器在事务中核对实际接收者、任务 owner、版本、期限、必要权限与能力，随后一次性更新负责权。相同幂等请求返回既有 agreement；一个 Agent 不能替另一个主体发出接受。

### 4.2 面向接收者的投影消息

```json
{
  "type": "projection.upsert",
  "protocol_version": 1,
  "stream_id": "str_project_01",
  "projection_id": "prj_run_card_01",
  "projection_revision": "4",
  "event_id": "evt_run_waiting_01",
  "entity": { "type": "agent_run", "id": "run_01", "version": "9" },
  "cursor": "opaque-authenticated-cursor",
  "schema_version": 1,
  "payload": {
    "status": "waiting_approval",
    "summary": "公告已准备，等待批准发送",
    "approval_ref": "apr_01"
  }
}
```

这里仅示范安全公开字段，不能包含私有上下文、未授权 Task 标题或秘密。event_id 关联原事实，projection_id/revision 负责视图去重；entity.version 仅在相同主体、view_scope、projection 和授权代际内辅助防止乱序覆盖。投影修订和撤回优先，不能用更高实体版本覆盖受限投影。HTTP 查询也携带 view_scope/authz_generation/版本上下文，不同权限视图分别缓存。stream 内部序号不明文放在 cursor 中。

## 5. WebSocket 与恢复协议

浏览器升级连接使用会话 Cookie 和严格 Origin 检查；机器连接使用支持的 Authorization header。不得把长期 token 放进 URL/query 或日志。必须跨域的部署另行定义明确允许来源，禁止凭据模式下通配来源。

| 帧 | 方向 | 含义 |
|---|---|---|
| hello / welcome | 双向 | 协议版本、连接 ID、心跳和能力协商；身份来自认证。 |
| subscribe / subscribed | 双向 | 指定授权 stream 和 cursor，服务器验证订阅范围。 |
| projection.upsert / projection.remove | 服务端→客户端 | 持久投影变化、删除或受控墓碑。 |
| ack | 客户端→服务端 | 已持久应用/接收的游标；不是已读或接单。 |
| resync_required / access_revoked | 服务端→客户端 | 作废相应缓存和 cursor，停止旧流。 |
| ping / pong | 双向 | 连接存活，不能当任务执行心跳。 |
| presence / typing | 双向 | TTL 临时状态，限频、不持久化为业务事实。 |

订阅过程使用“建立唤醒监听 → 读取已提交增量至水位 → 继续读取数据库”的循环；唤醒只是提示，即使先到或丢失仍由周期补查收敛。首次/失效同步使用第 02 篇一致快照会话，分页期间重新验权。慢客户端有缓冲上限，超限断开并续传，不无限占内存。

流式模型 token 使用独立的短期 `run.output.delta` 通道，具有 chunk index 和租约代际，断线允许丢失临时片段；最终回复/产物经持久提交才成为事实。不能用临时 token 事件推进任务完成或已读游标。若需要完整流回放，使用有保留范围的输出缓冲，仍不把每个 token 写成领域事件。

## 6. 托管 Agent Runtime

### 6.1 ModelAdapter 与 RuntimeStep

ModelAdapter 输入为实际获准上下文、工具 schema 的受限投影、生成选项和取消信号；输出为文本增量、候选 tool call、结构化结果、finish reason、用量及供应商 request ID。适配器声明支持的结构化输出、图像、并行工具和取消能力，缺失能力不伪装成功。

RuntimeStep 是有限执行步骤，引用 Run、step_no、checkpoint、Task/lease/grant 代际和预算 reservation。步骤只有在当前状态允许时领取；遇到审批、输入或依赖后持久化等待条件并释放执行槽。Worker 不在数据库事务中等待网络或人工。

```text
job(intent_id)
  → 加载授权范围内的 Run，领取有限租约
  → 重验 Task/祖先/Agent 安装/Grant/期限
  → 预占本步预算，构造 ContextManifest
  → 在事务外调用模型或受控工具
  → 仅把模型返回解释为候选回复/动作
  → 短事务提交检查点、结果、事件及下个 intent
  → 释放或结算适用资源
```

模型纯生成失败可按预算和错误类型重试；若候选工具已进入 Action，恢复查 Action 记录，不重复发明新的业务键。模型调用本身可能被计费，超时后的 token/费用是待核对用量，不能简单视为免费失败。

### 6.2 检查点与恢复

检查点保存步骤状态、输入资源版本、已确认回执、产物引用、等待条件、可恢复模型上下文及实际配置版本，不以隐藏推理链为恢复前提。正文按敏感度存受控对象，队列只有引用。

正常同一 Run 的暂停恢复保留 Run ID；终结 Run 重试创建新 Run 并关联 previous_run_id。接管租约增加 lease_generation；心跳及普通提交必须同时验证 holder、generation 和未过期的数据库当前时间，即使尚无接管者也拒绝已过期 Worker。迟到回执可经独立受限路径记录。

恢复扫描器检查 Run 状态和持久 intent：queued 无任务唤醒则重建；租约超时则核对在途 Action 并接管/结束；审批已决定则恢复等待条件；期限到达进入 expired；unknown 不自动继续原动作。所有扫描带批次、锁、退避和死信处理。

### 6.3 多 Agent 与上下文

协调 Agent 通过 Task/Request 用例拆分，不能在模型内维护唯一任务图。内部和外部 Agent 都必须接受契约。并行只允许在祖先授权、预算及资源冲突允许时进行；子 Agent 输出默认不递归触发同一规则。

上下文组装记录实际引用、版本、分类、处理目的和模型目的地；历史摘要与记忆在当前访问条件下使用。Agent 有读取权限不等于可以把结论发往当前会话，全程经披露决策。未经授权的来源标题也不能出现在引用中。

## 7. 行动网关、审批与 unknown

### 7.1 提议与执行

Action 固定主体、Task/Run、工具版本、资源版本、目标/受众、规范化输入、内容 hash、预算和授权依据。JSON 规范化采用固定序列化规则，二进制内容按不可变 blob hash 引用；同一字节指纹不等于拥有权限。

审批 decision 与一次性授权消费分别记录。执行前锁住适用 fence、任务祖先、Action、审批和预算，检查当前状态并创建唯一 ActionAttempt/执行意图。tool-runner 领取受限短期执行令牌，不能修改 input；每个连接器必须明确网络超时、业务幂等键、幂等有效期、结果查询和补偿能力。

工具调用在事务外执行。发包前尽力重查短期资格，实际发包与平台撤销仍不能建立跨系统原子性；已经准入的请求属于可能在途的动作，取消界面必须展示这一边界。

为避免数据库按 RPO 恢复后遗失外部已执行事实，发包前还必须将 action_id、attempt_id、业务幂等键、参数指纹和执行时刻写入不会随业务数据库回退的独立行动意图日志，确认持久化后才发送。日志不含秘密和完整正文，回执随后追加；日志不可用时停止新的外部副作用。恢复时先从该日志重建跨恢复点的核对范围，不能仅信任旧备份里的 pending 状态，具体流程见第 05 篇。

### 7.2 结果判定

| 观察 | 记录和后续行为 |
|---|---|
| 确认未发送且没有外部影响 | 标记可安全重试的尝试失败；仍用原 Action/参数/业务键。 |
| 供应方明确成功且回执可验证 | succeeded，保存外部 ID、结果与计费。 |
| 供应方明确失败并有足够证据 | 本次 Attempt failed；确认无既成副作用且获准重试时重新验证后回到 Action ready，否则 Action 终结 failed。 |
| HTTP 超时、连接断开、Worker 在提交后崩溃 | unknown，先查询/核对；不得当普通网络异常重试。 |
| 查询暂未找到 | 保留 unknown，除非供应方语义足以证明未执行。 |
| 外部幂等键已过期 | 不再假定同键可以安全重发，转核对或人工。 |

核对作业只有查询、记录回执和结算权限，无权重新执行原动作。任务关闭后也允许记账与事实记录。重复回执按来源和外部 ID 去重；互相矛盾的回执进入人工核对，不覆盖已确认事实。

安全重试路径为 `executing → ready`，Action 保存 next_attempt_at 与累计尝试次数；新 Attempt 复用同一 Action、指纹和业务幂等键，审批消费始终绑定这一业务行动。重试仍重验审批有效性、预算和全部执行代际；unknown 不走该路径。已终结的 failed/succeeded/cancelled Action 不原地重开；确需另一次业务行动时重新创建并明确授权。

补偿是新 Action，引用原行动并独立鉴权/审批；它可能失败，不能把补偿标为“原操作从未发生”。

## 8. 外部 Agent V1 协议

选择主动拉取：installation 认证 → 发现能力/收件箱 → 读取有权查看的 Request → 接受/拒绝 → 领取或创建已授权 Run → 心跳/报告 → 提交 Artifact 和 submission → 等待验收。浏览器或普通 Agent 的 inbox ACK 不能隐式触发接单。

Run 由服务器生成 lease_generation 和执行资格；外部 Agent 自报 progress 不直接决定 Task 状态。提交时检查 proposal/Task/Run 版本、产物结构和披露权限；仅允许具备验收能力的主体调用 review。

取消通过 inbox/Run 状态传达，同时平台立即失效新资源/工具授权。远端没有确认时显示 cancellation_requested/unconfirmed 等观察字段；平台 lease 结束不证明远端进程已停止。外部 Agent 带自身凭证执行的行为标为其自主边界，平台不能声称被完全拦截。

Task cancel/failed 在任务根锁保护的同一事务中将本任务及后代任务的非终态 Run 标记 cancellation_requested：仍持有效运行租约的置 cancelling，其余置 cancelled 并清除租约。不会生成停止确认、恢复执行代际或释放未结费用。相同事务撤销 proposed/awaiting_approval/ready Action 及其审批；executing/unknown 和回执保留待核对。该联动由 API 显式注入 Task 服务；缺少联动且存在待处理执行时返回 SERVICE_UNAVAILABLE 并回滚任务状态。后代 Task 自身合同状态不自动改写，祖先终态/epoch 仍负责阻断执行。完成验收使用独立闭合门禁。

取消观察补充：Task 终止可能令 Run 固定输入版本失效。Run 状态读取仍验证当前调用者权限、创建者和 Agent 身份；仅已请求取消且输入版本冲突时返回不含 summary/output 的运行状态与费用元数据。上下文接口不豁免原内容/权限校验，避免用观察取消状态绕过历史内容访问限制。


V1 提供最小 TS SDK 和独立示例 Agent，以 HTTP/WS 契约接入。Python 等实现可以直接调用 API；后续再发布语言 SDK、设备连接和外部标准适配器。SDK 自动处理传输退避，不自动接受任务、审批或重试未知 Action。

## 9. Schedule 与触发规则

Scheduler 周期扫描 due schedules，锁定计划后按时区计算 occurrence。唯一键为 schedule_id+revision+scheduled_instant；保存原时区与本次 UTC 时刻。生成 occurrence 与 dispatch intent 在同一事务内完成。

默认错过执行策略为合并补一次，重叠为禁止；完整补跑只在显式开启且有上限时使用。夏令时不存在的本地时间默认跳过，重复本地时间默认执行第一次，界面显示下一次实际执行时刻。禁用/修改计划增加 revision；Worker 消费旧 occurrence 前检查有效 revision，旧唤醒不获得新资格。

触发事件绑定 causal root、trigger_id、depth 和 budget；循环检测与最大深度默认启用。每次自动跟进都形成 Task/Run 或已有目标的有限推进，不能绕过任务树预算。调度持久事实由本应用保存，pg-boss cron 仅作辅助唤醒，不能替代产品的错过、关闭和时区语义。[pg-boss 调度](https://pgboss.io/api/scheduling)

## 10. 初始运行参数与扩展点

开发环境默认：Run 步骤最多 20 次、单次模型请求超时 120 秒、工具超时按连接器定义、执行租约 60 秒且每 15 秒续约、最大委派深度 4、同根任务最多 4 个运行槽、默认请求有效期 24 小时。心跳丢失时先检查业务状态和在途行动，不靠单次定时器直接判定失败。这些值均可被组织更严格地限制，必须在 M0/M4 测量后冻结发布配置。

工具/模型/队列/存储/调度/协议均有端口适配，但身份、契约、Action 和投影语义保持稳定。引入持久工作流引擎、公开插件或跨组织 Agent 时，必须复用执行代际、核对和披露要求，并增加兼容和故障用例。

### 交接行动清单增量（2026-10-05）

人类端使用 `GET /v1/tasks/{id}/handoff-actions`，机器端使用 `GET /v1/machine/tasks/{id}/handoff-actions`。二者共享当前 owner 检查和 `TaskHandoffActions` 契约；机器端另需 `tasks.read` scope。返回 `task_id`、`task_version`、`pending_action_ids`，不返回行动参数或凭证。

SDK 提供 `getTaskHandoffActions(taskId)` 与 `createTaskRequest(taskId, version, input, idempotencyKey)`。Agent 必须把核对后的编号放入明确的 WorkProposal，再经 `tasks.write` 创建提案；收到、ACK、接受仍是分离命令。`HANDOFF_ACTIONS_CHANGED` 要求重新核对并提出最新条款，`HANDOFF_ACTIONS_LIMIT` 表示超过 100 项且没有返回截断清单。权限失败不能降级成空数组继续提交。

详细并发边界、已完成引用及子任务范围见 [DEV-ADR-11](07-implementation-decisions.md)。

## 组织工作区成员管理（2026-10-05 增量）

`/v1/organization/access`、`/workspaces`、`/candidates` 及 `/workspaces/{id}/members` 提供 human 管理入口。创建使用 `CreateManagedWorkspaceInput`；成员写入使用 `SetWorkspaceMemberInput`，If-Match 指工作区版本，角色/状态/理由均显式提交。`LAST_WORKSPACE_ADMIN` 是 409 拒绝；`VERSION_CONFLICT` 后需重新核对，不能自动覆盖。

列表每页最多 100 条并使用调用者、授权修订和用途绑定的游标。事件 `workspace.created` 与 `workspace.member_changed` 与写入同事务提交；工作区事件不投影为会话正文。完整路径、DTO 和鉴权要求以生成 OpenAPI 为准，操作范围见 [组织管理](../operations/organization-management.md)。
