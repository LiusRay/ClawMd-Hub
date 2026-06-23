# ClawMd Hub Node Client

Node.js client for watching a local folder and triggering sync through a ClawMd Hub server at millisecond-level latency.

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:

```bash
RAY_PATH=/Users/you/Documents/KnowledgeBase
SERVER_URL=wss://sync.example.com
ACCESS_TOKEN=replace-with-the-same-secret
DEVICE_ID=desktop-main
SYNC_TO_SERVER=true
LOCAL_DB_PATH=/Users/you/.clawmd-hub/client-state.db
LOCAL_SCAN_CONCURRENCY=8
LOCAL_SCAN_PROGRESS_INTERVAL=1000
UPLOAD_BATCH_SIZE=10
UPLOAD_BATCH_MAX_MB=20
```

## Run

```bash
npm start
```

## Behavior

- Scans local files on startup
- Stores local file metadata and hashes in SQLite
- Reuses SQLite hashes when file size and mtime are unchanged
- Fetches server file metadata
- Detects local changes and triggers sync at millisecond-level latency
- Uploads files missing or changed on the server
- Downloads files missing locally
- Watches local changes with `chokidar`
- Receives remote update notifications over Socket.IO
- Stores local state under `~/.clawmd-hub/client-state.db` by default

## Local Index Mode

Build or refresh the local SQLite index without connecting to the server:

```bash
LOCAL_INDEX_ONLY=true npm start
```

Useful settings:

```bash
LOCAL_DB_PATH=/Users/you/.clawmd-hub/client-state.db
LOCAL_SCAN_CONCURRENCY=8
LOCAL_SCAN_PROGRESS_INTERVAL=1000
```

## Ignore Rules

The client reads `.syncignore` from the synced folder. If it is missing, default rules are used:

```text
node_modules/**
.git/**
.DS_Store
```

## Notes

This is a Node runtime client, not a packaged desktop app. It can run anywhere Node.js and filesystem watching are available, including macOS, Linux, and Windows.

The client does not provide version rollback. Deletes are synced to the server as soft-delete state and server-side trash records. Use Git alongside ClawMd Hub when you need durable history or rollback for Markdown knowledge bases and project files.
