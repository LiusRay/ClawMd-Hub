# ClawMd Hub

[English](README.md) · [简体中文](docs/readme/README.zh-CN.md)

ClawMd Hub is a Markdown knowledge-base sync hub for AI workflows. It watches local files and triggers sync automatically at millisecond-level latency across Node runtimes, cloud servers, and future iOS/Android clients, helping Claude, Codex, and OpenClaw use the same up-to-date AI context layer. Deleted files are synced as soft-delete state on the server. ClawMd Hub does not provide version rollback, so it is best used together with Git for durable history and rollback.

## Status

This project is under active development. The current version includes a Node.js server and a cross-platform Node runtime client for macOS, Linux, and Windows. It is not a packaged desktop app yet. Installers and service wrappers may be added later. The API, data model, and plugin interfaces may still change before v1.0.

ClawMd Hub focuses on fast file synchronization, not version rollback. Deleted files are synced as delete operations, while the server marks them as soft-deleted and keeps server-side trash records. For Markdown knowledge bases and project documents, use it together with Git when you need durable history, branching, review, or rollback.

## Features

- Markdown and file-based knowledge-base sync
- Millisecond-level change detection and automatic sync trigger
- Real-time device connection with Socket.IO
- HTTP batch upload and file download
- Initial two-way sync with hash comparison
- `.syncignore` support
- MongoDB file metadata index
- Redis device state and short-term operation cache
- Delete sync with server-side soft-delete state and trash storage
- Conflict detection with conflict-copy generation
- Conflict listing and manual resolution API
- Cross-platform Node file watcher client
- Designed to pair with Git for version history and rollback

## Architecture

```text
clawmd-hub/
├── server/
├── node-client/
└── docs/
    └── readme/
```

The server stores file content on disk and metadata in MongoDB. Redis is used for device state, hash cache, trash records, and short-term operation logs.

The Node client stores local file metadata and hashes in SQLite. On later starts, unchanged files reuse the SQLite hash instead of recalculating every file hash.

## Quick Start

### Server

```bash
cd server
npm install
cp .env.example .env
npm start
```

### Node Client

```bash
cd node-client
npm install
cp .env.example .env
npm start
```

## Example Configuration

Server:

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

Node client:

```bash
RAY_PATH=/Users/you/Documents/MarkdownVault
SERVER_URL=wss://sync.example.com
ACCESS_TOKEN=replace-with-the-same-secret
DEVICE_ID=desktop-main
SYNC_TO_SERVER=true
LOCAL_DB_PATH=/Users/you/.clawmd-hub/client-state.db
LOCAL_SCAN_CONCURRENCY=8
LOCAL_SCAN_PROGRESS_INTERVAL=1000
FILE_CHANGE_DEBOUNCE_MS=1000
REMOTE_WRITE_SUPPRESS_MS=5000
UPLOAD_BATCH_SIZE=10
UPLOAD_BATCH_MAX_MB=20
```

Local index only mode:

```bash
LOCAL_INDEX_ONLY=true npm start
```

## Plugin Direction

ClawMd Hub is designed to grow into a plugin-based Markdown knowledge hub:

- Obsidian plugin for vault sync status, conflict review, and manual sync
- Codex plugin or local tool for project context synchronization
- Claude/OpenClaw connector or MCP server for reading and writing AI context
- Web console for devices, files, conflicts, and sync health

## Roadmap

The roadmap describes planned development directions, not features that are already fully available in the current release. Items may change as the project evolves.

### v0.3 Stability

- Improve download and retry behavior
- Stream downloads from the server
- Add local status/check commands
- Add conflict query helpers
- Add log rotation and operational docs

### v0.4 Node Runtime Packaging

- Provide install and service scripts for macOS, Linux, and Windows
- Add one-command update flow
- Add desktop notifications
- Add local consistency check tooling

### v0.5 Plugin SDK

- JavaScript/TypeScript SDK
- REST API documentation
- MCP adapter prototype
- Obsidian plugin prototype

### v0.6 Mobile Clients

- iOS app-scoped sync
- Android directory sync
- Manual and background sync modes
- Conflict viewing and selective sync

### v1.0 AI Knowledge Sync Layer

- Stable desktop/iOS/Android protocol
- Clear file states: active, deleted, conflict, resolved
- Device-level sync status
- Durable sync logs
- Reliable conflict-preserving behavior

## Security Notes

- Never commit `.env` files.
- Use a long random `ACCESS_TOKEN`.
- Deploy production servers behind HTTPS/WSS.
- Back up `STORAGE_PATH` and MongoDB regularly.
- Review Git history before making an existing private repository public.

## Open Source

ClawMd Hub is fully open source under the MIT License. You can use, copy, modify, distribute, sublicense, and use it commercially for free, as long as the MIT license notice is preserved.

The software is provided as-is without warranty. Keep private configuration, secrets, sync data, database dumps, and personal notes out of public repositories.

## License

[MIT](LICENSE)

## Friendly Links

[Linux do](https://linux.do/)
