# 已批准 Action 的资源版本与不可变绑定补验

日期：2026-10-05（Asia/Shanghai）。基于 859280d，仅补充测试和证据，不改变产品接口与执行逻辑。

通过真实 PostgreSQL、HTTP 工具服务与独立签名执行日志验证：

- 人类批准后，通过任务服务修改标题；确认 execution_epoch 不变、任务版本递增。旧 Action 在 claim 前返回 VERSION_CONFLICT，HTTP 尝试为零，独立日志为空。按新版本重新授权和批准的新 Action 正常成功，恰好一次请求和副作用。
- 已领取租约并写入持久意图后，同样修改任务标题；dispatch 再检查资源版本并拒绝。abortPrepared 将未派发行动关闭为 failed，任务预算预占与支出均为零，没有 HTTP 请求或副作用。
- 对已批准 Action 的 PATCH 分别注入 target_id、executor_principal_id、tool_id、tool_version：四次均返回 400。随后读取确认原目标、执行者、工具、版本、fingerprint 和 ready 状态保持不变。该接口不支持更换这些绑定；这是拒绝非法修订的验证，不是合法换绑流程。

最终执行：`pnpm test:integration tests/integration/actions.test.ts`，1 文件、19 测试通过，19.05 秒。测试首次扩展时误以创建输入字段 executor_principal_id 断言响应；实际响应字段为 executor_id。更正测试后重跑通过，未改动产品契约。

范围限制：这里只验证显式任务版本引用与上述四种非法字段修订。模型来源、Artifact 发布、Agent 安装/目标配置变化与并发撤权的完整组合仍需分别补验；AC-12、INV-08 保持 partial，整体仍为 27 verified / 13 partial / 1 pending。
