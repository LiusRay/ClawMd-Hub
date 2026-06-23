require('dotenv').config();
const io = require('socket.io-client');
const chokidar = require('chokidar');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const os = require('os');
const { smartUpload } = require('./smart-upload');
const localDb = require('./local-db');
const {
  updateLocalDbFromPath,
  buildLocalIndex
} = require('./local-index');

const RAY_PATH = process.env.RAY_PATH || path.join(process.env.HOME, 'Documents/Ray');
const SERVER_URL = process.env.SERVER_URL;
const DEVICE_ID = process.env.DEVICE_ID || uuidv4();
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const SYNC_TO_SERVER = process.env.SYNC_TO_SERVER !== 'false';
const LOCAL_INDEX_ONLY = process.env.LOCAL_INDEX_ONLY === 'true';
const LOCAL_SCAN_CONCURRENCY = parseInt(process.env.LOCAL_SCAN_CONCURRENCY || '8', 10);
const LOCAL_SCAN_PROGRESS_INTERVAL = parseInt(process.env.LOCAL_SCAN_PROGRESS_INTERVAL || '1000', 10);

if (!ACCESS_TOKEN) {
  console.error('❌ 错误：未配置 ACCESS_TOKEN');
  console.error('请在 .env 文件中设置 ACCESS_TOKEN');
  process.exit(1);
}

if (!LOCAL_INDEX_ONLY && !SERVER_URL) {
  console.error('❌ 错误：未配置 SERVER_URL');
  console.error('请在 .env 文件中设置 SERVER_URL，例如 ws://localhost:3000 或 wss://sync.example.com');
  process.exit(1);
}

const HTTP_URL = SERVER_URL
  ? SERVER_URL.replace('wss://', 'https://').replace('ws://', 'http://')
  : null;

console.log(`\n🚀 ClawMd Hub Node 客户端启动\n`);
console.log(`📁 Ray 路径: ${RAY_PATH}`);
console.log(`🌐 WebSocket: ${SERVER_URL || 'LOCAL_INDEX_ONLY'}`);
console.log(`🌐 HTTP API: ${HTTP_URL || 'LOCAL_INDEX_ONLY'}`);
console.log(`💻 设备 ID: ${DEVICE_ID}`);
console.log(`🔐 访问令牌: ${ACCESS_TOKEN.substring(0, 8)}...`);
console.log(`🗄️  本地 SQLite: ${localDb.getDbPath()}`);
console.log(`🔢 本地扫描并发: ${LOCAL_SCAN_CONCURRENCY}`);
console.log(`☁️  服务器备份: ${SYNC_TO_SERVER ? '开启' : '关闭'}\n`);

function loadSyncIgnore() {
  const ignoreFile = path.join(RAY_PATH, '.syncignore');
  
  if (!fsSync.existsSync(ignoreFile)) {
    console.log('⚠️  未找到 .syncignore，使用默认忽略规则');
    return ['node_modules/**', '.git/**', '.DS_Store'];
  }

  try {
    const content = fsSync.readFileSync(ignoreFile, 'utf8');
    const rules = content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .map(line => {
        if (line.endsWith('/')) {
          return line + '**';
        }
        return line;
      });
    
    console.log(`📋 加载 .syncignore 规则 (${rules.length} 条)`);
    return rules;
  } catch (error) {
    console.error('❌ 读取 .syncignore 失败:', error.message);
    return ['node_modules/**', '.git/**', '.DS_Store'];
  }
}

const ignoreRules = loadSyncIgnore();

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

const LOCAL_IP = getLocalIP();
console.log(`🏠 本机内网 IP: ${LOCAL_IP || '未检测到'}\n`);

if (LOCAL_INDEX_ONLY) {
  console.log('🧪 本地索引模式：只扫描并写入 SQLite，不连接服务器\n');
  buildLocalIndex(RAY_PATH, ignoreRules, localDb, {
    concurrency: LOCAL_SCAN_CONCURRENCY,
    progressInterval: LOCAL_SCAN_PROGRESS_INTERVAL
  })
    .then(() => process.exit(0))
    .catch(error => {
      console.error('❌ 本地索引失败:', error.message);
      process.exit(1);
    });
  return;
} else {
  console.log('⏳ 正在连接服务器...');
}

const socket = io(SERVER_URL, {
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  reconnectionAttempts: Infinity
});

