const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DEFAULT_DB_PATH = path.join(
  process.env.HOME,
  '.clawmd-hub',
  'client-state.db'
);

const dbPath = process.env.LOCAL_DB_PATH || DEFAULT_DB_PATH;
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    size INTEGER NOT NULL DEFAULT 0,
    mtime REAL NOT NULL DEFAULT 0,
    hash TEXT,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_files_sync_status ON files(sync_status);
  CREATE INDEX IF NOT EXISTS idx_files_updated_at ON files(updated_at);
`);

const getFileStmt = db.prepare('SELECT * FROM files WHERE path = ?');
const upsertFileStmt = db.prepare(`
  INSERT INTO files (path, size, mtime, hash, sync_status, updated_at)
  VALUES (@path, @size, @mtime, @hash, @syncStatus, @updatedAt)
  ON CONFLICT(path) DO UPDATE SET
    size = excluded.size,
    mtime = excluded.mtime,
    hash = excluded.hash,
    sync_status = excluded.sync_status,
    updated_at = excluded.updated_at
`);
const markDeletedStmt = db.prepare(`
  INSERT INTO files (path, size, mtime, hash, sync_status, updated_at)
  VALUES (?, 0, 0, NULL, 'deleted', ?)
  ON CONFLICT(path) DO UPDATE SET
    size = 0,
    mtime = 0,
    hash = NULL,
    sync_status = 'deleted',
    updated_at = excluded.updated_at
`);
const getStateStmt = db.prepare('SELECT value FROM sync_state WHERE key = ?');
const setStateStmt = db.prepare(`
  INSERT INTO sync_state (key, value, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET
    value = excluded.value,
    updated_at = excluded.updated_at
`);
const countFilesStmt = db.prepare('SELECT COUNT(*) AS count FROM files');

function getDbPath() {
  return dbPath;
}

function getFile(filePath) {
  return getFileStmt.get(filePath);
}

function upsertFile({ path: filePath, size, mtime, hash, syncStatus = 'pending' }) {
  upsertFileStmt.run({
    path: filePath,
    size,
    mtime,
    hash,
    syncStatus,
    updatedAt: Date.now()
  });
}

function markFileDeleted(filePath) {
  markDeletedStmt.run(filePath, Date.now());
}

function getState(key) {
  const row = getStateStmt.get(key);
  return row ? row.value : null;
}

function setState(key, value) {
  setStateStmt.run(key, value, Date.now());
}

function countFiles() {
  return countFilesStmt.get().count;
}

function transaction(fn) {
  return db.transaction(fn)();
}

module.exports = {
  getDbPath,
  getFile,
  upsertFile,
  markFileDeleted,
  getState,
  setState,
  countFiles,
  transaction
};
