'use strict';
/**
 * 零依赖二维码生成器（QR Code Model 2）
 *
 * 为什么要自己写：项目要求零成本零依赖，不能引 npm 包、不能用第三方 CDN 生成器。
 * 所以这里手写了一个最小可用的 QR 编码器，支持：
 *   - 字节模式（UTF-8）
 *   - 版本 1~10（足够放下网址）
 *   - 纠错等级 L / M / Q / H
 *   - 自动选择最优掩码
 *
 * 用法：const qr = require('./lib/qrcode.js');
 *       qr.toSVG('https://example.com', { scale: 8, margin: 4 })
 */

/* ------------------------- 二维码版本参数表（版本 1~10） ------------------------- */
/**
 * 每格包含三样东西：EC（每块纠错码字数）+ 块分组（[块数, 每块数据码字数] 的列表）
 *
 * 为什么要合并成一张表：我第一版分成了 CAPACITY / EC_BLOCKS / EC_STRUCTURE 三张表，
 * 结果互相不一致（版本3-H 的数据容量写成 27，版本5以上块数写成了第一组的块数），
 * 生成出来的二维码自己都解不出来。合并成一张之后，绝对不可能再自相矛盾。
 *
 * 数据码字总数 = Σ(块数 × 每块数据码字)
 * 总码字       = 数据码字 + EC × 总块数
 * 上面两个等式由 lib/qrcode-verify.js 逐格核对（版本1~10 × L/M/Q/H 共 40 格）。
 */
const QR_PARAMS = {
  //                      L                    M                    Q                       H
  1: [[7, [[1, 19]]], [10, [[1, 16]]], [13, [[1, 13]]], [17, [[1, 9]]]],
  2: [[10, [[1, 34]]], [16, [[1, 28]]], [22, [[1, 22]]], [28, [[1, 16]]]],
  3: [[15, [[1, 55]]], [26, [[1, 44]]], [18, [[2, 17]]], [22, [[2, 13]]]],
  4: [[20, [[1, 80]]], [18, [[2, 32]]], [26, [[2, 24]]], [16, [[4, 9]]]],
  5: [[26, [[1, 108]]], [24, [[2, 43]]], [18, [[2, 15], [2, 16]]], [22, [[2, 11], [2, 12]]]],
  6: [[18, [[2, 68]]], [16, [[4, 27]]], [24, [[4, 19]]], [28, [[4, 15]]]],
  7: [[20, [[2, 78]]], [18, [[4, 31]]], [18, [[2, 14], [4, 15]]], [26, [[4, 13], [1, 14]]]],
  8: [[24, [[2, 97]]], [22, [[2, 38], [2, 39]]], [22, [[4, 18], [2, 19]]], [26, [[4, 14], [2, 15]]]],
  9: [[30, [[2, 116]]], [22, [[3, 36], [2, 37]]], [20, [[4, 16], [4, 17]]], [24, [[4, 12], [4, 13]]]],
  10: [[18, [[2, 68], [2, 69]]], [26, [[4, 43], [1, 44]]], [24, [[6, 19], [2, 20]]], [28, [[6, 15], [2, 16]]]]
};
const EC_LEVEL_INDEX = { L: 0, M: 1, Q: 2, H: 3 };

/** 总码字数（固定值，官方标准） */
const TOTAL_CODEWORDS = { 1: 26, 2: 44, 3: 70, 4: 100, 5: 134, 6: 172, 7: 196, 8: 242, 9: 292, 10: 346 };

/** 每个版本每个等级的数据码字总数 */
const CAPACITY = (function build() {
  const out = {};
  for (const v of Object.keys(QR_PARAMS)) {
    out[v] = QR_PARAMS[v].map(([, groups]) => groups.reduce((a, [n, s]) => a + n * s, 0));
  }
  return out;
})();

/** 每块纠错码字数 */
const EC_PER_BLOCK = (function build() {
  const out = {};
  for (const v of Object.keys(QR_PARAMS)) {
    out[v] = QR_PARAMS[v].map(([ec]) => ec);
  }
  return out;
})();

/** 块分组 */
const EC_GROUPS = (function build() {
  const out = {};
  for (const v of Object.keys(QR_PARAMS)) {
    out[v] = QR_PARAMS[v].map(([, groups]) => groups);
  }
  return out;
})();

