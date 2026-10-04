# 01 技术栈与选型决策

版本：1.0 · 2026-10-04 · 上级：[开发设计索引](README.md)

## 1. 决策结论

Imbox V1 使用 TypeScript 作为前端、服务端、托管 Agent 编排和首个 SDK 的主语言，以 Node.js 24 LTS 运行服务端，采用 PostgreSQL 作为权威状态存储。整体为模块化单体加独立 Worker，普通消息、模型调用和外部行动使用不同资源池。

选择依据是当前工作以协议、网络 I/O、状态机和交互为主；共享契约能减少人类界面与 Agent API 的偏差。CPU 密集解析和将来的不可信代码执行使用独立进程/沙箱。Python Agent 可通过公开协议接入，不要求迁移其框架；未来确有性能证据时可独立实现 Go/Rust 服务。

## 2. 主语言方案比较

下表是对本项目的工程判断，不是语言性能排名。

| 方案 | 适合本项目的方面 | 当前代价 | 决定 |
|---|---|---|---|
| TypeScript + Node.js | 前后端与 SDK 共享类型；JSON/流式接口直接；少量开发者可贯通完整流程 | 运行时仍需校验；CPU 任务必须隔离；严格约束异步错误和依赖边界 | V1 主栈。 |
| Go + TypeScript | 网络服务与并发控制清晰，单二进制部署 | 从第一天维护双语言、跨语言契约生成及更多工具链 | 有测量依据后用于独立网关或高负载服务。 |
| Python + TypeScript | 数据分析和模型工具生态适合专项执行器 | 增加主业务双语言，前端/协议实现复用减少 | 外部 Agent、专项工具和未来 Python SDK。 |
| Rust + TypeScript | 适合高性能、强隔离的底层组件 | 当前领域迭代和 UI 开发不能从复杂工具链获得足够收益 | 设备执行器、沙箱辅助组件或测得的性能瓶颈。 |

不以模型 SDK 的语言决定整个 IM 后端，不为未来可能的规模提前引入多语言服务。

## 3. 技术清单

| 层 | 选定方案 | 使用边界 |
|---|---|---|
| 主语言 | TypeScript 6，严格模式，ESM | `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`；禁止边界上的未验证 `any`。 |
| 运行时 | Node.js 24 LTS，Linux 容器 | 生产编译后运行 JavaScript；开发可用 tsx，不能以开发执行器替代发布产物。 |
| 包管理 | pnpm 10 workspace | 精确 `packageManager`、锁文件和 frozen install；初期不额外引入 Nx/Turborepo。 |
| Web | React 19 + Vite 8 | 登录后 SPA/PWA；营销站和 SSR 不进入主业务服务。 |
| 路由/数据/列表 | React Router 7、TanStack Query 5、TanStack Virtual | HTTP 查询与投影 reducer 明确分工，不生成第二套任务真相。 |
| UI | Tailwind CSS 4、Radix UI、自有设计 token | 可访问组件、主题、移动适配；不把第三方组件默认样式当设计系统。 |
| 离线存储 | IndexedDB + Dexie | 按账号/租户隔离缓存与发送队列；权限撤销后清理；不存 access token。 |
| API | Fastify 5，官方 cookie/websocket 等兼容插件 | 路由插件负责传输，业务调用 application 层；插件版本逐个匹配 Fastify 主版本。 |
| 契约 | JSON Schema 2020-12 + Ajv 8 的 Ajv2020 + OpenAPI 3.1.1 | Schema 为权威源，构建生成类型/SDK；不手写重复 DTO。 |
| 数据访问 | PostgreSQL 18 + node-postgres (`pg`) + Kysely | SQL 约束和事务优先，Kysely 提供类型化查询；保留手写参数化 SQL。 |
| 数据迁移 | Kysely migration runner + 审阅后的 SQL | 版本化增量迁移，生产单次执行；禁用自动 schema 同步。 |
| 异步任务 | pg-boss | 负责调度和重复可容忍的唤醒；Run/Action/审批权威状态仍在业务表。 |
| 实时 | 原生 WebSocket + HTTP 补齐；SSE/轮询作为可选降级 | 持久投影负责恢复；不依赖进程内广播或 WebSocket 长连接保证可靠性。 |
| 对象存储 | S3 API；开发 SeaweedFS S3 | 生产使用通过契约测试的托管 S3 或独立运维 S3 服务；私有桶、受控下载。 |
| 人类认证 | OIDC Authorization Code + PKCE；Keycloak 为开发默认 IdP | 后端管理会话，不自建密码系统；生产可接兼容 IdP。 |
| Agent 认证 | 安装级凭证 + 可撤销短期 opaque token | 每次请求解析主体与 grant；不把 Agent 声明或模型内容当身份。 |
| 模型调用 | 自有 ModelAdapter 接口 + 供应商 SDK/HTTP 适配 | 状态机、授权与成本不交给模型编排框架；至少支持假模型和两个配置化适配器。 |
| 搜索 | PostgreSQL FTS + `pg_trgm` + 显式语言处理接口 | 中文先提供经过验证的字符检索；独立搜索引擎与向量索引后置。 |
| 测试 | Vitest、fast-check、Playwright、Testcontainers、k6 | 单元/性质、真实数据库集成、浏览器端到端与负载各有门禁。 |
| 质量与 CI | ESLint、Prettier、GitHub Actions | 类型、依赖边界、schema 兼容、迁移和安全检查进入流水线。 |
| 可观测性 | Pino、OpenTelemetry、Prometheus/Grafana，兼容 OTLP 后端 | 结构化日志、指标和 trace 分离；正文与秘密默认不采集。 |
| 打包部署 | OCI 镜像、Docker Compose、反向代理 | Compose 用于本地/单机试用；生产部署可使用容器平台，无须先建设 Kubernetes。 |

