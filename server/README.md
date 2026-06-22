# ClawMd Hub Server

Node.js sync server for ClawMd Hub.

## Setup

```bash
npm install
cp .env.example .env
node scripts/init-db.js
node scripts/init-conflicts-collection.js
```

## Run

```bash
npm start
```

## Production

```bash
pm2 start src/index.js --name clawmd-hub-server
pm2 save
```

## Environment

```bash
ACCESS_TOKEN=replace-with-a-long-random-secret
STORAGE_PATH=/var/lib/clawmd-hub/files
MONGODB_URI=mongodb://localhost:27017/clawmd-hub
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
SYNC_CHECK_INTERVAL=30
PORT=3000
HOST=0.0.0.0
NODE_ENV=production
```

## API

- `GET /health`
- `GET /files?token=...`
- `POST /upload`
- `GET /download/:path?token=...`
- `POST /restore`
- `GET /conflicts?token=...`
- `POST /conflicts/:id/resolve`
