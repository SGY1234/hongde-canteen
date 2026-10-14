'use strict';
/**
 * 二维码自检：自己生成的二维码，自己再解一遍，确认能读出来。
 * 不验证就等于没写 —— 二维码生成错了的话，同学扫不出来，是最糟的失败。
 *
 * 运行：node lib/qrcode-verify.js
 */

const assert = require('assert');
const { encode } = require('./qrcode.js');
const INT = require('./qrcode.js').__internals;

/* 参数表直接用编码器里的那一张（唯一数据源），避免两边各写一份又对不上 */
const CAP = INT.CAPACITY;
const EC_BLOCKS = INT.EC_BLOCKS;        // [每块纠错码字数, 块数]
const EC_STRUCTURE = INT.EC_STRUCTURE;  // [[块数, 每块数据码字], ...]
const TOTAL_CW = INT.TOTAL_CODEWORDS;

/* ---------------- GF(256) ---------------- */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function init() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x; LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11D;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
function mul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }
function inv(a) { return EXP[255 - LOG[a]]; }

const CAP_LOCAL_REMOVED = true;   // 参数表已改为引用编码器里的唯一数据源
/* 下面这两个常量保留给解码器的位流读取用（值来自编码器的表） */
const TOTAL_CODEWORDS = TOTAL_CW;

/* ---------------- 多项式工具（纠错用） ---------------- */
/** 卷积相乘（索引 j = x^j，低位是低次项） */
function conv(a, b) {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) out[i + j] ^= mul(a[i], b[j]);
  }
  return out;
}
function trim(p) {
  const out = p.slice();
  while (out.length > 1 && out[out.length - 1] === 0) out.pop();
  return out;
}
function evaluate(p, x) {
  let y = 0;
  for (let i = p.length - 1; i >= 0; i--) y = mul(y, x) ^ p[i];
  return y;
}

/**
 * Reed-Solomon 纠错
 *
 * 用的是 PETSc 教科书里的标准写法：
 *   1. 求校正子 S_i = R(α^i)
 *   2. 直接解线性方程组（Toeplitz）得到误差定位多项式 Λ —— 比 Berlekamp-Massey 好写、不易错
 *   3. Chien 搜索找误差位置
 *   4. Forney 公式求误差值
 *   5. 改完复验，校正子必须全部归零
 *
 * 我在这里踩过两次坑（BM 版算错次数、欧几里得版多项式除法写反），
 * 所以最后选了最"笨"但最不容易错的解法。
 */
function rsCorrect(received, ecCount) {
  const r = received.slice();
  const n = r.length;

  // ---- 1. 校正子 ----
  const synd = new Array(ecCount).fill(0);
  let hasError = false;
  for (let i = 0; i < ecCount; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s = mul(s, EXP[i]) ^ r[j];
    synd[i] = s;
    if (s !== 0) hasError = true;
  }
  if (!hasError) return r.slice(0, n - ecCount);

  // ---- 2. 解线性方程组求 Λ ----
  // Λ(X) = 1 + λ₁X + … + λ_νX^ν，满足 S_{i+ν} + λ₁S_{i+ν-1} + … + λ_νS_i = 0
  let lambda = null;
  for (let nu = 1; nu <= Math.floor(ecCount / 2); nu++) {
    // 构造 nu×nu 方程：Σ_k λ_k · S_{nu+i-1-k} = S_{nu+i-1}（i 从 1 到 nu）
    const M = [];
    const bv = [];
    for (let i = 1; i <= nu; i++) {
      const row = [];
      for (let k = 1; k <= nu; k++) row.push(synd[nu + i - 1 - k]);
      M.push(row);
      bv.push(synd[nu + i - 1]);
    }
    const x = solveLinear(M, bv);
    if (!x) continue;                       // 奇异矩阵 -> 说明真实错误数比 nu 少
    const cand = [1].concat(x);
    // 用剩下的校正子验证这个 Λ 是否成立
    let ok = true;
    for (let i = nu; i < ecCount && ok; i++) {
      let s = 0;
      for (let k = 1; k < cand.length; k++) {
        if (i - k >= 0) s ^= mul(cand[k], synd[i - k]);
      }
      if ((s ^ synd[i]) !== 0) ok = false;
    }
    if (ok) { lambda = cand; break; }
  }
  if (!lambda) throw new Error('纠错失败：解不出误差定位多项式');

  // ---- 3. Chien 搜索 ----
  const positions = [];
  for (let i = 0; i < n; i++) {
    const Xinv = EXP[(255 - ((n - 1 - i) % 255)) % 255];
    if (evaluate(lambda, Xinv) === 0) positions.push(i);
  }
  if (positions.length !== lambda.length - 1) {
    throw new Error('纠错失败：误差位置数不匹配（找到 ' + positions.length
      + '，多项式次数 ' + (lambda.length - 1) + '）');
  }

  // ---- 4. Forney：Ω(X) = [S(X)·Λ(X)] mod X^ecCount ----
  const omega = trim(conv(synd, lambda).slice(0, ecCount));

  for (const pos of positions) {
    const i = (n - 1 - pos) % 255;
    const Xinv = EXP[(255 - i) % 255];
    const num = evaluate(omega, Xinv);
    // Λ 的形式导数（奇次项），再代入 X^-1
    let den = 0;
    for (let j = 1; j < lambda.length; j += 2) den ^= mul(lambda[j], EXP[(j - 1) * i % 255]);
    if (den === 0) throw new Error('纠错失败：Forney 分母为 0');
    const mag = mul(EXP[i], mul(num, inv(den)));
    r[pos] ^= mag;
  }

  // ---- 5. 复验 ----
  for (let i = 0; i < ecCount; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s = mul(s, EXP[i]) ^ r[j];
    if (s !== 0) throw new Error('纠错后仍有残留错误');
  }
  return r.slice(0, n - ecCount);
}

