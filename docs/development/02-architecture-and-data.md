# 02 工程架构与数据设计

版本：1.0 · 2026-10-04 · 上级：[开发设计索引](README.md)

## 1. 进程与权威状态

V1 使用四个可独立部署的进程入口，共享经过版本控制的应用层。它们是资源与信任边界，不是四套业务系统。

| 入口 | 职责 | 禁止事项 |
|---|---|---|
| `apps/web` | 静态 Web/PWA 产物 | 包含服务端凭证、直连数据库或自行判定审批。 |
| `apps/api` | OIDC 会话、HTTP/WS、命令处理、授权读取 | 同步等待长时间模型或外部工具调用。 |
| `apps/worker` | outbox、投影、唤醒、Run 步骤、核对、文件与通知作业 | 依赖进程内内存保存唯一任务状态。 |
| `apps/tool-runner` | 有限受控工具、目的地限制、凭证代理与回执 | 获得任意业务表写权限、任意 shell 或全租户秘密。 |

初期 worker 按队列角色启动同一构建产物，例如 dispatcher、projector、runtime、maintenance；分别配置并发、连接池和网络出口。工具执行进程通过应用服务接口领取动作及提交回执，不能直接修改审批。

PostgreSQL 保存业务权威状态。pg-boss 是可重建唤醒层；S3 保存正文和二进制对象；客户端缓存、搜索文档和实时投影均是受控派生数据。权限、Action 准入、预算、租约和验收判断读取主库。

## 2. 计划中的仓库结构

以下目录由 M0 起逐步建立；本次开发设计提交不表示这些应用已经存在。

```text
apps/
  web/                 # React 客户端
  api/                 # Fastify 路由、认证、WS
  worker/              # 不同工作角色的启动入口
  tool-runner/         # 独立的工具执行入口
packages/
  contracts/           # JSON Schema、OpenAPI、事件、生成类型
  domain/              # 纯状态规则、值对象和不变量
  application/         # 用例、事务编排、资源与角色检查
  db/                  # SQL、Kysely、迁移、RLS、事务适配器
  policy/              # 读/执行/披露决策与审批规则
  agent-runtime/       # 步骤协调、检查点、预算与模型意图解析
  model-adapters/      # 各供应商、流、用量和假模型
  tool-adapters/       # 受控连接器契约与结果核对
  sdk/                 # TS HTTP/WS Agent 与客户端 SDK
  ui/                  # 客户端设计系统及安全卡片
  observability/       # 日志、trace、指标和脱敏
  testkit/             # 双租户数据、外部系统模拟器、故障屏障
infra/                 # Compose、镜像、反向代理、监控配置
tests/                 # 集成、端到端、故障、负载、恢复
docs/                  # 产品、开发、后续 ADR 与运维手册
```

`domain` 不导入 Fastify、数据库或模型 SDK。`application` 依赖 domain、policy 和端口接口；db/model/tool 适配器实现端口。入口负责组合，不跨模块直接操作其他模块内部表。contracts 不依赖 domain 的内部实体，避免把数据库字段泄漏为 API。

通过 package exports、ESLint/import 规则和依赖图检查强制边界。包是源码组织单元，不意味着独立发布或独立服务。初期只发布 SDK，需要时再拆其他包。

## 3. 模块及数据所有权

| 模块 | 拥有的数据与命令 | 主要输出 |
|---|---|---|
| Identity | 主体、会话、设备、租户成员、Agent 安装 | AuthContext、撤销版本。 |
| Communication | 会话、消息、回复、反应、已读 | 授权消息视图和通信事件。 |
| Work | Task、依赖、参与者、契约、交接、验收 | 负责权、目标版本与执行代际。 |
| Execution | Run、租约、检查点、输入与唤醒 | 有限步骤、等待与执行观察。 |
| Action | Action、Attempt、Approval、Receipt | 获准动作、未知结果和核对。 |
| Resources | 附件、产物、版本、记忆与来源 | 可访问的内容引用与披露范围。 |
| Policy | Grant、代理授权、ACL、策略与撤销 fence | 带理由的允许/拒绝/需审批决定。 |
| Budget | 账户、预占、用量、并发槽 | 一致的费用和配额归属。 |
| Delivery | 事件、outbox、投影、订阅与通知 | 可恢复且不泄漏权限的事件流。 |
| Governance | 删除、保留、导出、审计 | 生命周期控制和可核对回执。 |

