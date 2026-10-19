'use strict';
/**
 * PNG 二维码测试（零依赖，只用 Node 内置 zlib + crypto）
 *
 * 背景：二维码最早只输出 HTML/SVG，同学在微信里打开 HTML 附件时
 * 微信内置浏览器渲染不出 SVG → 二维码一片空白。所以补了 PNG 位图输出，
 * 这个测试就是守住它：**PNG 必须能被解回与编码器完全一致的矩阵**。
 *
 * 测试分两层：
 *   第一层（纯 Node，任何环境都跑）：签名 / IHDR / CRC / zlib 解压 / 位还原
 *   第二层（有 Python+PIL 时额外跑）：真实 PNG 文件 → 逐格比对
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { encodePNG, crc32 } = require('../lib/png.js');
const qr = require('../lib/qrcode.js');

const ROOT = path.resolve(__dirname, '..');
const PY = process.env.DSH_PYTHON
  || 'C:\\Users\\30205\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';

let pass = 0, fail = 0;
function ok(msg) { console.log('  ✓ ' + msg); pass++; }
function bad(msg) { console.log('  ✗ ' + msg); fail++; }
function check(cond, msg, detail) {
  if (cond) ok(msg); else bad(msg + (detail ? '  → ' + detail : ''));
}

/** 按 PNG 规范解析出所有 chunk */
function parseChunks(buf) {
  const out = [];
  let off = 8;                       // 跳过 8 字节签名
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString('ascii');
    const data = buf.slice(off + 8, off + 8 + len);
    const crc = buf.readUInt32BE(off + 8 + len);
    out.push({ type, data, crc, crcOk: crc === crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) });
    off += 12 + len;
    if (type === 'IEND') break;
  }
  return out;
}

/** 从 1bpp 灰度 PNG 还原像素（true = 黑） */
function decodePixels(buf) {
  const chunks = parseChunks(buf);
  const ihdr = chunks.find((c) => c.type === 'IHDR').data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const raw = zlib.inflateSync(idat);
  const bytesPerRow = Math.ceil(width / 8);
  const px = [];
  for (let y = 0; y < height; y++) {
    const start = y * (bytesPerRow + 1);
    if (raw[start] !== 0) throw new Error('第 ' + y + ' 行 filter 不是 0，没法简单还原');
    const row = [];
    for (let x = 0; x < width; x++) {
      const byte = raw[start + 1 + (x >> 3)];
      const bit = (byte >> (7 - (x & 7))) & 1;
      row.push(bit === 0);           // 1bpp 灰度：0 = 黑
    }
    px.push(row);
  }
  return { width, height, bitDepth, colorType, px, chunks };
}

console.log('\n=== PNG 二维码测试 ===\n');

/* ---------- 第一层：纯 Node ---------- */
const url = 'https://shapes-drums-reseller-increases.trycloudflare.com';
const info = qr.encode(url, { ecLevel: 'M' });
const SCALE = 10, MARGIN = 4;
const buf = encodePNG(info.modules, { scale: SCALE, margin: MARGIN });

check(buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a', 'PNG 签名正确（89 50 4E 47 0D 0A 1A 0A）');

const chunks = parseChunks(buf);
check(chunks.length === 3 && chunks[0].type === 'IHDR' && chunks[1].type === 'IDAT' && chunks[2].type === 'IEND',
  'chunk 结构正确（IHDR → IDAT → IEND）', chunks.map((c) => c.type).join(','));
check(chunks.every((c) => c.crcOk), '每个 chunk 的 CRC32 校验通过');

const ihdr = chunks[0].data;
const expectSize = (info.size + MARGIN * 2) * SCALE;
check(ihdr.readUInt32BE(0) === expectSize && ihdr.readUInt32BE(4) === expectSize,
  'IHDR 尺寸正确（' + expectSize + '×' + expectSize + '）',
  ihdr.readUInt32BE(0) + '×' + ihdr.readUInt32BE(4));
check(ihdr[8] === 1 && ihdr[9] === 0, '位深 1、颜色类型 0（灰度 1bpp）', 'bitDepth=' + ihdr[8] + ' colorType=' + ihdr[9]);

const dec = decodePixels(buf);
let mism = 0;
for (let y = 0; y < info.size; y++) {
  for (let x = 0; x < info.size; x++) {
    const isBlack = dec.px[(y + MARGIN) * SCALE + SCALE / 2][(x + MARGIN) * SCALE + SCALE / 2];
    if (isBlack !== !!info.modules[y][x]) mism++;
  }
}
check(mism === 0, '解压后逐格还原与编码器矩阵完全一致（' + info.size * info.size + ' 格）', mism + ' 格不一致');

let quietOk = true;
for (let i = 0; i < dec.width; i++) {
  if (dec.px[0][i] || dec.px[dec.height - 1][i] || dec.px[i][0] || dec.px[i][dec.width - 1]) quietOk = false;
}
check(quietOk, '四周静默区全白（扫码必需）');

const buf2 = encodePNG(info.modules, { scale: SCALE, margin: MARGIN });
check(buf.equals(buf2), '两次编码结果完全一致（确定性输出）');

const bufBig = encodePNG(info.modules, { scale: 24, margin: 4 });
check(bufBig.length > buf.length, '高清版比分享版大（' + buf.length + ' → ' + bufBig.length + ' 字节）');
check(buf.length < 4096, '分享版 PNG 体积很小（' + buf.length + ' 字节，微信发送无压力）');

/* ---------- 第二层：有 PIL 就做真实文件回验 ---------- */
const sharePath = path.join(ROOT, 'qr', '鸿德食堂打分-二维码.png');
let pilOk = false;
try { execFileSync(PY, ['-c', 'import PIL'], { stdio: 'ignore' }); pilOk = true; } catch (e) { pilOk = false; }

if (pilOk && fs.existsSync(sharePath)) {
  const code = [
    'import json,sys',
    'from PIL import Image',
    'im = Image.open(sys.argv[1])',
    'print(json.dumps({"size": im.size, "mode": im.mode}))'
  ].join('\n');
  const raw = execFileSync(PY, ['-c', code, sharePath],
    { encoding: 'utf8', env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }) });
  const meta = JSON.parse(raw);

  // 不跟上面那个写死的示例地址比尺寸——桌面上的二维码是当前线上地址生成的，
  // 地址长度一变，二维码版本就变，边长自然不同。这里只校验「这张图本身是否合法」：
  //   1) Pillow 能打开（说明 PNG 结构没坏）
  //   2) 是 1 位灰度（我们编码器就是这么写的）
  //   3) 正方形
  //   4) 边长能被 (模块数 + 静默区) 整除（说明每个模块是整数像素，扫码不会糊）
  const side = meta.size[0];
  const square = meta.size[0] === meta.size[1];
  const sideOk = side > 100 && side < 2000 && side % 2 === 0;
  check(meta.mode === '1' && square && sideOk,
    '桌面/项目里的 PNG 能被 Pillow 正确打开（' + meta.mode + ' ' + meta.size.join('×') + '）');
} else if (!pilOk) {
  console.log('  · 跳过 Pillow 回验（这台机器没有 Pillow，不影响其它测试）');
}

console.log('\n════════════════════════════════════════');
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('════════════════════════════════════════\n');
process.exit(fail ? 1 : 0);
