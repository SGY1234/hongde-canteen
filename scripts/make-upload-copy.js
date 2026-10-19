'use strict';
/**
 * 生成一份"可以安全上传到公开网站"的项目副本
 *
 * 为什么要单独准备：
 *   - .env.feishu / .deploy-token 里是密钥，传到公开仓库等于公开密码
 *   - node_modules / .edge-profile 是临时垃圾，又大又没用
 *   - 测试脚本、交接文档、二维码对线上运行没影响，但会让上传变慢、界面变乱
 *
 * 用法：node scripts/make-upload-copy.js [目标目录]
 * 默认目标：项目同级目录下的「上传到GitHub」
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const dest = process.argv[2] || path.join(path.dirname(ROOT), '上传到GitHub');

/** 需要上传的：[源目录, 上传后的路径] */
const INCLUDE_DIRS = [
  ['public', 'public'],
  ['server', 'server'],
  ['lib', 'lib'],
  ['api', 'api'],
  ['demo', 'demo'],
  ['netlify', 'netlify']
];
const INCLUDE_FILES = [
  'netlify.toml', 'vercel.json', 'package.json', '使用说明.md', '.gitignore'
];
/** 绝对不上传的文件名（密钥等） */
const NEVER = new Set([
  '.env.feishu', '.deploy-token', 'deploy.zip', 'pnpm-lock.yaml', 'package-lock.json',
  'tunnel.log', 'srv-err.log', 'srv-out.log'
]);
/** 绝对不上传的目录名 */
const NEVER_DIRS = new Set(['node_modules', 'data', '.git', '.edge-profile', 'qr', 'test', 'scripts']);

let count = 0;
let bytes = 0;

function copyDir(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir)) {
    if (NEVER.has(name) || NEVER_DIRS.has(name)) continue;
    const src = path.join(srcDir, name);
    const dst = path.join(dstDir, name);
    const st = fs.statSync(src);
    if (st.isDirectory()) copyDir(src, dst);
    else if (!/\.(tmp|log|bak)$/i.test(name)) {
      fs.copyFileSync(src, dst);
      count++;
      bytes += st.size;
    }
  }
}

if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

for (const [srcRel, dstRel] of INCLUDE_DIRS) {
  const src = path.join(ROOT, srcRel);
  if (fs.existsSync(src)) copyDir(src, path.join(dest, dstRel));
}
for (const f of INCLUDE_FILES) {
  const src = path.join(ROOT, f);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(dest, f));
    count++;
    bytes += fs.statSync(src).size;
  }
}

// 兜底再写一份 .gitignore（确保密钥不会被提交）
fs.writeFileSync(path.join(dest, '.gitignore'), [
  'node_modules/',
  'data/',
  '.env.feishu',
  '.deploy-token',
  'deploy.zip',
  '*.log',
  '.edge-profile/'
].join('\n') + '\n', 'utf8');

// 安全检查：确认密钥没有混进去
const leaked = [];
(function scan(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) { scan(full); continue; }
    if (NEVER.has(name)) leaked.push(full);
    const text = fs.readFileSync(full, 'utf8');
    if (/nfp_[A-Za-z0-9]{10,}/.test(text)) leaked.push(full + '（内容含 Netlify token）');
    if (/cli_[A-Za-z0-9]{14,}/.test(text)) leaked.push(full + '（内容含飞书 App ID）');
  }
})(dest);

console.log('已生成可安全上传的副本：');
console.log('  ' + dest);
console.log('  文件 ' + count + ' 个，共 ' + (bytes / 1024).toFixed(1) + ' KB');
console.log('  已排除：密钥文件、node_modules、data、测试、脚本、二维码');
if (leaked.length) {
  console.log('\n  ❌ 安全检查未通过，发现敏感内容：');
  leaked.forEach((f) => console.log('     ' + f));
  process.exit(1);
} else {
  console.log('  ✅ 安全检查通过：副本里没有密钥');
}

console.log('\n目录结构：');
(function show(dir, prefix) {
  const items = fs.readdirSync(dir).sort();
  items.forEach((name, i) => {
    const full = path.join(dir, name);
    const isDir = fs.statSync(full).isDirectory();
    const last = i === items.length - 1;
    console.log('  ' + prefix + (last ? '└─ ' : '├─ ') + name + (isDir ? '/' : ''));
    if (isDir) show(full, prefix + (last ? '   ' : '│  '));
  });
})(dest, '');