跨模块命令通过 application 在同一数据库事务内调用明确的 repository 接口。例如交接同时影响 Work、Policy、Execution 和 Delivery，不通过异步事件最终决定 owner。

## 4. 数据约定与租户隔离

### 4.1 基本约定

- 数据库用 snake_case；API 也采用 snake_case，SDK 可以生成辅助类型但不改变 wire 字段。
- UUID 表示实体 ID；内部时间为 `timestamptz`，API 为 UTC RFC3339，显示时使用用户时区。
- `version`、序号和费用使用 `bigint` 或适当精度 `numeric`；JSON 用十进制字符串传输可能超出 JS 安全整数的值，禁止隐式 `Number()`。
- 金额为带币种的整数微单位，计价规则单独版本化；模型 token 和调用次数为非负整数。
- 可删除正文存对象或专门 payload 表；元数据只保存必要引用。JSONB 仅用于有 schema 的扩展、工具输入和模型元信息，不替代外键、状态和预算字段。

### 4.2 全局身份与租户内主体

`principals` 保存全局身份，`external_identities(issuer, subject)` 映射 OIDC；租户内的 `tenant_principals(tenant_id, principal_id)` 是成员或 Agent 安装的合法主体关系，包含状态与撤销 revision。Task 的 owner、责任主体和参与者引用该关系，避免仅凭一个全局 ID 成为租户 owner。

离开组织时主体关系变为禁用/历史状态，不直接删除被任务引用的身份；显示资料按删除政策匿名化。任务状态处理遵循产品中的兜底和显式接管规则。

### 4.3 RLS 与连接池

业务表统一使用 `(tenant_id, id)` 唯一键或主键，外键包含 tenant_id。应用角色不是表 owner、superuser 或 BYPASSRLS；启用并强制 RLS。每个数据库事务固定一条连接，由可信 AuthContext 设置事务局部租户变量，未设置时拒绝访问。

```sql
SELECT set_config('imbox.tenant_id', $1, true);

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY tasks_tenant_isolation ON tasks
  USING (tenant_id = NULLIF(current_setting('imbox.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('imbox.tenant_id', true), '')::uuid);
```

