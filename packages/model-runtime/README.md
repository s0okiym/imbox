# @imbox/model-runtime

托管文字生成的有限执行步骤。当前适配器连接显式配置的本机 Ollama，只支持文字和取消信号；流式 token、图像和工具调用能力返回 false。模型输出不会直接执行代码、变更 Task 状态或批准 Action。

Agent revision 只能配置 `{"model_alias":"local"}`。服务端模型目录决定 endpoint、模型及摘要，ContextManifest 的 destination 必须精确为 `model:local`。每次发送正文前核验模型摘要；未知配置、非本机 URL、重定向、超大输入/输出均拒绝。输入仅包含明确获准的来源版本与处理目的，来源放在 user 数据中。提示词不能替代权限检查，工具授权仍由行动网关处理。

当前固定 Qwen3 0.6B 的 8192 token 上下文，按 UTF-8 字节保守计数，并为模板和输出留空间；超过限制在调用前拒绝，不能把被供应方静默截断的正文说成已使用。供应方 chat API 说明见 [Ollama 官方 API](https://docs.ollama.com/api/chat)，模型来源见 [Qwen3 0.6B](https://ollama.com/library/qwen3:0.6b)。本机计算使用明确的 `local-unmetered` 计价策略，金额为 0，同时保留实际输入/输出 token 数；本地 invocation ID 不是供应商签发的收费回执。

执行顺序为 lease → 当前授权/上下文 → 预算预占 → 事务外 HTTP → 原子结算与检查点 → 完成报告。租约每 15 秒续期。结算和结果检查点同事务提交，崩溃恢复可以复用结果；失效执行仅允许登记迟到用量事实，不公开内容。调用后超时/断开保留 unknown，不自动重发。Run 的最终状态不替代 Task 的提交与验收。

## 本地运行与验证

```sh
docker compose -f infra/compose.yaml --profile model up -d model
docker compose -f infra/compose.yaml --profile model exec -T model ollama pull qwen3:0.6b
pnpm test:model
```

镜像和模型 SHA-256 固定于 compose / `.env.example` / 真实模型用例。若 upstream 标签摘要变化，先评估并显式更新配置；不自动接受新模型。启动业务 Worker 前设置 `.env` 的 `ENABLE_LOCAL_MODEL=true`，并填写全部 `OLLAMA_*` 配置。创建 hosted installation 的 revision 配置上述 alias，明确把 Agent 加入会话/任务，再创建 Run；安装本身不授予业务数据权限。

投影 Worker 和模型循环并行运行；慢模型不阻塞聊天同步。默认单个模型执行槽，运行进程使用独立 worker ID，进程退出中断在途请求并保留未知用量。

- `tests/integration/model-adapter.test.ts`：真实 HTTP 协议与故障边界。
- `tests/integration/model-driver.test.ts`：真实 PostgreSQL + HTTP 故障服务，覆盖持久检查点、源撤权、unknown、暂停恢复和目的地拒绝。
- `tests/model/ollama.test.ts`：实际固定模型 + PostgreSQL，没有模型响应替身，输出 `.artifacts/model-evidence.json`。

前两组的测试服务只用于故障注入，不能作为真实模型质量证据。最后一组只验证小模型实际执行链与标识提取，不代表复杂推理、中文长文本或生产负载质量已经评估。

## 一次工具提案与人工恢复

显式 Task Run 可通过 `tool_grant_id` 绑定一个已有 CapabilityGrant。创建者必须是人类，grant 的 executor 必须是本 Run 安装的 Agent，预算币种相同且 grant 上限不超过 Run 上限。当前工具路径的 ContextManifest 仅支持该 Task 当前版本，且版本列表必须精确等于 grant 披露清单；消息、Memory、Artifact 派生文本尚不能由现有 TaskVersionRef grant 表达，因此拒绝混合来源。普通文字 Run 保持原有来源能力。

本机 Ollama 使用 `format` JSON Schema 生成 `final` 或 `tool_intent`，随后由契约校验。`structuredOutput=true`，`toolCalls=false`：这是受约束的结构化提案，不是原生 function calling。模型只能选择提案文字；工具版本、目标、执行者、grant、资源版本、估算费用和永久业务键由平台绑定。目标 URL 和凭证不进入模型输入。

有限路径为：模型结果和用量持久检查点 → 同事务创建 Action/唯一 Run 意图 → `waiting_approval` 并释放租约 → 人类审批 → **人类显式恢复 Run** → 新租约 → 已有工具网关执行同一 Action → 一次模型结果总结。审批本身不会发送；普通 Action 扫描器不会执行绑定 Run 的 Action。最多一件工具业务行动及两次模型请求，仍受原 Run 的 20 步、24 小时和预算约束；不启动循环调用、递归 Run 或自动审批。

工具阶段同时预占/结算 Run 与 Task 祖先预算，各自只记一次；本机模型的 0 元计价不代表工具免费。超时保持 Action unknown 和原预算预占，Run 等待核对。只有可信供应方回执核对后，人类才能恢复；恢复读取原 Action/检查点，不另造业务键。旧 Run generation、暂停、取消、安装/身份/源撤权都拒绝新的工具准入，迟到回执仍可补记费用而不发布模型内容。取消时尚未发送的绑定 Action 同事务取消。

`createModelDriver({worker, models, actions})` 显式装配工具能力；工具模式缺失网关时失败关闭。Task/Run 权限未通过时不得显示意图；审批和执行状态可通过 `GET /v1/agent-runs/:id/tool-intent` 查看。

相关官方协议：[Ollama 结构化输出](https://docs.ollama.com/capabilities/structured-outputs)。真实 PostgreSQL 与 HTTP 故障测试见 `tests/integration/run-tool-intents.test.ts`；测试用 HTTP 模型用于协议/故障边界，不代表实际模型质量。