/** 高斯消元求线性方程组（无解/多解返回 null） */
function solveLinear(M, b) {
  const n = b.length;
  const a = M.map((row, i) => row.concat([b[i]]));
  for (let col = 0; col < n; col++) {
    let piv = -1;
    for (let row = col; row < n; row++) if (a[row][col] !== 0) { piv = row; break; }
    if (piv < 0) return null;
    [a[col], a[piv]] = [a[piv], a[col]];
    const invPiv = inv(a[col][col]);
    for (let k = col; k <= n; k++) a[col][k] = mul(a[col][k], invPiv);
    for (let row = 0; row < n; row++) {
      if (row === col || a[row][col] === 0) continue;
      const f = a[row][col];
      for (let k = col; k <= n; k++) a[row][k] ^= mul(f, a[col][k]);
    }
  }
  return a.map((row) => row[n]);
}

/* ---------------- 从矩阵解码 ---------------- */
function decode(matrix) {
  const size = matrix.length;
  const version = (size - 17) / 4;
  if (!Number.isInteger(version) || version < 1 || version > 10) throw new Error('版本识别失败: ' + size);

  const reserved = buildReserved(size, version);

  // 读格式信息 -> 纠错等级 + 掩码
  let fmt = 0;
  for (let i = 0; i <= 5; i++) fmt |= matrix[8][i] << i;
  fmt |= matrix[8][7] << 6;
  fmt |= matrix[8][8] << 7;
  fmt |= matrix[7][8] << 8;
  for (let i = 9; i <= 14; i++) fmt |= matrix[14 - i][8] << i;
  fmt ^= 0x5412;
  const ecBits = (fmt >> 13) & 3;
  const mask = (fmt >> 10) & 7;
  const ecIndex = [1, 0, 3, 2][ecBits];       // 位值 -> L,M,Q,H 索引

  // 反掩码
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
  const m = matrix.map((row) => row.slice());
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!reserved[r][c] && MASKS[mask](r, c)) m[r][c] ^= 1;
    }
  }

  // 按列蛇形读出码字
  const bitStream = [];
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (let k = 0; k < 2; k++) {
        const c = col - k;
        if (reserved[row][c]) continue;
        bitStream.push(m[row][c]);
      }
    }
    upward = !upward;
  }
  const totalData = CAP[version][ecIndex];
  const ecPerBlock = EC_BLOCKS[version][ecIndex][0];
  const structure = EC_STRUCTURE[version][ecIndex];
  const totalCodewords = TOTAL_CW[version];

  const codewords = [];
  for (let i = 0; i + 8 <= bitStream.length && codewords.length < totalCodewords; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bitStream[i + j];
    codewords.push(v);
  }

  // 反交织
  const blocks = [];
  let off = 0;
  structure.forEach(([count, sizeIn]) => {
    for (let i = 0; i < count; i++) {
      blocks.push({ data: new Array(sizeIn), ec: new Array(ecPerBlock) });
    }
  });
  const maxData = Math.max(...structure.map(([, s]) => s));
  let readIdx = 0;
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) {
      if (i < b.data.length) b.data[i] = codewords[readIdx++];
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const b of blocks) b.ec[i] = codewords[readIdx++];
  }

  // 逐块纠错。注意：数据码字是"分块存放"的 —— 第 1 块的全部数据 + 第 2 块的全部数据…
  // （编码时先把每个数据块单独算纠错，再把数据码字按列交织；所以这里恢复时要按块拼回，
  //   千万不能再交织一次，否则字节顺序全错 —— 这个坑我踩过。）
  const dataCodewords = [];
  for (const b of blocks) {
    const full = b.data.concat(b.ec).map((v) => (v == null ? 0 : v));
    const fixed = rsCorrect(full, ecPerBlock);
    fixed.forEach((v) => dataCodewords.push(v));
  }

  // 解析位流
  const bits = [];
  dataCodewords.forEach((b) => { for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1); });
  let p = 0;
  const take = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | bits[p++];
    return v;
  };
  const mode = take(4);
  if (mode !== 4) throw new Error('模式不是字节模式: ' + mode);
  const len = take(version < 10 ? 8 : 16);
  const out = [];
  for (let i = 0; i < len; i++) out.push(take(8));
  return { text: Buffer.from(out).toString('utf8'), version, mask, ecIndex };
}