这是迁移模式示例，需要对每个租户表应用。`SET LOCAL` 必须位于事务中，不得在池连接上设置会话永久变量。RLS 是租户防御层，不代替资源 ACL，也不能防止持有应用数据库角色的任意 SQL 自行改变 GUC。多个 permissive policy 的 OR 合并必须审查；约束错误统一映射，防止泄漏其他租户对象是否存在。[PostgreSQL RLS](https://www.postgresql.org/docs/18/ddl-rowsecurity.html)

身份查询、迁移、备份、pg-boss 调度和跨租户维护采用分开的数据库角色。跨租户 dispatcher 只读全局路由表中的 tenant_id、intent_id 和运行时限等最小元数据，随后使用租户受限事务处理正文；不能给整个 Worker 集群 BYPASSRLS。

## 5. 表组、关键字段与索引

所有可变业务表带 created_at、updated_at、version；需要保留历史的状态迁移另写事件。下表为迁移拆分依据，完整字段由 M0-M2 的 schema 与迁移补齐。

| 表组 | 必需字段/约束 | 主要索引 |
|---|---|---|
| principals、external_identities、sessions、devices | 身份类型、issuer/subject 唯一、token_hash、失效时间、撤销版本 | session/token hash 唯一、设备主体。 |
| tenants、workspaces、tenant_principals、memberships | 复合身份关系、状态、角色；不把 workspace_id 当 tenant_id | tenant+principal、scope+role。 |
| agent_profiles、agent_revisions、agent_installations、machine_credentials | 配置不可变版本、执行模式、能力、归属、token hash | tenant+agent、installation+revision。 |
| conversations、conversation_members、messages、message_revisions、reactions | 会话成员历史范围、thread_root、reply_to、消息版本、删除墓碑 | conversation+message order；message+revision；反应唯一键。 |
| tasks、task_participants、task_conversation_links | root/parent、owner、accountable、scope、status、execution_epoch、验收定义 | tenant+owner+status；root_task_id；parent_task_id；link 唯一。 |
| task_dependencies、task_submissions、task_reviews | 无环依赖、固定产物版本、验收主体/规则与证据 | dependent/prerequisite；submission+reviewer。 |
| collaboration_requests、agreements | kind、proposal_version、request/recipient、expires_at、accepted_version | task+kind+status；recipient+pending。 |
| agent_runs、run_leases、run_checkpoints、run_inputs | nullable task、origin_scope、agent_revision、lease_generation、状态、epoch 链 | task+created_at；state+next_wakeup；run+checkpoint_no。 |
| capability_grants、grant_dependencies、approvals、policy_fences | 授予来源、范围、revision、参数指纹、一次性消费动作 | grantee+scope；action+proposal_revision；依赖祖先。 |
| actions、action_attempts、action_receipts、reconciliation_cases | 稳定业务键、actor、Task/Run、动作指纹、外部幂等到期、unknown 原因 | tenant+business_key 唯一；action+attempt_no；external receipt 去重。 |
| budget_accounts、budget_reservations、usage_records、execution_slots | 父子额度、reserved/settled、币种、计价版、原子计数 | reservation_key 唯一；provider usage 去重；root+state。 |
| attachments、artifacts、artifact_versions、comments、resource_links | blob_ref、checksum、scan_state、不可变版本、评论锚点与ACL | resource+version；storage_ref；source/target 反向关系。 |
| context_manifests、context_items、memories、memory_revisions | 实际来源版本、敏感度、处理目的、确认与到期状态 | run；owner_scope；expires_at；source_ref。 |
| domain_events、outbox、consumer_receipts、dispatch_intents | aggregate_version、event_id、目标、状态、重试、租约 | 聚合版本唯一；未处理部分索引；consumer+event 去重。 |
| projection_streams、projections、projection_deliveries | head_seq、ACL generation、projection_id/revision、授权 DTO | stream+seq 唯一；stream+projection+revision 唯一。 |
| subscriptions、read_cursors、inbox_items、notification_attempts | 订阅权限、未读位置、需要处理动作、推送回执 | principal+stream；principal+unresolved。 |
| schedules、schedule_occurrences、triggers | timezone、版本、启用、missed/overlap 策略 | next_due；schedule+revision+instant 唯一。 |
| search_documents、deletion_requests、deletion_targets、audit_records | 受控文本、来源、删除代际、保留期限、完成证据 | source；deletion+target；tenant+audit time。 |

Task 的父子写入需加任务树锁并检查环。允许同租户跨根依赖；全部依赖边增删先取得租户级 dependency_graph 事务锁，再按顺序取得相关根锁、检查整图无环并写入。只锁一条新边两端不能防止多事务共同成环。V1 parent/root 创建后不可原地改挂；独立继续通过显式新目标/授权关联，不在线重写整棵树。一个 Task 可以关联多个 Conversation，同租户关联不授予访问权。

## 6. 关键约束示例

以下 DDL 展示必须落实的约束，不是可直接部署的完整迁移：引用的主体、租户和会话表需要先创建。

```sql
CREATE TABLE tasks (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  root_task_id uuid NOT NULL,
  parent_task_id uuid,
  owner_principal_id uuid NOT NULL,
  accountable_principal_id uuid NOT NULL,
  status text NOT NULL CHECK
    (status IN ('open','active','blocked','in_review','completed','failed','cancelled')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  execution_epoch bigint NOT NULL DEFAULT 1 CHECK (execution_epoch > 0),
  goal text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, root_task_id) REFERENCES tasks(tenant_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, parent_task_id) REFERENCES tasks(tenant_id, id),
  FOREIGN KEY (tenant_id, owner_principal_id)
    REFERENCES tenant_principals(tenant_id, principal_id),
  FOREIGN KEY (tenant_id, accountable_principal_id)
    REFERENCES tenant_principals(tenant_id, principal_id),
  CHECK (parent_task_id IS NULL OR parent_task_id <> id)
);

CREATE TABLE task_conversation_links (
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  disclosure_scope_ref uuid NOT NULL,
  PRIMARY KEY (tenant_id, task_id, conversation_id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks(tenant_id, id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations(tenant_id, id)
);
```

根任务 `root_task_id=id` 且 parent 为空；子任务 root 必须与祖先一致，由受锁用例验证，必要时增加约束触发器。循环检查不能仅依赖上述 self-FK。不得使用 `ON DELETE CASCADE` 顺带抹掉任务、审批或行动审计。

Action 必須绑定 Task；普通当前会话回复仍是通信命令。Run 的 task_id 可空但 origin_scope 必须合法；会话问答升级后保存原始作用域，并增加任务关联，不抹去之前的权限和执行事实。

## 7. 事务模型与锁顺序

### 7.1 通用命令事务

身份解析与输入结构校验 → 开始租户事务 → 幂等命令行领取 → 取得相应业务锁 → 重查授权/状态/版本 → 变更权威数据 → 写 DomainEvent 与 outbox/intent → 保存命令结果引用 → 提交 → 返回。

幂等记录包含主体、租户、操作、key、请求规范化哈希、完成状态和结果引用。相同 key 不同内容返回冲突；重放响应时重新做当前访问检查，不能凭幂等缓存读到已撤权的正文。命令保留至少覆盖客户端最大重试期限，Action 的业务去重保留遵循更长的业务周期。

默认 READ COMMITTED 配合显式锁/条件更新。状态机转移中不能先无锁读取状态再无条件写入。序列化失败或死锁可以有限次数重试整笔纯数据库事务，事务内禁止模型和外部网络调用。

### 7.2 V1 加锁策略

任务树内的负责权、生命周期、依赖、Action 准入和预算操作先获取同一 `pg_advisory_xact_lock`，键由 tenant+root_task_id 稳定映射。V1 接受同一根任务下短事务串行的代价；哈希碰撞只导致额外串行，不能作为权限判断。跨根操作按排序后的锁键获取，禁止任意锁顺序。

统一顺序为：租户策略 fence → 相关主体/安装 fence（按 ID）→ dependency_graph 锁（仅变更依赖图时）→ 根任务锁（排序）→ Task 祖先行（根到叶）→ 请求/Run/Action 行 → Grant/审批/资源 fence（分类及 ID 排序）→ 根及祖先预算 → 聚合版本与投影 stream_head。读取授权 fence 使用会与撤销更新冲突的 `FOR SHARE` 或更强锁；不用不足以阻止普通字段更新的 `FOR KEY SHARE`。[PostgreSQL 锁规则](https://www.postgresql.org/docs/18/explicit-locking.html)

撤销用例只更新自己拥有的 fence/grant 并发出后续处理事件，不在持有靠后锁时回头申请任务树锁。新增用例必须列出锁序；一个步骤若需多资源，应先完成允许范围解析再按固定顺序加锁并重验。

### 7.3 交接、取消和重开

交接接受在同一事务检查提案、owner/version、接收者和必要权限，更新 owner 与 execution_epoch，固定 agreement，关闭竞争请求，失效旧 grant，并写事件。已接受相同决定幂等返回；另一请求或版本冲突不得“最后写入覆盖”。

取消/完成/失败递增适用 Task epoch；后代 Action 检查全部祖先 epoch 与生命周期，因此无需等待后代状态传播即可阻止新准入。重开使用新 epoch/new Run/new grant；旧 Run 不能因 Task 再次 active 恢复资格。独立继续的工作有新的目标与预算，保留历史关联。

Action 准入事务与撤销 fence 更新之间有清楚的线性化顺序：撤销先提交则准入失败；准入已提交则记录为在途，工具执行前再尽力重验。跨网络提交仍不原子，不能以数据库锁宣称能停止已获准的外部请求。

## 8. 租约与层级预算

Run 使用 `lease_generation` 防重复 Worker，Task 使用 `execution_epoch` 防旧负责权，Grant 使用 revision 防撤权后复用。三者必须分别保存与检查，不能以某一租约替代其他权限。

租约用数据库时间、holder、generation、expires_at 表示。心跳、普通结果/检查点和状态写入同时要求 holder 匹配、generation 匹配、expires_at 大于数据库实际当前时刻；执行比较使用当前时钟而非长事务开始时的旧时间。即使还没有新 Worker 接管，过期持有者也不能续约或提交；到期恢复必须重新领取并增加 generation。晚到回执走观察事实接口，不获取新的执行资格。

预算采用一份根消费账本，子预算是消费上限，祖先计数用于约束而不重复计费。每个步骤在同一短事务锁根和相关祖先预算、验证未结算+已结算+本次预占不超过上限，然后生成唯一 reservation。执行结束按唯一 usage/receipt 结算或释放，重复报告不重复扣费。

模型费用估算、真实账单、计算并发槽和外部在途操作分别记录。Worker 退出可释放其本地计算槽，但 unknown Action 的费用预占和远端在途标记不能因此释放。超估算记录差额并停止新增派发，不假装绝对金额封顶。

## 9. 事件、outbox 与持久作业

### 9.1 事件与可靠派发

DomainEvent 使用 `(tenant_id, aggregate_type, aggregate_id, aggregate_version)` 唯一约束。业务事务同时写 outbox；dispatcher 短事务用 SKIP LOCKED 领取、提交租约，然后发送到 pg-boss。发送成功后标记完成；崩溃可能重复派发，由稳定 intent_id 和业务消费记录去重。[PostgreSQL SELECT](https://www.postgresql.org/docs/18/sql-select.html)

consumer receipt 与消费造成的数据变化同事务提交。多受众 fanout 的工作键包含 event_id、目标 scope 和 projector_version，各目标单独完成；不能投递了其中一个目标就认定全部送达。

`dispatch_intents` 持久保存 type、tenant、resource_id、generation、due_at、status 和重试控制；pg-boss job 仅传受控引用。即使队列条目被清理，也能由扫描待处理 intent 重建。队列的自动 retry 只能重复领取业务步骤，不能盲目再次执行外部副作用。

### 9.2 顺序与缺口

SKIP LOCKED 和多个 Worker 不保证同一聚合事件顺序。projector 的消费进度键至少包含 tenant_id、projector_version、target_scope、aggregate_type、aggregate_id，不能让先完成的受众使其他受众的同版事件被跳过。仅处理该目标的下一版本，不相关事件也按 no-op 推进；checkpoint、receipt 与对应投影在同一事务提交。

缺口先重取缺失事件再重试，死信阻断相应聚合/目标后续推进并报警。新受众通过获授权历史/当前快照建立明确 baseline_version，再接后续版本；已清理历史不能被假定永远从 1 重放。压缩进度可以另有明确的“取最新授权快照”投影类型，但消息新增、删除和审批等关键事实不随意跳过。

LISTEN/NOTIFY 仅发送不含正文的唤醒提示，使用专用会话连接并辅以数据库扫描；断线不丢权威状态，也不能在 transaction-pooling 连接上依赖长期 LISTEN。[PostgreSQL NOTIFY](https://www.postgresql.org/docs/18/sql-notify.html)

## 10. 投影与同步游标

### 10.1 提交顺序安全的 stream

每个流有 `projection_streams.head_seq`。追加 delivery 的事务先锁 stream 行，递增 head，再写 materialized projection 与 delivery，直到提交才释放锁。禁止直接用 bigserial、UUID 时间或 created_at 的最大值作为已完整消费水位：较小值所在事务可能更晚提交。数据库 sequence 本身不提供提交顺序保证。[PostgreSQL 事务隔离](https://www.postgresql.org/docs/18/transaction-iso.html)

`projection_id` 表示某个受众视图，revision 表示视图版本；delivery_seq 表示该流中一次变化的位置。同一领域事件可以产生不同 projection_id，重投递同一变化不得分配新业务版本。客户端先核对主体、scope、projection 和授权 generation，再按投影修订/撤回更新；实体版本比较只适用于完全相同的可见视图，不能跨受众合并。

普通消息可在命令事务内生成会话基础投影，缩短可见延迟；私有任务/运行的公开摘要、个人 inbox 等投影异步生成。两种路径都使用同一 stream_head 规则。一个投影流只维护该受众范围的可公开 DTO；更敏感版本使用另一个 scope，读取和推送前仍重查当前权限。

### 10.2 快照、游标与权限变化

首次同步在一个 REPEATABLE READ 事务中读取已提交的投影表快照、同一流 head 和授权 generation，并创建短期分页快照会话/清单；多页读取必须固定该快照，不能每页另取当前业务表。完成后从快照 head 补齐 delivery，再继续在线拉取。

快照必须来自同一投影数据视图，不能将权威 Task 当前行与异步投影的任意最大序号拼成“无遗漏快照”。HTTP 实体查询也返回 view_scope、授权 generation 和适用的版本上下文；只有同一主体和视图内可防止实体版本倒退。公开投影修订/撤回优先于实体版本，私人 HTTP 结果不能合并进群体视图，较高实体版本也不能复活受限内容。

cursor 使用 AEAD 密文或服务端随机不透明句柄，绑定主体、租户、stream、权限 generation、保留 generation、扫描位置和有效期；单纯 Base64+签名不隐藏序号。更换权限、流重建或保留窗口过期返回 `RESYNC_REQUIRED`。空页也返回已扫描位置，不暴露隐藏事件数量。

V1 使用会话流、授权任务视图流和个人收件箱流，不提供全系统总序。跨流事件仅通过关联 ID 与实体版本联结。多个流的 cursor 独立持有。

## 11. 文件、检索与删除

上传创建 pending 元数据与限定对象键；客户端只可上传到对应租户隔离的暂存路径。完成通知后服务器核对实际大小、校验值和类型，扫描成功才变为 ready。扫描失败、过期上传和孤立对象走持久清理任务，不能把客户端报成功当作可读取依据。

消息、产物、记忆、上下文与检索文档通过 `resource_links` 记录来源及版本。删除先更新权威墓碑/访问 generation，立即阻止新读取，再清理 S3、索引、缓存和派生数据；每个目标有可重试状态与证据。数据库与对象存储没有跨系统事务，采用 staging/finalize 与孤立对象扫描收敛。

检索文档按资源和授权版本生成。先租户与可访问候选筛选，再全文/字符匹配，返回前重验；用户看不到未授权标题、片段和计数。删除传播未完成期间不能继续通过旧索引返回正文。

## 12. 迁移、数据规模与退出条件

每个迁移有固定 ID、校验和及审核记录。采用 expand → 双版本兼容 → 回填 → 切换 → contract；大表索引按数据库要求选择非事务并发创建方式。生产迁移用独立角色和锁，应用启动不自动竞争执行迁移。

回填分批、幂等、有断点，不持有长事务影响消息写入。RLS、外键、唯一性、版本和状态 CHECK 在迁移测试中覆盖；迁移前后都测试旧应用读写。备份恢复策略见第 05 篇，不能只验证空库安装。

首版先使用明确索引和冷热保留，不立即按所有字段分区。事件/投影/审计达到实测瓶颈时再按租户或时间分区，迁移不得破坏唯一性、授权 cursor 或删除传播。

本篇完成的工程门槛：在真实 PostgreSQL 下证明租户隔离、双交接接受、祖先取消与子 Action 竞争、预算并发预占、乱序投影、较小序号迟提交和幂等恢复均满足产品 INV；仅有 ORM mock 不算完成。
