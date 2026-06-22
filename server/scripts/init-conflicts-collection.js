require('dotenv').config();
const { MongoClient } = require('mongodb');
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/clawmd-hub';
async function initConflictsCollection() {
  const client = new MongoClient(MONGODB_URI);
  try {
    console.log('🔌 正在连接 MongoDB...');
    await client.connect();
    console.log('✅ MongoDB 连接成功\n');
    const db = client.db();
    const collections = await db.listCollections({ name: 'conflicts' }).toArray();
    if (collections.length > 0) {
      console.log('⚠️  conflicts 集合已存在');
      const choice = process.argv[2];
      if (choice === '--force') {
        console.log('🗑️  删除旧集合...');
        await db.collection('conflicts').drop();
        console.log('✅ 旧集合已删除\n');
      } else {
        console.log('💡 使用 --force 参数强制重建');
        return;
      }
    }
    console.log('📦 创建 conflicts 集合...');
    await db.createCollection('conflicts');
    console.log('✅ conflicts 集合已创建\n');
    console.log('🔧 创建索引...');
    await db.collection('conflicts').createIndex(
      { resolved: 1, detected_at: -1 },
      { name: 'idx_resolved_detected' }
    );
    console.log('  ✅ 索引: resolved + detected_at');
    await db.collection('conflicts').createIndex(
      { original_path: 1 },
      { name: 'idx_original_path' }
    );
    console.log('  ✅ 索引: original_path');
    await db.collection('conflicts').createIndex(
      { device_id: 1, detected_at: -1 },
      { name: 'idx_device_detected' }
    );
    console.log('  ✅ 索引: device_id + detected_at');
    console.log('');
    console.log('🔧 扩展 files 集合字段...');
    const filesCount = await db.collection('files').countDocuments();
    if (filesCount > 0) {
      const result = await db.collection('files').updateMany(
        {
          $or: [
            { last_modified_by: { $exists: false } },
            { last_modified_at: { $exists: false } },
            { conflict_count: { $exists: false } }
          ]
        },
        {
          $set: {
            last_modified_by: 'unknown',
            last_modified_at: Date.now(),
            conflict_count: 0
          }
        }
      );
      console.log(`  ✅ 更新了 ${result.modifiedCount} 个文件记录`);
    } else {
      console.log('  ℹ️  files 集合为空，跳过字段扩展');
    }
    console.log('');
    console.log('📊 集合信息:');
    const conflictsIndexes = await db.collection('conflicts').indexes();
    console.log(`  conflicts 集合: ${conflictsIndexes.length} 个索引`);
    const filesCollections = await db.listCollections({ name: 'files' }).toArray();
    if (filesCollections.length > 0) {
      const filesIndexes = await db.collection('files').indexes();
      console.log(`  files 集合: ${filesIndexes.length} 个索引, ${filesCount} 条记录`);
    } else {
      console.log(`  files 集合: 尚未创建（将在首次同步时自动创建）`);
    }
    console.log('');
    console.log('✅ conflicts 集合初始化完成！');
    console.log('');
    console.log('📋 数据模型:');
    console.log(`
  conflicts: {
    _id: ObjectId,
    original_path: String,
    conflict_path: String,
    device_id: String,
    detected_at: Number,
    resolved: Boolean,
    resolved_at: Number,
    resolution: String,
    server_hash: String,
    client_hash: String
  }
  files (新增字段): {
    last_modified_by: String,
    last_modified_at: Number,
    conflict_count: Number
  }
    `);
  } catch (error) {
    console.error('❌ 初始化失败:', error.message);
    process.exit(1);
  } finally {
    await client.close();
    console.log('👋 MongoDB 连接已关闭');
  }
}
if (require.main === module) {
  initConflictsCollection().catch(console.error);
}
module.exports = { initConflictsCollection };
