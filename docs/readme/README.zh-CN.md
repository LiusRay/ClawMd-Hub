# ClawMd Hub

[English](../../README.md) · [简体中文](README.zh-CN.md)

ClawMd Hub 是一个面向 AI 工作流的 Markdown 资料库同步中枢。它会监听本地文件变化，并以毫秒级延迟自动触发同步到 Node 运行环境、云端服务器以及未来的 iOS/Android 客户端，帮助 Claude、Codex、OpenClaw 使用同一份最新的 AI 上下文资料层。文件删除会同步为服务端软删除状态。ClawMd Hub 不提供版本回滚能力，因此更适合配合 Git 使用，由 Git 负责持久化历史版本和回滚。

## 项目状态

项目正在开发中。当前版本包含 Node.js 服务端和跨平台 Node 运行端客户端，可运行在 macOS、Linux 和 Windows。它目前还不是桌面安装包，后续可能增加安装包和系统服务封装。v1.0 之前，API、数据模型和插件接口都可能继续调整。

ClawMd Hub 专注于快速文件同步，不提供版本回滚能力。本地删除会作为删除操作同步到服务端，但服务端会标记为软删除，并保留服务端回收站记录。对于 Markdown 资料库和项目文档，建议配合 Git 使用，由 Git 负责历史版本、分支、审查和回滚。

## 功能特性

- 面向 Markdown 和文件型知识库的同步
- 毫秒级检测本地变化并自动触发同步
- 基于 Socket.IO 的实时设备连接
- HTTP 批量上传和文件下载
- 基于 hash 对比的首次双向同步
- 支持 `.syncignore`
- MongoDB 文件元数据索引
- Redis 设备状态和短期操作缓存
- 删除同步、服务端软删除状态和回收站
- 冲突检测和冲突副本生成
- 冲突列表和手动解决 API
- 跨平台 Node 文件监听客户端
- 建议配合 Git 管理历史版本和回滚

## 架构

```text
clawmd-hub/
├── server/
├── node-client/
├── docs/
│   └── readme/
└── test-conflict.sh
```

服务端把文件内容存储在磁盘上，把文件元数据存储在 MongoDB 中。Redis 用于设备状态、hash 缓存、回收站记录和短期操作日志。

## 快速开始

### 服务端

```bash
cd server
npm install
cp .env.example .env
npm start
```

### Node 客户端

```bash
cd node-client
npm install
cp .env.example .env
npm start
```

## 配置示例

服务端：

```bash
ACCESS_TOKEN=replace-with-a-long-random-secret
STORAGE_PATH=/var/lib/clawmd-hub/files
MONGODB_URI=mongodb://localhost:27017/clawmd-hub
REDIS_HOST=localhost
REDIS_PORT=6379
PORT=3000
HOST=0.0.0.0
NODE_ENV=production
```

Node 客户端：

```bash
RAY_PATH=/Users/you/Documents/MarkdownVault
SERVER_URL=wss://sync.example.com
ACCESS_TOKEN=replace-with-the-same-secret
DEVICE_ID=desktop-main
SYNC_TO_SERVER=true
```

## 插件方向

ClawMd Hub 后续会发展成插件化的 Markdown AI 资料库中枢：

- Obsidian 插件：同步状态、冲突查看、手动同步
- Codex 插件或本地工具：同步项目上下文
- Claude/OpenClaw 连接器或 MCP Server：读写 AI 上下文
- Web 控制台：管理设备、文件、冲突和同步健康状态

## 路线图

### v0.3 稳定性

- 优化下载和重试逻辑
- 服务端改为流式下载
- 增加本地状态检查命令
- 增加冲突查询辅助工具
- 增加日志轮转和运维文档

### v0.4 Node 运行环境打包

- 提供 macOS、Linux、Windows 的安装和服务脚本
- 增加一键更新流程
- 增加桌面通知
- 增加本地一致性检查工具

### v0.5 插件 SDK

- JavaScript/TypeScript SDK
- REST API 文档
- MCP 适配器原型
- Obsidian 插件原型

### v0.6 移动客户端

- iOS App 内同步
- Android 目录同步
- 手动和后台同步模式
- 冲突查看和选择性同步

### v1.0 AI 知识库同步层

- 稳定的桌面端/iOS/Android 协议
- 清晰的文件状态：active、deleted、conflict、resolved
- 设备级同步状态
- 持久化同步日志
- 可靠的冲突副本保留机制

## 安全说明

- 不要提交 `.env` 文件。
- 使用足够长的随机 `ACCESS_TOKEN`。
- 生产环境请使用 HTTPS/WSS。
- 定期备份 `STORAGE_PATH` 和 MongoDB。
- 将已有私有仓库公开前，请先检查 Git 历史。

## 开源协议

ClawMd Hub 基于 MIT License 完全开源。你可以免费使用、复制、修改、分发、再授权，也可以免费商用，只需要保留 MIT 协议声明。

软件按现状提供，不附带任何担保。请不要把私有配置、密钥、同步数据、数据库备份和个人笔记提交到公开仓库。

## License

[MIT](../../LICENSE)

## 友情链接

[Linux do](https://linux.do/)
