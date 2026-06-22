#!/usr/bin/env node
const { MongoClient } = require('mongodb');
require('dotenv').config();
async function initDatabase() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/clawmd-hub';
  console.log('🔗 连接 MongoDB...');
  console.log(`   URI: ${uri.replace(/\/\/.*@/, '//<credentials>@')}`);
  const client = new MongoClient(uri);
  try {
    await client.connect();
    console.log('✅ 连接 MongoDB 成功\n');
    const db = client.db();
    console.log('📦 检查集合...');
    const collections = await db.listCollections().toArray();
    const collectionNames = collections.map(c => c.name);
    if (!collectionNames.includes('files')) {
      await db.createCollection('files');
      console.log('   ✅ 创建 files 集合');
    } else {
      console.log('   ✓ files 集合已存在');
    }
    if (!collectionNames.includes('sync_logs')) {
      await db.createCollection('sync_logs');
      console.log('   ✅ 创建 sync_logs 集合');
    } else {
      console.log('   ✓ sync_logs 集合已存在');
    }
    if (!collectionNames.includes('sync_status')) {
      await db.createCollection('sync_status');
      console.log('   ✅ 创建 sync_status 集合');
    } else {
      console.log('   ✓ sync_status 集合已存在');
    }
    console.log('');
    console.log('📊 创建索引...');
    await db.collection('files').createIndex(
      { path: 1 },
      { unique: true, name: 'idx_path_unique' }
    );
    console.log('   ✅ files.path (唯一索引)');
    await db.collection('files').createIndex(
      { deleted: 1 },
      { name: 'idx_deleted' }
    );
    console.log('   ✅ files.deleted');
    await db.collection('files').createIndex(
      { updated_at: -1 },
      { name: 'idx_updated_at' }
    );
    console.log('   ✅ files.updated_at');
    await db.collection('files').createIndex(
      { hash: 1 },
      { name: 'idx_hash' }
    );
    console.log('   ✅ files.hash');
    await db.collection('sync_logs').createIndex(
      { file_path: 1, timestamp: -1 },
      { name: 'idx_file_path_timestamp' }
    );
    console.log('   ✅ sync_logs.file_path + timestamp');
    await db.collection('sync_logs').createIndex(
      { device_id: 1, timestamp: -1 },
      { name: 'idx_device_timestamp' }
    );
    console.log('   ✅ sync_logs.device_id + timestamp');
    await db.collection('sync_logs').createIndex(
      { timestamp: -1 },
      { name: 'idx_timestamp' }
    );
    console.log('   ✅ sync_logs.timestamp');
    console.log('');
    console.log('⚙️  初始化同步状态...');
    const existingStatus = await db.collection('sync_status').findOne({ _id: 'global' });
    if (!existingStatus) {
      await db.collection('sync_status').insertOne({
        _id: 'global',
        total_files: 0,
        active_files: 0,
        deleted_files: 0,
        total_size_bytes: 0,
        last_check_time: Date.now(),
        last_check_result: 'init',
        last_check_duration_ms: 0,
        updated_at: Date.now()
      });
      console.log('   ✅ 创建初始状态记录');
    } else {
      console.log('   ✓ 状态记录已存在');
    }
    console.log('');
    console.log('📊 数据库统计：');
    const filesCount = await db.collection('files').countDocuments();
    const logsCount = await db.collection('sync_logs').countDocuments();
    console.log(`   files: ${filesCount} 条记录`);
    console.log(`   sync_logs: ${logsCount} 条记录`);
    console.log('');
    console.log('🎉 数据库初始化完成！');
  } catch (error) {
    console.error('');
    console.error('❌ 初始化失败:');
    console.error('   ', error.message);
    console.error('');
    if (error.code === 'ECONNREFUSED') {
      console.error('💡 提示：');
      console.error('   1. 确保 MongoDB 已启动');
      console.error('   2. 检查 MONGODB_URI 配置');
      console.error('   3. 确认防火墙设置');
    }
    process.exit(1);
  } finally {
    await client.close();
  }
}
initDatabase();
