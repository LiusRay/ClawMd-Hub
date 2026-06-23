const path = require('path');
const { getDb } = require('./db');
async function detectConflict(filePath, clientHash, clientMtime, baseHash, deviceId) {
  const db = getDb();
  try {
    const serverFile = await db.collection('files').findOne({
      path: filePath,
      deleted: false
    });
    if (!serverFile) {
      return {
        conflict: false,
        action: 'upload',
        reason: 'new_file'
      };
    }
    if (serverFile.hash === clientHash) {
      return {
        conflict: false,
        action: 'skip',
        reason: 'same_hash'
      };
    }
    if (baseHash) {
      if (baseHash !== serverFile.hash) {
        return {
          conflict: true,
          action: 'create_conflict_copy',
          serverFile,
          reason: 'concurrent_modification',
          details: {
            serverHash: serverFile.hash,
            clientHash,
            baseHash
          }
        };
      }
      return {
        conflict: false,
        action: 'upload',
        reason: 'based_on_latest'
      };
    }
    const timeDiff = Math.abs(serverFile.mtime - clientMtime);
    const TIME_THRESHOLD = parseInt(process.env.CONFLICT_TIME_THRESHOLD) || 5000;
    if (timeDiff < TIME_THRESHOLD) {
      return {
        conflict: false,
        action: 'upload',
        reason: 'within_time_threshold',
        details: {
          timeDiff,
          threshold: TIME_THRESHOLD
        }
      };
    }
    return {
      conflict: true,
      action: 'create_conflict_copy',
      serverFile,
      reason: 'time_diff_exceeded',
      details: {
        timeDiff,
        threshold: TIME_THRESHOLD,
        serverMtime: serverFile.mtime,
        clientMtime
      }
    };
  } catch (error) {
    console.error('❌ 冲突检测失败:', error.message);
    return {
      conflict: false,
      action: 'upload',
      reason: 'detection_error',
      error: error.message
    };
  }
}
function generateConflictCopyName(filePath, deviceId) {
  const parsedPath = path.parse(filePath);
  const timestamp = formatTimestamp(Date.now());
  const cleanDeviceId = deviceId
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .substring(0, 20);
  const conflictName = `${parsedPath.name}-conflict-${cleanDeviceId}-${timestamp}${parsedPath.ext}`;
  return path.join(parsedPath.dir, conflictName);
}
function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}
async function handleConflict(filePath, content, deviceId, saveFileToServer) {
  const db = getDb();
  const crypto = require('crypto');
  try {
    const conflictPath = generateConflictCopyName(filePath, deviceId);
    console.log(`⚠️  检测到冲突: ${filePath}`);
    console.log(`📝 生成冲突副本: ${conflictPath}`);
    await saveFileToServer(conflictPath, content);
    const contentBuffer = Buffer.isBuffer(content) ? content : Buffer.from(content || '', 'utf8');
    const hash = crypto.createHash('md5').update(contentBuffer).digest('hex');
    const size = contentBuffer.length;
    await db.collection('files').insertOne({
      path: conflictPath,
      hash,
      size,
      mtime: Date.now(),
      deleted: false,
      last_modified_by: deviceId,
      last_modified_at: Date.now(),
      conflict_count: 0,
      created_at: Date.now(),
      updated_at: Date.now()
    });
    const conflictRecord = {
      original_path: filePath,
      conflict_path: conflictPath,
      device_id: deviceId,
      detected_at: Date.now(),
      resolved: false,
      server_hash: null,
      client_hash: hash,
      resolution: null
    };
    const result = await db.collection('conflicts').insertOne(conflictRecord);
    console.log(`✅ 冲突副本已保存: ${conflictPath}`);
    console.log(`📋 冲突记录ID: ${result.insertedId}`);
    await db.collection('files').updateOne(
      { path: filePath },
      { $inc: { conflict_count: 1 } }
    );
    return {
      conflictPath,
      conflict: {
        ...conflictRecord,
        _id: result.insertedId
      }
    };
  } catch (error) {
    console.error('❌ 处理冲突失败:', error.message);
    throw error;
  }
}
async function getConflictStats() {
  const db = getDb();
  try {
    const totalConflicts = await db.collection('conflicts').countDocuments();
    const unresolvedConflicts = await db.collection('conflicts').countDocuments({ resolved: false });
    const resolvedConflicts = await db.collection('conflicts').countDocuments({ resolved: true });
    const recentConflicts = await db.collection('conflicts')
      .find({ resolved: false })
      .sort({ detected_at: -1 })
      .limit(10)
      .toArray();
    return {
      total: totalConflicts,
      unresolved: unresolvedConflicts,
      resolved: resolvedConflicts,
      recent: recentConflicts
    };
  } catch (error) {
    console.error('❌ 获取冲突统计失败:', error.message);
    return {
      total: 0,
      unresolved: 0,
      resolved: 0,
      recent: [],
      error: error.message
    };
  }
}
module.exports = {
  detectConflict,
  generateConflictCopyName,
  handleConflict,
  getConflictStats
};
