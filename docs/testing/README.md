# 验证与回归执行说明

状态：持续开发中的验证记录，**不是 V1 准出报告**。完整范围见 [实施状态](../implementation-status.md) 和 [开发测试设计](../development/06-delivery-and-testing.md)。

本次结果与适用边界见 [测试报告](test-report.md)，发布门槛见 [准出记录](../release-readiness.md)。

## 环境与执行

使用仓库 `.node-version`、`packageManager` 和 `pnpm-lock.yaml` 固定的 Node.js 24 / pnpm 10 工具链。PostgreSQL 18 由 `infra/compose.yaml` 固定镜像摘要启动，开发和测试分别使用 `imbox_dev`、`imbox_test`；不得将测试 URL 指向业务数据库。迁移、应用、身份验证使用三个独立数据库角色。

```sh
pnpm install --frozen-lockfile
pnpm infra:up
pnpm verify
pnpm infra:setup:test
pnpm db:setup:test
pnpm test:integration
pnpm exec playwright install chromium
pnpm test:e2e
```

`verify` 检查运行环境、生成契约是否最新、构建、源代码及顶层测试类型、Lint 和单元测试。集成测试与浏览器测试单独执行，不能把只通过 `verify` 写成全系统通过。

顶层集成测试串行运行，隔离随机租户并连接真实 PostgreSQL。显式 bootstrap 会调整专用开发/测试角色权限，引导命令以事务锁串行化权限调整；正式报告仍按一套候选串行运行所有集合，避免测试负载互相影响。测试数据保留在专用测试库，便于失败分析；销毁 `imbox` Docker volume 会同时清除本项目的开发和测试数据，不能作为正常恢复步骤。

Playwright 使用独立测试会话与固定种子主体，自动启动本地 API、Web 和 Worker，端口为 4110 / 4173。浏览器通过真实同源代理访问 API，不替换业务响应。网络故障用例在服务器完成写入后丢弃响应，检验客户端恢复和服务器幂等。

## 回归集合

| 集合        | 文件                                                                                            | 核心断言                                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| DOMAIN      | `packages/domain/tests/*.test.ts`                                                               | 状态转移、负责权交接、全祖先 epoch、过期但尚未接管的租约、unknown 预算、重复结算、依赖无环与性质测试。    |
| CONTRACT    | `packages/contracts/test/*.test.ts`                                                             | Schema 2020-12、UTC、UUID、int64 字符串、未知字段拒绝、数据大小和结构、生成文件与 OpenAPI。               |
| DATABASE    | `packages/db/test/postgres.integration.test.ts`                                                 | 强制 RLS、非 owner 应用角色、缺失租户上下文、连接复用、复合外键、提交顺序、bigint 精度、事务回滚。        |
| IDENTITY    | `packages/auth/test/auth.integration.test.ts`                                                   | 真实 HTTP 测试身份提供方/JWKS、OIDC 校验和重放拒绝、Cookie/摘要、CSRF、撤销、身份角色隔离。               |
| MESSAGING   | `tests/integration/messaging.test.ts`                                                           | 重复命令与并发发送只落一次、历史范围、当前 ACL、工作区撤权、版本冲突、正文撤回、单调已读。                |
| HTTP        | `tests/integration/http.test.ts`                                                                | Cookie 会话、Origin/CSRF、响应白名单、强 ETag、异常输入、大小边界、真实写入与查询。                       |
| SYNC        | `tests/integration/sync.test.ts`                                                                | outbox 重放/乱序/租约、固定快照分页、撤回防泄露、实际 TCP WebSocket、断线补齐、ACK/已读分离、撤权和背压。 |
| TASK        | `tests/integration/tasks.test.ts`                                                               | 任务独立权限、显式接受、并发交接、委派建子任务、全祖先 fence、依赖成环、固定提交/验收。                   |
| RUNTIME     | `tests/integration/runtime.test.ts`                                                             | 当前身份与上下文、过期租约、祖先与身份代际、预算抢占、未结用量、容量/步数/生命周期、HTTP 白名单。         |
| MODEL       | `tests/integration/model-adapter.test.ts`、`model-driver.test.ts`、`tests/model/ollama.test.ts` | 真实 HTTP 故障、模型摘要预检、取消与迟到计费、持久检查点，以及真实本地模型接入。                          |
| ACTION      | `tests/integration/actions.test.ts`、`action-journal.test.ts`                                   | 人工审批固定指纹/目标、授权撤销、HTTP 已执行但丢响应、unknown 核对、预算及独立日志持久性。                |
| AGENT       | `tests/integration/agents.test.ts`                                                              | 机器 Token、作用域/撤销/租户 fence、ACK 与接受分离、外部自报、显式 Agent 间交接、SDK 同键重试。           |
| SCHEDULE    | `packages/scheduling/src/calendar.test.ts`、`tests/integration/scheduling.test.ts`              | 时区/DST、错过触发、去重、修订失效、重叠限制、运行授权与关闭。                                            |
| MAINTENANCE | `tests/integration/maintenance.test.ts`                                                         | 负责人不可用、执行期限、请求超时、服务身份审计、并发维护、升级负责人离开后的回退。                        |
| RESOURCE    | `tests/integration/resources.test.ts`                                                           | 真实 S3 上传、类型/大小/摘要、当前 ACL、固定版本、删除与清理；附件与任务证据随实现扩展。                  |
| WEB         | `apps/web/**/*.test.ts`                                                                         | 请求幂等、视图与代际归并、登录通知来源、同步状态、可见内容与已读边界。                                    |
| BROWSER     | `tests/e2e/messaging.spec.ts`                                                                   | 双人真实聊天、编辑/撤回、文字内容不执行 HTML、退出清理、已提交但响应丢失、移动布局、断网恢复。            |

