# Imbox

面向人与人、人和 AI Agent、Agent 之间沟通与协作的 AI 原生即时通信系统。

当前仓库包含产品与系统设计及开发方案，尚未实现应用程序。

- [产品与系统设计 v2.0](docs/imbox-product-and-system-design.md)：产品体验、领域模型、协作协议、Agent 运行、权限与隐私、可靠性、演进路线和验收标准。
- [开发设计 v1.0](docs/development/README.md)：技术选型、工程与数据设计、接口和 Runtime、客户端、安全运维、工作包及测试验收。

选定技术栈：TypeScript 6、Node.js 24 LTS、Fastify 5、React 19、Vite 8、PostgreSQL 18、Kysely、pg-boss、S3 兼容对象存储。精确依赖与镜像版本将在工程初始化时锁定并验证。

设计文档使用稳定文件名，版本及更新记录维护在文档内部。
