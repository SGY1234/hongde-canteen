'use strict';
/**
 * 零依赖 PNG 编码器（手写，不引入任何 npm 包）
 *
 * 为什么需要它：
 *   发给同学的二维码图片必须是**位图**。之前只输出了 HTML（内联 SVG），
 *   同学在微信里打开 HTML 附件时，微信内置浏览器经常渲染不出 SVG → 二维码空白。
 *   直接在微信里发 PNG 图片就不会有这个问题（点开就能长按识别）。
 *
 * 实现要点：
 *   - 用 PNG 灰度 + 1 位深度（1bpp），黑白二维码天然只有两色，文件最小
 *   - 每行前面加一个 filter 字节（0 = None）
 *   - 整个数据块用 zlib.deflateSync 压缩（Node 内置 zlib，不算外部依赖）
 *   - CRC32 按 PNG 规范实现（多项式 0xEDB88320）
 *
 * 用法：
 *   const { encodePNG } = require('./png.js');
 *   const buf = encodePNG(matrix, { scale: 10, margin: 4 });
 *   // matrix: [[0,1,1,...], ...]  二维数组，1 = 黑
 */

const zlib = require('zlib');

/* ---------- CRC32 ---------- */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** 组装一个 PNG chunk：长度 + 类型 + 数据 + CRC */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * 把 0/1 矩阵编码成 PNG 二进制
 * @param {number[][]} matrix  二维数组，非 0 视为黑
 * @param {object} opts        { scale = 8, margin = 4 }
 * @returns {Buffer}
 */
function encodePNG(matrix, opts) {
  const o = opts || {};
  const scale = Math.max(1, o.scale || 8);       // 每个二维码格子放大成多少像素
  const margin = o.margin == null ? 4 : o.margin; // 静默区（必须留白，否则扫不出来）

  if (!Array.isArray(matrix) || !matrix.length || !Array.isArray(matrix[0])) {
    throw new Error('matrix 必须是二维数组');
  }
  const rows = matrix.length;
  const cols = matrix[0].length;
  const size = (cols + margin * 2) * scale;      // 输出为正方形：宽高都用它

  // PNG 是逐行存储的，每行开头要有一个 filter 字节（0 = 不滤波）
  const bytesPerRow = Math.ceil(size / 8);       // 1bpp：每 8 个像素 1 字节
  const raw = Buffer.alloc((bytesPerRow + 1) * size, 0xFF); // 先全填白，再把黑点画上

  for (let y = 0; y < size; y++) {
    const rowStart = y * (bytesPerRow + 1);
    raw[rowStart] = 0;                            // filter 类型：None
    // 该行对应的二维码行号（去掉静默区后按 scale 折算）
    const srcY = Math.floor(y / scale) - margin;
    if (srcY < 0 || srcY >= rows) continue;       // 静默区，保持白色
    for (let x = 0; x < size; x++) {
      const srcX = Math.floor(x / scale) - margin;
      if (srcX < 0 || srcX >= cols) continue;
      if (matrix[srcY][srcX]) {
        const byteIndex = rowStart + 1 + (x >> 3);
        raw[byteIndex] &= ~(0x80 >> (x & 7));     // 该位清 0 = 黑（灰度 1bpp 里 0=黑、1=白）
      }
    }
  }

  // IHDR：宽、高、位深 1、颜色类型 0（灰度）、压缩 0、滤波 0、隔行 0
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 1;    // bit depth
  ihdr[9] = 0;    // color type: grayscale
  ihdr[10] = 0;   // compression
  ihdr[11] = 0;   // filter
  ihdr[12] = 0;   // interlace

  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

module.exports = { encodePNG, crc32 };
