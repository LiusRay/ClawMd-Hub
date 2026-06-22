const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { getDb } = require('./db');
async function warmupOnStartup(storagePath) {
  console.log('\n🔥 启动缓存预热...');
  const db = getDb();
  try {
    const dbCount = await db.collection('files')
      .countDocuments({ deleted: false });
    console.log(`📊 MongoDB 文件数: ${dbCount}`);
    console.log('📂 扫描磁盘文件...');
    const fsCount = await countFilesOnDisk(storagePath);
    console.log(`📂 磁盘文件数: ${fsCount}`);
    if (dbCount !== fsCount) {
      console.log(`⚠️  发现差异，启动全量同步...`);
      await fullSync(storagePath);
    } else {
      console.log(`✅ 缓存一致，跳过同步`);
    }
    await updateSyncStatus();
    console.log('✅ 预热完成\n');
  } catch (error) {
    console.error('❌ 预热失败:', error.message);
    throw error;
  }
}
async function countFilesOnDisk(storagePath) {
  let count = 0;
  async function walk(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === '.trash') continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          count++;
        }
      }
    } catch (error) {
    }
  }
  await walk(storagePath);
  return count;
}
async function fullSync(storagePath) {
  console.log('🔄 开始全量同步...');
  const db = getDb();
  const startTime = Date.now();
  try {
    const dbFiles = await db.collection('files')
      .find({ deleted: false })
      .project({ path: 1 })
      .toArray();
    const dbPaths = new Set(dbFiles.map(f => f.path));
    console.log(`   已加载 ${dbPaths.size} 个 DB 文件路径`);
    const fsPaths = new Set();
    const toInsert = [];
    let scanned = 0;
    async function walk(dir) {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name === '.trash') continue;
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(fullPath);
          } else if (entry.isFile()) {
            const relativePath = path.relative(storagePath, fullPath);
            fsPaths.add(relativePath);
            scanned++;
            if (scanned % 100 === 0) {
              console.log(`   已扫描 ${scanned} 个文件...`);
            }
            if (!dbPaths.has(relativePath)) {
              try {
                const content = await fs.readFile(fullPath);
                const hash = crypto.createHash('md5').update(content).digest('hex');
                const stats = await fs.stat(fullPath);
                toInsert.push({
                  path: relativePath,
                  hash,
                  size: stats.size,
                  mtime: stats.mtimeMs,
                  deleted: false,
                  created_at: Date.now(),
                  updated_at: Date.now()
                });
              } catch (error) {
                console.error(`   ⚠️  读取失败: ${relativePath}`);
              }
            }
          }
        }
      } catch (error) {
      }
    }
    await walk(storagePath);
    console.log(`   扫描完成: ${scanned} 个文件`);
    if (toInsert.length > 0) {
      console.log(`   正在插入 ${toInsert.length} 个新文件...`);
      const BATCH_SIZE = 1000;
      for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
        const batch = toInsert.slice(i, i + BATCH_SIZE);
        await db.collection('files').insertMany(batch, { ordered: false });
        console.log(`   已插入 ${Math.min(i + BATCH_SIZE, toInsert.length)}/${toInsert.length}`);
      }
      console.log(`   ✅ 新增 ${toInsert.length} 个文件`);
    }
    const toDelete = [];
    for (const dbPath of dbPaths) {
      if (!fsPaths.has(dbPath)) {
        toDelete.push(dbPath);
      }
    }
    if (toDelete.length > 0) {
      console.log(`   正在标记 ${toDelete.length} 个已删除文件...`);
      await db.collection('files').updateMany(
        { path: { $in: toDelete } },
        {
          $set: {
            deleted: true,
            updated_at: Date.now()
          }
        }
      );
      console.log(`   🗑️  标记删除 ${toDelete.length} 个文件`);
    }
    const duration = Date.now() - startTime;
    console.log(`✅ 全量同步完成，耗时 ${(duration / 1000).toFixed(1)} 秒`);
  } catch (error) {
    console.error('❌ 全量同步失败:', error.message);
    throw error;
  }
}
async function updateSyncStatus() {
  const db = getDb();
  try {
    const totalFiles = await db.collection('files').countDocuments();
    const activeFiles = await db.collection('files').countDocuments({ deleted: false });
    const deletedFiles = await db.collection('files').countDocuments({ deleted: true });
    const sizeResult = await db.collection('files').aggregate([
      { $match: { deleted: false } },
      { $group: { _id: null, totalSize: { $sum: '$size' } } }
    ]).toArray();
    const totalSize = sizeResult.length > 0 ? sizeResult[0].totalSize : 0;
    await db.collection('sync_status').updateOne(
      { _id: 'global' },
      {
        $set: {
          total_files: totalFiles,
          active_files: activeFiles,
          deleted_files: deletedFiles,
          total_size_bytes: totalSize,
          updated_at: Date.now()
        }
      },
      { upsert: true }
    );
    console.log(`📊 统计更新: ${activeFiles} 个活跃文件 (${(totalSize / 1024 / 1024).toFixed(1)} MB)`);
  } catch (error) {
    console.error('❌ 更新统计失败:', error.message);
  }
}
async function startPeriodicCheck(storagePath, intervalMinutes = 30) {
  console.log(`⏰ 启动定期巡检，间隔 ${intervalMinutes} 分钟\n`);
  const intervalMs = intervalMinutes * 60 * 1000;
  setInterval(async () => {
    console.log('\n🔍 开始定期巡检...');
    const db = getDb();
    const startTime = Date.now();
    try {
      const dbCount = await db.collection('files')
        .countDocuments({ deleted: false });
      const fsCount = await countFilesOnDisk(storagePath);
      console.log(`📊 DB: ${dbCount}, 磁盘: ${fsCount}`);
      if (dbCount !== fsCount) {
        console.log(`⚠️  发现差异，启动全量同步...`);
        await fullSync(storagePath);
      } else {
        console.log(`✅ 巡检通过，数据一致`);
      }
      const duration = Date.now() - startTime;
      await db.collection('sync_status').updateOne(
        { _id: 'global' },
        {
          $set: {
            last_check_time: Date.now(),
            last_check_result: 'ok',
            last_check_duration_ms: duration
          }
        }
      );
      console.log(`✅ 巡检完成，耗时 ${(duration / 1000).toFixed(1)} 秒\n`);
    } catch (error) {
      console.error('❌ 巡检失败:', error.message);
      await db.collection('sync_status').updateOne(
        { _id: 'global' },
        {
          $set: {
            last_check_time: Date.now(),
            last_check_result: 'error'
          }
        }
      );
    }
  }, intervalMs);
}
module.exports = {
  warmupOnStartup,
  fullSync,
  updateSyncStatus,
  startPeriodicCheck,
  countFilesOnDisk
};
