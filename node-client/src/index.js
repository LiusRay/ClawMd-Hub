require('dotenv').config();
const io = require('socket.io-client');
const chokidar = require('chokidar');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const os = require('os');
const { smartUpload } = require('./smart-upload');

const RAY_PATH = process.env.RAY_PATH || path.join(process.env.HOME, 'Documents/Ray');
const SERVER_URL = process.env.SERVER_URL;
const DEVICE_ID = process.env.DEVICE_ID || uuidv4();
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const SYNC_TO_SERVER = process.env.SYNC_TO_SERVER !== 'false';

const CACHE_DIR = path.join(process.env.HOME, '.clawmd-hub', 'sync');
const CACHE_FILE = path.join(CACHE_DIR, 'file-hashes.json');

if (!ACCESS_TOKEN) {
  console.error('❌ 错误：未配置 ACCESS_TOKEN');
  console.error('请在 .env 文件中设置 ACCESS_TOKEN');
  process.exit(1);
}

if (!SERVER_URL) {
  console.error('❌ 错误：未配置 SERVER_URL');
  console.error('请在 .env 文件中设置 SERVER_URL，例如 ws://localhost:3000 或 wss://sync.example.com');
  process.exit(1);
}

const HTTP_URL = SERVER_URL.replace('wss://', 'https://').replace('ws://', 'http://');

console.log(`\n🚀 ClawMd Hub Node 客户端启动\n`);
console.log(`📁 Ray 路径: ${RAY_PATH}`);
console.log(`🌐 WebSocket: ${SERVER_URL}`);
console.log(`🌐 HTTP API: ${HTTP_URL}`);
console.log(`💻 设备 ID: ${DEVICE_ID}`);
console.log(`🔐 访问令牌: ${ACCESS_TOKEN.substring(0, 8)}...`);
console.log(`☁️  服务器备份: ${SYNC_TO_SERVER ? '开启' : '关闭'}\n`);

console.log('⏳ 正在连接服务器...');

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

const socket = io(SERVER_URL, {
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  reconnectionAttempts: Infinity
});

const syncingFiles = new Set();

async function scanLocalFiles() {
  console.log('🔍 开始扫描本地文件...');
  
  const files = [];
  
  async function walk(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(RAY_PATH, fullPath);
        
        let shouldIgnore = false;
        for (const rule of ignoreRules) {
          const pattern = rule
            .replace(/\./g, '\\.')
            .replace(/\*\*/g, '§§§')
            .replace(/\*/g, '[^/]*')
            .replace(/§§§/g, '.*')
            .replace(/\?/g, '[^/]');
          
          const regex = new RegExp('^' + pattern + '$');
          
          if (regex.test(relativePath) || regex.test(entry.name)) {
            shouldIgnore = true;
            break;
          }
        }
        
        if (shouldIgnore) continue;
        
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else {
          files.push(relativePath);
        }
      }
    } catch (error) {
    }
  }
  
  await walk(RAY_PATH);
  
  console.log(`📊 扫描完成，共 ${files.length} 个文件`);
  return files;
}
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
    return [];
  }
}

async function loadHashCache() {
  try {
    const data = await fs.readFile(CACHE_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return {};
  }
}

async function saveHashCache(cache) {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (error) {
    console.error('⚠️  保存哈希缓存失败:', error.message);
  }
}

async function getFileHash(filePath) {
  const crypto = require('crypto');
  const fullPath = path.join(RAY_PATH, filePath);
  
  try {
    const stats = await fs.stat(fullPath);
    const mtime = stats.mtimeMs;
    
    if (hashCache[filePath]) {
      const cached = hashCache[filePath];
      
      if (cached.mtime === mtime) {
        return cached.hash;
      }
    }
    
    const content = await fs.readFile(fullPath);
    const hash = crypto.createHash('md5').update(content).digest('hex');
    
    hashCache[filePath] = {
      hash,
      mtime,
      size: stats.size
    };
    
    return hash;
  } catch (error) {
    throw error;
  }
}

let hashCache = {};

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
  
  console.log('💾 加载本地哈希缓存...');
  hashCache = await loadHashCache();
  const cacheCount = Object.keys(hashCache).length;
  console.log(`   已加载 ${cacheCount} 个文件的哈希缓存\n`);
  
  console.log('📋 获取服务器文件列表...');
  const serverFiles = await getServerFiles();

  const serverFileMap = new Map(serverFiles.map(f => [
    f.p || f.path,
    {
      hash: f.h || f.hash,
      size: f.s || f.size
    }
  ]));
  console.log(`📋 服务器已有 ${serverFiles.length} 个文件\n`);
  
  const localFiles = await scanLocalFiles();
  const localFileSet = new Set(localFiles);
  
  console.log('🔍 对比文件哈希...');
  const filesToUpload = [];
  let cached = 0;
  let calculated = 0;
  
  for (const filePath of localFiles) {
    try {
      const localHash = await getFileHash(filePath);
      
      if (hashCache[filePath] && hashCache[filePath].hash === localHash) {
        cached++;
      } else {
        calculated++;
      }
      
      if ((cached + calculated) % 100 === 0) {
        console.log(`   已对比 ${cached + calculated}/${localFiles.length} 个文件 (缓存命中: ${cached}, 重新计算: ${calculated})`);
      }
      
      const serverFile = serverFileMap.get(filePath);
      
      if (!serverFile || localHash !== serverFile.hash) {
        filesToUpload.push(filePath);
      }
    } catch (error) {
    }
  }
  
  await saveHashCache(hashCache);
  console.log(`\n💾 已保存哈希缓存 (缓存命中: ${cached}, 重新计算: ${calculated})\n`);
  
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
       await smartUpload(filesToUpload, RAY_PATH, uploadFilesHTTP);
     } catch (error) {
       console.error('❌ 智能上传失败:', error.message);
     }
    }
 
    if (filesToUpload.length === 0 && filesToDownload.length === 0) {
    console.log('✅ 所有文件已同步，无需上传或下载！\n');
  }
  
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
      console.log(`🗑️  已删除: ${filePath}`);
    } else {
      try {
        const latestContent = await downloadFile(filePath);
        const dir = path.dirname(fullPath);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(fullPath, latestContent);
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
        console.log(`✅ 删除已同步: ${relativePath}`);
      }
    } else {
      const contentBuffer = await fs.readFile(fullPath);
      const crypto = require('crypto');
      const stats = await fs.stat(fullPath);
      
      socket.emit('file:changed', {
        filePath: relativePath,
        operation,
        content: contentBuffer.toString('base64'),
        contentEncoding: 'base64',
        hash: crypto.createHash('md5').update(contentBuffer).digest('hex'),
        mtime: stats.mtimeMs,
        deviceId: DEVICE_ID
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
