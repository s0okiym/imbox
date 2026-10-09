# 独立 Worker 进程崩溃后的租约恢复

日期：2026-10-08（Asia/Shanghai），父候选 ae54c39。

此前联合故障回归（见 [消息联合故障与 ACK 积压恢复](joint-fault-recovery-2026-10-05.md)）通过暂停调用并重新创建投影处理器模拟投影中断，明确不冒充杀死独立 Worker 进程。本轮补齐该缺口：真实 Worker 入口（`apps/worker/src/main.ts`）作为独立 OS 进程启动，绑定隔离测试租户与应用数据库角色，在投影中途被 SIGKILL 硬终止。

场景与断言：

- 任何投影者运行期间经真实认证 HTTP 提交 40 条消息，outbox 积压 40 条 pending，接收者事件查询为空。
- 测试持有会话行锁（conversations FOR UPDATE）冻结投影事务，随后启动真实 Worker 进程；它以单一批次租约全部 40 条（leased、单一 holder、attempts=1），首个投影事务阻塞在该行锁上。
- 对该进程发送 SIGKILL：退出码为 null、signal 为 SIGKILL，无任何失败处理器运行。搁置的 40 条租约保持 leased、租约仍存活（`lease_expires_at > clock_timestamp()`）、零 dead、零 projector 回执，接收者仍读不到任何消息。被杀进程的阻塞事务随连接断开由数据库回滚，不留锁残留。
- 启动新的独立 Worker 进程：租约到期前无法领取搁置行；到期后经正常领取路径重认领（attempts 恰好为 2，即崩溃前一次、恢复后一次），全部 completed，每条事件恰好一条 projector 回执。
- 接收者从原游标重连 WebSocket：40 条重放消息逐一核对正文并 ACK，恢复后在线消息送达，41 条消息 ID 唯一无遗漏或重复，数据库消息恰为 41 条。替代 Worker 最后经 SIGTERM 正常停止，退出码 0。

生产配置变更：Worker 新增 `WORKER_LEASE_SECONDS` 环境变量（默认 30，整数 1–300，非法值启动即拒绝），与 `WORKER_POLL_INTERVAL_MS` 同样显式校验后传给 outbox 处理器的租约时长；默认行为不变。该配置已加入 `infra/deployment/worker.env.example` 与 [运维手册](../operations/README.md) 的 Worker 段落，说明调整约束（须大于最慢单条投影事务时长，不得手工清除未完成行）。

首轮编写时发现并修正的测试问题：`consumer_receipts` 由多个消费者共享，通知派发循环（`notification-events:v1`）会在投影被锁期间独立消费 message 事件并写入自己的回执。断言必须按 `conversation-projector:v1` 过滤；这不改变生产行为，反而确认了通知循环与投影循环相互独立的设计。同轮把搁置计数改为 `count(distinct ...)` 以避免回执 JOIN 扇出放大计数。另有一次执行因 `fork` 强制 IPC 通道失败，改为 `spawn` 以 `--import tsx` 启动真实入口，进程模型不变。

验证批次（本机独立 Node 24.21.0 工具链，PostgreSQL 18 / 127.0.0.1:55432）：

- 新用例单跑通过（17.8 秒）；随后 `tests/integration/sync.test.ts` 全文件 17/17 通过（42.49 秒）。
- 完整 `pnpm verify` 通过：环境检查、契约、构建、运行依赖、全仓类型、测试类型、Lint 与 34 文件 191 项单元（9.44 秒）。
- 回归目录更新为 89 文件 / 539 声明；`pnpm test:acceptance` 按预期 30/41 非零退出。
- coverage.json 同步修正 AC-14 的过期注记：Task 取消到 Run 取消请求/状态联动的实现与证据（`task-cancellation-propagation-2026-10-05.md`，候选 41f3e12）此前未登记，现已补入；AC-14 仍因跨主机 TLS/网络分区/重启部署矩阵保持 partial。

范围与边界：这是单进程投影路径的崩溃-恢复回归。租约时长为加速验证配置为 12 秒（机制与默认 30 秒一致，均为到期重认领）；未覆盖长期积压、数据库与队列联合故障、跨主机进程消失、容器编排重启策略或参考容量，AC-16 保持 partial。通知循环独立消费属预期行为，本用例不验证通知送达本身。
