# Agent 身份与外部执行

`createAgentService` 使用独立的身份与业务数据库连接。注册分为保留稳定 ID、写入禁用租户安装、激活身份、激活安装四个可恢复阶段；只允许租户和工作空间管理员创建。安装本身不授予会话或任务访问权。

机器接口固定在 `/v1/machine/*`，使用 `Authorization: Bearer …` 和 `X-Imbox-Tenant-Id`，拒绝 Cookie 混用。人类接口继续采用会话和 CSRF。完整请求和响应见生成 OpenAPI。

- 凭证最多 30 天，秘密只在创建成功的首次响应返回；幂等重放不再次披露，丢失响应须撤销后新建。
- 访问令牌有效期最多 15 分钟且不超过凭证期限；每凭证最多 20 个活动令牌。只存带域分隔的 HMAC 摘要。
- scope 是安装、凭证与令牌的交集；每个业务事务重新锁定并验证身份版本、安装代际、凭证修订、令牌有效期和租户授权版本。
- 凭证撤销和安装停用立即影响后续平台调用；不能证明远端进程或其自有凭证停止。
- Agent 请求 ACK 只写固定提案版本的收件记录，不接受契约、不改变 owner。
- 外部 Run 使用服务器派生的 holder 和租约 generation，按动作分别要求 runs.execute/runs.report。重复 claim 使用相同幂等键只返回原租约；过期后不能用旧键取得新租约。
- 外部输出明确标记 `external_report`，执行结束不等于任务验收。外部主体不能调用托管 Worker 的预算结算或行动回执接口。

验证：`pnpm test:integration tests/integration/agents.test.ts`，使用真实 PostgreSQL、TCP HTTP、TypeScript SDK及两个外部主体，覆盖人→Agent→Agent交接、ACK分离、令牌/授权撤销、租约和重放。
