const { MongoClient } = require('mongodb');
let client = null;
let db = null;
let isConnected = false;
async function connect(uri) {
  if (isConnected && client) {
    return { client, db };
  }
  try {
    console.log('🔌 正在连接 MongoDB...');
    client = new MongoClient(uri, {
      maxPoolSize: 10,
      minPoolSize: 2,
      maxIdleTimeMS: 60000,
      serverSelectionTimeoutMS: 5000
    });
    await client.connect();
    db = client.db();
    isConnected = true;
    console.log('✅ MongoDB 连接成功');
    console.log(`📦 数据库: ${db.databaseName}`);
    client.on('close', () => {
      console.log('⚠️  MongoDB 连接关闭');
      isConnected = false;
    });
    client.on('error', (error) => {
      console.error('❌ MongoDB 连接错误:', error.message);
      isConnected = false;
    });
    return { client, db };
  } catch (error) {
    console.error('❌ MongoDB 连接失败:', error.message);
    isConnected = false;
    throw error;
  }
}
async function disconnect() {
  if (client) {
    await client.close();
    client = null;
    db = null;
    isConnected = false;
    console.log('👋 MongoDB 连接已断开');
  }
}
function getDb() {
  if (!db) {
    throw new Error('数据库未连接，请先调用 connect()');
  }
  return db;
}
function checkConnection() {
  return isConnected && client && client.topology && client.topology.isConnected();
}
async function getStats() {
  if (!isConnected || !db) {
    return { connected: false };
  }
  try {
    const stats = await db.stats();
    const collections = await db.listCollections().toArray();
    return {
      connected: true,
      database: db.databaseName,
      collections: collections.length,
      dataSize: stats.dataSize,
      indexSize: stats.indexSize,
      storageSize: stats.storageSize
    };
  } catch (error) {
    return { connected: false, error: error.message };
  }
}
module.exports = {
  connect,
  disconnect,
  getDb,
  checkConnection,
  getStats
};
