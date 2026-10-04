# AC / INV 逐项证据审查

日期：2026-10-04（Asia/Shanghai）。审查范围是仓库当前 V1 实现与本机可重复验证的路径。检查了相关测试中的实际断言、状态/权限拒绝条件和业务事务边界，未按文件名批量通过。初始分批记录见 [候选证据](provisioning-evidence-2026-10-04.json)，最终同一源码全量 CI 与指纹见 [最终候选证据](final-candidate-evidence-2026-10-05.json)，具名用例与定位见 [回归目录](regression-cases.md)，机器映射见 [coverage.json](../../tests/acceptance/coverage.json)。

`verified` 表示本项所列当前 V1 协议行为已有本地执行与断言支持，不代表任意外部供应方、性能或生产运维全部通过；`partial` 表示已验证一部分，并明确列出缺口；`pending` 表示缺少关键部署证据。完整生产门禁继续要求 41 项全部 verified，不能用本机试用资格替代。

| 要求   | 结果     | 实际断言与缺口                                                                                                                                                                  |
| ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-01  | verified | 私聊新增专用回归验证双方收发、第三人不可枚举/读取且不能增删成员；messaging/message-interactions 验证版本冲突、固定引用、删除脱敏、线程、反应和单调已读。                        |
| AC-02  | verified | messaging 的并发重复发送只有一条；sync 的固定快照衔接、断线补齐与 ACK 不写 read_cursors；agents 的 ACK 后请求仍 pending；offline 浏览器验证重连后仅发送一次。                   |
| AC-03  | verified | promotion 逐断言确认原 Run 对象不变、task_id 仍为空、原预算不变，产生唯一新 Task，继续执行必须重新授予 Agent 任务参与权限，撤销来源后重放拒绝。                                 |
| AC-04  | verified | agents 中 human→agent→agent 交接测试在 acknowledgeRequest 后断言 received_at 存在、status=pending、原 owner 不变，只有 decide accept 后才切换负责权。                           |
| AC-05 | verified | 委派拒绝/过期不创建 child，接受仅创建一个 child；三人浏览器闭环验证 Bob 拒绝后 Alice 改派 Charlie，Charlie 接受并获得子任务且不获得父任务入口，刷新后父 owner 仍为 Alice，子 accountable 仍为 Alice。 |
| AC-06  | verified | tasks 的 concurrent competing handoffs 断言仅一次成功、owner 为胜出者、version/epoch=2、唯一 owner/accept/agreement；同键五次接受返回同一协议，写入处于同一事务。               |
| AC-07 | verified | 真实交接后旧 Worker 心跳、预占、结果提交均拒绝；已持久化意图尚未派发的 Action 被旧 epoch 围栏拒绝并释放预占；真实 HTTP 副作用发生后交接且丢响应，新 owner 只读核对、一次 POST 与一次费用结算。 |
| AC-08  | verified | maintenance 并发扫描只升级一次，保持显式 blocked 和 owner_unavailable，审计 actor 为维护身份，原指派管理员离开时重新路由；源码只变阻塞/代际，不置空 owner。                     |
| AC-09  | verified | tasks conversation summary 仅返回显式 public_summary，关联不授予 Task ACL；knowledge 私人目标不出现在他人搜索，分页没有 total，跨租户与隐蔽成员读取拒绝。                       |
| AC-10  | verified | runtime-knowledge 拒绝私有 Memory 披露到会话、来源范围不同和 Agent 缺少读取权限；run-tool-intents 混合来源在排队前拒绝且模型调用/副作用均为零。                                 |
| AC-11  | verified | actions 验证无批准、过期批准、参数修改后旧批准失效且外部调用为零；machine-run-tools 验证审批后仍须人工 resume 与新租约。                                                        |
| AC-12  | partial  | 批准后撤销 grant、身份/参与代际改变会拒绝执行；来源撤回阻止模型输出。仍需针对已批准 Action 的每种资源版本变更补齐独立组合测试。                                                 |
| AC-13  | verified | actions/run-tool-intents 对真实受控服务注入丢响应，断言 unknown、一个 POST、核对成功后不重发；action-recovery 核对仅 GET 并且记账一次。                                         |
| AC-14  | partial  | runtime 分开记录 cancelling 与 worker acknowledged cancelled；未派发 Action 随 Run 取消，已发生/unknown 保留。真实外部 Agent 失联后恢复及远端确认的部署演练仍未完成。           |
| AC-15 | partial | 树预算/并发/期限、依赖防环、五层/200 节点边界已有实测；新增 8 Agent 有限计划、12 并发扫描/派发、停用、四租约和共享预算联合突发验证。模型驱动互相唤醒网络、任意事件触发和跨租户长期压力仍待完成。 |
| AC-16  | partial  | sync 投影事务回滚后持久重试、模型丢响应挂起、checkpoint 恢复不再请求模型；浏览器离线壳可用。尚未完成模型/对象/连接故障与积压同时出现时的长期联合演练。                          |
| AC-17  | verified | agents 作者绑定认证身份，伪造 actor 字段拒绝；过期/轮换 lease 拒绝；completed 外部回报保留 external_report/external 标识，machine API 不提供人类批准/恢复入口。                 |
| AC-18  | partial  | 已补产物同版本双写竞争（仅一次成功）以及新版写入与两名审核者同时验收（唯一决定/事件、幂等重试、固定旧版 hash）；删除来源拒绝仍保留。当前 Artifact 仅创建者能更新，跨作者编辑策略及外部发布 Action 对旧批准/新版产物的联合矩阵仍未完成。             |
| AC-19  | partial  | knowledge、resources、notifications、exports 验证当前 ACL 与分页/计数/下载分块/导出中途撤权，推送发送前重验。真实厂商通知及离线设备得知撤权后的跨设备矩阵仍待验收。             |
| AC-20  | partial  | governance/retention 验证派生正文清除、独立意图重放；真实隔离 dump/对象恢复重放四条事实，PWA 清除本机副本。生产备份链、所有组织授权历史和 WAL PITR 尚未覆盖。                   |
| AC-21  | partial  | Web 对协议/schema v1 内未知展示实体使用固定本地提示，不展示未知载荷；HTTP 快照和 WebSocket 保持已知消息同步，控制帧及不兼容版本拒绝。已有未知路由/非法请求拒绝。真实历史客户端与服务端滚动升级、动作 schema 版本联合矩阵仍未完成。                                   |
| AC-22  | verified | scheduling 同时扫描/派发只产生一次 occurrence 与 wake，停用后跳过、overlap 跳过、skip/coalesce 持久计数；calendar 单元覆盖纽约 DST、Lord Howe 半小时变更、Apia 跳日和上海时区。 |
| AC-23  | partial  | 跨租户、伪造身份/授权字段、私有来源披露与受限工具绑定已有拒绝断言，Memory instruction_authority=none。真实 IdP 回调矩阵、链接出口和模型提示攻击联合红队范围未全部验收。         |
| AC-24  | verified | tasks 验收仅限指定审核者，submission 固定 hash/goal；开放 child 阻止父任务通过验收；runtime 全子树 live Run/未知记账阻止关闭，Run completed 本身不执行任务验收。                |
| AC-25  | verified | tasks 父任务关闭/重开提升代际且旧 child proposal 失效；runtime 旧 claim 不可预占/提交；actions 旧 grant/epoch 被拒绝，不能借重开复活旧能力。                                    |
| INV-01 | verified | HTTP/machine 作者、批准者均来自认证上下文；正文 actor_id、target_id、executor_principal_id 注入拒绝；Agent 与人类会话不能混用。                                                 |
| INV-02 | verified | Task owner 非空数据库约束、初始 self owner 和唯一活动 owner 竞争断言；maintenance 明确阻塞与升级，不静默清空或改派。                                                            |
| INV-03 | verified | 咨询提案修订并接受后明确断言 owner 与 accountable 均保持原主体；委派前后父 owner、子 owner/accountable 已断言，交接 ACK 后及接受前原 owner 保持。                               |
| INV-04 | verified | 通过真实接受事务核对唯一 owner、accountable 不变、任务版本/epoch/授权代际提升及唯一交接事件和 outbox；旧 Worker 和未派发 Action 被拒绝，在途结果独立核对。 |
| INV-05 | verified | 传输 ACK 不写已读，Agent ACK 不接单，completed external report 不代表平台验证；任务必须经提交和指定审核者验收，Run 结束与 Task 关闭分离。                                       |
| INV-06 | verified | Task 会话关联不授予 Task ACL；Agent 注册不授予消息/任务访问；跨会话资源附件被拒绝，定向 Artifact share 不授予底层资源 ACL。                                                     |
| INV-07 | verified | runtime-knowledge 检查人类与 Agent 来源权限及披露范围，action 要求独立 grant/approval；分享固定版本/收件人代际，新群成员不继承旧分享。                                          |
| INV-08 | partial  | 未批/过期/参数变化/当前撤权均有执行前拒绝与零副作用断言；更完整的目标、执行主体和资源变更交叉矩阵仍待补验，不能将部分覆盖描述为完整证明。                                       |
| INV-09 | verified | 消息、outbox、SDK 同业务键幂等；unknown Action 不重发，只读核对、一次记账，恢复孤立行动继续保留原业务键。                                                                       |
| INV-10 | verified | domain/action 拒绝取消 unknown 或进入普通重试；UI unknown 只提供 reconcile；runtime 取消保留未知费用，迟到真实费用可记录且不发布旧结果。                                        |
| INV-11 | partial | 全祖先预算、四并发槽、20 步、绝对期限及五层/200 节点边界已有断言；8 Agent 有限唤醒突发联合验证精确容量和预算拒绝。模型驱动事件链与多租户长期混合压力仍待验收。 |
| INV-12 | verified | 消息/任务/资源/Run/工具/订阅重验当前身份与权限，移除后重新加入也不复活旧代际；离线设备无法即时得知远端撤权的边界按主动缓存策略说明。                                            |
| INV-13 | partial  | 搜索、分页、未读计数、导出分块、推送预派发与离线缓存清理分别已有断言；真实系统推送/设备生命周期与联合撤权矩阵尚不完整。                                                         |
| INV-14 | verified | 外部 Run 明确 external execution_location 与 external_report 来源，完成自报不改变 Task 验收；机器工具请求仍受当前 scope、主体、租约和人类恢复规则限制。                         |
| INV-15 | partial  | message/Memory/Run/资源/评论与分享的删除、保留、独立重放有测试；生产备份链及所有组织身份变更无法仅由本地四条事实恢复证明。                                                      |
| INV-16 | pending  | 本地 HTTP 试用不构成生产 TLS、静态加密或密钥托管证据。V1 不提供 E2EE；服务端/配置模型可见授权明文的说明保留，生产加密承诺待目标部署验收。                                       |

2026-10-05 交接和委派补验后结果：27 项 verified、13 项 partial、1 项 pending，新增实际运行与边界见 [交接证据](handoff-evidence-2026-10-05.md) 和 [委派证据](delegation-evidence-2026-10-05.md)。`pnpm test:acceptance` 预期仍非零退出；其余已通过的工程、集成和浏览器测试不因此作废。

后续按完整用户流程补验，优先交接包行动清单、组织生命周期与兼容性；真机、生产 IdP/TLS、灾备和参考容量使用真实环境证据。上述补验边界与当前可运行主体一并交付，遵循先完成主体、再细化的优先级。