Node 官方将 24 列为 LTS；Fastify 5 与该运行时匹配。依赖最低运行版本不能替代 Node 的维护状态判断。[Node 发布](https://nodejs.org/en/about/previous-releases)、[Fastify 支持政策](https://fastify.dev/docs/latest/Reference/LTS/)

TypeScript 6、React 19 和 Vite 8 是本次选定版本线，精确补丁在工程初始化时锁定；同一 Node 版本用于本地、CI 与构建镜像。[TypeScript 6](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html)、[React 版本](https://react.dev/versions)、[Vite 发布](https://vite.dev/blog/)、[pnpm 兼容性](https://pnpm.io/installation)

## 4. 后端与数据库选择理由

### 4.1 Fastify 与模块化业务层

使用 Fastify 提供 HTTP、插件封装、请求生命周期和 WebSocket 接入，应用层显式组合依赖。接口 schema、日志和测试注入点易于保持统一。NestJS 可以提供组织规范，但当前不需要其装饰器与依赖注入体系；领域边界由源码目录、接口及依赖检查保证。

不把运行状态塞进 HTTP 请求生命周期；不让 Next.js 服务端函数承担持久 Agent Runtime。客户端掉线不取消后台任务，模型连接断开按执行状态单独处理。

### 4.2 PostgreSQL 与 Kysely

选择关系约束、事务、行锁与条件更新承担任务、审批和预算的一致性。Kysely 作为查询构建层，数据库真实 schema 和迁移是持久模型权威；复杂锁、RLS 和 outbox 使用经过审阅的 SQL，避免 ORM 隐式加载或级联隐藏权限边界。[PostgreSQL 版本政策](https://www.postgresql.org/support/versioning/)、[Kysely](https://www.kysely.dev/)、[Kysely 迁移](https://www.kysely.dev/docs/migrations)

V1 采用 PostgreSQL 18 版本线；若部署平台只能提供另一受支持版本，必须作为明确偏离记录并跑全套数据库测试，不能无声替换。生产使用最新经验证的安全补丁，而非把本文件当永久补丁锁。

### 4.3 pg-boss 与持久状态机

V1 已有 PostgreSQL，使用 pg-boss 可以减少另设队列集群的成本。业务事务写 durable intent/outbox，dispatcher 发布唤醒；消费者获取业务租约，执行一个有限步骤，再保存检查点。等待人工输入时没有长期占用的 Worker。

pg-boss 的消费、超时和重试不是外部行动严格一次的保证，其并发设置也不能代替事务预算预占。主动显式配置轮询、重试、超时和保留参数；即时消息直接写权威流，不能经默认作业轮询后才显示。[pg-boss](https://pgboss.io/)、[Worker 语义](https://pgboss.io/api/workers)、[Jobs](https://pgboss.io/api/jobs)

Temporal 是未来需要复杂工作流版本迁移、规模化编排时的候选。若引入，先决定哪些状态转移由它持有，哪些继续由业务数据库持有，并设计幂等桥接；不能使两个系统同时成为审批或 Task 状态的权威。Redis/BullMQ、Kafka/NATS 也不进入 V1 强制依赖，后续可替代唤醒/分发适配器。

## 5. 契约、认证与模型适配

### 5.1 Schema 策略

采用 JSON Schema 2020-12 为接口和事件定义权威结构，OpenAPI 固定为 3.1.1。Fastify 默认验证/序列化配置不能被假定等同于此方言：M0 明确安装 Ajv2020 validator compiler，并为响应使用“构造授权 DTO → 同方言验证 → JSON 序列化”的受控出口。不能把 2020-12 schema 直接交给只支持其他方言的默认链路。[Ajv 方言](https://ajv.js.org/json-schema.html)、[Fastify 校验与序列化](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)、[OpenAPI 3.1.1](https://spec.openapis.org/oas/v3.1.1.html)

V1 schema 使用受约束的类型、枚举、对象、数组、范围和引用；限制递归、正则、深度和编译开销。Agent 提供的工具 schema 属于不可信数据，不能在主 API 进程中任意编译执行。SDK 和浏览器的类型检查是开发便利，服务端校验始终执行。

### 5.2 认证与外部协议

采用已有 OIDC IdP 处理用户认证，应用自行维护资源成员关系、会话和授权。Keycloak 只作为默认 IdP 实现，不进入业务权限模型。Agent 使用安装级身份和业务能力，首版采用主动拉取/长轮询及 HTTP 回报，以减少回调地址、重放和入站网络复杂度。[OIDC](https://openid.net/specs/openid-connect-core-1_0.html)、[Keycloak 指南](https://www.keycloak.org/guides)

内部协议先落地完整的接单、报告、提交、取消和核对。MCP 工具与 A2A 接入通过可替换适配器完成，具体标准版本在实现该适配器时核验；首版外部 Agent 不依赖这些协议才能工作。

### 5.3 模型与工具

模型仅输出候选文本、结构化结果与工具意图。ModelAdapter 暴露流式生成、取消、用量、能力和错误映射；所选模型由部署配置及租户数据策略决定。第一个实际供应商在 M0 联调时配置，不在仓库提交真实凭证，也不把任意供应商兼容接口视作语义完全相同。

V1 工具限于受控资料读取、产物生成和有限连接器；不开放任意 shell、任意网页脚本或未经审查代码执行。代码补丁可作为产物，真正执行需要后续独立沙箱方案。

## 6. 搜索、媒体与存储

PostgreSQL 全文搜索不自动等于高质量中文分词。V1 中文消息/标题采用规范化字符检索和 `pg_trgm` 支持的索引查询，明确短查询的性能上限；英文等适用语言可使用 FTS。验收集必须同时包含中文、英文、混合语言与删除/撤权过滤。独立搜索或向量检索在需要时替换 SearchPort。[pg_trgm](https://www.postgresql.org/docs/18/pgtrgm.html)

S3 用于附件、产物、受控上下文正文。开发默认 SeaweedFS 提供可本地运行的 S3 端点；生产端点需验证本项目使用的上传、读取、删除、版本和加密能力，不能依据“S3 兼容”字样假定所有语义相同。[SeaweedFS](https://github.com/seaweedfs/seaweedfs)

音视频实时传输、CRDT 协同编辑、向量数据库和设备侧执行器均通过接口预留，V1 不部署无实际消费者的基础设施。

## 7. 版本、许可证与供应链

1. M0 生成 `pnpm-lock.yaml`、精确 `packageManager`、运行时版本文件、容器 digest 和 schema 版本清单；所有 CI 使用 frozen install。
2. 独立确认 Fastify 插件、TypeScript 类型工具、Vite/React 插件、pg-boss 与 PostgreSQL 的兼容矩阵；不能靠宽泛 `>=` 通过安装就认为验证完成。
3. 接口主版本、事件 schema 版本、数据库迁移版本和应用版本独立管理。服务滚动发布至少兼容前一应用版本的读写契约。
4. 升级先通过自动化回归和恢复用例；安全补丁优先，破坏性升级记录迁移与回退路径。
5. 生成依赖与镜像 SBOM，核对依赖许可证、分发要求、维护状态和漏洞。禁止将未审核脚本、远程 schema 或模型返回内容当可信构建步骤。
6. 本次核验日期为 2026-10-04；文档中链接为官方资料，未来实施仍需重验支持周期。

## 8. 已接受的取舍与触发条件

| 决策 ID | 当前取舍 | 何时重新评估 |
|---|---|---|
| DEV-ADR-01 | TypeScript 单主栈，CPU 任务隔离 | 实测 event loop 阻塞或特定执行器需要其他语言。 |
| DEV-ADR-02 | PostgreSQL 同时保存业务状态、outbox 与作业元数据 | 队列负载影响事务 SLO，且调优和资源池隔离不足。 |
| DEV-ADR-03 | Web/PWA 首发 | 目标用户依赖可靠移动推送、设备能力或应用商店分发。 |
| DEV-ADR-04 | API-first，schema 单一来源 | 有新的客户端/协议需求时扩展契约，不转为仅 TS 可用的内部调用。 |
| DEV-ADR-05 | OIDC 身份与业务权限分离 | 新 IdP、企业 SSO 或设备登录；保持主体映射和撤销语义。 |
| DEV-ADR-06 | 自有有限状态执行器与 pg-boss 唤醒 | 编排数量、版本升级和调度规模证明需要独立工作流服务。 |
| DEV-ADR-07 | V1 不接受任意可执行插件 | 准备好隔离、出口、凭证代理和沙箱逃逸验证后再开放。 |

选型已经确定；M0 负责验证兼容性与固定补丁，不重新泛泛比较所有语言。未达到验证门槛时写出具体失败证据，再调整受影响组件。