/** 总块数 */
const BLOCK_COUNT = (function build() {
  const out = {};
  for (const v of Object.keys(QR_PARAMS)) {
    out[v] = QR_PARAMS[v].map(([, groups]) => groups.reduce((a, [n]) => a + n, 0));
  }
  return out;
})();

// 兼容旧名字（内部曾用过 EC_BLOCKS / EC_STRUCTURE）
const EC_BLOCKS = {};
const EC_STRUCTURE = {};
for (const v of Object.keys(QR_PARAMS)) {
  EC_BLOCKS[v] = EC_PER_BLOCK[v].map((ec, i) => [ec, BLOCK_COUNT[v][i]]);
  EC_STRUCTURE[v] = EC_GROUPS[v];
}

/* ------------------------- 有限域 GF(256) ------------------------- */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11D;   // 本原多项式 x^8+x^4+x^3+x^2+1
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** 生成多项式 g(x) = (x-a^0)(x-a^1)...(x-a^(n-1)) */
function rsGenerator(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], 1);
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** 计算纠错码字 */
function rsEncode(data, ecCount) {
  const gen = rsGenerator(ecCount);
  const res = new Uint8Array(data.length + ecCount);
  res.set(data, 0);
  for (let i = 0; i < data.length; i++) {
    const factor = res[i];
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j++) {
      res[i + j] ^= gfMul(gen[j], factor);
    }
  }
  return res.slice(data.length);
}

/* ------------------------- 编码 ------------------------- */
function utf8Bytes(str) {
  const out = [];
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) {
      out.push(0xC0 | (cp >> 6), 0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
      out.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
    } else {
      out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F),
        0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
    }
  }
  return out;
}

/** 数据码字 */
function buildData(bytes, version, ecIndex) {
  const totalData = CAPACITY[version][ecIndex];
  // 位流：模式指示符 0100 + 字符数 + 数据 + 结束符
  const bits = [];
  const push = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };
  push(4, 4);                                    // 字节模式
  push(bytes.length, version < 10 ? 8 : 16);      // 字符数指示符
  bytes.forEach((b) => push(b, 8));
  // 结束符
  const maxBits = totalData * 8;
  for (let i = 0; i < 4 && bits.length < maxBits; i++) bits.push(0);
  // 补齐到字节
  while (bits.length % 8 !== 0) bits.push(0);
  // 填充码字 0xEC / 0x11
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    codewords.push(v);
  }
  const padBytes = [0xEC, 0x11];
  let p = 0;
  while (codewords.length < totalData) {
    codewords.push(padBytes[p++ % 2]);
  }
  return codewords;
}

/** 分块 + 纠错 + 交织 */
function interleave(codewords, version, ecIndex) {
  const groups = EC_GROUPS[version][ecIndex];
  const ecPerBlock = EC_PER_BLOCK[version][ecIndex];
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  groups.forEach(([count, size]) => {
    for (let i = 0; i < count; i++) {
      const block = codewords.slice(offset, offset + size);
      offset += size;
      dataBlocks.push(block);
      ecBlocks.push(Array.from(rsEncode(Uint8Array.from(block), ecPerBlock)));
    }
  });
  if (offset !== codewords.length) {
    throw new Error('内部错误：数据码字数与分块表不匹配（' + offset + ' ≠ ' + codewords.length + '）');
  }

  const out = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) {
    dataBlocks.forEach((b) => { if (i < b.length) out.push(b[i]); });
  }
  for (let i = 0; i < ecPerBlock; i++) {
    ecBlocks.forEach((b) => out.push(b[i]));
  }
  return out;
}

