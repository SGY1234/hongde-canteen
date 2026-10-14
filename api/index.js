/**
 * Vercel / 其它 Serverless 平台的函数入口。
 * 所有 /api/* 请求都会落到这里（见 vercel.json 的 rewrites）。
 * 完整接口说明见 server/local.js 的注释；部署步骤见《使用说明.md》第五节。
 */
module.exports = require('../server/local.js');
