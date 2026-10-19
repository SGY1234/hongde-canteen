'use strict';
/** 一次性修复：去掉 package.json 可能存在的 BOM（PowerShell 写文件时容易带上） */
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'package.json');
let s = fs.readFileSync(p, 'utf8');
const hadBom = s.charCodeAt(0) === 0xFEFF;
if (hadBom) s = s.slice(1);
const obj = JSON.parse(s);
fs.writeFileSync(p, s, 'utf8');
console.log('package.json ' + (hadBom ? '已去掉 BOM' : '本来就没有 BOM'));
console.log('  依赖数：' + (Object.keys(obj.dependencies || {}).length + Object.keys(obj.devDependencies || {}).length));
console.log('  首字节：0x' + fs.readFileSync(p)[0].toString(16));