/* ------------------------- 矩阵构造 ------------------------- */
function createMatrix(version) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(null));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  const setFinder = (r, c) => {
    for (let i = -1; i <= 7; i++) {
      for (let j = -1; j <= 7; j++) {
        const rr = r + i, cc = c + j;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const inRing = (i >= 0 && i <= 6 && (j === 0 || j === 6)) ||
          (j >= 0 && j <= 6 && (i === 0 || i === 6));
        const inCore = i >= 2 && i <= 4 && j >= 2 && j <= 4;
        modules[rr][cc] = (inRing || inCore) ? 1 : 0;
        reserved[rr][cc] = true;
      }
    }
  };
  setFinder(0, 0);
  setFinder(0, size - 7);
  setFinder(size - 7, 0);

  // 定位图案
  for (let i = 8; i < size - 8; i++) {
    modules[6][i] = i % 2 === 0 ? 1 : 0; reserved[6][i] = true;
    modules[i][6] = i % 2 === 0 ? 1 : 0; reserved[i][6] = true;
  }

  // 校正图案（版本 2 以上）
  const ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
  };
  const positions = ALIGN[version] || [];
  positions.forEach((r) => {
    positions.forEach((c) => {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) return;
      for (let i = -2; i <= 2; i++) {
        for (let j = -2; j <= 2; j++) {
          const on = Math.max(Math.abs(i), Math.abs(j)) !== 1;
          modules[r + i][c + j] = on ? 1 : 0;
          reserved[r + i][c + j] = true;
        }
      }
    });
  });

  // 格式信息区 + 版本信息区 先占位
  for (let i = 0; i < 9; i++) {
    if (!reserved[8][i]) { reserved[8][i] = true; }
    if (!reserved[i][8]) { reserved[i][8] = true; }
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = true;
    reserved[size - 1 - i][8] = true;
  }
  reserved[size - 8][8] = true;
  // 版本信息（版本 >= 7）
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        reserved[size - 11 + j][i] = true;
        reserved[i][size - 11 + j] = true;
      }
    }
  }

  return { size, modules, reserved };
}

/** 把数据位放入矩阵（含掩码前的原始放置） */
function placeData(matrix, bits) {
  const { size, modules, reserved } = matrix;
  let idx = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;   // 跳过时序列
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (let k = 0; k < 2; k++) {
        const c = col - k;
        if (reserved[row][c]) continue;
        modules[row][c] = idx < bits.length ? bits[idx] : 0;
        idx++;
      }
    }
    upward = !upward;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r, c) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
];

/** 格式信息（含 BCH 校验） */
function formatBits(ecIndex, mask) {
  const EC_BITS = [1, 0, 3, 2];              // L=01, M=00, Q=11, H=10
  let data = (EC_BITS[ecIndex] << 3) | mask;
  let bits = data << 10;
  const G = 0x537;
  for (let i = 14; i >= 10; i--) {
    if ((bits >> i) & 1) bits ^= G << (i - 10);
  }
  return ((data << 10) | bits) ^ 0x5412;
}

/** 版本信息（含 BCH 校验，版本 >= 7） */
function versionBits(version) {
  let bits = version << 12;
  const G = 0x1F25;
  for (let i = 17; i >= 12; i--) {
    if ((bits >> i) & 1) bits ^= G << (i - 12);
  }
  return (version << 12) | bits;
}

function applyFormatAndVersion(matrix, version, ecIndex, mask) {
  const { size, modules } = matrix;
  const fmt = formatBits(ecIndex, mask);
  const bit = (i) => (fmt >> i) & 1;

  // 左上
  for (let i = 0; i <= 5; i++) modules[8][i] = bit(i);
  modules[8][7] = bit(6);
  modules[8][8] = bit(7);
  modules[7][8] = bit(8);
  for (let i = 9; i <= 14; i++) modules[14 - i][8] = bit(i);

  // 右上 / 左下
  for (let i = 0; i <= 7; i++) modules[8][size - 1 - i] = bit(i);
  for (let i = 8; i <= 14; i++) modules[size - 15 + i][8] = bit(i);
  modules[size - 8][8] = 1;   // 固定暗模块

  if (version >= 7) {
    const vb = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const b = (vb >> i) & 1;
      const r = Math.floor(i / 3);
      const c = i % 3;
      modules[size - 11 + c][r] = b;
      modules[r][size - 11 + c] = b;
    }
  }
}

