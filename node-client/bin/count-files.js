#!/usr/bin/env node
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();
const RAY_PATH = process.env.RAY_PATH;
const SYNCIGNORE_FILE = path.join(RAY_PATH, '.syncignore');
let ignoreRules = [];
async function loadSyncIgnore() {
  try {
    const content = await fs.readFile(SYNCIGNORE_FILE, 'utf8');
    ignoreRules = content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
  } catch (error) {
    ignoreRules = [];
  }
}
function shouldIgnore(relativePath) {
  for (const rule of ignoreRules) {
    const pattern = rule
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '§§§')
      .replace(/\*/g, '[^/]*')
      .replace(/§§§/g, '.*')
      .replace(/\?/g, '[^/]');
    const regex = new RegExp('^' + pattern + '$');
    if (regex.test(relativePath)) {
      return true;
    }
  }
  return false;
}
async function scanLocalFiles() {
  const files = [];
  async function walk(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(RAY_PATH, fullPath);
        if (shouldIgnore(relativePath)) {
          continue;
        }
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          files.push(relativePath);
        }
      }
    } catch (error) {
    }
  }
  await walk(RAY_PATH);
  return files;
}
async function getLocalFileStats() {
  const files = await scanLocalFiles();
  const stats = {
    total: files.length,
    byExtension: {},
    byDirectory: {}
  };
  for (const file of files) {
    const ext = path.extname(file).toLowerCase() || 'no-ext';
    stats.byExtension[ext] = (stats.byExtension[ext] || 0) + 1;
    const dir = path.dirname(file).split('/')[0] || 'root';
    stats.byDirectory[dir] = (stats.byDirectory[dir] || 0) + 1;
  }
  return stats;
}
async function printStats() {
  console.log('\n📊 本地文件统计工具');
  console.log('='.repeat(60));
  console.log(`📁 扫描目录: ${RAY_PATH}`);
  console.log(`🚫 忽略规则: ${ignoreRules.length} 条\n`);
  console.log('🔍 正在扫描文件...\n');
  const stats = await getLocalFileStats();
  console.log(`📁 总文件数: ${stats.total.toLocaleString()} 个`);
  console.log('');
  const sortedExts = Object.entries(stats.byExtension)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);
  console.log('📑 文件类型分布（前15）:');
  console.log('-'.repeat(40));
  for (const [ext, count] of sortedExts) {
    const percentage = ((count / stats.total) * 100).toFixed(1);
    const bar = '█'.repeat(Math.floor(count / stats.total * 30));
    console.log(`   ${ext.padEnd(15)} ${count.toString().padStart(6)} 个  ${percentage.padStart(5)}%  ${bar}`);
  }
  console.log('');
  const sortedDirs = Object.entries(stats.byDirectory)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);
  console.log('📂 目录分布（前15）:');
  console.log('-'.repeat(40));
  for (const [dir, count] of sortedDirs) {
    const percentage = ((count / stats.total) * 100).toFixed(1);
    const bar = '█'.repeat(Math.floor(count / stats.total * 30));
    console.log(`   ${dir.padEnd(20)} ${count.toString().padStart(6)} 个  ${percentage.padStart(5)}%  ${bar}`);
  }
  console.log('');
  console.log('='.repeat(60));
  console.log('✅ 统计完成\n');
}
async function main() {
  if (!RAY_PATH) {
    console.error('❌ 错误: 未配置 RAY_PATH 环境变量');
    console.error('💡 请在 .env 文件中配置: RAY_PATH=/path/to/your/directory');
    process.exit(1);
  }
  try {
    await loadSyncIgnore();
    await printStats();
  } catch (error) {
    console.error('❌ 错误:', error.message);
    process.exit(1);
  }
}
if (require.main === module) {
  main();
}
module.exports = { getLocalFileStats, scanLocalFiles };
