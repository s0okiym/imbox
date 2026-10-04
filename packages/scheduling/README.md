# 有限调度唤醒

本包只恢复**人类明确选择的现有 Task Run**。创建或修订计划时，Run 必须属于该用户、绑定指定 Task，并已经暂停且没有有效执行租约。Agent 和服务身份不能创建计划；调度不会自动接受 Request、创建 Run、扩大权限、重置预算或复活终态 Run。

支持一次触发及 IANA 时区下的每日本地 `HH:mm`。使用 Temporal polyfill 0.5.1：不存在的本地时间跳过，重复时间只取第一次实际时刻。`start_at` 包含边界，`deadline` 不含边界，计划总期限不超过创建时刻后 366 天。原时区和实际 UTC occurrence 都落库。

`missed_policy=coalesce` 将到期时刻合并为最近的一次；`skip` 只容忍 60 秒扫描/派发延迟。重叠固定禁止：只有暂停且无有效租约的 Run 能变为 `queued`。其他非终态 Run 记为 `skipped/overlap`；不为待审批、待输入或待依赖运行自动作出决定。修改或禁用增加 revision，已经排队的旧 revision 在消费时失效。

`maximum_wakeups` 为 1–1000 的**累计 occurrence 额度**：创建待派发 occurrence 就占用，随后跳过、拒绝也不退回，修订不重置计数。因此实际恢复次数不会超过额度。用户可以在新的显式修订中提高总额度，但不能超过 1000，也不能延长原计划的 366 天总期限。

每次恢复仍消耗原 Run 的生命周期：当前部署每 Run 最多 20 个步骤、从 Run 创建起绝对 24 小时有效，沿用同一预算、上下文和祖先授权代际。创建/修订的 start 与 deadline 必须落在该 Run 的原始 24 小时寿命内；366 天只是日历算法的预留上界，不是当前执行许可。每日规则不是“每天新建任务运行”：等待锁或宕机超过原 Run 寿命的 occurrence 也会拒绝；托管文字步骤目前通常一次执行后完成，之后不会再次恢复。需要新的运行时，用户必须创建并授权新的 Run，再显式创建或修订计划。调度 UI 应明确显示这些限制，不能把它描述成无限周期执行。

数据库事务同时保存 occurrence、领域事件和 outbox；唯一键为 tenant + schedule + revision + scheduled instant。Worker 调用 `collectDue(tenantId, limit?)` 和 `dispatchPending(tenantId, limit?)`，默认批量 100，上限 100。待派发 occurrence 本身是持久队列，pg-boss 可辅助唤醒但不是调度事实。系统时钟判断来自 PostgreSQL，客户端不能提交“现在”绕过到期检查。

派发事务持有 schedule/occurrence 锁，然后重新检查租户、全局身份版本、安装、Task 祖先代际、当前源访问权限、上下文、预算、未核对费用和 Run 生命周期，再执行 `paused → queued` 与 Run outbox 事件。禁用与派发以事务提交顺序线性化：已经提交的恢复不能被后来的禁用撤回，禁用之后旧 occurrence 无法获得执行资格。恢复后的 Worker 仍重复自己的授权检查，调度不授予新的能力。因 RLS、数据库或未知系统错误失败的事务保持 pending，不伪装成业务拒绝。

公开接口仅允许创建者操作，读取计划与 occurrence 也重新检查当前 Task/Run 源访问；撤权后详情返回 404、列表隐藏条目。列表固定最多 100 条，仅支持不透明 `cursor`，不接受 `limit`。所有修改要求稳定幂等键，修订与禁用还要求 `If-Match`。DELETE 表示禁用，历史事实保留。

API 导出 `registerScheduleRoutes(app, {identity, scheduling})`。服务由 `createSchedulingService({db, cursorSecret})` 创建，包含 `create/get/list/revise/disable/occurrences` 及内部扫描/派发方法。Runtime 同事务端口为 `validateScheduledRun(tx, {auth, taskId, runId}, requirePaused?)` 和 `scheduledWake(tx, {...binding, occurrenceId, scheduleId, scheduledInstant, deadline, latestDispatchAt})`，后者只返回 `dispatched` 或 `overlap`，无网络副作用。最终 Run UPDATE 再以数据库时钟检查到期/截止及寿命，避免等待锁时跨过截止后仍执行。

测试：`src/calendar.test.ts` 验证纽约 DST、Lord Howe 半小时切换、Apia 跳日和错过策略；`tests/integration/scheduling.test.ts` 验证真实 PostgreSQL 去重、并发禁用、授权与预算 fencing、运行寿命、RLS 和 HTTP 契约。
