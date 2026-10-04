# 本机试用交付

本入口把 API、Worker 和 Web 作为一组启动，面向开发和功能试用。只绑定回环地址，使用开发种子身份。它不是生产发布入口，也不启动尚未配置的模型或外部工具提供方。

## 准备和启动

需要 Node.js 24、pnpm 10、Docker Compose。首次执行：

```sh
pnpm install --frozen-lockfile
pnpm pilot:setup
pnpm pilot
```

`pilot:setup` 在 `.env` 不存在时从模板创建私有配置，生成独立随机会话密钥和隐私账本密钥，启用开发身份。已有 `.env` 原样保留；缺项请参照 `.env.example` 补齐。随后启动本项目 PostgreSQL/SeaweedFS、构建 workspace、应用开发库迁移并幂等写入 Alice、Bob、Charlie 测试身份。不会删除数据库卷或重置已有业务记录。

已有配置至少需要 `APP_ENV=development`、数据库的应用/身份/迁移连接、随机 `SESSION_SECRET`、`API_HOST=127.0.0.1`、`API_PORT=4100`、`PUBLIC_ORIGIN=http://localhost:5173`。开发登录还需要 `ENABLE_DEV_AUTH=true` 和模板中的种子主体白名单。Worker 租户清单必须显式配置；本地种子为 `WORKER_TENANT_IDS=10000000-0000-4000-8000-000000000001`。

默认访问 `http://localhost:5173`。端口被占用时命令退出，不停止其他应用。可为本次进程指定不同端口，无需改动已有配置：

```sh
PUBLIC_ORIGIN=http://localhost:5183 API_PORT=4180 pnpm pilot
PUBLIC_ORIGIN=http://localhost:5183 API_PORT=4180 pnpm pilot:status
```

如果已有旧配置缺少 Worker 清单，可在命令前加上 `WORKER_TENANT_IDS=10000000-0000-4000-8000-000000000001`，或补入 `.env`。Web 和 API 端口必须不同且不小于 1024。已启用文件上传时，改变 Web Origin 也要重新配置对象存储 CORS。

`pilot` 在前台监督构建后的 API、Worker 和 Vite 开发 Web；不会自动重建后端。任何子进程退出会停止整组服务并报告失败。启动就绪检查同时访问 API `/readyz` 和 Web 页面；Worker 存活不代表每个业务队列都没有积压。配置 `ENABLE_DEMO_TOOL=true` 时，已配置的独立 tool-runner 也在同一监督组中运行。

Ctrl+C 停止这一组应用；超过 10 秒仍未退出的直接子进程会被终止。PostgreSQL、对象存储和数据卷保留，之后可再次 `pnpm pilot`。`pnpm pilot:status` 检查当前配置对应的 API 数据库就绪端点和 Web 可达性，不声称是完整监控。日志追加写入 `.artifacts/pilot/` 私有文件，排查时不要上传完整日志、配置或凭证。

## 建议试用顺序

1. 在两个独立浏览器上下文分别以 Alice、Bob 登录；新建包含 Bob 的群聊，发送、编辑、删除消息，验证双方同步。已有浏览器自动化覆盖丢响应重试和离线恢复。
2. 建立任务，填写目标、验收条件和预算；发起咨询、委派或交接，由接收者明确接受，检查 owner 与任务状态。提交固定版本产物后由审核者验收，再完成任务。
3. 在 Agent 目录注册受控外部 Agent，按 [外部 Agent 示例](../../examples/external-agent.ts) 配置其一次性凭证。收件箱 ACK、接单、Run 完成和任务验收是不同事实。
4. 按 [运维入口](README.md) 配置本地固定模型、文件存储或受控工具后再试对应功能。模型需要 Ollama 及固定摘要模型；工具需要真实受控服务和独立行动日志；文件需要开发桶及当前 Origin CORS。默认配置不宣称这些能力可用。
5. 在任务与 Run 详情查看暂停、取消、失败和 unknown 结果；unknown 使用只读核对流程，不能靠重复发送确认成功。

本机种子身份仅用于试用。真实组织开户、身份绑定、生产部署、目标设备与容量验收的剩余工作见 [交付边界与后续优先级](../delivery-backlog.md)。