/** 重建"保留区"地图（与编码器逻辑必须一致） */
function buildReserved(size, version) {
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const markFinder = (r, c) => {
    for (let i = -1; i <= 7; i++) {
      for (let j = -1; j <= 7; j++) {
        const rr = r + i, cc = c + j;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        reserved[rr][cc] = true;
      }
    }
  };
  markFinder(0, 0); markFinder(0, size - 7); markFinder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) { reserved[6][i] = true; reserved[i][6] = true; }
  const ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
  };
  (ALIGN[version] || []).forEach((r) => {
    (ALIGN[version] || []).forEach((c) => {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) return;
      for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) reserved[r + i][c + j] = true;
    });
  });
  for (let i = 0; i < 9; i++) { reserved[8][i] = true; reserved[i][8] = true; }
  for (let i = 0; i < 8; i++) { reserved[8][size - 1 - i] = true; reserved[size - 1 - i][8] = true; }
  reserved[size - 8][8] = true;
  if (version >= 7) {
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) {
      reserved[size - 11 + j][i] = true;
      reserved[i][size - 11 + j] = true;
    }
  }
  return reserved;
}

/* ---------------- 跑测试 ---------------- */
const CASES = [
  'https://hongde-canteen.vercel.app',
  'http://10.39.239.143:5173',
  'http://192.168.1.100:5173',
  'https://鸿德食堂打分.example.com',
  'a',
  'https://example.com/very/long/path/that/needs/a/bigger/qr/version/to/hold/all/of/this/text?ok=1'
];

/* ---------- 第 0 步：先核对版本参数表自洽 ---------- */
// 总码字 = 数据码字 + 每块纠错码字 × 块数
// 这张表最容易写错（我第一版就把版本3-H写成了27，还漏了版本5以上的块数），所以必须逐格核对。
console.log('\n版本参数表自洽核对（版本 1~10 × 纠错等级 L/M/Q/H）');
let tableErrors = 0;
for (let v = 1; v <= 10; v++) {
  const row = [];
  for (let e = 0; e < 4; e++) {
    const dataCw = CAP[v][e];
    const ecPerBlock = EC_BLOCKS[v][e][0];
    const blockCount = EC_BLOCKS[v][e][1];
    const structCount = EC_STRUCTURE[v][e].reduce((a, [n]) => a + n, 0);
    const structData = EC_STRUCTURE[v][e].reduce((a, [n, s]) => a + n * s, 0);
    const okTotal = dataCw + ecPerBlock * blockCount === TOTAL_CW[v];
    const okBlocks = blockCount === structCount;
    const okData = dataCw === structData;
    if (!okTotal || !okBlocks || !okData) {
      row.push(['L', 'M', 'Q', 'H'][e] + '✗(总' + okTotal + '块' + okBlocks + '数据' + okData + ')');
      tableErrors++;
    }
  }
  console.log('  版本 ' + String(v).padStart(2) + '：' + (row.length ? row.join(' ') : '✓ 四个等级全部自洽'));
}
if (tableErrors) {
  console.log('\n❌ 版本参数表有 ' + tableErrors + ' 处错误，必须先修 lib/qrcode.js 的表\n');
  process.exit(1);
}
void CAP_LOCAL_REMOVED;
void INT;

