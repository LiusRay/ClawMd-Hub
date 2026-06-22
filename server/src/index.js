require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const redis = require('redis');
const fs = require('fs').promises;
const path = require('path');
const { connect: connectMongo, getDb } = require('./db');
const { warmupOnStartup, updateSyncStatus, startPeriodicCheck } = require('./sync');
const { detectConflict, handleConflict, getConflictStats } = require('./conflict');
const app = express();
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 50e6
});
const STORAGE_PATH = process.env.STORAGE_PATH || path.join(__dirname, '../../storage/files');
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
if (!ACCESS_TOKEN) {
  console.error('❌ 错误：未配置 ACCESS_TOKEN');
  console.error('请在 .env 文件中设置 ACCESS_TOKEN');
  process.exit(1);
}
let redisClient;
async function initRedis() {
  redisClient = redis.createClient({
    socket: {
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379
    },
    password: process.env.REDIS_PASSWORD || undefined
  });
  redisClient.on('error', (err) => console.error('Redis Error:', err));
  redisClient.on('connect', () => console.log('✅ Redis 连接成功'));
  await redisClient.connect();
}
const onlineDevices = new Map();
async function findPeerDevices(currentDeviceId, localIP) {
  if (!localIP) return [];
  const subnet = localIP.split('.').slice(0, 3).join('.');
  const peers = [];
  for (const [socketId, device] of onlineDevices.entries()) {
    if (device.deviceId === currentDeviceId) continue;
    if (device.localIP && device.localIP.startsWith(subnet)) {
      peers.push({
        deviceId: device.deviceId,
        localIP: device.localIP,
        deviceType: device.deviceType
      });
    }
  }
  return peers;
}
async function saveFileToServer(filePath, content) {
  const fullPath = path.join(STORAGE_PATH, filePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf8');
}
async function deleteFileFromServer(filePath) {
  const fullPath = path.join(STORAGE_PATH, filePath);
  const trashPath = path.join(STORAGE_PATH, '.trash', filePath);
  const trashKey = `trash:${filePath}`;
  const trashRecord = {
    originalPath: filePath,
    deletedAt: Date.now(),
    expireAt: Date.now() + 30 * 86400 * 1000
  };
  try {
    await fs.mkdir(path.dirname(trashPath), { recursive: true });
    await fs.rename(fullPath, trashPath);
    await redisClient.set(trashKey, JSON.stringify(trashRecord), { EX: 86400 * 30 });
    console.log(`🗑️  软删除: ${filePath} → .trash/`);
    return { deleted: true, alreadyDeleted: false };
  } catch (error) {
    if (error.code === 'ENOENT') {
      try {
        await fs.access(trashPath);
        await redisClient.set(trashKey, JSON.stringify(trashRecord), { EX: 86400 * 30 });
        console.log(`🗑️  已软删除，跳过重复删除: ${filePath}`);
        return { deleted: true, alreadyDeleted: true };
      } catch {
        console.log(`🗑️  文件已不存在，标记删除: ${filePath}`);
        await redisClient.del(`file:hash:${filePath}`);
        return { deleted: false, alreadyDeleted: true };
      }
    }
    console.error(`❌ 软删除失败: ${filePath}`, error.message);
    throw error;
  }
}
io.on('connection', (socket) => {
  console.log(`🔗 新连接: ${socket.id}`);
  let authenticated = false;
  let deviceInfo = null;
  socket.on('auth', async (data) => {
    const { token, deviceId, deviceType, localIP } = data;
    if (token !== ACCESS_TOKEN) {
      console.log(`❌ 认证失败: ${socket.id} (令牌错误)`);
      socket.emit('auth:failed', { message: '访问令牌错误' });
      socket.disconnect();
      return;
    }
    authenticated = true;
    deviceInfo = {
      deviceId,
      deviceType,
      localIP: localIP || null,
      connectedAt: Date.now()
    };
    onlineDevices.set(socket.id, deviceInfo);
    await redisClient.hSet(`device:${deviceId}`, {
      socketId: socket.id,
      deviceType,
      localIP: localIP || '',
      status: 'online',
      lastSeen: Date.now()
    });
    console.log(`✅ 认证成功: ${deviceId} (${deviceType}) IP: ${localIP || '未知'}`);
    const peerDevices = await findPeerDevices(deviceId, localIP);
    socket.emit('auth:success', {
      success: true,
      deviceId,
      peerDevices
    });
  });
  socket.on('sync:init', (data) => {
    if (!authenticated) return;
    const { deviceId, fileCount } = data;
    console.log(`🔄 ${deviceId} 开始首次同步 (${fileCount} 个文件)`);
  });
  socket.on('file:changed', async (data) => {
    if (!authenticated) {
      console.log(`⚠️  收到未认证连接的文件上传，尝试从数据中验证...`);
    }
    const { filePath, operation, content, deviceId, isInitialSync } = data;
    if (!isInitialSync) {
      console.log(`📝 文件变更: ${filePath} (${operation}) from ${deviceId}`);
    }
    socket.broadcast.emit('file:update', {
      filePath,
      operation,
      content,
      fromDevice: deviceId,
      timestamp: Date.now()
    });
    try {
      if (operation === 'delete') {
        await deleteFileFromServer(filePath);
        const db = getDb();
        await db.collection('files').updateOne(
          { path: filePath },
          { $set: { deleted: true, updated_at: Date.now() } }
        );
        if (!isInitialSync) {
          console.log(`🗑️  已删除服务器文件: ${filePath}`);
        }
      } else {
        await saveFileToServer(filePath, content);
        const crypto = require('crypto');
        const hash = crypto.createHash('md5').update(content).digest('hex');
        const size = Buffer.byteLength(content, 'utf8');
        const db = getDb();
        await db.collection('files').updateOne(
          { path: filePath },
          {
            $set: {
              hash,
              size,
              mtime: Date.now(),
              deleted: false,
              updated_at: Date.now()
            },
            $setOnInsert: { created_at: Date.now() }
          },
          { upsert: true }
        );
        if (!isInitialSync) {
          console.log(`💾 已保存到服务器: ${filePath}`);
        }
      }
    } catch (error) {
      console.error(`❌ 保存文件失败: ${filePath}`, error.message);
    }
  });
  socket.on('disconnect', async () => {
    if (deviceInfo) {
      await redisClient.hSet(`device:${deviceInfo.deviceId}`, {
        status: 'offline',
        lastSeen: Date.now()
      });
      onlineDevices.delete(socket.id);
      console.log(`🔌 设备断开: ${deviceInfo.deviceId}`);
    } else {
      console.log(`🔌 未认证连接断开: ${socket.id}`);
    }
  });
});
app.get('/health', async (req, res) => {
  const onlineCount = onlineDevices.size;
  const conflictStats = await getConflictStats();
  res.json({
    status: 'ok',
    onlineDevices: onlineCount,
    conflicts: conflictStats,
    timestamp: Date.now()
  });
});
app.post('/upload', async (req, res) => {
  try {
    const { token, deviceId, files } = req.body;
    if (token !== ACCESS_TOKEN) {
      return res.status(401).json({ error: '访问令牌错误' });
    }
    if (!files || !Array.isArray(files)) {
      return res.status(400).json({ error: '缺少 files 参数' });
    }
    console.log(`📤 收到 HTTP 上传: ${deviceId}, ${files.length} 个文件`);
    const crypto = require('crypto');
    const db = getDb();
    const results = [];
    for (const file of files) {
      const { filePath, content, operation, hash: clientHash, baseHash, mtime: clientMtime } = file;
      try {
        if (operation === 'delete') {
          await deleteFileFromServer(filePath);
          await db.collection('files').updateOne(
            { path: filePath },
            { $set: { deleted: true, updated_at: Date.now() } }
          );
          await redisClient.del(`file:hash:${filePath}`);
          results.push({ filePath, success: true, action: 'deleted' });
        } else {
          const conflictDetection = await detectConflict(
            filePath,
            clientHash,
            clientMtime,
            baseHash,
            deviceId
          );
          if (conflictDetection.conflict) {
            const { conflictPath, conflict } = await handleConflict(
              filePath,
              content,
              deviceId,
              saveFileToServer
            );
            await db.collection('conflicts').updateOne(
              { _id: conflict._id },
              { $set: { server_hash: conflictDetection.serverFile.hash } }
            );
            console.log(`⚠️  冲突已处理: ${filePath} → ${conflictPath}`);
            results.push({
              filePath,
              success: true,
              conflict: true,
              conflictPath,
              reason: conflictDetection.reason,
              message: '检测到冲突，已创建副本'
            });
            io.emit('conflict:detected', {
              originalPath: filePath,
              conflictPath,
              deviceId,
              serverHash: conflictDetection.serverFile.hash,
              clientHash,
              timestamp: Date.now()
            });
          } else {
            await saveFileToServer(filePath, content);
            const hash = clientHash || crypto.createHash('md5').update(content).digest('hex');
            const size = Buffer.byteLength(content, 'utf8');
            await redisClient.set(
              `file:hash:${filePath}`,
              JSON.stringify({ hash, size, mtime: Date.now() }),
              { EX: 86400 * 30 }
            );
            await db.collection('files').updateOne(
              { path: filePath },
              {
                $set: {
                  hash,
                  size,
                  mtime: Date.now(),
                  deleted: false,
                  last_modified_by: deviceId,
                  last_modified_at: Date.now(),
                  updated_at: Date.now()
                },
                $setOnInsert: {
                  created_at: Date.now(),
                  conflict_count: 0
                }
              },
              { upsert: true }
            );
            await db.collection('sync_logs').insertOne({
              file_path: filePath,
              action: operation || 'update',
              device_id: deviceId,
              hash,
              timestamp: Date.now()
            });
            const opsKey = `file:ops:${filePath}`;
            const op = JSON.stringify({
              action: operation || 'update',
              device: deviceId,
              time: Date.now(),
              hash
            });
            await redisClient.rPush(opsKey, op);
            await redisClient.expire(opsKey, 86400 * 90);
            results.push({
              filePath,
              success: true,
              action: conflictDetection.action,
              reason: conflictDetection.reason
            });
          }
        }
        io.emit('file:update', {
          filePath,
          operation: operation || 'update',
          fromDevice: deviceId,
          timestamp: Date.now()
        });
      } catch (error) {
        console.error(`❌ 保存失败: ${filePath}`, error.message);
        results.push({ filePath, success: false, error: error.message });
      }
    }
    const successCount = results.filter(r => r.success).length;
    console.log(`✅ HTTP 上传完成: ${successCount}/${files.length}`);
    res.json({
      success: true,
      total: files.length,
      succeeded: successCount,
      failed: files.length - successCount,
      results
    });
  } catch (error) {
    console.error('❌ HTTP 上传错误:', error);
    res.status(500).json({ error: error.message });
  }
});
app.get('/download/:path(*)', async (req, res) => {
  try {
    const { token } = req.query;
    const filePath = req.params.path;
    if (token !== ACCESS_TOKEN) {
      return res.status(401).json({ error: '访问令牌错误' });
    }
    const fullPath = path.join(STORAGE_PATH, filePath);
    try {
      const content = await fs.readFile(fullPath, 'utf8');
      res.send(content);
    } catch (error) {
      res.status(404).json({ error: '文件不存在' });
    }
  } catch (error) {
    console.error('❌ 下载文件错误:', error);
    res.status(500).json({ error: error.message });
  }
});
app.post('/restore', async (req, res) => {
  try {
    const { token, filePath } = req.body;
    if (token !== ACCESS_TOKEN) {
      return res.status(401).json({ error: '访问令牌错误' });
    }
    const trashPath = path.join(STORAGE_PATH, '.trash', filePath);
    const originalPath = path.join(STORAGE_PATH, filePath);
    try {
      await fs.mkdir(path.dirname(originalPath), { recursive: true });
      await fs.rename(trashPath, originalPath);
      await redisClient.del(`trash:${filePath}`);
      console.log(`♻️  还原文件: ${filePath}`);
      res.json({ success: true, message: '文件已还原' });
    } catch (error) {
      res.status(404).json({ error: '回收站中找不到该文件' });
    }
  } catch (error) {
    console.error('❌ 还原文件错误:', error);
    res.status(500).json({ error: error.message });
  }
});
app.get('/conflicts', async (req, res) => {
  try {
    const { token } = req.query;
    if (token !== ACCESS_TOKEN) {
      return res.status(401).json({ error: '访问令牌错误' });
    }
    const db = getDb();
    const conflicts = await db.collection('conflicts')
      .find({ resolved: false })
      .sort({ detected_at: -1 })
      .limit(100)
      .toArray();
    res.json({ conflicts });
  } catch (error) {
    console.error('❌ 获取冲突列表错误:', error);
    res.status(500).json({ error: error.message });
  }
});
app.post('/conflicts/:id/resolve', async (req, res) => {
  try {
    const { token, resolution } = req.body;
    const { id } = req.params;
    if (token !== ACCESS_TOKEN) {
      return res.status(401).json({ error: '访问令牌错误' });
    }
    const db = getDb();
    const { ObjectId } = require('mongodb');
    await db.collection('conflicts').updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          resolved: true,
          resolved_at: Date.now(),
          resolution: resolution || 'manual'
        }
      }
    );
    res.json({ success: true, message: '冲突已标记为已解决' });
  } catch (error) {
    console.error('❌ 解决冲突错误:', error);
    res.status(500).json({ error: error.message });
  }
});
app.get('/files', async (req, res) => {
  try {
    const { token } = req.query;
    if (token !== ACCESS_TOKEN) {
      return res.status(401).json({ error: '访问令牌错误' });
    }
    console.log('📋 客户端请求文件列表');
    const db = getDb();
    const files = await db.collection('files')
      .find({ deleted: false })
      .project({ path: 1, hash: 1, size: 1, _id: 0 })
      .toArray();
    const simplified = files.map(f => ({
      p: f.path,
      h: f.hash,
      s: f.size
    }));
    console.log(`📋 返回文件列表: ${simplified.length} 个文件`);
    res.json({ files: simplified });
  } catch (error) {
    console.error('❌ 获取文件列表错误:', error);
    res.status(500).json({ error: error.message });
  }
});
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
async function start() {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/clawmd-hub';
    await connectMongo(mongoUri);
    await initRedis();
    await warmupOnStartup(STORAGE_PATH);
    const checkInterval = parseInt(process.env.SYNC_CHECK_INTERVAL) || 30;
    startPeriodicCheck(STORAGE_PATH, checkInterval);
    httpServer.listen(PORT, HOST, () => {
      console.log(`🚀 ClawMd Hub Server 启动成功!`);
      console.log(`📡 WebSocket: ws://${HOST}:${PORT}`);
      console.log(`🏥 健康检查: http://${HOST}:${PORT}/health`);
    });
  } catch (error) {
    console.error('❌ 启动失败:', error);
    process.exit(1);
  }
}
start();
async function preloadFileCache() {
  console.log('🔥 开始预热文件缓存...');
  const crypto = require('crypto');
  let cached = 0;
  let created = 0;
  const actualFiles = new Set();
  async function walk(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '.trash') continue;
          await walk(fullPath);
        } else if (entry.isFile()) {
          const relativePath = path.relative(STORAGE_PATH, fullPath);
          actualFiles.add(relativePath);
          const cacheKey = `file:hash:${relativePath}`;
          try {
            const cachedData = await redisClient.get(cacheKey);
            if (cachedData) {
              cached++;
            } else {
              const content = await fs.readFile(fullPath);
              const hash = crypto.createHash('md5').update(content).digest('hex');
              const stats = await fs.stat(fullPath);
              await redisClient.set(
                cacheKey,
                JSON.stringify({ hash, size: stats.size, mtime: stats.mtimeMs }),
                { EX: 86400 * 30 }
              );
              created++;
              if ((cached + created) % 100 === 0) {
                console.log(`   已处理 ${cached + created} 个文件...`);
              }
            }
          } catch (error) {
          }
        }
      }
    } catch (error) {
    }
  }
  await walk(STORAGE_PATH);
  console.log('🧹 清理孤儿缓存...');
  let cleaned = 0;
  try {
    const allCacheKeys = await redisClient.keys('file:hash:*');
    for (const key of allCacheKeys) {
      const filePath = key.replace('file:hash:', '');
      if (!actualFiles.has(filePath)) {
        await redisClient.del(key);
        cleaned++;
        if (cleaned % 50 === 0) {
          console.log(`   已清理 ${cleaned} 个孤儿缓存...`);
        }
      }
    }
  } catch (error) {
    console.error('⚠️  清理孤儿缓存失败:', error.message);
  }
  console.log(`✅ 缓存预热完成！`);
  console.log(`   📁 实际文件: ${actualFiles.size} 个`);
  console.log(`   ✅ 已有缓存: ${cached} 个`);
  console.log(`   🆕 新建缓存: ${created} 个`);
  console.log(`   🧹 清理孤儿: ${cleaned} 个`);
}
