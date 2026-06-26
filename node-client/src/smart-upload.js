const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
function normalizeUploadItem(item) {
  return typeof item === 'string' ? { path: item } : item;
}

async function buildUploadFile(RAY_PATH, item) {
  const uploadItem = normalizeUploadItem(item);
  const filePath = uploadItem.path;
  const fullPath = path.join(RAY_PATH, filePath);
  const contentBuffer = await fs.readFile(fullPath);
  const stats = await fs.stat(fullPath);
  return {
    filePath,
    content: contentBuffer.toString('base64'),
    contentEncoding: 'base64',
    operation: 'create',
    hash: crypto.createHash('md5').update(contentBuffer).digest('hex'),
    mtime: stats.mtimeMs,
    baseHash: uploadItem.baseHash || null,
    baseRevision: uploadItem.baseRevision || 0,
    size: contentBuffer.length,
    force: Boolean(uploadItem.force)
  };
}
function calculateStrategy(files, totalSizeMB) {
  const fileCount = files.length;
  if (fileCount <= 20) {
    return {
      mode: 'single',
      concurrency: fileCount,
      batchSize: 1,
      description: `${fileCount}个文件直接并发上传`
    };
  }
  const batchSize = parseInt(process.env.UPLOAD_BATCH_SIZE || '10', 10);
  const maxBatchSizeMB = parseFloat(process.env.UPLOAD_BATCH_MAX_MB || '20');
  let concurrency;
  if (totalSizeMB < 100) {
    concurrency = 3;
  } else if (totalSizeMB < 500) {
    concurrency = 2;
  } else {
    concurrency = 1;
  }
  return {
    mode: 'batch',
    concurrency,
    batchSize,
    maxBatchSizeMB,
    description: `每批最多${batchSize}个或${maxBatchSizeMB}MB，${concurrency}批并发`
  };
}
async function createBatches(files, RAY_PATH, batchSize, maxBatchSizeMB) {
  const batches = [];
  let currentBatch = [];
  let currentSizeMB = 0;
  for (const item of files) {
    const filePath = normalizeUploadItem(item).path;
    let sizeMB = 0;
    try {
      const stats = await fs.stat(path.join(RAY_PATH, filePath));
      sizeMB = stats.size / 1024 / 1024;
    } catch (error) {
    }
    const shouldStartNewBatch =
      currentBatch.length > 0 &&
      (currentBatch.length >= batchSize || currentSizeMB + sizeMB > maxBatchSizeMB);
    if (shouldStartNewBatch) {
      batches.push(currentBatch);
      currentBatch = [];
      currentSizeMB = 0;
    }
    currentBatch.push(item);
    currentSizeMB += sizeMB;
  }
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }
  return batches;
}
async function smartUpload(filesToUpload, RAY_PATH, uploadFn, options = {}) {
  console.log('🧠 智能上传分析中...\n');
  let totalSizeMB = 0;
  for (const item of filesToUpload) {
    const filePath = normalizeUploadItem(item).path;
    try {
      const fullPath = path.join(RAY_PATH, filePath);
      const stats = await fs.stat(fullPath);
      totalSizeMB += stats.size / 1024 / 1024;
    } catch (error) {
    }
  }
  const strategy = calculateStrategy(filesToUpload, totalSizeMB);
  console.log('📊 上传策略：');
  console.log(`   模式: ${strategy.mode === 'single' ? '单文件并发' : '批次并发'}`);
  console.log(`   文件总数: ${filesToUpload.length} 个`);
  console.log(`   总大小: ${totalSizeMB.toFixed(1)} MB`);
  console.log(`   ${strategy.description}`);
  console.log('');
  if (strategy.mode === 'single') {
    return await uploadSingle(filesToUpload, RAY_PATH, uploadFn, strategy.concurrency, options);
  } else {
    return await uploadBatch(filesToUpload, RAY_PATH, uploadFn, strategy, options);
  }
}
async function uploadSingle(files, RAY_PATH, uploadFn, concurrency, options) {
  console.log(`🚀 开始并发上传 ${files.length} 个文件...\n`);
  let uploaded = 0;
  const results = { succeeded: 0, failed: 0 };
  for (let i = 0; i < files.length; i += concurrency) {
    const batch = files.slice(i, i + concurrency);
    const promises = batch.map(async (item) => {
      const filePath = normalizeUploadItem(item).path;
      try {
        const result = await uploadFn([await buildUploadFile(RAY_PATH, item)]);
        results.succeeded++;
        uploaded++;
        if (options.onFileUploaded) {
          await options.onFileUploaded(filePath, result.results && result.results[0]);
        }
        console.log(`   ✅ [${uploaded}/${files.length}] ${filePath}`);
      } catch (error) {
        results.failed++;
        console.error(`   ❌ [${uploaded}/${files.length}] ${filePath}: ${error.message}`);
      }
    });
    await Promise.all(promises);
  }
  console.log(`\n✅ 上传完成！成功: ${results.succeeded}, 失败: ${results.failed}\n`);
  return results;
}
async function uploadBatch(files, RAY_PATH, uploadFn, strategy, options) {
  console.log(`🚀 开始批次并发上传...\n`);
  const { batchSize, concurrency, maxBatchSizeMB } = strategy;
  let uploaded = 0;
  const results = { succeeded: 0, failed: 0 };
  const batches = await createBatches(files, RAY_PATH, batchSize, maxBatchSizeMB);
  console.log(`📦 已分为 ${batches.length} 批，每批最多 ${batchSize} 个文件或 ${maxBatchSizeMB}MB\n`);
  for (let i = 0; i < batches.length; i += concurrency) {
    const concurrentBatches = batches.slice(i, i + concurrency);
    console.log(`🔄 正在并发上传第 ${i + 1}-${Math.min(i + concurrency, batches.length)} 批...\n`);
    const promises = concurrentBatches.map(async (batch, idx) => {
      const batchNum = i + idx + 1;
      try {
        const batchFiles = [];
        let batchSizeMB = 0;
        for (const item of batch) {
          const filePath = normalizeUploadItem(item).path;
          try {
            const fullPath = path.join(RAY_PATH, filePath);
            const stats = await fs.stat(fullPath);
            const sizeMB = stats.size / 1024 / 1024;
            batchFiles.push(await buildUploadFile(RAY_PATH, item));
            batchSizeMB += sizeMB;
          } catch (error) {
            console.error(`   ❌ 读取失败: ${filePath}`);
          }
        }
        const result = await uploadPreparedBatch(uploadFn, batchFiles);
        if (options.onFileUploaded && result.results) {
          for (const file of result.results) {
            if (file.success) {
              await options.onFileUploaded(file.filePath, file);
            }
          }
        }
        batchFiles.length = 0;
        uploaded += result.succeeded;
        results.succeeded += result.succeeded;
        results.failed += result.failed;
        console.log(`   ✅ 批次${batchNum}: ${result.succeeded}/${batch.length} 成功 (${batchSizeMB.toFixed(1)}MB)`);
      } catch (error) {
        console.error(`   ❌ 批次${batchNum}失败，尝试拆分上传: ${error.message}`);
        const splitResult = await uploadSplitBatch(batch, RAY_PATH, uploadFn, options);
        uploaded += splitResult.succeeded;
        results.succeeded += splitResult.succeeded;
        results.failed += splitResult.failed;
      }
    });
    await Promise.all(promises);
    console.log(`   进度: ${uploaded}/${files.length} (${(uploaded / files.length * 100).toFixed(1)}%)\n`);
    if (global.gc) {
      global.gc();
    }
  }
  console.log(`\n✅ 上传完成！成功: ${results.succeeded}, 失败: ${results.failed}\n`);
  return results;
}
async function uploadPreparedBatch(uploadFn, batchFiles) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await uploadFn(batchFiles);
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, attempt * 1000));
      }
    }
  }
  throw lastError;
}
async function uploadSplitBatch(batch, RAY_PATH, uploadFn, options) {
  const results = { succeeded: 0, failed: 0 };
  for (const item of batch) {
    const filePath = normalizeUploadItem(item).path;
    try {
      const result = await uploadPreparedBatch(uploadFn, [await buildUploadFile(RAY_PATH, item)]);
      results.succeeded += result.succeeded;
      results.failed += result.failed;
      if (options.onFileUploaded && result.results && result.results[0] && result.results[0].success) {
        await options.onFileUploaded(filePath, result.results[0]);
      }
    } catch (error) {
      results.failed++;
      console.error(`      ❌ 拆分上传失败: ${filePath}: ${error.message}`);
    }
  }
  return results;
}
module.exports = { smartUpload };
