const fs = require('fs').promises;
const path = require('path');
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
  const batchSize = 50;
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
    description: `每批${batchSize}个，${concurrency}批并发`
  };
}
async function smartUpload(filesToUpload, RAY_PATH, uploadFn) {
  console.log('🧠 智能上传分析中...\n');
  let totalSizeMB = 0;
  for (const filePath of filesToUpload) {
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
    return await uploadSingle(filesToUpload, RAY_PATH, uploadFn, strategy.concurrency);
  } else {
    return await uploadBatch(filesToUpload, RAY_PATH, uploadFn, strategy);
  }
}
async function uploadSingle(files, RAY_PATH, uploadFn, concurrency) {
  console.log(`🚀 开始并发上传 ${files.length} 个文件...\n`);
  let uploaded = 0;
  const results = { succeeded: 0, failed: 0 };
  for (let i = 0; i < files.length; i += concurrency) {
    const batch = files.slice(i, i + concurrency);
    const promises = batch.map(async (filePath) => {
      try {
        const fullPath = path.join(RAY_PATH, filePath);
        const content = await fs.readFile(fullPath, 'utf8');
        const crypto = require('crypto');
        const hash = crypto.createHash('md5').update(content).digest('hex');
        const stats = await fs.stat(fullPath);
        const mtime = stats.mtimeMs;
        await uploadFn([{
          filePath,
          content,
          operation: 'create',
          hash,
          mtime,
          baseHash: null
        }]);
        results.succeeded++;
        uploaded++;
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
async function uploadBatch(files, RAY_PATH, uploadFn, strategy) {
  console.log(`🚀 开始批次并发上传...\n`);
  const { batchSize, concurrency } = strategy;
  let uploaded = 0;
  const results = { succeeded: 0, failed: 0 };
  const batches = [];
  for (let i = 0; i < files.length; i += batchSize) {
    batches.push(files.slice(i, i + batchSize));
  }
  console.log(`📦 已分为 ${batches.length} 批，每批约 ${batchSize} 个文件\n`);
  for (let i = 0; i < batches.length; i += concurrency) {
    const concurrentBatches = batches.slice(i, i + concurrency);
    console.log(`🔄 正在并发上传第 ${i + 1}-${Math.min(i + concurrency, batches.length)} 批...\n`);
    const promises = concurrentBatches.map(async (batch, idx) => {
      const batchNum = i + idx + 1;
      try {
        const batchFiles = [];
        let batchSizeMB = 0;
        for (const filePath of batch) {
          try {
            const fullPath = path.join(RAY_PATH, filePath);
            const content = await fs.readFile(fullPath, 'utf8');
            const sizeMB = Buffer.byteLength(content, 'utf8') / 1024 / 1024;
            const crypto = require('crypto');
            const hash = crypto.createHash('md5').update(content).digest('hex');
            const stats = await fs.stat(fullPath);
            const mtime = stats.mtimeMs;
            batchFiles.push({
              filePath,
              content,
              operation: 'create',
              hash,
              mtime,
              baseHash: null
            });
            batchSizeMB += sizeMB;
          } catch (error) {
            console.error(`   ❌ 读取失败: ${filePath}`);
          }
        }
        const result = await uploadFn(batchFiles);
        batchFiles.length = 0;
        uploaded += result.succeeded;
        results.succeeded += result.succeeded;
        results.failed += result.failed;
        console.log(`   ✅ 批次${batchNum}: ${result.succeeded}/${batch.length} 成功 (${batchSizeMB.toFixed(1)}MB)`);
      } catch (error) {
        console.error(`   ❌ 批次${batchNum}失败: ${error.message}`);
        results.failed += batch.length;
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
module.exports = { smartUpload };
