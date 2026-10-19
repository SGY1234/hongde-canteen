'use strict';
/** 把二维码模块矩阵导出成 JSON（给 Python 画预览图用） */
const fs = require('fs');
const path = require('path');
const qr = require('../lib/qrcode.js');

const url = process.argv[2] || 'http://10.39.239.143:5173';
const out = process.argv[3] || path.join(__dirname, '..', 'qr', 'matrix.json');
const q = qr.encode(url, { ecLevel: 'M' });
fs.writeFileSync(out, JSON.stringify({
  url, size: q.size, version: q.version, mask: q.mask, ecLevel: q.ecLevel, modules: q.modules
}), 'utf8');
console.log('已导出 ' + out + '（' + q.size + '×' + q.size + '，版本 ' + q.version + '）');
