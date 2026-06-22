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
```

## Run

```bash
npm start
```

## Behavior

- Scans local files on startup
- Fetches server file metadata
- Detects local changes and triggers sync at millisecond-level latency
- Uploads files missing or changed on the server
- Downloads files missing locally
- Watches local changes with `chokidar`
- Receives remote update notifications over Socket.IO
- Stores local hash cache under `~/.clawmd-hub/sync`

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
