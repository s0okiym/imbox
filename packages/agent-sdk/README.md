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