/** 惩罚分（选最优掩码用） */
function penalty(m) {
  const { size, modules } = m;
  let score = 0;
  // 规则1：同色连续
  const runScore = (get) => {
    let s = 0;
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b < size; b++) {
        if (get(a, b) === get(a, b - 1)) run++;
        else { if (run >= 5) s += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) s += 3 + (run - 5);
    }
    return s;
  };
  score += runScore((r, c) => modules[r][c]);
  score += runScore((c, r) => modules[r][c]);
  // 规则2：2x2 同色块
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = modules[r][c];
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) score += 3;
    }
  }
  // 规则3：类似定位图案
  const pattern = [1, 0, 1, 1, 1, 0, 1];
  const check = (get) => {
    for (let a = 0; a < size; a++) {
      for (let b = 0; b + 7 <= size; b++) {
        let match = true;
        for (let k = 0; k < 7; k++) if (get(a, b + k) !== pattern[k]) { match = false; break; }
        if (match) {
          const before = b >= 4 ? [0, 0, 0, 0].every((_, k) => get(a, b - 4 + k) === 0) : false;
          const after = b + 11 <= size ? [0, 0, 0, 0].every((_, k) => get(a, b + 7 + k) === 0) : false;
          if (before || after) score += 40;
        }
      }
    }
  };
  check((r, c) => modules[r][c]);
  check((c, r) => modules[r][c]);
  // 规则4：黑白比例
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += modules[r][c];
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return score;
}

/** 某个版本/等级能否装下指定的字节数（要算上模式指示符、字符数、结束符的开销） */
function fitsInVersion(byteLen, version, ecIndex) {
  const countBits = version < 10 ? 8 : 16;
  const needBits = 4 + countBits + byteLen * 8;
  // 还要留得下结束符（最多 4 bit），然后按字节对齐
  const needCodewords = Math.ceil((needBits + 4) / 8);
  return needCodewords <= CAPACITY[version][ecIndex];
}

/** 主函数：字符串 -> 布尔矩阵 */
function encode(text, opts) {
  opts = opts || {};
  const ecName = opts.ecLevel || 'M';
  const ecIndex = EC_LEVEL_INDEX[ecName];
  const bytes = utf8Bytes(text);

  // 选最小的可用版本（注意：必须按"码字数"比较，不能直接比字节数，
  // 否则会选到容量刚好差一点点的版本，生成出来的码字放不进去 —— 这个坑我踩过）
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    if (fitsInVersion(bytes.length, v, ecIndex)) { version = v; break; }
  }
  if (!version) throw new Error('内容太长，超出本生成器支持范围（版本 1~10）');

  const data = buildData(bytes, version, ecIndex);
  if (data.length !== CAPACITY[version][ecIndex]) {
    throw new Error('内部错误：数据码字数 ' + data.length + ' 与容量 ' + CAPACITY[version][ecIndex] + ' 不一致');
  }
  const final = interleave(data, version, ecIndex);
  const bits = [];
  final.forEach((b) => { for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1); });

  const base = createMatrix(version);
  placeData(base, bits);

  // 试 8 种掩码，选惩罚分最低的
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const m = {
      size: base.size,
      modules: base.modules.map((row) => row.slice()),
      reserved: base.reserved
    };
    for (let r = 0; r < m.size; r++) {
      for (let c = 0; c < m.size; c++) {
        if (!base.reserved[r][c] && MASKS[mask](r, c)) m.modules[r][c] ^= 1;
      }
    }
    applyFormatAndVersion(m, version, ecIndex, mask);
    const p = penalty(m);
    if (!best || p < best.p) best = { p, m, mask };
  }
  return { version, size: best.m.size, modules: best.m.modules, mask: best.mask, ecLevel: ecName };
}

/** 输出 SVG 字符串 */
function toSVG(text, opts) {
  opts = opts || {};
  const scale = opts.scale || 8;
  const margin = opts.margin == null ? 4 : opts.margin;
  const dark = opts.dark || '#000000';
  const light = opts.light || '#ffffff';
  const qr = encode(text, opts);
  const total = (qr.size + margin * 2) * scale;
  let path = '';
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (qr.modules[r][c]) {
        const x = (c + margin) * scale;
        const y = (r + margin) * scale;
        path += `M${x} ${y}h${scale}v${scale}h-${scale}z`;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${total}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">`
    + `<rect width="${total}" height="${total}" fill="${light}"/>`
    + `<path d="${path}" fill="${dark}"/>`
    + `</svg>`;
}

module.exports = {
  encode,
  toSVG,
  // 以下导出给自检用（验证码字摆放是否正确）
  __internals: {
    utf8Bytes, buildData, interleave, createMatrix, placeData,
    applyFormatAndVersion, MASKS, rsEncode, formatBits, versionBits,
    QR_PARAMS, CAPACITY, EC_PER_BLOCK, EC_GROUPS, BLOCK_COUNT, TOTAL_CODEWORDS,
    EC_LEVEL_INDEX, EC_BLOCKS, EC_STRUCTURE
  }
};
