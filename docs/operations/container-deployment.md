# 应用容器部署

本方案提供 API、Worker、受控工具执行器和 Web 四个镜像，以及 Caddy 同源 HTTPS/WSS 网关。它是单机部署基线，不代表完整生产准出；公共域名证书、真实 IdP、外部供应商、容量、监控和恢复演练仍须按[准出文档](../release-readiness.md)验收。

## 构建与发布边界

在仓库根目录使用 Node 24、pnpm 10 和 Docker BuildKit：

```sh
pnpm install --frozen-lockfile
pnpm verify
IMBOX_IMAGE_TAG=release-candidate pnpm build:images
```

默认产物为 `imbox/{api,worker,tool-runner,web}:local`；可用 `IMBOX_IMAGE_PREFIX`、`IMBOX_IMAGE_TAG` 指定仓库前缀和版本。命令只构建，不上传镜像。部署时应使用已审核的不可变 digest，并记录源码提交、锁文件 SHA256、镜像平台和 digest。不同构建的时间戳/证明元数据可能不同，不承诺 OCI 字节完全一致。

Dockerfile 固定 Node 24.21.0 和 Caddy 2.11.6 的 manifest digest。先按锁文件构建，再离线、冻结锁文件安装生产依赖；保留 workspace 包布局，以确保内部包解析正确。运行镜像不携带源码、编译测试、开发依赖、仓库 `.env` 或 Git 数据。构建后校验编译产物的直接包导入是否已声明运行依赖；该检查不代替容器业务测试。

## 部署前准备

需要 Docker Compose 2.30 或更新版本（使用 `env_file.format: raw`），独立 PostgreSQL、域名及开放的 TCP 80/443。先按[运维说明](README.md)建立 owner、app、identity 分离的数据库角色；运行时不得使用 owner、superuser 或 BYPASSRLS。数据库地址必须可从容器网络访问，`localhost` 指容器自身。按数据库服务配置 CA/证书验证，不要关闭 TLS 验证。

将 `infra/deployment/{api,worker,release}.env.example` 复制到仓库之外的 `/etc/imbox/`，替换所有占位值，限制目录和文件访问权限。API/Worker 文件按原始 env 格式解析：一行 `KEY=value`，值不要加 shell 引号，不支持多行秘密。只向需要的服务提供密钥。API 与 Worker 的 policy 签名密钥必须相同；会话密钥独立生成。迁移文件单独配置 `MIGRATION_DATABASE_URL`，不向运行服务提供迁移凭据。

```sh
install -d -m 700 /etc/imbox
install -d -m 700 -o 1000 -g 1000 /var/lib/imbox/policy-ledger
chmod 600 /etc/imbox/*.env
```

上述命令需要主机管理员权限。已有目录先核对所有权与备份，禁止直接清空。policy ledger 必须独立于 PostgreSQL 快照持久化，保留撤权记录；签名密钥须备份并限制访问。Caddy 的 data/config 命名卷保存证书状态，不能随意删除。

`PUBLIC_ORIGIN` 必须与外部 HTTPS 地址完全一致；`IMBOX_PUBLIC_HOST` 为 DNS 主机名。注册真实 OIDC 客户端，并按身份接入说明配置回调和账号绑定。Worker 的 `WORKER_TENANT_IDS` 必须明确列出允许处理的租户 UUID，新租户上线后同步更新并重启 Worker。启用 Web Push 时还需为 Worker 提供独立 identity 数据库连接及相关密钥，见 [Web Push](web-push.md)。

## 迁移、启动与核验

以下命令从仓库根目录执行，假设 release.env 中引用的镜像已经存在：

```sh
docker compose --env-file /etc/imbox/release.env -f infra/deployment/compose.yaml config --quiet
docker compose --env-file /etc/imbox/release.env -f infra/deployment/compose.yaml run --rm migrate
docker compose --env-file /etc/imbox/release.env -f infra/deployment/compose.yaml up -d --wait api worker web
```

迁移是显式操作，不随 API 启动自动执行。先备份并审查 schema 兼容性，再迁移；回退镜像不等于回退数据库。Compose 只公开网关端口，API 4100 留在内部网络。进程使用 UID 1000、只读根文件系统、丢弃 capabilities、受限临时目录；网关仅增加绑定低端口的能力。

检查 HTTPS `/readyz`、真实 OIDC 登录、创建会话/消息、消息投影、WSS 连接和重启后读取。API 有 readiness healthcheck；Worker 和网关当前没有业务健康探针，`up --wait` 不能证明队列实际前进，必须检查业务指标/积压。不要把环境内容、Cookie、Authorization、CSRF 或原始请求日志上传到报告。

Caddy 自动处理公网证书，并原生代理 WebSocket；API 路径不进入 SPA fallback，API 响应使用 no-store，版本化 assets 长缓存，入口和 Service Worker 重新验证。路由依据 [Caddy 模式](https://caddyserver.com/docs/caddyfile/patterns)及[反向代理文档](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)。本地测试仅验证 localhost CA，未证明公网 ACME 成功。当前 API 不信任代理转发 IP；上线前评估按 IP 限流在网关后的聚合影响，再明确可信代理范围。

## 可选模型、资源和工具

默认关闭模型、资源及外部工具。模型服务必须通过适配器允许的 HTTPS 地址访问；不要把 Docker 网络上的 HTTP 主机名误当回环地址。资源需配置私有对象存储、浏览器可访问的 HTTPS endpoint、CORS 和最小权限凭据，配置项见根 `.env.example`，不可照搬开发密码。

启用受控工具时，在所有部署命令中追加 `-f infra/deployment/compose.tools.yaml`，配置 `IMBOX_TOOL_IMAGE`、`IMBOX_TOOL_ENV_FILE`、`IMBOX_ACTION_DIR`，并为 action journal 创建 UID 1000、0700 的独立持久化目录。API、Worker、tool-runner 按功能提供相同 journal 签名密钥和 `ENABLE_DEMO_TOOL=true`、HTTPS execute/lookup URL、认证配置；tool-runner 另需 app 数据库连接和 `TOOL_RUNNER_TENANT_IDS`。工具授权、审批和幂等约束仍由应用执行，Compose 文件不授予工具权限。journal 必须独立备份，禁止和数据库一起回滚以免重复副作用。

## 回归与限制

已有测试基础设施、角色和数据库准备完成后：

```sh
pnpm build:images
pnpm test:deployment
```

测试启动隔离 Compose 项目和 policy 卷，通过真实容器验证生产依赖、非 root/只读、TLS 缓存策略、禁止开发登录、Cookie/CSRF、Worker 消息投影、WSS 和 API 重启。测试使用外部生成的 fixture session 和 localhost CA，不是实际 OIDC 登录或浏览器 UI 验收。结束后清理测试容器、卷及私密 env 文件，保留脱敏 evidence；CI 串行运行此套件。可通过 `IMBOX_TEST_DOCKER_NETWORK` 和 `IMBOX_TEST_DATABASE_HOST` 适配测试网络。

尚未通过本套件证明：可选工具容器的真实 HTTPS 副作用、公网证书、对象存储和模型的部署链路、跨主机高可用、备份恢复/PITR、生产容量、设备推送、滚动升级与 schema 回退。继续记录在准出清单，不以容器启动替代验收。
