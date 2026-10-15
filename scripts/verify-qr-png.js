'use strict';
/**
 * 二维码 PNG 回验：PNG 文件 → 还原 0/1 矩阵 → 与本工具编码器的矩阵逐格比对
 *
 * 为什么需要这一步：
 *   手机上扫不出来时，必须能分清是「码画错了」还是「手机/环境问题」。
 *   本脚本把两张 PNG（分享版 / 高清版）都拆回矩阵，逐格和编码器结果对比，
 *   全部一致就说明 PNG 本身没问题。
 *
 * 用法：
 *   node scripts/verify-qr-png.js                 # 用 tools/current-url.txt 里的当前地址
 *   node scripts/verify-qr-png.js https://xxx.com # 指定地址
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const qr = require('../lib/qrcode.js');

const ROOT = path.resolve(__dirname, '..');
const URL_FILE = path.resolve(ROOT, '..', 'tools', 'current-url.txt');

const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
let url = arg;
if (!url) {
  try { url = fs.readFileSync(URL_FILE, 'utf8').trim(); } catch (e) { /* 下面报错 */ }
}
if (!url) { console.error('没有地址：请带上网址参数，或先跑一次 scripts/go-live.js'); process.exit(1); }

const PY = process.env.DSH_PYTHON
  || 'C:\\Users\\30205\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';

/** 用 Python(PIL) 把 PNG 还原成 0/1 矩阵（矩阵总大小 + 静默区 = 图形尺寸） */
function pngToMatrix(file, scale, margin, n) {
  const code = [
    'import json,sys',
    'from PIL import Image',
    'im = Image.open(sys.argv[1]); px = im.load()',
    'scale, margin, n = int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])',
    'out = []',
    'for y in range(n):',
    '    row = []',
    '    for x in range(n):',
    '        cx = (x+margin)*scale + scale//2',
    '        cy = (y+margin)*scale + scale//2',
    '        row.append(1 if px[cx,cy] == 0 else 0)',
    '    out.append(row)',
    'print(json.dumps(out))'
  ].join('\n');
  const raw = execFileSync(PY, ['-c', code, file, String(scale), String(margin), String(n)],
    { encoding: 'utf8', env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }) });
  return JSON.parse(raw);
}

console.log('\n=== 二维码 PNG 回验（PNG → 矩阵 → 与编码器比对）===\n');
console.log('  期望指向：' + url);

const info = qr.encode(url, { ecLevel: 'M' });
console.log('  编码器：版本 ' + info.version + ' · ' + info.size + '×' + info.size
  + ' · 纠错 ' + info.ecLevel + ' · 掩码 ' + info.mask + '\n');

const cases = [
  { name: '鸿德食堂打分-二维码.png', scale: 10, margin: 4, tag: '分享版（微信发图用）' },
  { name: '鸿德食堂打分-二维码-高清.png', scale: 24, margin: 4, tag: '高清版（打印用）' }
];

let pass = 0, fail = 0;
for (const c of cases) {
  const file = path.join(ROOT, 'qr', c.name);
  const desktop = path.join('D:\\Users\\30205\\Desktop', c.name);
  if (!fs.existsSync(file)) { console.log('  ⚠️ 找不到 ' + file + '，跳过'); continue; }
  const matrix = pngToMatrix(file, c.scale, c.margin, info.size);
  let bad = 0;
  for (let y = 0; y < info.size; y++) {
    for (let x = 0; x < info.size; x++) {
      if (matrix[y][x] !== (info.modules[y][x] ? 1 : 0)) bad++;
    }
  }
  const cells = info.size * info.size;
  if (bad === 0) {
    console.log('  ✓ ' + c.tag + '：' + cells + ' 格全部一致  ✅');
    pass++;
  } else {
    console.log('  ✗ ' + c.tag + '：有 ' + bad + '/' + cells + ' 格不一致  ❌');
    fail++;
  }
  console.log('      项目内：' + file);
  console.log('      桌面上：' + (fs.existsSync(desktop) ? desktop + ' ✅' : desktop + '（没找到）'));
}

console.log('\n  结果：' + pass + ' 张通过，' + fail + ' 张失败');
console.log(fail === 0 ? '  ✅ PNG 位图与编码器完全一致，码没画错\n' : '  ❌ 有 PNG 不一致，需要检查 lib/png.js\n');
process.exit(fail ? 1 : 0);
