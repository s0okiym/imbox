# 真实交接与在途执行补验

日期：2026-10-05（Asia/Shanghai）。应用业务代码未改动；本轮增加跨模块集成断言，使用实际 PostgreSQL、Task 接受事务、Worker、Action 执行器、HTTP 服务和独立签名账本。

- 旧 Worker：任务交接给 Bob 后，原 claim 的心跳、预算预占和 completed 回报全部拒绝，原 Run 未被旧回报改成完成；唯一 owner 更新，accountable 不变，execution_epoch 和 authz_generation 各提升一次，交接事件版本等于任务版本并有唯一对应 outbox。原发起人降为 reviewer，当前执行权限检查返回 NOT_FOUND，测试不将其误报为必然经过 epoch 检查。
- 已准备 Action：先领取执行租约并持久化 intent，再接受交接；dispatch 返回 EXECUTION_FENCE_CONFLICT，HTTP 请求和副作用均为零；abortPrepared 释放预占，费用仍为零。
- 在途 Action：HTTP 夹具先实际提交副作用，然后保留响应；等待副作用信号后接受交接，再断开响应。Action 保持 unknown 且阻止任务关闭，新 owner 可核对并幂等重放核对命令；最终仅一个 POST、一个副作用、7 microunits 费用和零剩余预占。测试未用 sleep 制造竞争窗口。

验证命令：`pnpm test:integration tests/integration/actions.test.ts tests/integration/runtime.test.ts tests/integration/tasks.test.ts`。结果为 3 文件 / 52 项通过，25.36 秒。测试类型检查、相关 ESLint 与回归目录检查均通过；远程全量 CI 以对应提交的运行结果为准，不复用前一提交的通过结论。

编写过程曾发现测试对拒绝码的假设不正确，以及误用不存在的 runs 表名；分别改为实际权限语义的 NOT_FOUND 和 agent_runs。初次尝试在交接包中填写行动 ID 被现有契约拒绝：WorkProposal.handoff.pending_action_ids 当前限制为空数组。测试使用现行契约完成交接，通过新 owner 的 Action 访问与核对验证遗留结果。这证明 AC-07 / INV-04 的执行边界，但不证明交接包行动清单体验已完成。

后续应补交接包行动清单的协议、同任务引用校验、接单前披露和界面展示；不能只放开数组长度而遗漏授权检查。已有外部调用不会因交接被平台撤销，最终仍依赖供应方按业务键核对；真实第三方供应商故障模型不由此受控夹具覆盖。

界面同时移除了未经核实的“无待接管的外部行动”断言，改为提示接管后核对执行中和未知结果。Web 类型检查与对应 ESLint 通过；这项文案修正不等于已实现行动清单。

完整远程复核：7e9c3c2 的 [CI 37217037797](https://github.com/s0okiym/imbox/actions/runs/37217037797) 全部步骤成功，180 单元、249 集成、24 浏览器（1.9 分钟）及 1 项真实模型通过，结构化记录见 [CI 证据](handoff-ci-2026-10-05.json)。该批次不包含之后新增的委派浏览器场景。
