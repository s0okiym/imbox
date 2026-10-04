# Artifact 分享授权与新版本隔离

日期：2026-10-05（Asia/Shanghai），基于 999ec56 的真实 PostgreSQL/S3 集成补验，产品源码无改动。

同一个 Artifact 的版本一明确分享给不具备源会话 ACL 的 Bob 后，创建者发布内容不同的版本二。断言旧分享及原幂等请求仍绑定版本一和原 SHA-256；通过实际分块下载核对返回的是版本一完整字节，Bob 仍不可直接读取版本二资源。

将版本二 ID 配上版本一摘要创建分享返回 VERSION_CONFLICT；使用正确版本二摘要但复用版本一请求键返回 IDEMPOTENCY_CONFLICT，两个失败均未新增分享。只有正确新版本 ID、摘要和新请求键组成的新明确分享，才允许 Bob 下载版本二；旧分享依然绑定版本一。

验证：`pnpm test:integration tests/integration/artifact-collaboration.test.ts`，1 文件、8 测试通过，10.25 秒。数据经过真实对象存储上传、完成验证及下载，不以伪造数据库内容替代字节验证。

限制：这是内部显式分享授权的版本隔离，不是外部 Action 发布工具的批准矩阵，也不代表多作者编辑已实现。AC-18 仍为 partial；跨作者编辑策略和外部发布动作的完整旧批准/新版本组合待完成。
