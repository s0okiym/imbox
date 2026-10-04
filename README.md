# Imbox

面向人与人、人和 AI Agent、Agent 之间沟通与协作的 AI 原生即时通信系统。

当前正在实现 V1。已有可执行的身份认证、消息与权限、持久同步、Web 客户端、任务协作、持久 Agent Runtime、受控外部行动、机器身份与 SDK，以及受限文件产物、调度、治理、离线缓存与通知；容量优化与完整准出验证继续推进。具体完成边界见 [实施状态](docs/implementation-status.md)，不能把当前工程视作完整产品发布。

## 设计与工程

- [产品与系统设计 v2.0](docs/imbox-product-and-system-design.md)：体验、领域、Agent 运行、权限、可靠性、未来扩展和验收标准。
- [开发设计 v1.0](docs/development/README.md)：技术选型、数据与接口、客户端、安全运维和交付工作包。
- [验证与回归说明](docs/testing/README.md)：真实数据库、协议、浏览器验证以及证据边界。
- [开发总结](docs/development-summary.md)、[测试报告](docs/testing/test-report.md)、[准出记录](docs/release-readiness.md)：当前实现、实测结果与尚未解除的发布门槛。

主语言 TypeScript；Node.js 24、pnpm 10、Fastify 5、React 19、Vite 8、PostgreSQL 18、Kysely。依赖精确版本和镜像摘要已锁定。持久调度以 PostgreSQL 状态和幂等扫描为权威；真实 S3、Ollama 模型与独立工具执行入口已加入，完整部署与恢复验证继续推进。

## 本地运行

推荐使用新的 [本机试用入口](docs/operations/local-pilot.md)：`pnpm install --frozen-lockfile` → `pnpm pilot:setup` → `pnpm pilot`。已有配置保留，应用进程集中启动与停止。阶段交付边界见 [后续优先级](docs/delivery-backlog.md)。下面保留手动操作方式。

需要 `.node-version` 指定的 Node.js 24、`package.json` 指定的 pnpm 10，以及 Docker Compose。数据库监听 `127.0.0.1:55432`，避免占用宿主已有的 PostgreSQL。

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm infra:up
pnpm build
pnpm db:setup
pnpm db:seed
```

在 `.env` 中设置独立随机 `SESSION_SECRET`（至少 32 字符，不能保留占位值），并配置 OIDC；本地测试也可显式设 `ENABLE_DEV_AUTH=true`，只允许种子白名单中的测试主体。生产环境拒绝启用开发登录。

分别启动三个进程：

```sh
pnpm dev
VITE_ENABLE_DEV_LOGIN=true pnpm dev:web
pnpm dev:worker
```

Web 默认 `http://localhost:5173`，同源代理 API 4100。修改 Web 地址时同步修改 `.env` 的 `PUBLIC_ORIGIN`；修改 API 地址时设置 Vite 的 `IMBOX_API_PROXY_TARGET`。Worker 只处理 `WORKER_TENANT_IDS` 明确列出的租户。

`.env.example` 中的账号密码仅供本机开发；迁移角色、应用角色、身份角色有不同权限。应用与 Worker 不自动执行迁移，也不应使用迁移连接串。

## 验证

```sh
pnpm verify
pnpm infra:setup:test
pnpm db:setup:test
pnpm test:integration
pnpm exec playwright install chromium
pnpm test:e2e
```

浏览器测试自动启动独立 API / Web / Worker，使用 `imbox_test`、4110 / 4173 端口。所有服务执行真实业务路径；浏览器测试身份和本地 OIDC 测试提供方不代表生产身份系统已验收。

`pnpm test:acceptance` 检查完整 AC/INV 清单的证据状态，在 V1 全范围完成前应保持阻断。设计文件保留稳定名称，版本和更新记录维护在文档内部。

运行与故障处置见 [运维入口](docs/operations/README.md)，系统推送配置和设备验收见 [Web Push 手册](docs/operations/web-push.md)。
