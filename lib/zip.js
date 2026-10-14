'use strict';
/**
 * 零依赖 ZIP 打包器（stored 模式，不压缩，够用且绝对不会出错）
 *
 * 为什么自己写：项目要求零依赖，不能引 archiver/jszip；
 * 系统也没装 7z/zip 命令行。而 Netlify 提供"上传一个 ZIP"的部署方式，比逐文件上传稳。
 *
 * ZIP 格式（endian 都是 little-endian）：
 *   本地文件头(30字节 + 名称) + 数据
 *   ...每个文件重复...
 *   中央目录头(46字节 + 名称) + 中央目录结束记录(22字节)
 */

const fs = require('fs');
const path = require('path');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** 收集目录下所有文件，返回 [{rel, full}] */
function collect(dir, relBase, out, skipTop) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = (relBase ? relBase + '/' : '') + name;
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      if (!relBase && skipTop && skipTop.has(name)) continue;
      collect(full, rel, out, skipTop);
    } else {
      if (/\.(tmp|log|bak)$/i.test(name)) continue;
      out.push({ rel, full });
    }
  }
  return out;
}

/**
 * 打包成 ZIP Buffer
 * @param {Array<{rel:string, full:string}>} entries
 */
function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  // MS-DOS 时间戳（不精确也没关系，Netlify 不看）
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;

  for (const e of entries) {
    const data = fs.readFileSync(e.full);
    // 文件名直接用 UTF-8 原始字节 + 置 UTF-8 标志位（0x0800），
    // 绝对不能做 URL 编码 —— 我试过，中文文件名会变成 %E4%BD%BF...，解出来是坏的
    const nameBuf = Buffer.from(e.rel, 'utf8');
    const crc = crc32(data);

    // 本地文件头
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // 签名
    local.writeUInt16LE(20, 4);           // 解压所需版本
    local.writeUInt16LE(0x0800, 6);       // 通用标志：文件名是 UTF-8
    local.writeUInt16LE(0, 8);            // 压缩方法 0 = 不压缩
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // 压缩后大小
    local.writeUInt32LE(data.length, 22); // 原始大小
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);           // 扩展字段长度

    chunks.push(local, nameBuf, data);

    // 中央目录项
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);              // 创建版本
    cd.writeUInt16LE(20, 6);              // 解压所需版本
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);              // 扩展字段
    cd.writeUInt16LE(0, 32);              // 注释
    cd.writeUInt16LE(0, 34);              // 磁盘号
    cd.writeUInt16LE(0, 36);              // 内部属性
    cd.writeUInt32LE(0, 38);              // 外部属性
    cd.writeUInt32LE(offset, 42);         // 本地头偏移
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, end]);
}

module.exports = { makeZip, collect, crc32 };

// 命令行用法：node lib/zip.js <目录> <输出.zip> [跳过目录1,跳过目录2]
if (require.main === module) {
  const [dir, out, skipArg] = process.argv.slice(2);
  if (!dir || !out) {
    console.error('用法：node lib/zip.js <目录> <输出.zip> [跳过目录,用逗号分隔]');
    process.exit(1);
  }
  const skip = new Set((skipArg || '').split(',').filter(Boolean));
  const entries = collect(dir, '', [], skip);
  const buf = makeZip(entries);
  fs.writeFileSync(out, buf);
  console.log('已打包 ' + entries.length + ' 个文件 -> ' + out + '（' + (buf.length / 1024).toFixed(1) + ' KB）');
  entries.forEach((e) => console.log('   ' + e.rel));
}
