'use strict';
/**
 * 把项目完整复制到 D 盘工作区（备份/交接用）
 * 用法：node scripts/backup.js <目标目录>
 *
 * 只复制"以后能跑起来"需要的文件，明确排除运行数据、密钥、临时文件。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const dest = process.argv[2];
if (!dest) {
  console.error('用法：node scripts/backup.js <目标目录>');
  process.exit(1);
}

/** 要备份的（相对路径，文件或目录） */
const INCLUDE = [
  'public', 'server', 'api', 'lib', 'demo', 'scripts', 'test', 'qr', 'netlify',
  'package.json', 'vercel.json', 'netlify.toml',
  '.env.feishu.example', '.gitignore',
  '启动.bat', '清空数据.bat', '使用说明.md', '菜单核对清单.md', '落地方案.md'
];

/** 绝不备份的目录（**只对根目录生效**：public/data/menu.json 是数据源必须备份；
 *  根目录的 data/ 才是打分产生的运行数据） */
const ROOT_EXCLUDE_DIRS = new Set(['data', 'node_modules', '.git', '.edge-profile']);
/** 绝不备份的敏感文件（密钥） */
const SKIP_FILES = new Set(['.env.feishu', '.deploy-token', 'deploy.zip']);
const EXCLUDE_EXT = new Set(['.tmp', '.log', '.bak']);

let files = 0;
let dirs = 0;
let bytes = 0;

function copyOne(src, dst, isRoot) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    const base = path.basename(src);
    if (isRoot && ROOT_EXCLUDE_DIRS.has(base)) return;
    fs.mkdirSync(dst, { recursive: true });
    dirs++;
    for (const name of fs.readdirSync(src)) {
      copyOne(path.join(src, name), path.join(dst, name), false);
    }
    return;
  }
  if (SKIP_FILES.has(path.basename(src))) return;
  if (EXCLUDE_EXT.has(path.extname(src).toLowerCase())) return;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  files++;
  bytes += st.size;
}

fs.mkdirSync(dest, { recursive: true });
for (const item of INCLUDE) {
  const src = path.join(ROOT, item);
  if (!fs.existsSync(src)) {
    console.log('  ⚠️ 跳过不存在的：' + item);
    continue;
  }
  copyOne(src, path.join(dest, item), true);
}

console.log('  ✅ 备份完成：' + dest);
console.log('     文件 ' + files + ' 个，目录 ' + dirs + ' 个，共 ' + (bytes / 1024).toFixed(1) + ' KB');
console.log('     已排除：data（打分数据）、.env.feishu / .deploy-token（密钥）、临时文件');
