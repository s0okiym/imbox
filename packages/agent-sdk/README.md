# Imbox TypeScript Agent SDK

SDK 与 API 使用同一套生成契约，令牌只保存在内存中。固定可信 HTTPS origin；只有显式 `allowLoopbackHttp` 才允许本机 HTTP。API ID、输入、响应均校验，不允许调用者伪造身份、lease holder 或平台验证状态。

```ts
const client = new ImboxAgentClient({ origin, tenantId });
await client.exchange({ credential, scopes: ['requests.read', 'requests.ack'] });
const inbox = await client.listRequests();
// Caller deliberately chooses the request and exact version to acknowledge.
await client.acknowledgeRequest(requestId, proposalVersion, stableIdempotencyKey);
```

SDK 不自动接受契约、审批或重做未知外部行动。GET 和携带幂等键的命令遇到传输故障、502/503/504 时最多退避重试两次；始终复用同一请求体和键，整体超时默认 30 秒。凭证兑换不自动重试，401/403/409 原样交给调用者处理。发生不确定结果时保留命令键，并先查询服务端状态。

可执行协议示例位于 `examples/external-agent.ts`，用 `pnpm exec tsx examples/external-agent.ts` 启动。环境变量和行为见文件注释；示例只确认收件，显式提供 Run ID 才执行固定结果上报，不声称具有模型推理能力。机器凭证通过进程环境提供，不写入仓库或输出日志。

执行器确实停止后，若原租约仍有效，使用普通 `report(..., { status: 'cancelled', generation, checkpoint }, key)` 确认。租约已经过期且平台已请求取消/标记过期时，可调用独立通道：

```ts
// Stop and join your local work first. A lost lease alone does not prove it stopped.
const receipt = await client.acknowledgeCancellation(runId, lastClaimedGeneration, stableKey);
// receipt has only run_id, generation, acknowledged_at and external_report provenance.
```

该通道需要 `runs.report` 和仍有效的原领取凭证，服务端核对最后一次实际领取的 Worker/代际。其他代际、替换凭证和被撤销的授权不能提交或重放。它不接收输出、检查点或费用，也不续租/重启工作。平台的 `expired` 状态保持不变；租约过期的 `cancelling` 可完成为 `cancelled`。返回的是 Agent 自报事实，不是平台独立验证进程停止。未知外部行动仍必须单独核对。

升级前已清除租约持有人、无法证明最后领取者的历史记录不会凭猜测补齐；确认继续显示未知。