let pass = 0, fail = 0;
console.log('\n二维码自检（生成 -> 解码 -> 比对原文）\n');
for (const text of CASES) {
  try {
    const qr = encode(text, { ecLevel: 'M' });
    const got = decode(qr.modules);
    assert.strictEqual(got.text, text, '解出来的内容不一致');
    console.log('  ✓ 版本 ' + String(qr.version).padStart(2) + ' · 掩码 ' + qr.mask + ' · ' + qr.size + '×' + qr.size + '  「' + (text.length > 42 ? text.slice(0, 42) + '…' : text) + '」');
    pass++;
  } catch (e) {
    console.log('  ✗ 「' + text + '」  ' + e.message);
    fail++;
  }
}

// 四个纠错等级都要能解
console.log('\n四个纠错等级：');
for (const lv of ['L', 'M', 'Q', 'H']) {
  try {
    const text = 'http://10.39.239.143:5173';
    const qr = encode(text, { ecLevel: lv });
    const got = decode(qr.modules);
    assert.strictEqual(got.text, text);
    console.log('  ✓ 等级 ' + lv + '（版本 ' + qr.version + '）');
    pass++;
  } catch (e) {
    console.log('  ✗ 等级 ' + lv + '  ' + e.message);
    fail++;
  }
}

  // 抗污损：故意改坏若干模块（相当于二维码被蹭脏/贴纸遮住一点），纠错应该能救回来。
  // 注意掩码要"先脱再穿"，否则改的是掩码后的图案，等于乱改。
  console.log('\n抗污损（改坏若干模块，纠错应能救回）：');
  for (const [lv, changes] of [['M', 1], ['Q', 2], ['H', 3]]) {
    try {
      const text = 'http://10.39.239.143:5173';
      const qr = encode(text, { ecLevel: lv });
      const size = qr.size;
      const version = qr.version;
      const ecIndex = { L: 0, M: 1, Q: 2, H: 3 }[lv];
      const aw = buildReserved(size, version);
      const mk = [
        (r, c) => (r + c) % 2 === 0,
        (r, c) => r % 2 === 0,
        (r, c) => c % 3 === 0,
        (r, c) => (r + c) % 3 === 0,
        (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
        (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
        (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
        (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
      ][qr.mask];

      const m = qr.modules.map((row) => row.slice());
      // 脱掩码
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) if (!aw[r][c] && mk(r, c)) m[r][c] ^= 1;
      }
      // 在数据区挑 changes 个互不相邻的模块改坏
      let changed = 0;
      for (let r = 3; r < size - 3 && changed < changes; r += 5) {
        for (let c = 3; c < size - 3 && changed < changes; c += 7) {
          if (!aw[r][c]) { m[r][c] ^= 1; changed++; }
        }
      }
      // 重新穿掩码
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) if (!aw[r][c] && mk(r, c)) m[r][c] ^= 1;
      }

      const got = decode(m);
      assert.strictEqual(got.text, text);
      console.log('  ✓ 等级 ' + lv + '（版本 ' + version + '）：改坏 ' + changed + ' 处后仍能正确解出');
      pass++;
    } catch (e) {
      console.log('  ✗ 等级 ' + lv + ' 抗污损失败：' + e.message);
      fail++;
    }
  }

console.log('\n════════════════════════════════════════');
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('════════════════════════════════════════\n');
process.exit(fail ? 1 : 0);