const syncingFiles = new Set();
async function uploadFilesHTTP(files) {
  const fetch = (await import('node-fetch')).default;
  
  try {
    const response = await fetch(`${HTTP_URL}/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        token: ACCESS_TOKEN,
        deviceId: DEVICE_ID,
        files
      })
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const result = await response.json();
    return result;
    
  } catch (error) {
    console.error('❌ HTTP 上传失败:', error.message);
    throw error;
  }
}

async function getServerFiles() {
  const fetch = (await import('node-fetch')).default;
  
  try {
    const response = await fetch(`${HTTP_URL}/files?token=${encodeURIComponent(ACCESS_TOKEN)}`);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const result = await response.json();
    return result.files || [];
    
  } catch (error) {
    console.error('❌ 获取服务器文件列表失败:', error.message);
    throw error;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function downloadFile(filePath) {
  const fetch = (await import('node-fetch')).default;

  const encodedPath = encodeURIComponent(filePath);
  const url = `${HTTP_URL}/download/${encodedPath}?token=${encodeURIComponent(ACCESS_TOKEN)}`;
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        compress: false,
        headers: {
          'Accept-Encoding': 'identity'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.buffer();

    } catch (error) {
      const isLastAttempt = attempt === maxRetries;

      if (isLastAttempt) {
        console.error(`❌ 下载失败: ${filePath}`, error.message);
        throw error;
      }

      console.warn(`⚠️  下载失败，准备重试 (${attempt}/${maxRetries}): ${filePath} - ${error.message}`);
      await sleep(1000 * attempt);
    }
  }
}

async function startInitialSync() {
  console.log('\n🔄 开始首次同步...\n');
  
  const localIndexInitialized = localDb.getState('local_index_initialized') === 'true';
  console.log(`💾 本地索引: ${localIndexInitialized ? '已初始化' : '首次建立'}`);
  console.log(`   已记录 ${localDb.countFiles()} 个文件状态\n`);
  
  console.log('📋 获取服务器文件列表...');
  let serverFiles;
  try {
    serverFiles = await getServerFiles();
  } catch (error) {
    console.error('❌ 首次同步中止：无法确认服务器文件列表，避免误判为云端空数据');
    return;
  }

  const serverFileMap = new Map(serverFiles.map(f => [
    f.p || f.path,
    {
      hash: f.h || f.hash,
      size: f.s || f.size
    }
  ]));
  console.log(`📋 服务器已有 ${serverFiles.length} 个文件\n`);
  
  const localIndex = await buildLocalIndex(RAY_PATH, ignoreRules, localDb, {
    concurrency: LOCAL_SCAN_CONCURRENCY,
    progressInterval: LOCAL_SCAN_PROGRESS_INTERVAL
  });
  const localFiles = localIndex.files;
  const localFileSet = new Set(localFiles.map(file => file.path));
  
  console.log('🔍 对比本地与服务器文件...');
  const filesToUpload = [];
  
  for (const localFile of localFiles) {
    try {
      const serverFile = serverFileMap.get(localFile.path);
      
      if (!serverFile || localFile.hash !== serverFile.hash) {
        filesToUpload.push(localFile.path);
        localDb.upsertFile({
          path: localFile.path,
          size: localFile.size,
          mtime: localFile.mtime,
          hash: localFile.hash,
          syncStatus: 'pending_upload'
        });
      } else {
        localDb.upsertFile({
          path: localFile.path,
          size: localFile.size,
          mtime: localFile.mtime,
          hash: localFile.hash,
          syncStatus: 'synced'
        });
      }
    } catch (error) {
    }
  }
  
  console.log(`\n💾 已更新 SQLite 索引 (缓存命中: ${localIndex.cached}, 重新计算: ${localIndex.calculated})\n`);
  
  const filesToDownload = [];

  for (const serverFile of serverFiles) {
    const filePath = serverFile.p || serverFile.path;
    if (filePath && !localFileSet.has(filePath)) {
      filesToDownload.push(filePath);
    }
  }
  
  console.log(`📤 需要上传: ${filesToUpload.length} 个文件`);
  console.log(`📥 需要下载: ${filesToDownload.length} 个文件`);
  console.log(`✅ 已同步: ${localFiles.length - filesToUpload.length} 个文件\n`);
  
  let uploaded = 0;
  let downloaded = 0;
  let failedBatches = [];
  
  if (filesToDownload.length > 0) {
    console.log('📥 开始下载文件...\n');
    
    for (const filePath of filesToDownload) {
      try {
        const content = await downloadFile(filePath);
        const fullPath = path.join(RAY_PATH, filePath);
        
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        
        await fs.writeFile(fullPath, content);
        await updateLocalDbFromPath(RAY_PATH, localDb, filePath, 'synced');
        
        downloaded++;
        
        if (downloaded % 10 === 0) {
          console.log(`   已下载 ${downloaded}/${filesToDownload.length} 个文件...`);
        }
        
      } catch (error) {
        console.error(`❌ 下载失败: ${filePath}`, error.message);
      }
    }
    
    console.log(`\n✅ 下载完成！共下载 ${downloaded}/${filesToDownload.length} 个文件\n`);
    }
 
    if (filesToUpload.length > 0) {
     try {
       await smartUpload(filesToUpload, RAY_PATH, uploadFilesHTTP, {
         onFileUploaded: async (filePath) => {
           try {
             await updateLocalDbFromPath(RAY_PATH, localDb, filePath, 'synced');
           } catch (error) {
             console.error(`⚠️  更新本地索引失败: ${filePath}`, error.message);
           }
         }
       });
     } catch (error) {
       console.error('❌ 智能上传失败:', error.message);
     }
    }
 
    if (filesToUpload.length === 0 && filesToDownload.length === 0) {
    console.log('✅ 所有文件已同步，无需上传或下载！\n');
  }
  localDb.setState('local_index_initialized', 'true');
  localDb.setState('last_initial_sync_at', String(Date.now()));
  startWatching();
}

socket.on('connect', () => {
  console.log('✅ 连接到服务器成功');
  console.log('🔐 发送认证信息...');
  
  socket.emit('auth', {
    token: ACCESS_TOKEN,
    deviceId: DEVICE_ID,
    deviceType: 'mac',
    localIP: LOCAL_IP
  });
});

socket.on('auth:success', (data) => {
  console.log(`✅ 认证成功`);
  console.log(`📱 设备注册: ${data.deviceId}`);
  
  if (data.peerDevices && data.peerDevices.length > 0) {
    console.log(`🏠 发现同局域网设备: ${data.peerDevices.length} 台`);
    data.peerDevices.forEach(peer => {
      console.log(`   - ${peer.deviceId} (${peer.localIP})`);
    });
  }
  
  console.log('🚀 启动同步任务...');
  
  startInitialSync();
});

socket.on('auth:failed', (data) => {
  console.error('❌ 认证失败:', data.message);
  console.error('请检查 ACCESS_TOKEN 是否正确');
  process.exit(1);
});

socket.on('registered', (data) => {
  console.log(`📱 设备注册成功: ${data.deviceId}`);
  startWatching();
});

socket.on('file:update', async (data) => {
  const { filePath, operation, content, fromDevice } = data;
  
  if (fromDevice === DEVICE_ID) {
    return;
  }

  const fullPath = path.join(RAY_PATH, filePath);
  
  console.log(`📥 收到远程更新: ${filePath} (${operation}) from ${fromDevice}`);
  
  syncingFiles.add(fullPath);
  
  try {
    if (operation === 'delete') {
      await fs.unlink(fullPath);
      localDb.markFileDeleted(filePath);
      console.log(`🗑️  已删除: ${filePath}`);
    } else {
      try {
        const latestContent = await downloadFile(filePath);
        const dir = path.dirname(fullPath);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(fullPath, latestContent);
        await updateLocalDbFromPath(RAY_PATH, localDb, filePath, 'synced');
        console.log(`💾 已保存: ${filePath}`);
      } catch (error) {
        console.error(`❌ 下载失败，使用通知中的内容: ${filePath}`);
        if (content) {
          const dir = path.dirname(fullPath);
          await fs.mkdir(dir, { recursive: true });
          const fallbackContent = data.contentEncoding === 'base64'
            ? Buffer.from(content, 'base64')
            : Buffer.from(content, 'utf8');
          await fs.writeFile(fullPath, fallbackContent);
          await updateLocalDbFromPath(RAY_PATH, localDb, filePath, 'synced');
          console.log(`💾 已保存（降级）: ${filePath}`);
        }
      }
    }
  } catch (error) {
    console.error(`❌ 处理文件失败: ${filePath}`, error.message);
  } finally {
    setTimeout(() => syncingFiles.delete(fullPath), 1000);
  }
});

socket.on('conflict:detected', async (data) => {
  const { originalPath, conflictPath, deviceId, serverHash, clientHash, timestamp } = data;

  if (deviceId === DEVICE_ID) {
    console.log(`\n⚠️  检测到冲突!`);
    console.log(`   原文件: ${originalPath}`);
    console.log(`   冲突副本: ${conflictPath}`);
    console.log(`   服务器哈希: ${serverHash}`);
    console.log(`   客户端哈希: ${clientHash}\n`);

    try {
      const content = await downloadFile(conflictPath);
      const fullPath = path.join(RAY_PATH, conflictPath);

      syncingFiles.add(fullPath);

      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content);

      console.log(`✅ 冲突副本已下载到本地: ${conflictPath}\n`);
      console.log(`💡 请手动合并冲突后删除副本\n`);

      setTimeout(() => syncingFiles.delete(fullPath), 1000);

    } catch (error) {
      console.error(`❌ 下载冲突副本失败:`, error.message);
    }
  }
});

socket.on('disconnect', () => {
  console.log('🔌 与服务器断开连接');
});

socket.on('connect_error', (error) => {
  console.error('❌ 连接服务器失败:', error.message);
});

function startWatching() {
  console.log('👀 开始监听文件变化...\n');
  
  const ignoredPatterns = ignoreRules.map(rule => {
    let pattern = rule.replace(/\/\*\*$/, '');
    if (!pattern.endsWith('/')) {
      pattern = pattern + '/**';
    } else {
      pattern = pattern + '**';
    }
    return path.join(RAY_PATH, pattern);
  });
  
  const explicitIgnore = [
    path.join(RAY_PATH, '**/.git/**'),
    path.join(RAY_PATH, '**/.claude/**'),
    path.join(RAY_PATH, '**/.DS_Store'),
    path.join(RAY_PATH, '**/node_modules/**'),
    path.join(RAY_PATH, '**/*.log')
  ];
  
  const watcher = chokidar.watch(RAY_PATH, {
    ignored: [...ignoredPatterns, ...explicitIgnore],
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100
    }
  });
  
  console.log(`📁 监听目录: ${RAY_PATH}`);
  console.log(`🚫 排除规则: ${ignoreRules.length} 条\n`);
  
  watcher
  watcher.on('add', (filePath) => handleFileChange(filePath, 'create'));
  
  watcher.on('change', (filePath) => handleFileChange(filePath, 'update'));
  
  watcher.on('unlink', (filePath) => handleFileChange(filePath, 'delete'));

  watcher.on('error', (error) => {
    console.error('❌ 文件监听错误:', error);
  });
}

async function handleFileChange(fullPath, operation) {
  if (syncingFiles.has(fullPath)) {
    return;
  }

  const relativePath = path.relative(RAY_PATH, fullPath);
  
  console.log(`📝 本地文件变化: ${relativePath} (${operation})`);

  try {
    if (operation === 'delete') {
      const result = await uploadFilesHTTP([{
        filePath: relativePath,
        operation: 'delete'
      }]);
      
      if (result.succeeded > 0) {
        localDb.markFileDeleted(relativePath);
        console.log(`✅ 删除已同步: ${relativePath}`);
      }
    } else {
      const contentBuffer = await fs.readFile(fullPath);
      const crypto = require('crypto');
      const stats = await fs.stat(fullPath);
      const hash = crypto.createHash('md5').update(contentBuffer).digest('hex');
      
      socket.emit('file:changed', {
        filePath: relativePath,
        operation,
        content: contentBuffer.toString('base64'),
        contentEncoding: 'base64',
        hash,
        mtime: stats.mtimeMs,
        deviceId: DEVICE_ID
      });

      localDb.upsertFile({
        path: relativePath,
        size: stats.size,
        mtime: stats.mtimeMs,
        hash,
        syncStatus: 'synced'
      });

      console.log(`📤 已发送: ${relativePath}`);
    }
  } catch (error) {
    console.error(`❌ 处理失败: ${relativePath}`, error.message);
  }
}

process.on('SIGINT', () => {
  console.log('\n👋 正在退出...');
  socket.disconnect();
  process.exit(0);
});
