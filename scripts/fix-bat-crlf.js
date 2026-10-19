'use strict';
/**
 * 修复 .bat 文件的换行符（必须 CRLF）并去掉 BOM
 *
 * 为什么需要它（真踩过的坑）：
 *   Windows 的 cmd 逐行读取 .bat，**行尾必须是 CRLF**。
 *   如果文件是 LF（Unix）行尾，cmd 会把相邻的行粘在一起、或把中文按 ANSI 错乱解析，
 *   表现是：**双击 .bat 后窗口一闪而过、网站根本没启动**，而且不报明显的错，极难排查。
 *   另外 .bat 也不能带 UTF-8 BOM（三个字节会被当成命令的一部分）。
 *
 * 用法：
 *   node scripts/fix-bat-crlf.js                  # 检查并修复项目里的 .bat
 *   node scripts/fix-bat-crlf.js <目录或文件>      # 处理指定位置
 *   node scripts/fix-bat-crlf.js --check          # 只报告，不修改
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes('--check');
const targets = argv.filter((a) => !a.startsWith('--'));

/** 默认扫描这些位置 */
function defaultTargets() {
  const out = [ROOT];
  const desktop = [
    'D:\\Users\\30205\\Desktop\\鸿德食堂打分-上线文件',
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'Desktop', '鸿德食堂打分-上线文件')
  ].filter(Boolean);
  for (const d of desktop) { try { if (fs.existsSync(d)) out.push(d); } catch (e) { /* 忽略 */ } }
  return out;
}

function collectBat(p, acc) {
  let st;
  try { st = fs.statSync(p); } catch (e) { return acc; }
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(p)) {
      if (name === 'node_modules' || name === '.git') continue;
      collectBat(path.join(p, name), acc);
    }
  } else if (/\.bat$/i.test(p)) {
    acc.push(p);
  }
  return acc;
}

const files = [];
for (const t of (targets.length ? targets : defaultTargets())) collectBat(path.resolve(t), files);

console.log('\n=== .bat 换行符检查（必须 CRLF、无 BOM）===\n');

let fixed = 0, alreadyOk = 0, bomFixed = 0;
for (const f of files) {
  const buf = fs.readFileSync(f);
  let changed = false;
  let b = buf;

  // 1) 去掉 UTF-8 BOM
  if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) {
    b = b.slice(3);
    changed = true;
    bomFixed++;
  }

  // 2) 行尾统一成 CRLF
  const text = b.toString('utf8');
  const crlfCount = (text.match(/\r\n/g) || []).length;
  const lfOnly = (text.match(/(?<!\r)\n/g) || []).length;
  let out = text;
  if (lfOnly > 0) {
    out = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    changed = true;
  }

  const rel = path.relative(ROOT, f);
  const label = rel.startsWith('..') ? f : rel;

  if (!changed) {
    console.log('  ✓ ' + label + '  已经正确（CRLF×' + crlfCount + '）');
    alreadyOk++;
    continue;
  }

  if (CHECK_ONLY) {
    console.log('  ✗ ' + label + '  需要修复（LF 行 ' + lfOnly + ' 个'
      + (bomFixed ? '，另有 BOM' : '') + '）');
    fixed++;
    continue;
  }

  fs.writeFileSync(f, Buffer.from(out, 'utf8'));
  console.log('  🔧 已修复 ' + label
    + '（' + (lfOnly > 0 ? 'LF→CRLF ' + lfOnly + ' 行' : '')
    + (b[0] !== buf[0] ? '，去掉 BOM' : '') + '）');
  fixed++;
}

console.log('\n  共检查 ' + files.length + ' 个 .bat：正常 ' + alreadyOk + ' 个，'
  + (CHECK_ONLY ? '需要修复 ' : '已修复 ') + fixed + ' 个');
if (CHECK_ONLY && fixed) console.log('  去掉 --check 再跑一次即为真正修复');
console.log('');
process.exit(CHECK_ONLY && fixed ? 1 : 0);
