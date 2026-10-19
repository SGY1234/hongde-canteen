'use strict';
/**
 * 把本机打分记录导出成文件（飞书连不上时的保命工具）
 *
 * 什么时候用：
 *   飞书被风控期间，服务会自动降级把分数存到 data/ratings.json。
 *   这些数据必须能随时拿出来（给人看、备份、或以后补进飞书表）。
 *
 * 用法：
 *   node scripts/export-local.js            # 导出 JSON + CSV 到桌面文件夹
 *   node scripts/export-local.js --json     # 只导出 JSON
 *   node scripts/export-local.js --csv      # 只导出 CSV（Excel 可直接打开）
 *
 * 输出（默认写到桌面「鸿德食堂打分-上线文件」和项目 qr/ 目录）：
 *   打分记录-导出.csv    用 Excel 打开，一行一道菜
 *   打分记录-导出.json   程序用，含全部字段
 */

const fs = require('fs');
const path = require('path');
const { resolveOutDir } = require('../lib/desktop-dir.js');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.HD_DATA_DIR
  ? path.resolve(process.env.HD_DATA_DIR)
  : path.join(ROOT, 'data');

const argv = process.argv.slice(2);
const ONLY_JSON = argv.includes('--json');
const ONLY_CSV = argv.includes('--csv');

/**
 * 输出目录：项目 qr/ + 桌面上的项目专属文件夹。
 * ⚠️ 必须走 lib/desktop-dir.js —— 它会优先进「鸿德食堂打分-上线文件」文件夹，
 * 绝不把文件散落到桌面根目录（用户明确要求过）。
 */
function outDirs() {
  const out = [{ dir: path.join(ROOT, 'qr'), tag: '(项目内)' }];
  const desk = resolveOutDir();
  if (desk) out.push({ dir: desk, tag: '(桌面)' });
  return out;
}

/** CSV 字段转义：含逗号/引号/换行的值要用双引号包起来 */
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function main() {
  const file = path.join(DATA_DIR, 'ratings.json');
  if (!fs.existsSync(file)) {
    console.log('\n  本机还没有打分记录（' + file + ' 不存在）。');
    console.log('  说明：飞书连不上时，分数才会存到这里；现在没有 = 期间没人打分。\n');
    return;
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error('  读不了 ' + file + '：' + e.message);
    process.exit(1);
  }
  const records = Object.values((data && data.records) || {});
  if (!records.length) {
    console.log('\n  本机记录是空的（文件存在但没有数据）。\n');
    return;
  }

  // 排序：先按票数多，再按平均分高
  records.sort((a, b) => (b.votes || 0) - (a.votes || 0)
    || ((b.sum || 0) / (b.votes || 1)) - ((a.sum || 0) / (a.votes || 1)));

  const totalVotes = records.reduce((n, r) => n + (r.votes || 0), 0);
  const stamp = new Date().toISOString().slice(0, 10);

  const json = {
    _说明: '鸿德食堂打分工具 · 本机打分记录导出（飞书降级期间的数据）',
    _导出时间: new Date().toLocaleString('zh-CN'),
    _记录数: records.length,
    _总票数: totalVotes,
    _平均分: totalVotes ? Number((records.reduce((n, r) => n + (r.sum || 0), 0) / totalVotes).toFixed(2)) : 0,
    records
  };

  const header = ['所属校区', '所属食堂', '所属档口', '菜品名称', '累计总分', '打分人数', '平均分'];
  const lines = [header.join(',')];
  for (const r of records) {
    const avg = r.votes ? (r.sum / r.votes) : 0;
    lines.push([
      csvCell(r.campusName || '鸿德主校区'),
      csvCell(r.canteenName), csvCell(r.stallName), csvCell(r.dishName),
      csvCell(r.sum), csvCell(r.votes), csvCell(avg.toFixed(2))
    ].join(','));
  }
  // 加 BOM，让 Excel 正确识别中文
  const csv = '\uFEFF' + lines.join('\r\n') + '\r\n';

  console.log('\n=== 导出本机打分记录 ===\n');
  console.log('  数据文件：' + file);
  console.log('  共 ' + records.length + ' 道菜 · ' + totalVotes + ' 票\n');
  for (const r of records.slice(0, 12)) {
    const avg = r.votes ? (r.sum / r.votes).toFixed(1) : '0.0';
    console.log('    ' + String(r.canteenName || '').padEnd(12) + String(r.dishName || '').padEnd(18)
      + ' 总分 ' + String(r.sum).padStart(3) + ' · ' + r.votes + ' 人 · 均分 ' + avg);
  }
  if (records.length > 12) console.log('    …（还有 ' + (records.length - 12) + ' 条）');
  console.log('');

  for (const t of outDirs()) {
    try {
      fs.mkdirSync(t.dir, { recursive: true });
      if (!ONLY_CSV) {
        fs.writeFileSync(path.join(t.dir, '打分记录-导出.json'), JSON.stringify(json, null, 2), 'utf8');
      }
      if (!ONLY_JSON) {
        fs.writeFileSync(path.join(t.dir, '打分记录-导出.csv'), csv, 'utf8');
      }
      console.log('  ✅ 已导出到 ' + t.dir + ' ' + t.tag);
    } catch (e) {
      console.log('  ❌ 写不了 ' + t.dir + '：' + e.message);
    }
  }
  console.log('\n  CSV 用 Excel 双击就能打开；JSON 是给程序用的完整备份。\n');
}

main();