浏览器任务用例为 `tests/e2e/tasks.spec.ts`，运行/审批/只读核对用例为 `tests/e2e/runtime-actions.spec.ts`。后者将请求转发到独立真实 API 与 PostgreSQL，并使用真实 HTTP 工具制造响应丢失；不伪造业务成功响应。

新增功能必须扩展对应集合；场景的名称与测试代码才是执行入口，表格本身不是通过证据。所有测试最终需在同一候选提交上统一重跑，并记录迁移版本、依赖锁摘要和实际结果。

## 已发现并纳入回归的问题

- Fastify 路由参数带框架原型，不能直接当作普通 JSON DTO 传给对象安全校验；逐字段提取后仍保留严格契约校验。
- 浏览器默认 `fetch` 存为类属性后，调用时会绑定错误的 `this`；真实浏览器测试覆盖此路径。
- 页面新建 BroadcastChannel 发布登录通知，会被同页另一个 channel 收到；通知按页面来源区分，其他标签页继续清理旧身份视图。
- 工作区成员撤销必须同时阻断旧会话直接访问，不能只隐藏工作区导航。
- 消息删除必须立即失效旧授权快照，避免异步 projector 尚未更新时继续披露正文。

- 上下文查询不能直接输出 `SELECT *` 的数据库行：内部 tenant/manifest 列会违反严格响应契约。响应采用显式字段，HTTP 与浏览器共同回归。
- Agent 凭证动作的审计事件必须推进安装聚合版本；否则同一聚合版本事件唯一约束会拒绝后续撤销。
- 日志写入重试必须复用固定尝试时间，临时文件写入失败不能留下可误认为有效记录的半文件。

## 模型和对象存储验证

`pnpm test:model` 连接真实本地 Ollama，仅在模型镜像、模型摘要与 `.env.example` 约束符合时执行。模型输出与协议安全分别验证；不能用小模型回答正确替代服务端权限断言。

资源集成测试需要 Compose 的 SeaweedFS S3 和独立测试桶，初始化与配置见 `packages/resources/README.md`。浏览器直传测试还需要仅针对测试 Web Origin 的 S3 CORS；不得开放任意 Origin、Cookie 或共享生产桶。

## 证据与限制

失败时保留 `test-results/` 的截图、trace 和 `playwright-report/`；它们可能包含测试对话与 Cookie，只在受控测试环境保存，不提交 Git。当前测试 OIDC 提供方用于协议与错误注入，不等价于已验证生产 Keycloak 配置。

`tests/acceptance/coverage.json` 跟踪所有产品 AC 和系统 INV。`pnpm test:acceptance` 目前只是检查每项是否有完成状态与证据引用的**准出前置门**，不是独立运行全部场景的测试器。不得只修改这份清单就宣称验收通过。外部模型、真实连接器、移动系统通知、恢复演练与容量结果必须分别有实际证据。

## 新增回归入口

| 集合           | 入口                                                                                                                    | 关键断言                                                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Run 工具链     | `tests/integration/run-tool-intents.test.ts`、`machine-run-tools.test.ts`                                               | 审批后仍需人工恢复/新租约；固定身份单次派发；双层预算；unknown 原回执核对后仅总结；计划创建拒绝工具授权 Run。                |
| 通知           | `tests/integration/notifications.test.ts`、`packages/notifications/src/time.test.ts`、`tests/e2e/notifications.spec.ts` | 独立队列/迟到事件/去重；当前 ACL；静音/DND/时区；通用提示；真实通知跳转、已读和偏好持久化。                                  |
| 知识           | `tests/integration/machine-knowledge.test.ts`、`tests/e2e/knowledge.spec.ts`                                            | 机器 scope、主体私有隔离、来源撤权后内容消失。                                                                               |
| 产物协作       | `tests/integration/artifact-collaboration.test.ts`、`tests/e2e/resources.spec.ts`                                       | 固定版本/Unicode 锚点；有界定向分享；接收者无源 ACL 仍只能通过专用分享端点；撤销阻断。                                       |
| 数据治理       | `tests/e2e/governance.spec.ts`、`tests/integration/recovery-drill.test.ts`                                              | 导出当前作用域及完整性；实际 dump/restore/S3 恢复与独立删除事实重放。                                                        |
| 浏览器本地基础 | `apps/web/src/offline/offline-store.test.ts`、`app-location.test.ts`、`conversation-sync.test.ts`                       | IndexedDB 权限分区/过期/租约；无权威字段 URL；recent 截断标记传播。包含擦除与迟到写竞态；页面与生产 PWA 另有下列浏览器回归。 |

