# 组织与工作区初始化

`pnpm workspace:provision` 是受限的离线运维入口，用于将已认证的用户加入一个**全新的组织和工作区**。需要迁移 owner 连接与迁移 030；Web、Worker 和身份服务的运行账号不能执行，也不能读取初始化回执。它不提供公开注册接口，不修改已有组织，不覆盖身份绑定。

## 身份准备

先配置实际 OIDC 提供方、正确的回调地址和生产 HTTPS。用户完成一次 OIDC 登录后，平台按精确 `(issuer, subject)` 创建或找到全局 human principal；还没有组织权限的用户不能访问工作区。由部署管理员在受控数据库会话中核对 `external_identities` 的精确 issuer/subject 与 `principals`，取得用户 UUID。不能按邮件地址或同名显示名称猜测、合并用户，也不能将 Agent UUID 当作人类管理员。

本机试用可使用开发 seed 已创建的 human UUID。真实生产不得启用开发登录或把 Alice/Bob 种子身份作为业务管理员。

## 私有清单

在版本库之外保存权限为 0600 的 JSON 文件。为组织和工作区各生成一个新 UUID，填写已有用户 UUID。例如结构如下（UUID 仅演示字段格式）：

```json
{
  "tenant_id": "10000000-0000-4000-8000-000000000010",
  "workspace_id": "20000000-0000-4000-8000-000000000010",
  "tenant_name": "示例组织",
  "workspace_name": "协作空间",
  "owner_principal_id": "30000000-0000-4000-8000-000000000010",
  "member_principal_ids": ["30000000-0000-4000-8000-000000000011"],
  "requested_by": "变更申请人或运维标识",
  "change_reference": "经过审核的变更单标识"
}
```

唯一 owner 同时是工作区 admin，其他人仅为 member。最多 100 人（包括 owner），所有用户必须存在、有效且为 human。额外字段、重复 UUID 和无效值会被拒绝。`requested_by` 是操作人填写的说明，不冒充认证事实；数据库独立记录真实 `session_user`。

```sh
pnpm workspace:provision /absolute/private/workspace.json
pnpm workspace:provision /absolute/private/workspace.json --apply
```

默认只检查并输出 `planned`，不创建租户或权限；`--apply` 才执行整个事务。返回组织/工作区 ID、成员数量和规范化清单摘要，不输出密钥、OIDC subject 或数据库连接串。CLI 失败只给出固定排查提示，不输出数据库错误正文。

执行与回执写入同一事务，任一失败全部回滚。同一清单并发或重复提交只会初始化一次；再次执行返回 `already_applied`，不会重新激活已撤销成员。相同组织 ID 的不同清单和既有组织都会拒绝。不要通过删回执来更新或重建组织。

## 生效与运行

把新增组织 UUID 加入部署的 `WORKER_TENANT_IDS`；启用工具时也加入 `TOOL_RUNNER_TENANT_IDS`，随后重启对应进程。用户在登录页的“组织标识”填写新增 UUID，重新登录后开始使用。初始化不会偷偷扩展 Worker 的允许范围。

运维 owner 可查询 `workspace_provisioning_receipts` 核对组织、工作区、清单摘要、申请人、变更引用、数据库操作者和时间。运行账号没有此表的授权；回执不经过聊天事件广播。迁移 owner 本身具有管理数据库的能力，其凭证与数据库审计需要在部署环境独立保管。

当前边界：入口只解决首次开户与初始成员导入。日常组织角色/停用/恢复和多工作区成员管理已有 Web 入口，见 [组织管理](organization-management.md)；自助邀请及新增人员入组仍需后续实现；不要将这个命令用于绕过正常撤权流程。真实 IdP/TLS、生产部署和恢复后组织授权复核仍按准出门槛验收。
