const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

const DEFAULT_SCAN_CONCURRENCY = 8;
const DEFAULT_PROGRESS_INTERVAL = 1000;

function compileIgnoreRules(rules) {
  return rules.map(rule => {
    const pattern = rule
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '§§§')
      .replace(/\*/g, '[^/]*')
      .replace(/§§§/g, '.*')
      .replace(/\?/g, '[^/]');

    return new RegExp('^' + pattern + '$');
  });
}

function shouldIgnore(relativePath, entryName, compiledRules) {
  return compiledRules.some(regex =>
    regex.test(relativePath) ||
    regex.test(`${relativePath}/`) ||
    regex.test(entryName) ||
    regex.test(`${entryName}/`)
  );
}

function createIgnoreMatcher(rules) {
  const compiledRules = compileIgnoreRules(rules);

  return (relativePath) => {
    const normalizedPath = relativePath.split(path.sep).join('/');
    const entryName = path.basename(normalizedPath);
    return shouldIgnore(normalizedPath, entryName, compiledRules);
  };
}

async function scanLocalFiles(rayPath, ignoreRules, options = {}) {
  const progressInterval = options.progressInterval || DEFAULT_PROGRESS_INTERVAL;
  const isIgnored = createIgnoreMatcher(ignoreRules);
  const files = [];
  let scanned = 0;

  console.log('🔍 开始扫描本地文件...');

  async function walk(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(rayPath, fullPath);

        if (isIgnored(relativePath)) {
          continue;
        }

        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          const stats = await fs.stat(fullPath);
          files.push({
            path: relativePath,
            size: stats.size,
            mtime: stats.mtimeMs
          });
          scanned++;

          if (scanned % progressInterval === 0) {
            console.log(`   已扫描 ${scanned} 个文件...`);
          }
        }
      }
    } catch (error) {
    }
  }

  await walk(rayPath);

  console.log(`📊 扫描完成，共 ${files.length} 个文件`);
  return files;
}

async function calculateFileHash(rayPath, filePath) {
  const fullPath = path.join(rayPath, filePath);
  const content = await fs.readFile(fullPath);
  return crypto.createHash('md5').update(content).digest('hex');
}

async function getFileState(rayPath, localDb, fileInfo) {
  const cached = localDb.getFile(fileInfo.path);

  if (
    cached &&
    cached.hash &&
    cached.size === fileInfo.size &&
    cached.mtime === fileInfo.mtime
  ) {
    return {
      ...fileInfo,
      hash: cached.hash,
      fromCache: true
    };
  }

  const hash = await calculateFileHash(rayPath, fileInfo.path);
  localDb.upsertFile({
    path: fileInfo.path,
    size: fileInfo.size,
    mtime: fileInfo.mtime,
    hash,
    syncStatus: 'scanned'
  });

  return {
    ...fileInfo,
    hash,
    fromCache: false
  };
}

async function updateLocalDbFromPath(rayPath, localDb, filePath, syncStatus = 'synced') {
  const fullPath = path.join(rayPath, filePath);
  const stats = await fs.stat(fullPath);
  const hash = await calculateFileHash(rayPath, filePath);

  localDb.upsertFile({
    path: filePath,
    size: stats.size,
    mtime: stats.mtimeMs,
    hash,
    syncStatus
  });

  return hash;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  let index = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (index < items.length) {
      const currentIndex = index++;
      await mapper(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
}

async function buildLocalIndex(rayPath, ignoreRules, localDb, options = {}) {
  const concurrency = parseInt(options.concurrency || DEFAULT_SCAN_CONCURRENCY, 10);
  const progressInterval = parseInt(options.progressInterval || DEFAULT_PROGRESS_INTERVAL, 10);
  const localFiles = await scanLocalFiles(rayPath, ignoreRules, { progressInterval });
  const indexedFiles = [];
  let cached = 0;
  let calculated = 0;

  console.log(`🔢 本地索引并发: ${concurrency}`);
  console.log('🔍 计算并写入本地 SQLite 索引...');

  await mapWithConcurrency(localFiles, concurrency, async (fileInfo, currentIndex) => {
    try {
      const localFile = await getFileState(rayPath, localDb, fileInfo);
      if (localFile.fromCache) {
        cached++;
      } else {
        calculated++;
      }
      indexedFiles[currentIndex] = localFile;

      if ((cached + calculated) % progressInterval === 0) {
        console.log(`   已索引 ${cached + calculated}/${localFiles.length} 个文件 (缓存命中: ${cached}, 重新计算: ${calculated})`);
      }
    } catch (error) {
      console.error(`⚠️  本地索引失败: ${fileInfo.path} - ${error.message}`);
    }
  });

  localDb.setState('local_index_initialized', 'true');
  localDb.setState('last_local_index_at', String(Date.now()));

  console.log(`✅ 本地索引完成: ${localFiles.length} 个文件 (缓存命中: ${cached}, 重新计算: ${calculated})`);

  return {
    files: indexedFiles.filter(Boolean),
    cached,
    calculated
  };
}

module.exports = {
  scanLocalFiles,
  calculateFileHash,
  getFileState,
  updateLocalDbFromPath,
  buildLocalIndex,
  createIgnoreMatcher
};