`pnpm test:capacity` 使用独立随机数据库，默认百万历史消息、1,000 个实际 WebSocket、30 秒 / 50 消息每秒，同时运行聊天与通知派发。探针报告 `.artifacts/capacity-probe.json`，共享开发机结果不得替代设计环境或生产容量证明；当前不覆盖重连风暴及慢模型/文件并发。`pnpm test:recovery` 报告 `.artifacts/recovery-drill.json`，实际恢复不等于 WAL PITR 已验证。

历史浏览器入口 `tests/e2e/recent-history.spec.ts` 使用 1,055 条真实消息与真实投影，验证 recent 快照、显式旧页、窗口外深链及删除。容量增量记录见 [容量工作记录](capacity-report.md)。

- `tests/e2e/offline.spec.ts`：真实 API + PostgreSQL；明确同意、草稿跨刷新恢复、断网 IndexedDB 排队、联网重新认证后单次提交、退出清除。
- `tests/e2e/pwa.spec.ts`：先运行 `pnpm build`；测试自建静态服务器提供 `apps/web/dist` 并代理真实 API，验证实际 Service Worker 离线重载和缓存隔离，不使用 Vite 开发模式替代。
- `packages/notifications/src/push.test.ts`：AES-GCM/AAD/篡改检测、端点限制、VAPID 加密请求格式；`push-transport.test.ts` 使用注入 DNS/HTTPS 验证出站地址固定、状态分类和发送前撤权，不是实际厂商送达证据。
- `tests/integration/notifications.test.ts`：新增真实数据库加密订阅、会话换绑、最多 5 次尝试、过期订阅清理和旧订阅版本隔离。真实系统推送仍须按运维手册在浏览器和移动设备验收。

Agent 管理新增入口：`tests/integration/agents.test.ts` 覆盖管理员元数据读取、绑定主体/安装的分页、撤销后状态和管理员降权立即拒绝；`tests/e2e/agent-management.spec.ts` 覆盖注册外部 Agent、一次性遮盖显示密钥、不写浏览器持久存储、刷新后撤销和停用。执行结果以实施状态及最终报告为准。

离线竞态用例会把真实策略 HTTP 响应延迟到用户擦除本机数据之后，再观察两个后台轮询周期，确保旧响应不能重新建立同意状态；然后验证同一登录会话重新启用后仍能发送。

CI 现已编排 PostgreSQL 和真实 SeaweedFS、固定测试桶及精确 CORS、整仓 verify、全部集成测试、Chromium E2E 和实际固定摘要的本地模型调用。`infra:setup:test` 仅允许回环地址，不能用作生产桶初始化。CI 不上传 trace/截图/网络记录，以免泄漏一次性测试凭证；故障日志仍不得包含 Cookie 或订阅端点。最终 GitHub 运行状态需要在推送后核实，不能用 YAML 静态检查替代成功运行。容量及生产设备/PITR 门槛独立存在。

`runtime-actions.spec.ts` 的 5 个浏览器场景现在同时覆盖基础运行控制、人工 Action 审批/unknown 查询、来源撤权隐藏、Run-bound 工具完整审批/恢复/仅总结链，以及灾难恢复页面的孤立证据/一次记账/人工解冻。模型协议响应由本地受控服务产生；实际模型推理另由 `pnpm test:model` 验证。

Web Push 故障注入夹具把 Node ECDH 导出的私钥左侧补零到 32 字节后编码；不能直接假设 `getPrivateKey()` 始终返回固定宽度。曾复现 1,024 次生成中 2 次返回 31 字节，已修复由此导致的随机 VAPID 夹具失败。生产配置仍严格验证 VAPID 密钥，未为测试放宽要求。

所有具名用例的可再生静态索引见 [回归用例目录](regression-cases.md)。新增或移动测试后运行 `pnpm test:catalog`，`pnpm test:catalog:check` 可核对目录与源文件一致；静态目录不会更改 AC/INV 的验收状态。

组织接入回归见 `tests/integration/workspace-provisioning.test.ts`：只计划不写入、权限边界、原子初始化、并发重试不恢复撤权、真实认证与会话入口。私聊专用回归见 `direct-messaging.test.ts`。本轮验收逐项审查见 [AC/INV 审查记录](acceptance-review-2026-10-04.md)，其中 partial 和 pending 仍阻止完整生产准出。

组织管理回归：`tests/integration/organization.test.ts` 与 `tests/e2e/organization.spec.ts`。覆盖组织管理权、资源权限分离、成员命令、旧运行授权、独立账本恢复及 Web 明确确认；批次与限制见 [组织管理证据](organization-management-evidence-2026-10-05.md)。

容器发布回归：先 `pnpm build:images`，再 `pnpm test:deployment`。使用真实 Docker API/Worker/Caddy，验证 TLS、WSS、会话/CSRF、消息投影及重启；配置前提与证明边界见 [容器部署](../operations/container-deployment.md)。
