'use strict';
/**
 * 把后端代码打包成"一个自包含的云函数文件"
 *
 * 为什么要这么做：
 *   1. Netlify 的函数签名是 Lambda 风格 (event, context)，不是 Node 的 (req, res)，
 *      所以入口必须自己写适配器（server/local.js 已经导出框架无关的 route()）。
 *   2. Netlify 只打包 netlify/functions/ 目录里的东西，函数依赖上级目录的文件
 *      经常识别不到。全部内联成一个文件最稳。
 *
 * 用法：node scripts/build-function.js
 * 输出：netlify/functions/api.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'netlify', 'functions', 'api.js');

/** 要内联的模块：id -> 源文件 */
const MODULES = [
  { id: 'rankings', file: 'server/rankings.js' },
  { id: 'store', file: 'server/store.js' },
  { id: 'local', file: 'server/local.js' }
];

const parts = [];
for (const m of MODULES) {
  let code = fs.readFileSync(path.join(ROOT, m.file), 'utf8');
  // 把 require('./rankings.js') 之类换成内联的 __require('rankings')
  code = code.replace(/require\(['"]\.\/([a-zA-Z0-9_-]+)\.js['"]\)/g, (_, name) => {
    const known = MODULES.find((x) => x.id === name || path.basename(x.file, '.js') === name);
    return "__require('" + (known ? known.id : name) + "')";
  });
  // 把菜单 JSON 嵌进来：云端目录结构和本地不同，读文件不可靠
  if (code.includes('__HD_EMBEDDED_MENU__')) {
    const menuRaw = fs.readFileSync(path.join(ROOT, 'public', 'data', 'menu.json'), 'utf8');
    code = code.replace("'__HD_EMBEDDED_MENU__'", JSON.stringify(menuRaw));
    console.log('  已内嵌菜单：public/data/menu.json（' + (menuRaw.length / 1024).toFixed(1) + ' KB）');
  }
  parts.push(
    '// ════════ 内联模块：' + m.file + ' ════════\n' +
    '__define(' + JSON.stringify(m.id) + ', function (module, exports, require) {\n' +
    code + '\n});\n'
  );
}

const bundle = `'use strict';
/**
 * 鸿德食堂打分工具 · 云函数（自包含单文件）
 *
 * ⚠️ 这个文件由 scripts/build-function.js 自动生成，不要手改。
 *    改逻辑请改 server/ 下的源文件，然后重新运行：node scripts/build-function.js
 *
 * 内联了三个模块：server/local.js（路由与接口）、server/rankings.js（榜单算法）、
 * server/store.js（存储层：本地文件 / 飞书多维表格）。
 *
 * 环境变量（配在部署平台后台，绝不能写进前端）：
 *   FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_APP_TOKEN / FEISHU_TABLE_ID
 *   配齐则写飞书多维表格；没配则写本地文件（云函数环境不持久，只够看效果）。
 */

/* ---------- 极简模块系统 ---------- */
var __registry = {};
var __cache = {};
function __define(id, factory) { __registry[id] = factory; }
// 自己内联的模块走 __registry；Node 内置模块（fs/path/crypto/os/url）交给原生 require
var __nodeRequire = module.require.bind(module);
function __require(id) {
  if (__registry[id]) {
    if (__cache[id]) return __cache[id].exports;
    var mod = { exports: {} };
    __cache[id] = mod;
    __registry[id](mod, mod.exports, __require);
    return mod.exports;
  }
  return __nodeRequire(id);
}

${parts.join('\n')}

/* ---------- Netlify 函数入口（Lambda 风格） ---------- */
var __app = __require('local');

exports.handler = async function (event, context) {
  try {
    return await __app(event, context);
  } catch (err) {
    console.error('[fatal]', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: '服务器内部错误：' + (err && err.message) })
    };
  }
};
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, bundle, 'utf8');
console.log('已生成自包含云函数：' + OUT);
console.log('  大小：' + (Buffer.byteLength(bundle) / 1024).toFixed(1) + ' KB');
console.log('  内联模块：' + MODULES.map((m) => m.id).join(', '));

try {
  new vm.Script(bundle, { filename: OUT });
  console.log('  语法检查：通过 ✅');
} catch (e) {
  console.error('  语法检查：失败 ❌ ' + e.message);
  process.exit(1);
}

/* ---------- 真正跑一遍，模拟 Netlify 调用 ---------- */
// ⚠️ 强制本地模式：否则自测会连上真实飞书表格并往里面写测试数据
process.env.HD_FORCE_LOCAL = '1';
(async () => {
  try {
    const mod = require(OUT);
    const res = await mod.handler({
      httpMethod: 'GET',
      path: '/api/stats',
      rawUrl: 'https://example.netlify.app/api/stats',
      headers: { 'x-forwarded-for': '127.0.0.1' },
      body: null,
      isBase64Encoded: false
    }, {});
    console.log('  函数自测：HTTP ' + res.statusCode + '  ' + String(res.body).slice(0, 120));
    if (res.statusCode !== 200) process.exit(1);
    console.log('  ✅ 云函数可用\n');
  } catch (e) {
    console.error('  函数自测失败 ❌ ' + e.message);
    process.exit(1);
  }
})();
