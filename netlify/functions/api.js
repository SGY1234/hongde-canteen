'use strict';
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

// ════════ 内联模块：server/rankings.js ════════
__define("rankings", function (module, exports, require) {
'use strict';
/**
 * 榜单算法 —— 纯函数，不碰文件/网络，方便自动测试
 * 规则严格按需求文档：
 *   1. 单菜品评分      = 累计总分 / 打分人数        （打分人数 >= 5 才进榜）
 *   2. 单食堂档口榜    = 档口下所有进榜菜品的平均分再取平均
 *   3. 主校区食堂榜    = 食堂下所有进榜档口的平均分再取平均
 *   4. 全校总榜        = 所有进榜菜品混排 Top20
 *
 * 排序并列时的处理：均分 → 打分人数 → 菜名，保证结果稳定可复现。
 */

const MIN_VOTES = 5;          // 至少 5 个人打分才进入榜单
const BAYES_M = 5;            // 贝叶斯平滑强度（仅用于"综合推荐分"展示）
const BAYES_PRIOR = 4.0;      // 平滑先验分

function round1(n) {
  return Math.round(n * 10) / 10;
}

/** 综合推荐分：把 5 人门槛做成平滑先验，避免"1 个人打 5 星就压过 100 人打 4.8 星" */
function bayesScore(sum, votes) {
  return round1((sum + BAYES_M * BAYES_PRIOR) / (votes + BAYES_M));
}

function rawAverage(sum, votes) {
  return votes > 0 ? round1(sum / votes) : null;
}

/** 把一条记录补全成带名字、均分、价格的对象 */
function decorate(record, ctx) {
  const votes = Number(record.votes) || 0;
  const sum = Number(record.sum) || 0;
  const meta = (ctx.metaOf && ctx.metaOf(record.dishId)) || {};
  const stallMeta = (ctx.stallMetaOf && ctx.stallMetaOf(record.stallId)) || {};
  return {
    dishId: record.dishId,
    dishName: record.dishName || (ctx.dishNameOf ? ctx.dishNameOf(record.dishId) : '') || record.dishName,
    price: meta.price != null ? meta.price : null,
    unit: meta.unit || '元',
    stallId: record.stallId,
    stallName: (ctx.stallNameOf && ctx.stallNameOf(record.stallId)) || record.stallName || '',
    stallCode: stallMeta.code || '',
    canteenId: record.canteenId,
    canteenName: (ctx.canteenNameOf && ctx.canteenNameOf(record.canteenId)) || record.canteenName || '',
    sum: sum,
    votes: votes,
    average: rawAverage(sum, votes),
    bayes: bayesScore(sum, votes),
    qualified: votes >= MIN_VOTES
  };
}

function byScoreDesc(a, b) {
  if (b.average !== a.average) return b.average - a.average;
  if (b.votes !== a.votes) return b.votes - a.votes;
  return String(a.dishName).localeCompare(String(b.dishName), 'zh-Hans-CN');
}

function mean(values) {
  if (!values.length) return null;
  let s = 0;
  for (const v of values) s += v;
  return round1(s / values.length);
}

/**
 * 主入口
 * @param {Array} records 打分聚合记录 [{dishId,stallId,canteenId,dishName,sum,votes}]
 * @param {object} ctx     名称解析上下文 {stallNameOf, canteenNameOf, dishNameOf}
 * @returns {{dishes:Array, stalls:Array, canteens:Array, minVotes:number}}
 */
function computeBoards(records, ctx = {}) {
  const all = records.map((r) => decorate(r, ctx));
  const qualified = all.filter((d) => d.qualified).sort(byScoreDesc);

  /* ---- 档口聚合 ---- */
  const stallMap = new Map();
  for (const d of qualified) {
    if (!stallMap.has(d.stallId)) {
      stallMap.set(d.stallId, {
        stallId: d.stallId,
        stallName: d.stallName,
        stallCode: d.stallCode || '',
        canteenId: d.canteenId,
        canteenName: d.canteenName,
        dishes: [],
        votes: 0
      });
    }
    const s = stallMap.get(d.stallId);
    s.dishes.push(d);
    s.votes += d.votes;
  }
  const stalls = [...stallMap.values()].map((s) => {
    s.dishes.sort(byScoreDesc);
    s.qualifiedDishes = s.dishes.length;
    s.average = mean(s.dishes.map((d) => d.average));   // 档口 = 自家菜品平均分再平均
    return s;
  }).sort((a, b) => (b.average - a.average) || (b.votes - a.votes)
    || String(a.stallName).localeCompare(String(b.stallName), 'zh-Hans-CN'));

  /* ---- 食堂聚合 ---- */
  const canteenMap = new Map();
  for (const s of stalls) {
    if (!canteenMap.has(s.canteenId)) {
      canteenMap.set(s.canteenId, {
        canteenId: s.canteenId,
        canteenName: s.canteenName,
        stalls: [],
        votes: 0
      });
    }
    const c = canteenMap.get(s.canteenId);
    c.stalls.push(s);
    c.votes += s.votes;
  }
  const canteens = [...canteenMap.values()].map((c) => {
    c.stallCount = c.stalls.length;
    c.average = mean(c.stalls.map((s) => s.average));   // 食堂 = 所有档口平均分再平均
    c.dishes = c.stalls.reduce((acc, s) => acc.concat(s.dishes), []).sort(byScoreDesc).slice(0, 10);
    return c;
  }).sort((a, b) => (b.average - a.average) || (b.votes - a.votes)
    || String(a.canteenName).localeCompare(String(b.canteenName), 'zh-Hans-CN'));

  return { dishes: qualified, stalls, canteens, minVotes: MIN_VOTES };
}

/** 单食堂页面数据 */
function canteenBoard(records, ctx, canteenId, canteenName) {
  const boards = computeBoards(records, ctx);
  const stalls = boards.stalls.filter((s) => s.canteenId === canteenId);
  const canteen = boards.canteens.find((c) => c.canteenId === canteenId);
  // 该食堂里"还没凑够5人"的菜品，给个提示，激励投票
  const pending = records
    .map((r) => decorate(r, ctx))
    .filter((d) => d.canteenId === canteenId && !d.qualified)
    .sort((a, b) => b.votes - a.votes);

  return {
    canteenId,
    canteenName: canteenName || (canteen && canteen.canteenName) || '',
    canteenAverage: canteen ? canteen.average : null,
    stalls,
    pending: pending.slice(0, 8),
    minVotes: MIN_VOTES
  };
}

/** 全校总榜数据 */
function allBoard(records, ctx, limit = 20) {
  const boards = computeBoards(records, ctx);
  return {
    campusName: ctx.campusName || '主校区',
    dishes: boards.dishes.slice(0, limit),
    canteens: boards.canteens,
    minVotes: MIN_VOTES,
    totalQualified: boards.dishes.length
  };
}

module.exports = {
  MIN_VOTES,
  BAYES_M,
  BAYES_PRIOR,
  round1,
  rawAverage,
  bayesScore,
  computeBoards,
  canteenBoard,
  allBoard
};

});

// ════════ 内联模块：server/store.js ════════
__define("store", function (module, exports, require) {
'use strict';
/**
 * 数据存储层 —— 两种后端，同一套接口
 *   FileStore   : 本地/测试用，数据落在 data/ratings.json（原子写 + 串行队列，绝不丢数据）
 *   FeishuStore : 线上用，对接飞书多维表格（严格按需求文档的 7 个字段）
 *
 * 统一接口：
 *   list()             -> [{dishId,stallId,canteenId,dishName,stallName,canteenName,sum,votes}]
 *   applyRating(input) -> {record, isNew}
 *
 * 为什么要串行队列：需求文档的表结构是"一条菜品一行"的聚合表，
 * 「读出来 → 加上本次分数 → 写回去」这个动作如果并发执行会互相覆盖，所以全部排队。
 */

const fs = require('fs');
const path = require('path');

/* ============================ 本地文件存储 ============================ */
class FileStore {
  /**
   * @param {string|object} fileOrOpts
   *   string  -> 数据文件路径（简单用法）
   *   object  -> { file, detailsFile, fallbackFile }
   *     fallbackFile: 真实数据还不存在时用来展示的演示数据（只读）。
   *                   一旦有任何一条真实打分，就自动切回真实数据，演示数据不再出现。
   */
  constructor(fileOrOpts) {
    const opts = typeof fileOrOpts === 'string' ? { file: fileOrOpts } : (fileOrOpts || {});
    this.file = opts.file;
    this.detailsFile = opts.detailsFile || path.join(path.dirname(opts.file), 'details.json');
    this.fallbackFile = opts.fallbackFile || null;
    this.queue = Promise.resolve();   // 串行队列
    this._usedFallback = false;       // 本次读取是否用了演示数据
  }

  /**
   * 读取原始数据；真实文件不存在时回落到演示数据。
   * 注意：用演示数据时只会「读」，不会把它写进真实文件 ——
   * 第一条真实打分写入时，演示数据整体退场，真实榜单从零开始，
   * 这样同学看到的分数永远是真的，不会混进假分数。
   */
  _read() {
    const empty = { records: {} };
    this._usedFallback = false;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data && data.records) return data;
    } catch (e) { /* 文件不存在或损坏，继续往下试 */ }
    if (this.fallbackFile) {
      try {
        const demo = JSON.parse(fs.readFileSync(this.fallbackFile, 'utf8'));
        if (demo && demo.records && Object.keys(demo.records).length) {
          this._usedFallback = true;
          return demo;
        }
      } catch (e) { /* 没有演示数据也正常 */ }
    }
    return empty;
  }

  /** 是否正在展示演示数据（供接口/页面提示用） */
  isShowingDemo() {
    if (fs.existsSync(this.file)) return false;
    if (!this.fallbackFile || !fs.existsSync(this.fallbackFile)) return false;
    try {
      const demo = JSON.parse(fs.readFileSync(this.fallbackFile, 'utf8'));
      return !!(demo && demo.records && Object.keys(demo.records).length);
    } catch (e) {
      return false;
    }
  }

  _write(data) {
    const dir = path.dirname(this.file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = this.file + '.tmp' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);      // 原子替换，断电不会写出半个坏 JSON
  }

  _serial(task) {
    const run = this.queue.then(() => task());
    this.queue = run.catch(() => {});   // 单次失败不阻塞后续排队
    return run;
  }

  list() {
    return this._serial(() => Object.values(this._read().records || {}));
  }

  applyRating(input) {
    return this._serial(() => {
      const data = this._read();
      const wasDemo = this._usedFallback;
      // 演示数据不参与真实计分：第一条真实打分让演示数据整体退场
      if (wasDemo) data.records = {};
      data.records = data.records || {};
      const existing = data.records[input.dishId];
      const isNew = !existing;
      const rec = existing || {
        dishId: input.dishId,
        stallId: input.stallId,
        canteenId: input.canteenId,
        dishName: input.dishName,
        stallName: input.stallName,
        canteenName: input.canteenName,
        sum: 0,
        votes: 0
      };
      rec.sum = Number(rec.sum || 0) + input.score;
      rec.votes = Number(rec.votes || 0) + 1;
      rec.dishName = input.dishName || rec.dishName;
      rec.stallName = input.stallName || rec.stallName;
      rec.canteenName = input.canteenName || rec.canteenName;
      data.records[input.dishId] = rec;
      this._write(data);
      return { record: rec, isNew, demoDiscarded: wasDemo };
    });
  }

  /** 每条打分的明细留档（独立文件，不污染 7 字段主表） */
  appendDetail(detail) {
    return this._serial(() => {
      const f = this.detailsFile;
      let list = [];
      try {
        list = JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch (e) { list = []; }
      if (!Array.isArray(list)) list = [];
      list.push(detail);
      if (list.length > 5000) list = list.slice(-5000);
      if (!fs.existsSync(path.dirname(f))) fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(list), 'utf8');
      return detail;
    });
  }
}

/* ============================ 飞书多维表格存储 ============================ */
/**
 * 需要的环境变量（配在云函数后台，永远不要写进前端代码）：
 *   FEISHU_APP_ID        应用 App ID
 *   FEISHU_APP_SECRET    应用 App Secret
 *   FEISHU_APP_TOKEN     多维表格 app_token（表格 URL 里 /base/xxxxx 那段）
 *   FEISHU_TABLE_ID      数据表 table_id（URL 里 ?table=tblxxxx 那段）
 */
class FeishuStore {
  constructor(cfg) {
    this.cfg = cfg;
    this.base = 'https://open.feishu.cn/open-apis';
    this._token = null;
    this._tokenExpire = 0;
    this.queue = Promise.resolve();
  }

  _serial(task) {
    const run = this.queue.then(() => task());
    this.queue = run.catch(() => {});
    return run;
  }

  async _tenantToken() {
    const now = Date.now();
    if (this._token && now < this._tokenExpire) return this._token;
    const res = await fetch(this.base + '/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.cfg.appId, app_secret: this.cfg.appSecret })
    });
    const json = await res.json();
    if (json.code !== 0) {
      throw new Error('飞书鉴权失败: ' + json.msg + '（请检查 App ID / App Secret 是否填对）');
    }
    this._token = json.tenant_access_token;
    this._tokenExpire = now + (json.expire - 120) * 1000;
    return this._token;
  }

  async _req(method, url, body) {
    const token = await this._tenantToken();
    const res = await fetch(this.base + url, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: body ? JSON.stringify(body) : undefined
    });
    const json = await res.json();
    if (json.code !== 0) {
      const err = new Error('飞书接口错误: ' + json.msg + ' (code ' + json.code + ')');
      err.feishu = json;
      throw err;
    }
    return json.data;
  }

  _tablePath() {
    return '/bitable/v1/apps/' + this.cfg.appToken + '/tables/' + this.cfg.tableId;
  }

  /** 拉全表（自动翻页） */
  list() {
    return this._serial(async () => {
      const out = [];
      let pageToken = '';
      for (let i = 0; i < 50; i++) {          // 最多 50 页 ≈ 25000 行，够用
        const q = '?page_size=500' + (pageToken ? '&page_token=' + encodeURIComponent(pageToken) : '');
        const data = await this._req('GET', this._tablePath() + '/records' + q);
        for (const item of data.items || []) out.push(this._fromFeishu(item));
        if (!data.has_more) break;
        pageToken = data.page_token;
      }
      return out;
    });
  }

  /** 飞书记录 -> 统一格式 */
  _fromFeishu(item) {
    const f = item.fields || {};
    const txt = (v) => {
      if (v == null) return '';
      if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : (x && x.text) || '')).join('');
      if (typeof v === 'object') return v.text || v.name || '';
      return String(v);
    };
    const num = (v) => {
      if (v == null) return 0;
      if (Array.isArray(v)) return Number((v[0] && v[0].text) || 0) || 0;
      return Number(v) || 0;
    };
    const dishName = txt(f['菜品名称']);
    const stallName = txt(f['所属档口']);
    // 7 字段结构里没有 dishId（靠 档口+菜名 也能跑）。
    // 如果表里额外加了「菜品ID」这一列（推荐），就优先用它匹配菜单，联动更稳。
    const storedId = txt(f['菜品ID']);
    return {
      recordId: item.record_id,
      dishId: storedId || makeKey(stallName, dishName),
      dishName: dishName,
      stallName: stallName,
      canteenName: txt(f['所属食堂']),
      campusName: txt(f['所属校区']),
      sum: num(f['累计总分']),
      votes: num(f['打分人数'])
    };
  }

  /** 查到就累加，查不到就新建（全程串行） */
  applyRating(input) {
    return this._serial(async () => {
      const path0 = this._tablePath() + '/records';
      const token = await this._tenantToken();
      const res = await fetch(this.base + path0 + '/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({
          filter: {
            conjunction: 'and',
            conditions: [
              { field_name: '菜品名称', operator: 'is', value: [input.dishName] },
              { field_name: '所属档口', operator: 'is', value: [input.stallName] }
            ]
          },
          automatic_fields: false
        })
      });
      const sr = await res.json();
      // 1254005 = 没有匹配数据，属于正常情况
      if (sr.code !== 0 && sr.code !== 1254005) {
        const e = new Error('飞书查询失败: ' + sr.msg + ' (code ' + sr.code + ')');
        e.feishu = sr;
        throw e;
      }
      const items = (sr.data && sr.data.items) || [];

      if (!items.length) {
        const fields = {
          '所属校区': input.campusName || '主校区',
          '所属食堂': input.canteenName,
          '所属档口': input.stallName,
          '菜品名称': input.dishName,
          '累计总分': input.score,
          '打分人数': 1
        };
        if (this.cfg.hasDishIdField) fields['菜品ID'] = input.dishId;
        const created = await this._req('POST', path0, { fields });
        const rec = created && created.record;
        return {
          isNew: true,
          record: {
            recordId: rec && rec.record_id,
            dishId: makeKey(input.stallName, input.dishName),
            dishName: input.dishName,
            stallName: input.stallName,
            canteenName: input.canteenName,
            sum: input.score,
            votes: 1
          }
        };
      }

      const item = items[0];
      const cur = this._fromFeishu(item);
      const nextSum = cur.sum + input.score;
      const nextVotes = cur.votes + 1;
      await this._req('PUT', path0 + '/' + item.record_id, {
        fields: { '累计总分': nextSum, '打分人数': nextVotes }
      });
      return {
        isNew: false,
        record: {
          recordId: item.record_id,
          dishId: cur.dishId,
          dishName: cur.dishName,
          stallName: cur.stallName,
          canteenName: cur.canteenName,
          sum: nextSum,
          votes: nextVotes
        }
      };
    });
  }
}

/** 飞书表里没存 dishId，用 档口+菜名 造一个稳定 key，用于跨记录合并 */
function makeKey(stallName, dishName) {
  return String(stallName || '').trim() + '||' + String(dishName || '').trim();
}

module.exports = { FileStore, FeishuStore, makeKey };

});

// ════════ 内联模块：server/local.js ════════
__define("local", function (module, exports, require) {
'use strict';
/**
 * 鸿德食堂打分工具 —— 后端（零依赖）
 *
 * 两个身份，同一份代码：
 *   1) 本地开发/测试服务器：  node server/local.js        （含静态文件服务，手机同 WiFi 可直连）
 *   2) 线上 Serverless 函数： 被部署平台 require 后调用 handleRequest()
 *
 * 数据源自动切换：
 *   配了 FEISHU_APP_ID 等 4 个环境变量 -> 用飞书多维表格
 *   没配                              -> 用本地 data/ratings.json（零配置就能跑）
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const os = require('os');

const rankings = __require('rankings');
const stores = __require('store');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.HD_DATA_DIR ? path.resolve(process.env.HD_DATA_DIR) : path.join(ROOT, 'data');

/* ============================ 读本地配置文件 ============================ */
/**
 * 支持用 .env.feishu 文件配密钥（就不用在命令行里设一堆环境变量了）。
 *
 * 查找顺序（找到第一个就用）：
 *   ./.env.feishu        （项目根目录）
 *   ../.env.feishu       （打包进云函数目录时）
 *   ./.env               （通用写法）
 * 已经存在的环境变量优先，配置文件不覆盖它 —— 这样线上（平台后台配环境变量）
 * 和本地（配置文件）两种方式都能用。
 *
 * ⚠️ 安全开关：设了 HD_FORCE_LOCAL=1 就完全不读这些文件、强制用本地文件存储。
 *    这是给自动化测试用的 —— 否则测试会写进真实的飞书表格（这个坑我踩过）。
 */
function loadEnvFiles() {
  if (process.env.HD_FORCE_LOCAL === '1') return null;
  const candidates = [
    path.join(ROOT, '.env.feishu'),
    path.join(__dirname, '..', '.env.feishu'),
    path.join(__dirname, '.env.feishu'),
    path.join(process.cwd(), '.env.feishu'),
    path.join(ROOT, '.env'),
    path.join(process.cwd(), '.env')
  ];
  for (const file of candidates) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      let n = 0;
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!m) continue;
        const key = m[1];
        const val = m[2].replace(/^["']|["']$/g, '');
        if (process.env[key] === undefined) {   // 环境变量优先
          process.env[key] = val;
          n++;
        }
      }
      return { file, count: n };
    } catch (e) { /* 这个文件不存在，试下一个 */ }
  }
  return null;
}

const ENV_FILE = loadEnvFiles();

/* ============================ 数据源装配 ============================ */
const FEISHU_CFG = {
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  appToken: process.env.FEISHU_APP_TOKEN,
  tableId: process.env.FEISHU_TABLE_ID,
  // 表里额外加了「菜品ID」列就设成 1，联动更精确（见落地方案附录）
  hasDishIdField: process.env.FEISHU_HAS_DISH_ID === '1'
};

const USE_FEISHU = !!(FEISHU_CFG.appId && FEISHU_CFG.appSecret && FEISHU_CFG.appToken && FEISHU_CFG.tableId);

/** 是否真的在用飞书（启动时探测失败会自动关掉，见 probeFeishu） */
let FEISHU_OK = USE_FEISHU;
/** 降级原因（降级时写一行说明，供启动日志和页面提示用） */
let DEGRADE_REASON = '';
/**
 * 本次启动是否"配了飞书"（即正式上线场景）。
 * 用途：正式上线时若飞书被风控降级，**绝不能展示演示数据**，
 * 否则同学会把 599 票假分数当成真的；而开发者本地不配飞书测试时，
 * 演示数据是有用的（第一次打开就能看懂榜单长什么样）。
 */
let FEISHU_CONFIGURED_AT_BOOT = USE_FEISHU;

/** 本地文件存储（飞书不可用时的兜底，数据不会丢，只是没进飞书表） */
function makeFileStore() {
  const noDemo = process.env.HD_NO_DEMO === '1' || FEISHU_CONFIGURED_AT_BOOT;
  return new stores.FileStore({
    file: path.join(DATA_DIR, 'ratings.json'),
    detailsFile: path.join(DATA_DIR, 'details.json'),
    // 演示数据只在"没配飞书"的开发场景用；正式上线一律不展示
    fallbackFile: noDemo ? null : path.join(ROOT, 'demo', 'ratings.demo.json')
  });
}

let store = USE_FEISHU ? new stores.FeishuStore(FEISHU_CFG) : makeFileStore();

/**
 * 启动时探测飞书是否可用。
 * 为什么需要：飞书会偶发风控（例如 `21001 Access denied by access control policy`），
 * 一旦鉴权失败，所有读接口都会 500 —— **整个网站等于打不开**。
 * 这里的策略是：探测一次，失败就降级用本地文件，网站照常开门，
 * 并明确告诉用户"现在数据存在本机"，而不是让页面报错。
 */
async function probeFeishu() {
  if (!USE_FEISHU) return { ok: false, reason: '飞书 4 个配置值没配齐' };
  try {
    await Promise.race([
      store.list(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('飞书连接超时（15 秒）')), 15000))
    ]);
    return { ok: true, reason: '' };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e).split('\n')[0] };
  }
}

/* ============================ 菜单 ============================ */
/**
 * 菜单的候选路径。
 * 云函数环境的目录结构和本地不同，所以多试几个位置；
 * 如果全都没有，就用构建时嵌进来的那份（见 scripts/build-function.js）。
 */
function menuCandidates() {
  return [
    path.join(PUBLIC_DIR, 'data', 'menu.json'),                    // 本地开发
    path.join(__dirname, 'public', 'data', 'menu.json'),           // 打包进函数目录时
    path.join(__dirname, '..', 'public', 'data', 'menu.json'),
    path.join(process.cwd(), 'public', 'data', 'menu.json'),
    path.join(process.cwd(), 'data', 'menu.json')
  ];
}

function loadMenu() {
  for (const p of menuCandidates()) {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const menu = JSON.parse(raw);
      if (menu && menu.canteens) {
        menu.stalls = menu.stalls || [];
        menu.dishes = menu.dishes || [];
        return menu;
      }
    } catch (e) { /* 这个路径没有，试下一个 */ }
  }
  // 兜底：构建云函数时嵌进来的菜单内容（保证云端一定能读）
  if (typeof EMBEDDED_MENU_JSON === 'string' && EMBEDDED_MENU_JSON.length > 10) {
    const menu = JSON.parse(EMBEDDED_MENU_JSON);
    menu.stalls = menu.stalls || [];
    menu.dishes = menu.dishes || [];
    return menu;
  }
  throw new Error('读不到菜单文件，也找不到内嵌菜单。请检查 public/data/menu.json 是否存在。');
}

/** 由 scripts/build-function.js 在打包时替换成内嵌的菜单 JSON 字符串 */
const EMBEDDED_MENU_JSON = "{\n  \"_说明\": \"这是菜单数据源，你只需要改这个文件。改完刷新页面即可生效，不用重新部署。\",\n  \"_结构说明\": [\n    \"canteens 是食堂/店；每个 canteen 有一个 stallMode 标记它内部怎么卖：\",\n    \"  stallMode = single-menu  → 就一个菜单（页面自动跳过「选窗口」，同学少点一次）\",\n    \"  stallMode = multi-stall  → 里面有好几个窗口（页面让同学先选窗口）\",\n    \"stalls 是窗口；dishes 是菜品，用 stallId 挂到窗口上\",\n    \"stall 的 code 字段 = 现场挂的红圈窗口号（如 14号窗口），展示用\"\n  ],\n  \"_数据来源\": \"小张餐厅二楼实拍菜单照片（2026-10-14 晚上），逆时针从东北角起共 14 家。价格按照片录入，可随时修改。\",\n  \"_校对提示\": \"小张餐厅二楼 12 个窗口（290 道菜）+ 金冠 15 家店（192 道菜）已按实拍照片逐条录入并核对。民族餐厅、昕辉、汤姆大叔的菜名和价格还是待拍状态。\",\n  \"campuses\": [\n    {\n      \"id\": \"main\",\n      \"name\": \"鸿德主校区\",\n      \"active\": true\n    },\n    {\n      \"id\": \"east\",\n      \"name\": \"东校区\",\n      \"active\": false\n    }\n  ],\n  \"canteens\": [\n    {\n      \"id\": \"c1\",\n      \"campusId\": \"main\",\n      \"name\": \"金冠\",\n      \"stallMode\": \"multi-stall\"\n    },\n    {\n      \"id\": \"c2\",\n      \"campusId\": \"main\",\n      \"name\": \"小张餐厅二楼\",\n      \"stallMode\": \"multi-stall\"\n    },\n    {\n      \"id\": \"c3\",\n      \"campusId\": \"main\",\n      \"name\": \"民族餐厅\",\n      \"stallMode\": \"multi-stall\"\n    },\n    {\n      \"id\": \"c4\",\n      \"campusId\": \"main\",\n      \"name\": \"昕辉\",\n      \"stallMode\": \"single-menu\"\n    },\n    {\n      \"id\": \"c5\",\n      \"campusId\": \"main\",\n      \"name\": \"汤姆大叔\",\n      \"stallMode\": \"single-menu\"\n    }\n  ],\n  \"stalls\": [\n    {\n      \"id\": \"c2s1\",\n      \"canteenId\": \"c2\",\n      \"name\": \"花甲粉 · 螺蛳粉\",\n      \"code\": \"14号窗口\"\n    },\n    {\n      \"id\": \"c2s2\",\n      \"canteenId\": \"c2\",\n      \"name\": \"手工鲜肉小笼包\",\n      \"code\": \"13号窗口\"\n    },\n    {\n      \"id\": \"c2s3\",\n      \"canteenId\": \"c2\",\n      \"name\": \"小马哥焖肉饭\"\n    },\n    {\n      \"id\": \"c2s4\",\n      \"canteenId\": \"c2\",\n      \"name\": \"小爆炒荔枝鸡\",\n      \"code\": \"2号窗口\"\n    },\n    {\n      \"id\": \"c2s5\",\n      \"canteenId\": \"c2\",\n      \"name\": \"品味韩餐\",\n      \"code\": \"3号窗口\"\n    },\n    {\n      \"id\": \"c2s6\",\n      \"canteenId\": \"c2\",\n      \"name\": \"SAK 烤鸭饭 · 猪肘饭\",\n      \"code\": \"4号窗口\"\n    },\n    {\n      \"id\": \"c2s7\",\n      \"canteenId\": \"c2\",\n      \"name\": \"抖喜新疆炒米粉\",\n      \"code\": \"7号窗口\"\n    },\n    {\n      \"id\": \"c2s8\",\n      \"canteenId\": \"c2\",\n      \"name\": \"高师傅面食\",\n      \"code\": \"8号窗口\"\n    },\n    {\n      \"id\": \"c2s9\",\n      \"canteenId\": \"c2\",\n      \"name\": \"米线肉夹馍\",\n      \"code\": \"9号窗口\"\n    },\n    {\n      \"id\": \"c2s10\",\n      \"canteenId\": \"c2\",\n      \"name\": \"水吧（鲜饮小站）\",\n      \"code\": \"10号窗口\"\n    },\n    {\n      \"id\": \"c2s11\",\n      \"canteenId\": \"c2\",\n      \"name\": \"川渝自选菜\"\n    },\n    {\n      \"id\": \"c2s12\",\n      \"canteenId\": \"c2\",\n      \"name\": \"食味轩特色饭\",\n      \"code\": \"12号窗口\",\n      \"note\": \"老武汉黑鸭煲 / 香约脆皮鸡饭 / 土豆泥煎肉饭 三块招牌其实是同一家，已合并\"\n    },\n    {\n      \"id\": \"c3s1\",\n      \"canteenId\": \"c3\",\n      \"name\": \"兰州拉面窗口\"\n    },\n    {\n      \"id\": \"c3s2\",\n      \"canteenId\": \"c3\",\n      \"name\": \"新疆炒饭 · 烤肉窗口\"\n    },\n    {\n      \"id\": \"c3s3\",\n      \"canteenId\": \"c3\",\n      \"name\": \"清真快餐窗口\"\n    },\n    {\n      \"id\": \"c4s1\",\n      \"canteenId\": \"c4\",\n      \"name\": \"昕辉\"\n    },\n    {\n      \"id\": \"c5s1\",\n      \"canteenId\": \"c5\",\n      \"name\": \"汤姆大叔\"\n    },\n    {\n      \"id\": \"c1s1\",\n      \"canteenId\": \"c1\",\n      \"name\": \"鸡架拌面\"\n    },\n    {\n      \"id\": \"c1s2\",\n      \"canteenId\": \"c1\",\n      \"name\": \"荔枝鸡 特色米饭\"\n    },\n    {\n      \"id\": \"c1s3\",\n      \"canteenId\": \"c1\",\n      \"name\": \"江西南昌瓦罐煨汤 · 铁板炒饭\"\n    },\n    {\n      \"id\": \"c1s4\",\n      \"canteenId\": \"c1\",\n      \"name\": \"现炒盖饭\"\n    },\n    {\n      \"id\": \"c1s5\",\n      \"canteenId\": \"c1\",\n      \"name\": \"现包蒸饺\"\n    },\n    {\n      \"id\": \"c1s6\",\n      \"canteenId\": \"c1\",\n      \"name\": \"小爆炒同学\"\n    },\n    {\n      \"id\": \"c1s7\",\n      \"canteenId\": \"c1\",\n      \"name\": \"爆炒浇头面\"\n    },\n    {\n      \"id\": \"c1s8\",\n      \"canteenId\": \"c1\",\n      \"name\": \"牛肉汤烧饼\"\n    },\n    {\n      \"id\": \"c1s9\",\n      \"canteenId\": \"c1\",\n      \"name\": \"航语佳烤盘饭\"\n    },\n    {\n      \"id\": \"c1s10\",\n      \"canteenId\": \"c1\",\n      \"name\": \"爆二爷 把子肉热卤饭\"\n    },\n    {\n      \"id\": \"c1s11\",\n      \"canteenId\": \"c1\",\n      \"name\": \"付佳佳麻辣烫\"\n    },\n    {\n      \"id\": \"c1s12\",\n      \"canteenId\": \"c1\",\n      \"name\": \"马家胡同 小锅焖炖面\"\n    },\n    {\n      \"id\": \"c1s13\",\n      \"canteenId\": \"c1\",\n      \"name\": \"富荘閤 烤鸭拌饭\"\n    },\n    {\n      \"id\": \"c1s14\",\n      \"canteenId\": \"c1\",\n      \"name\": \"小馋猫私房面\"\n    },\n    {\n      \"id\": \"c1s15\",\n      \"canteenId\": \"c1\",\n      \"name\": \"紫糯饭团\"\n    }\n  ],\n  \"dishes\": [\n    {\n      \"id\": \"d100\",\n      \"stallId\": \"c2s1\",\n      \"name\": \"招牌花甲粉\",\n      \"price\": 13.9\n    },\n    {\n      \"id\": \"d101\",\n      \"stallId\": \"c2s1\",\n      \"name\": \"鲜花甲粉\",\n      \"price\": 19.9\n    },\n    {\n      \"id\": \"d102\",\n      \"stallId\": \"c2s1\",\n      \"name\": \"金汤花甲粉\",\n      \"price\": 18.9\n    },\n    {\n      \"id\": \"d103\",\n      \"stallId\": \"c2s1\",\n      \"name\": \"藤椒花甲粉\",\n      \"price\": 17.9\n    },\n    {\n      \"id\": \"d104\",\n      \"stallId\": \"c2s1\",\n      \"name\": \"黏糊麻酱螺蛳粉\",\n      \"price\": 16.9\n    },\n    {\n      \"id\": \"d105\",\n      \"stallId\": \"c2s1\",\n      \"name\": \"招牌螺蛳粉\",\n      \"price\": 12.9\n    },\n    {\n      \"id\": \"d106\",\n      \"stallId\": \"c2s1\",\n      \"name\": \"网红拉丝炸蛋螺蛳粉\",\n      \"price\": 16.9\n    },\n    {\n      \"id\": \"d107\",\n      \"stallId\": \"c2s1\",\n      \"name\": \"鲜在深山螺蛳粉\",\n      \"price\": 16.9\n    },\n    {\n      \"id\": \"d108\",\n      \"stallId\": \"c2s1\",\n      \"name\": \"虎皮鸡爪螺蛳粉\",\n      \"price\": 16.9\n    },\n    {\n      \"id\": \"d109\",\n      \"stallId\": \"c2s1\",\n      \"name\": \"油泼干拌螺蛳粉\",\n      \"price\": 24.9\n    },\n    {\n      \"id\": \"d110\",\n      \"stallId\": \"c2s1\",\n      \"name\": \"螺蛳粉（有肉）\",\n      \"price\": 16.9\n    },\n    {\n      \"id\": \"d111\",\n      \"stallId\": \"c2s1\",\n      \"name\": \"带皮鸭掌螺蛳粉\",\n      \"price\": 16.9\n    },\n    {\n      \"id\": \"d112\",\n      \"stallId\": \"c2s1\",\n      \"name\": \"番茄土豆泥螺蛳粉\",\n      \"price\": 16.9\n    },\n    {\n      \"id\": \"d113\",\n      \"stallId\": \"c2s1\",\n      \"name\": \"螺蛳粉 + 菌汤\",\n      \"price\": 18.9\n    },\n    {\n      \"id\": \"d114\",\n      \"stallId\": \"c2s1\",\n      \"name\": \"骨汤螺蛳粉\",\n      \"price\": 14.9\n    },\n    {\n      \"id\": \"d115\",\n      \"stallId\": \"c2s1\",\n      \"name\": \"三鲜螺蛳粉\",\n      \"price\": 14.9\n    },\n    {\n      \"id\": \"d116\",\n      \"stallId\": \"c2s1\",\n      \"name\": \"广东螺蛳粉\",\n      \"price\": 14.9\n    },\n    {\n      \"id\": \"d117\",\n      \"stallId\": \"c2s1\",\n      \"name\": \"干拌螺蛳粉\",\n      \"price\": 16.9\n    },\n    {\n      \"id\": \"d118\",\n      \"stallId\": \"c2s1\",\n      \"name\": \"香辣烤鱼螺蛳粉火锅（2-3人）\",\n      \"price\": 69.9\n    },\n    {\n      \"id\": \"d119\",\n      \"stallId\": \"c2s1\",\n      \"name\": \"豆腐螺蛳粉火锅\",\n      \"price\": 69.9\n    },\n    {\n      \"id\": \"d120\",\n      \"stallId\": \"c2s1\",\n      \"name\": \"双人肥肠螺蛳粉火锅\",\n      \"price\": 89.9\n    },\n    {\n      \"id\": \"d121\",\n      \"stallId\": \"c2s1\",\n      \"name\": \"人气套餐\",\n      \"price\": 20.9\n    },\n    {\n      \"id\": \"d122\",\n      \"stallId\": \"c2s1\",\n      \"name\": \"炸蛋螺蛳粉套餐\",\n      \"price\": 19.9\n    },\n    {\n      \"id\": \"d123\",\n      \"stallId\": \"c2s1\",\n      \"name\": \"兰花干螺蛳粉套餐\",\n      \"price\": 19.9\n    },\n    {\n      \"id\": \"d124\",\n      \"stallId\": \"c2s1\",\n      \"name\": \"鸡爪螺蛳粉套餐\",\n      \"price\": 19.9\n    },\n    {\n      \"id\": \"d130\",\n      \"stallId\": \"c2s2\",\n      \"name\": \"牛肉包\",\n      \"price\": 2.5\n    },\n    {\n      \"id\": \"d131\",\n      \"stallId\": \"c2s2\",\n      \"name\": \"酱肉包\",\n      \"price\": 2.5\n    },\n    {\n      \"id\": \"d132\",\n      \"stallId\": \"c2s2\",\n      \"name\": \"小猪奶黄包\",\n      \"price\": 2.5\n    },\n    {\n      \"id\": \"d133\",\n      \"stallId\": \"c2s2\",\n      \"name\": \"奥尔良鸡肉包\",\n      \"price\": 2.5\n    },\n    {\n      \"id\": \"d134\",\n      \"stallId\": \"c2s2\",\n      \"name\": \"鲜肉包\",\n      \"price\": 2\n    },\n    {\n      \"id\": \"d135\",\n      \"stallId\": \"c2s2\",\n      \"name\": \"梅干菜肉包\",\n      \"price\": 2\n    },\n    {\n      \"id\": \"d136\",\n      \"stallId\": \"c2s2\",\n      \"name\": \"肉沫酸豆角包\",\n      \"price\": 2\n    },\n    {\n      \"id\": \"d137\",\n      \"stallId\": \"c2s2\",\n      \"name\": \"豆沙包\",\n      \"price\": 2\n    },\n    {\n      \"id\": \"d138\",\n      \"stallId\": \"c2s2\",\n      \"name\": \"青椒茄子包\",\n      \"price\": 2\n    },\n    {\n      \"id\": \"d139\",\n      \"stallId\": \"c2s2\",\n      \"name\": \"韭菜鸡蛋包\",\n      \"price\": 2\n    },\n    {\n      \"id\": \"d140\",\n      \"stallId\": \"c2s2\",\n      \"name\": \"猪肉茴香包\",\n      \"price\": 2\n    },\n    {\n      \"id\": \"d141\",\n      \"stallId\": \"c2s2\",\n      \"name\": \"香菇油菜包\",\n      \"price\": 2\n    },\n    {\n      \"id\": \"d142\",\n      \"stallId\": \"c2s2\",\n      \"name\": \"牛肉小笼包\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"d143\",\n      \"stallId\": \"c2s2\",\n      \"name\": \"酱肉小笼包\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"d144\",\n      \"stallId\": \"c2s2\",\n      \"name\": \"鲜肉小笼包\",\n      \"price\": 8\n    },\n    {\n      \"id\": \"d145\",\n      \"stallId\": \"c2s2\",\n      \"name\": \"麻辣小龙虾小笼包\",\n      \"price\": 15\n    },\n    {\n      \"id\": \"d146\",\n      \"stallId\": \"c2s2\",\n      \"name\": \"韭菜鸡蛋小笼包\",\n      \"price\": 7\n    },\n    {\n      \"id\": \"d147\",\n      \"stallId\": \"c2s2\",\n      \"name\": \"香菇油菜小笼包\",\n      \"price\": 7\n    },\n    {\n      \"id\": \"d148\",\n      \"stallId\": \"c2s2\",\n      \"name\": \"生煎包\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"d149\",\n      \"stallId\": \"c2s2\",\n      \"name\": \"黑米粥\",\n      \"price\": 2\n    },\n    {\n      \"id\": \"d150\",\n      \"stallId\": \"c2s2\",\n      \"name\": \"小米南瓜粥\",\n      \"price\": 2\n    },\n    {\n      \"id\": \"d151\",\n      \"stallId\": \"c2s2\",\n      \"name\": \"绿豆薏米粥\",\n      \"price\": 2\n    },\n    {\n      \"id\": \"d152\",\n      \"stallId\": \"c2s2\",\n      \"name\": \"红枣银耳粥\",\n      \"price\": 2\n    },\n    {\n      \"id\": \"d153\",\n      \"stallId\": \"c2s2\",\n      \"name\": \"皮蛋瘦肉粥\",\n      \"price\": 3\n    },\n    {\n      \"id\": \"d154\",\n      \"stallId\": \"c2s2\",\n      \"name\": \"现磨豆浆\",\n      \"price\": 2.5\n    },\n    {\n      \"id\": \"d155\",\n      \"stallId\": \"c2s2\",\n      \"name\": \"鲜肉馄饨\",\n      \"price\": 8\n    },\n    {\n      \"id\": \"d156\",\n      \"stallId\": \"c2s2\",\n      \"name\": \"紫菜鸡蛋汤\",\n      \"price\": 2\n    },\n    {\n      \"id\": \"d157\",\n      \"stallId\": \"c2s2\",\n      \"name\": \"水饺\",\n      \"price\": 16\n    },\n    {\n      \"id\": \"d160\",\n      \"stallId\": \"c2s3\",\n      \"name\": \"香辣大盘鸡拌面\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"d161\",\n      \"stallId\": \"c2s3\",\n      \"name\": \"香辣大盘鸡拌饭\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"d162\",\n      \"stallId\": \"c2s3\",\n      \"name\": \"酱香大盘鸡拌面\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"d163\",\n      \"stallId\": \"c2s3\",\n      \"name\": \"酱香大盘鸡拌饭\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"d164\",\n      \"stallId\": \"c2s3\",\n      \"name\": \"干锅土豆片\",\n      \"price\": 11\n    },\n    {\n      \"id\": \"d165\",\n      \"stallId\": \"c2s3\",\n      \"name\": \"干锅素什锦\",\n      \"price\": 11\n    },\n    {\n      \"id\": \"d166\",\n      \"stallId\": \"c2s3\",\n      \"name\": \"干锅方便面\",\n      \"price\": 11\n    },\n    {\n      \"id\": \"d167\",\n      \"stallId\": \"c2s3\",\n      \"name\": \"干锅千叶豆腐\",\n      \"price\": 11\n    },\n    {\n      \"id\": \"d168\",\n      \"stallId\": \"c2s3\",\n      \"name\": \"干锅脆骨肠\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"d169\",\n      \"stallId\": \"c2s3\",\n      \"name\": \"干锅孜然肉\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"d170\",\n      \"stallId\": \"c2s3\",\n      \"name\": \"干锅椒麻鸡\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"d171\",\n      \"stallId\": \"c2s3\",\n      \"name\": \"干锅招牌鸡\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"d172\",\n      \"stallId\": \"c2s3\",\n      \"name\": \"干锅小酥肉\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"d173\",\n      \"stallId\": \"c2s3\",\n      \"name\": \"干锅酸菜五花肉\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"d174\",\n      \"stallId\": \"c2s3\",\n      \"name\": \"干锅大鸡排\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"d175\",\n      \"stallId\": \"c2s3\",\n      \"name\": \"干锅荷包蛋\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"d176\",\n      \"stallId\": \"c2s3\",\n      \"name\": \"干锅腊肠\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"d177\",\n      \"stallId\": \"c2s3\",\n      \"name\": \"干锅鸡翅中\",\n      \"price\": 15\n    },\n    {\n      \"id\": \"d178\",\n      \"stallId\": \"c2s3\",\n      \"name\": \"干锅雪花鸡柳\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"d179\",\n      \"stallId\": \"c2s3\",\n      \"name\": \"干锅大虾\",\n      \"price\": 15\n    },\n    {\n      \"id\": \"d180\",\n      \"stallId\": \"c2s3\",\n      \"name\": \"干锅鸡翅根\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"d181\",\n      \"stallId\": \"c2s3\",\n      \"name\": \"干锅翅中虾\",\n      \"price\": 16\n    },\n    {\n      \"id\": \"d182\",\n      \"stallId\": \"c2s3\",\n      \"name\": \"中式炸鸡馍\",\n      \"price\": 8\n    },\n    {\n      \"id\": \"d183\",\n      \"stallId\": \"c2s3\",\n      \"name\": \"芝士烤冷面\",\n      \"price\": 10\n    },\n    {\n      \"id\": \"d184\",\n      \"stallId\": \"c2s3\",\n      \"name\": \"手工大面筋\",\n      \"price\": 3\n    },\n    {\n      \"id\": \"d185\",\n      \"stallId\": \"c2s3\",\n      \"name\": \"蛋包芝士火鸡面\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"d190\",\n      \"stallId\": \"c2s4\",\n      \"name\": \"川湘小炒肉\",\n      \"price\": 15\n    },\n    {\n      \"id\": \"d191\",\n      \"stallId\": \"c2s4\",\n      \"name\": \"腊肉炒烟笋\",\n      \"price\": 15\n    },\n    {\n      \"id\": \"d192\",\n      \"stallId\": \"c2s4\",\n      \"name\": \"十八秒猪肝\",\n      \"price\": 16\n    },\n    {\n      \"id\": \"d193\",\n      \"stallId\": \"c2s4\",\n      \"name\": \"辣椒炒肉\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"d194\",\n      \"stallId\": \"c2s4\",\n      \"name\": \"孜然小炒肉\",\n      \"price\": 15\n    },\n    {\n      \"id\": \"d195\",\n      \"stallId\": \"c2s4\",\n      \"name\": \"酸辣藕带\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"d196\",\n      \"stallId\": \"c2s4\",\n      \"name\": \"手撕包菜\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"d197\",\n      \"stallId\": \"c2s4\",\n      \"name\": \"湘味下饭菜\",\n      \"price\": 15\n    },\n    {\n      \"id\": \"d198\",\n      \"stallId\": \"c2s4\",\n      \"name\": \"尖椒炒蛋\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"d199\",\n      \"stallId\": \"c2s4\",\n      \"name\": \"肉沫蒸蛋\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"d200\",\n      \"stallId\": \"c2s4\",\n      \"name\": \"酸辣土豆丝\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"d201\",\n      \"stallId\": \"c2s4\",\n      \"name\": \"农家一碗香\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"d202\",\n      \"stallId\": \"c2s4\",\n      \"name\": \"荔枝鸡咖喱双拼饭\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"d203\",\n      \"stallId\": \"c2s4\",\n      \"name\": \"酱骨荔枝鸡双拼饭\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"d204\",\n      \"stallId\": \"c2s4\",\n      \"name\": \"甜辣鸡卤肉双拼饭\",\n      \"price\": 15\n    },\n    {\n      \"id\": \"d205\",\n      \"stallId\": \"c2s4\",\n      \"name\": \"糖醋鸡贝贝咖喱饭\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"d206\",\n      \"stallId\": \"c2s4\",\n      \"name\": \"酱骨甜辣鸡双拼饭\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"d207\",\n      \"stallId\": \"c2s4\",\n      \"name\": \"卤肉糖醋鸡双拼饭\",\n      \"price\": 15\n    },\n    {\n      \"id\": \"d208\",\n      \"stallId\": \"c2s4\",\n      \"name\": \"酱骨焖茄子双拼饭\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"d209\",\n      \"stallId\": \"c2s4\",\n      \"name\": \"卤肉茄子双拼饭\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"d210\",\n      \"stallId\": \"c2s4\",\n      \"name\": \"咖喱鸡排双拼饭\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"d211\",\n      \"stallId\": \"c2s4\",\n      \"name\": \"酱骨卤肉双拼饭\",\n      \"price\": 15\n    },\n    {\n      \"id\": \"d212\",\n      \"stallId\": \"c2s4\",\n      \"name\": \"可乐鸡咖喱双拼饭\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"d220\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"蔬菜沙拉减脂饭\",\n      \"price\": 11\n    },\n    {\n      \"id\": \"d221\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"卫龙烤肉拌饭\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"d222\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"金针菇烤肉拌饭\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"d223\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"土豆丝烤肉拌饭\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"d224\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"辣白菜烤肉拌饭\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"d225\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"杏鲍菇烤肉拌饭\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"d226\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"奥尔良烤肉拌饭\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"d227\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"孜然烤肉拌饭\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"d228\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"火腿烤肉拌饭\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"d229\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"海苔烤肉拌饭\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"d230\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"肉松海苔拌饭\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"d231\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"照烧烤肉拌饭\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"d232\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"蜜汁烤肉拌饭\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"d233\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"黑椒烤肉拌饭\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"d234\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"蜂蜜芥末烤肉拌饭\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"d235\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"照烧鸡排拌饭\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"d236\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"蜜汁鸡排拌饭\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"d237\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"黑椒鸡排拌饭\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"d238\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"鸡排拼烤肉\",\n      \"price\": 15\n    },\n    {\n      \"id\": \"d239\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"金针菇寿司\",\n      \"price\": 9\n    },\n    {\n      \"id\": \"d240\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"酸萝卜寿司\",\n      \"price\": 9\n    },\n    {\n      \"id\": \"d241\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"辣白菜寿司\",\n      \"price\": 9\n    },\n    {\n      \"id\": \"d242\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"烤肉寿司\",\n      \"price\": 10\n    },\n    {\n      \"id\": \"d243\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"牛肉松寿司\",\n      \"price\": 10\n    },\n    {\n      \"id\": \"d244\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"蟹柳寿司\",\n      \"price\": 10\n    },\n    {\n      \"id\": \"d245\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"招牌蛋炒饭\",\n      \"price\": 11\n    },\n    {\n      \"id\": \"d246\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"腊肠蛋炒饭\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"d247\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"火腿蛋炒饭\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"d248\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"培根蛋炒饭\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"d249\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"鸭肠蛋炒饭\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"d250\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"泡菜鸡肉炒饭\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"d251\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"奥尔良小炒肉饭\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"d252\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"孜然小炒肉饭\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"d253\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"黑椒小炒肉饭\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"d254\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"多味鸡排炒饭\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"d255\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"大酱汤饭\",\n      \"price\": 11\n    },\n    {\n      \"id\": \"d256\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"炒年糕\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"d257\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"素石锅拌饭\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"d258\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"鱼饼年糕饭\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"d259\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"鸡排石锅拌饭\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"d260\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"牛肉石锅拌饭\",\n      \"price\": 15\n    },\n    {\n      \"id\": \"d261\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"奥尔良鸡肉石锅饭\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"d262\",\n      \"stallId\": \"c2s5\",\n      \"name\": \"煎鸡蛋\",\n      \"price\": 1.5\n    },\n    {\n      \"id\": \"d270\",\n      \"stallId\": \"c2s6\",\n      \"name\": \"招牌烤鸭饭（小份）\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"d271\",\n      \"stallId\": \"c2s6\",\n      \"name\": \"招牌烤鸭饭（大份）\",\n      \"price\": 15\n    },\n    {\n      \"id\": \"d272\",\n      \"stallId\": \"c2s6\",\n      \"name\": \"猪肘饭\",\n      \"price\": 15.9\n    },\n    {\n      \"id\": \"d273\",\n      \"stallId\": \"c2s6\",\n      \"name\": \"照烧鸡腿饭\",\n      \"price\": 12.9\n    },\n    {\n      \"id\": \"d274\",\n      \"stallId\": \"c2s6\",\n      \"name\": \"整只烤鸭\",\n      \"price\": 19.9\n    },\n    {\n      \"id\": \"d280\",\n      \"stallId\": \"c2s7\",\n      \"name\": \"招牌鸡肉炒米粉\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"d281\",\n      \"stallId\": \"c2s7\",\n      \"name\": \"火腿肠炒米粉\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"d282\",\n      \"stallId\": \"c2s7\",\n      \"name\": \"鱼排蟹排炒米粉\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"d283\",\n      \"stallId\": \"c2s7\",\n      \"name\": \"纯素多菜炒米粉\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"d284\",\n      \"stallId\": \"c2s7\",\n      \"name\": \"酸菜鸡肉炒米粉\",\n      \"price\": 15\n    },\n    {\n      \"id\": \"d285\",\n      \"stallId\": \"c2s7\",\n      \"name\": \"鸡肉多菜炒米粉\",\n      \"price\": 16\n    },\n    {\n      \"id\": \"d286\",\n      \"stallId\": \"c2s7\",\n      \"name\": \"酸菜牛肉炒米粉\",\n      \"price\": 17\n    },\n    {\n      \"id\": \"d287\",\n      \"stallId\": \"c2s7\",\n      \"name\": \"全家福炒米粉\",\n      \"price\": 18\n    },\n    {\n      \"id\": \"d288\",\n      \"stallId\": \"c2s7\",\n      \"name\": \"鸡肉+宽粉双拼炒米粉\",\n      \"price\": 16\n    },\n    {\n      \"id\": \"d289\",\n      \"stallId\": \"c2s7\",\n      \"name\": \"鸡肉+年糕双拼炒米粉\",\n      \"price\": 16\n    },\n    {\n      \"id\": \"d290\",\n      \"stallId\": \"c2s7\",\n      \"name\": \"鸡肉贡菜+馕双拼炒米粉\",\n      \"price\": 18\n    },\n    {\n      \"id\": \"d291\",\n      \"stallId\": \"c2s7\",\n      \"name\": \"牛肉+宽粉双拼炒米粉\",\n      \"price\": 18\n    },\n    {\n      \"id\": \"d292\",\n      \"stallId\": \"c2s7\",\n      \"name\": \"芝士鸡肉炒米粉\",\n      \"price\": 17\n    },\n    {\n      \"id\": \"d293\",\n      \"stallId\": \"c2s7\",\n      \"name\": \"鸡肉炒宽粉\",\n      \"price\": 15\n    },\n    {\n      \"id\": \"d294\",\n      \"stallId\": \"c2s7\",\n      \"name\": \"鸡肉多菜炒宽粉\",\n      \"price\": 16\n    },\n    {\n      \"id\": \"d295\",\n      \"stallId\": \"c2s7\",\n      \"name\": \"牛肉炒宽粉\",\n      \"price\": 17\n    },\n    {\n      \"id\": \"d296\",\n      \"stallId\": \"c2s7\",\n      \"name\": \"全家福炒宽粉\",\n      \"price\": 18\n    },\n    {\n      \"id\": \"d297\",\n      \"stallId\": \"c2s7\",\n      \"name\": \"鸡肉炒馕\",\n      \"price\": 16\n    },\n    {\n      \"id\": \"d298\",\n      \"stallId\": \"c2s7\",\n      \"name\": \"牛肉炒馕\",\n      \"price\": 18\n    },\n    {\n      \"id\": \"d299\",\n      \"stallId\": \"c2s7\",\n      \"name\": \"新疆炒五粉\",\n      \"price\": 19\n    },\n    {\n      \"id\": \"d300\",\n      \"stallId\": \"c2s7\",\n      \"name\": \"招牌牛肉炒米粉\",\n      \"price\": 15\n    },\n    {\n      \"id\": \"d301\",\n      \"stallId\": \"c2s7\",\n      \"name\": \"粉馕双拼牛肉炒米粉\",\n      \"price\": 18\n    },\n    {\n      \"id\": \"d310\",\n      \"stallId\": \"c2s8\",\n      \"name\": \"酸汤砂锅面\",\n      \"price\": 11\n    },\n    {\n      \"id\": \"d311\",\n      \"stallId\": \"c2s8\",\n      \"name\": \"招牌肉卤面\",\n      \"price\": 11\n    },\n    {\n      \"id\": \"d312\",\n      \"stallId\": \"c2s8\",\n      \"name\": \"原味鸡汤面\",\n      \"price\": 11\n    },\n    {\n      \"id\": \"d313\",\n      \"stallId\": \"c2s8\",\n      \"name\": \"酸辣鸡汤面\",\n      \"price\": 11\n    },\n    {\n      \"id\": \"d314\",\n      \"stallId\": \"c2s8\",\n      \"name\": \"什锦砂锅面\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"d315\",\n      \"stallId\": \"c2s8\",\n      \"name\": \"椒麻鸭块面\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"d316\",\n      \"stallId\": \"c2s8\",\n      \"name\": \"什锦酸汤面\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"d317\",\n      \"stallId\": \"c2s8\",\n      \"name\": \"小酥肉番茄面\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"d318\",\n      \"stallId\": \"c2s8\",\n      \"name\": \"小酥肉金汤面\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"d319\",\n      \"stallId\": \"c2s8\",\n      \"name\": \"什锦麻酱面\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"d320\",\n      \"stallId\": \"c2s8\",\n      \"name\": \"农家焖面\",\n      \"price\": 9\n    },\n    {\n      \"id\": \"d321\",\n      \"stallId\": \"c2s8\",\n      \"name\": \"鸡架拌面\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"d322\",\n      \"stallId\": \"c2s8\",\n      \"name\": \"小酥肉拌面\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"d323\",\n      \"stallId\": \"c2s8\",\n      \"name\": \"鸡腿拌面\",\n      \"price\": 15\n    },\n    {\n      \"id\": \"d324\",\n      \"stallId\": \"c2s8\",\n      \"name\": \"拌鸡架\",\n      \"price\": 10\n    },\n    {\n      \"id\": \"d325\",\n      \"stallId\": \"c2s8\",\n      \"name\": \"拌鸡腿\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"d326\",\n      \"stallId\": \"c2s8\",\n      \"name\": \"鸡丝麻酱面\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"d327\",\n      \"stallId\": \"c2s8\",\n      \"name\": \"招牌麻酱面\",\n      \"price\": 11\n    },\n    {\n      \"id\": \"d328\",\n      \"stallId\": \"c2s8\",\n      \"name\": \"油泼肉卤面\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"d329\",\n      \"stallId\": \"c2s8\",\n      \"name\": \"方便面\",\n      \"price\": 5\n    },\n    {\n      \"id\": \"d330\",\n      \"stallId\": \"c2s8\",\n      \"name\": \"火腿肠\",\n      \"price\": 1.5\n    },\n    {\n      \"id\": \"d331\",\n      \"stallId\": \"c2s8\",\n      \"name\": \"鸡蛋\",\n      \"price\": 1.5\n    },\n    {\n      \"id\": \"d340\",\n      \"stallId\": \"c2s9\",\n      \"name\": \"酱肉米线\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"d341\",\n      \"stallId\": \"c2s9\",\n      \"name\": \"酱肉米线 + 刀削面\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"d342\",\n      \"stallId\": \"c2s9\",\n      \"name\": \"酱肉米线 + 方便面\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"d343\",\n      \"stallId\": \"c2s9\",\n      \"name\": \"麻辣豆干米线\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"d344\",\n      \"stallId\": \"c2s9\",\n      \"name\": \"麻辣豆干米线 + 刀削面\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"d345\",\n      \"stallId\": \"c2s9\",\n      \"name\": \"原味清汤\",\n      \"price\": 11\n    },\n    {\n      \"id\": \"d346\",\n      \"stallId\": \"c2s9\",\n      \"name\": \"原味清汤 + 刀削面\",\n      \"price\": 11\n    },\n    {\n      \"id\": \"d347\",\n      \"stallId\": \"c2s9\",\n      \"name\": \"原味清汤 + 方便面\",\n      \"price\": 11\n    },\n    {\n      \"id\": \"d348\",\n      \"stallId\": \"c2s9\",\n      \"name\": \"麻辣米线\",\n      \"price\": 11\n    },\n    {\n      \"id\": \"d349\",\n      \"stallId\": \"c2s9\",\n      \"name\": \"麻辣米线 + 方便面\",\n      \"price\": 11\n    },\n    {\n      \"id\": \"d350\",\n      \"stallId\": \"c2s9\",\n      \"name\": \"麻辣米线 + 刀削面\",\n      \"price\": 11\n    },\n    {\n      \"id\": \"d351\",\n      \"stallId\": \"c2s9\",\n      \"name\": \"香辣米线\",\n      \"price\": 11\n    },\n    {\n      \"id\": \"d352\",\n      \"stallId\": \"c2s9\",\n      \"name\": \"香辣米线 + 刀削面\",\n      \"price\": 11\n    },\n    {\n      \"id\": \"d353\",\n      \"stallId\": \"c2s9\",\n      \"name\": \"香辣米线 + 方便面\",\n      \"price\": 11\n    },\n    {\n      \"id\": \"d354\",\n      \"stallId\": \"c2s9\",\n      \"name\": \"燕麦粥\",\n      \"price\": 2\n    },\n    {\n      \"id\": \"d355\",\n      \"stallId\": \"c2s9\",\n      \"name\": \"椰奶\",\n      \"price\": 2\n    },\n    {\n      \"id\": \"d356\",\n      \"stallId\": \"c2s9\",\n      \"name\": \"红枣豆浆\",\n      \"price\": 2\n    },\n    {\n      \"id\": \"d357\",\n      \"stallId\": \"c2s9\",\n      \"name\": \"椰奶燕麦粥\",\n      \"price\": 2\n    },\n    {\n      \"id\": \"d358\",\n      \"stallId\": \"c2s9\",\n      \"name\": \"鸡蛋火腿肉夹馍\",\n      \"price\": 5\n    },\n    {\n      \"id\": \"d359\",\n      \"stallId\": \"c2s9\",\n      \"name\": \"鸡蛋豆腐皮肉夹馍\",\n      \"price\": 5\n    },\n    {\n      \"id\": \"d360\",\n      \"stallId\": \"c2s9\",\n      \"name\": \"火腿豆腐皮肉夹馍\",\n      \"price\": 5\n    },\n    {\n      \"id\": \"d361\",\n      \"stallId\": \"c2s9\",\n      \"name\": \"火腿鸡蛋豆腐皮肉夹馍\",\n      \"price\": 6\n    },\n    {\n      \"id\": \"d362\",\n      \"stallId\": \"c2s9\",\n      \"name\": \"火腿豆皮加卫龙肉夹馍\",\n      \"price\": 6\n    },\n    {\n      \"id\": \"d363\",\n      \"stallId\": \"c2s9\",\n      \"name\": \"鸡蛋火腿加卫龙肉夹馍\",\n      \"price\": 6\n    },\n    {\n      \"id\": \"d364\",\n      \"stallId\": \"c2s9\",\n      \"name\": \"鸡蛋豆腐皮加卫龙肉夹馍\",\n      \"price\": 6\n    },\n    {\n      \"id\": \"d365\",\n      \"stallId\": \"c2s9\",\n      \"name\": \"鸡蛋火腿豆腐皮卫龙肉夹馍\",\n      \"price\": 7\n    },\n    {\n      \"id\": \"d366\",\n      \"stallId\": \"c2s9\",\n      \"name\": \"肉夹馍\",\n      \"price\": 8\n    },\n    {\n      \"id\": \"d367\",\n      \"stallId\": \"c2s9\",\n      \"name\": \"肉夹馍加火腿\",\n      \"price\": 9\n    },\n    {\n      \"id\": \"d368\",\n      \"stallId\": \"c2s9\",\n      \"name\": \"肉夹馍加鸡蛋\",\n      \"price\": 9.5\n    },\n    {\n      \"id\": \"d369\",\n      \"stallId\": \"c2s9\",\n      \"name\": \"肉夹馍加火腿卫龙\",\n      \"price\": 10\n    },\n    {\n      \"id\": \"d370\",\n      \"stallId\": \"c2s9\",\n      \"name\": \"肉夹馍加鸡蛋火腿\",\n      \"price\": 10.5\n    },\n    {\n      \"id\": \"d371\",\n      \"stallId\": \"c2s9\",\n      \"name\": \"肉夹馍加鸡蛋卫龙\",\n      \"price\": 10.5\n    },\n    {\n      \"id\": \"d380\",\n      \"stallId\": \"c2s10\",\n      \"name\": \"可乐\",\n      \"price\": 3\n    },\n    {\n      \"id\": \"d381\",\n      \"stallId\": \"c2s10\",\n      \"name\": \"雪碧\",\n      \"price\": 3\n    },\n    {\n      \"id\": \"d382\",\n      \"stallId\": \"c2s10\",\n      \"name\": \"芬达\",\n      \"price\": 3\n    },\n    {\n      \"id\": \"d383\",\n      \"stallId\": \"c2s10\",\n      \"name\": \"冰鲜柠檬水\",\n      \"price\": 4\n    },\n    {\n      \"id\": \"d384\",\n      \"stallId\": \"c2s10\",\n      \"name\": \"茉莉柠檬水\",\n      \"price\": 5\n    },\n    {\n      \"id\": \"d385\",\n      \"stallId\": \"c2s10\",\n      \"name\": \"柠檬红茶\",\n      \"price\": 5\n    },\n    {\n      \"id\": \"d386\",\n      \"stallId\": \"c2s10\",\n      \"name\": \"酸梅汁\",\n      \"price\": 3\n    },\n    {\n      \"id\": \"d387\",\n      \"stallId\": \"c2s10\",\n      \"name\": \"柳橙果汁\",\n      \"price\": 3\n    },\n    {\n      \"id\": \"d388\",\n      \"stallId\": \"c2s10\",\n      \"name\": \"芒果汁\",\n      \"price\": 3\n    },\n    {\n      \"id\": \"d389\",\n      \"stallId\": \"c2s10\",\n      \"name\": \"葡萄果汁\",\n      \"price\": 3\n    },\n    {\n      \"id\": \"d390\",\n      \"stallId\": \"c2s10\",\n      \"name\": \"荔枝果汁\",\n      \"price\": 3\n    },\n    {\n      \"id\": \"d391\",\n      \"stallId\": \"c2s10\",\n      \"name\": \"菠萝果汁\",\n      \"price\": 3\n    },\n    {\n      \"id\": \"d392\",\n      \"stallId\": \"c2s10\",\n      \"name\": \"茉莉花茶\",\n      \"price\": 3\n    },\n    {\n      \"id\": \"d393\",\n      \"stallId\": \"c2s10\",\n      \"name\": \"经典红茶\",\n      \"price\": 3\n    },\n    {\n      \"id\": \"d394\",\n      \"stallId\": \"c2s10\",\n      \"name\": \"经典绿茶\",\n      \"price\": 3\n    },\n    {\n      \"id\": \"d395\",\n      \"stallId\": \"c2s10\",\n      \"name\": \"白桃乌龙茶\",\n      \"price\": 3\n    },\n    {\n      \"id\": \"d400\",\n      \"stallId\": \"c2s11\",\n      \"name\": \"川渝自选菜（计重）\",\n      \"price\": 1.78,\n      \"unit\": \"元/50克\"\n    },\n    {\n      \"id\": \"d410\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"招牌黑鸭煲\",\n      \"price\": 13.8\n    },\n    {\n      \"id\": \"d411\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"金牌酱焖鸭\",\n      \"price\": 13.8\n    },\n    {\n      \"id\": \"d412\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"黑鸭鸡腿煲\",\n      \"price\": 14.8\n    },\n    {\n      \"id\": \"d413\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"黑鸭烧肉煲\",\n      \"price\": 15.8\n    },\n    {\n      \"id\": \"d414\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"黑鸭海带煲\",\n      \"price\": 12.8\n    },\n    {\n      \"id\": \"d415\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"黑鸭腐竹煲\",\n      \"price\": 12.8\n    },\n    {\n      \"id\": \"d416\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"黑鸭金针菇煲\",\n      \"price\": 12.8\n    },\n    {\n      \"id\": \"d417\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"黑鸭花菜煲\",\n      \"price\": 12.8\n    },\n    {\n      \"id\": \"d418\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"黑鸭木耳煲\",\n      \"price\": 12.8\n    },\n    {\n      \"id\": \"d419\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"黑鸭茄子煲\",\n      \"price\": 12.8\n    },\n    {\n      \"id\": \"d420\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"馋嘴土豆片\",\n      \"price\": 10.8\n    },\n    {\n      \"id\": \"d421\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"馋嘴千页豆腐\",\n      \"price\": 11.8\n    },\n    {\n      \"id\": \"d422\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"馋嘴宽粉\",\n      \"price\": 11.8\n    },\n    {\n      \"id\": \"d423\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"馋嘴金针菇\",\n      \"price\": 12.8\n    },\n    {\n      \"id\": \"d424\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"馋嘴方便面\",\n      \"price\": 12.8\n    },\n    {\n      \"id\": \"d425\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"馋嘴年糕\",\n      \"price\": 12.8\n    },\n    {\n      \"id\": \"d426\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"馋嘴鸭血\",\n      \"price\": 12.8\n    },\n    {\n      \"id\": \"d427\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"馋嘴乌冬面\",\n      \"price\": 12.8\n    },\n    {\n      \"id\": \"d428\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"馋嘴苕粉\",\n      \"price\": 13.6\n    },\n    {\n      \"id\": \"d429\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"馋嘴魔芋结\",\n      \"price\": 13.6\n    },\n    {\n      \"id\": \"d430\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"馋嘴脆骨肠\",\n      \"price\": 13.6\n    },\n    {\n      \"id\": \"d431\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"馋嘴培根\",\n      \"price\": 13.6\n    },\n    {\n      \"id\": \"d432\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"金牌馋嘴鸡\",\n      \"price\": 14.6\n    },\n    {\n      \"id\": \"d433\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"金牌馋嘴鸭\",\n      \"price\": 14.6\n    },\n    {\n      \"id\": \"d434\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"馋嘴小酥肉\",\n      \"price\": 14.6\n    },\n    {\n      \"id\": \"d435\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"招牌馋嘴鱼\",\n      \"price\": 15.6\n    },\n    {\n      \"id\": \"d436\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"香约脆皮鸡饭（大份）\",\n      \"price\": 12.5\n    },\n    {\n      \"id\": \"d437\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"香约脆皮鸡饭（小份）\",\n      \"price\": 11.5\n    },\n    {\n      \"id\": \"d438\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"番茄脆皮鸡饭\",\n      \"price\": 12.5\n    },\n    {\n      \"id\": \"d439\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"香辣脆皮鸡饭\",\n      \"price\": 12.5\n    },\n    {\n      \"id\": \"d440\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"千岛脆皮鸡饭\",\n      \"price\": 12.5\n    },\n    {\n      \"id\": \"d441\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"咖喱脆皮鸡饭\",\n      \"price\": 12.5\n    },\n    {\n      \"id\": \"d442\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"蜜汁脆皮鸡饭\",\n      \"price\": 12.5\n    },\n    {\n      \"id\": \"d443\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"沙拉脆皮鸡饭\",\n      \"price\": 11.5\n    },\n    {\n      \"id\": \"d444\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"韩式脆皮鸡饭\",\n      \"price\": 11.5\n    },\n    {\n      \"id\": \"d445\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"黑胡椒脆皮鸡饭\",\n      \"price\": 11.5\n    },\n    {\n      \"id\": \"d446\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"蜂蜜芥末脆皮鸡饭\",\n      \"price\": 11.5\n    },\n    {\n      \"id\": \"d447\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"黑椒鸡排煎肉饭\",\n      \"price\": 13.5\n    },\n    {\n      \"id\": \"d448\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"照烧鸡排煎肉饭\",\n      \"price\": 13.5\n    },\n    {\n      \"id\": \"d449\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"咖喱鸡排煎肉饭\",\n      \"price\": 13.5\n    },\n    {\n      \"id\": \"d450\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"香辣鸡排煎肉饭\",\n      \"price\": 13.5\n    },\n    {\n      \"id\": \"d451\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"沙拉鸡排煎肉饭\",\n      \"price\": 13.5\n    },\n    {\n      \"id\": \"d452\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"黑椒猪排煎肉饭\",\n      \"price\": 14.5\n    },\n    {\n      \"id\": \"d453\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"照烧猪排煎肉饭\",\n      \"price\": 14.5\n    },\n    {\n      \"id\": \"d454\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"咖喱猪排煎肉饭\",\n      \"price\": 14.5\n    },\n    {\n      \"id\": \"d455\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"香辣猪排煎肉饭\",\n      \"price\": 14.5\n    },\n    {\n      \"id\": \"d456\",\n      \"stallId\": \"c2s12\",\n      \"name\": \"沙拉猪排煎肉饭\",\n      \"price\": 14.5\n    },\n    {\n      \"id\": \"d500\",\n      \"stallId\": \"c3s1\",\n      \"name\": \"牛肉拉面\"\n    },\n    {\n      \"id\": \"d501\",\n      \"stallId\": \"c3s1\",\n      \"name\": \"毛细拉面\"\n    },\n    {\n      \"id\": \"d502\",\n      \"stallId\": \"c3s1\",\n      \"name\": \"牛肉炒面\"\n    },\n    {\n      \"id\": \"d510\",\n      \"stallId\": \"c3s2\",\n      \"name\": \"新疆炒饭\"\n    },\n    {\n      \"id\": \"d511\",\n      \"stallId\": \"c3s2\",\n      \"name\": \"羊肉串\"\n    },\n    {\n      \"id\": \"d512\",\n      \"stallId\": \"c3s2\",\n      \"name\": \"大盘鸡\"\n    },\n    {\n      \"id\": \"d513\",\n      \"stallId\": \"c3s2\",\n      \"name\": \"烤包子\"\n    },\n    {\n      \"id\": \"d520\",\n      \"stallId\": \"c3s3\",\n      \"name\": \"羊肉烧麦\"\n    },\n    {\n      \"id\": \"d521\",\n      \"stallId\": \"c3s3\",\n      \"name\": \"羊杂碎汤\"\n    },\n    {\n      \"id\": \"d522\",\n      \"stallId\": \"c3s3\",\n      \"name\": \"焙子夹肉\"\n    },\n    {\n      \"id\": \"d523\",\n      \"stallId\": \"c3s3\",\n      \"name\": \"手抓饭\"\n    },\n    {\n      \"id\": \"d600\",\n      \"stallId\": \"c4s1\",\n      \"name\": \"宫保鸡丁盖饭\"\n    },\n    {\n      \"id\": \"d601\",\n      \"stallId\": \"c4s1\",\n      \"name\": \"鱼香肉丝盖饭\"\n    },\n    {\n      \"id\": \"d602\",\n      \"stallId\": \"c4s1\",\n      \"name\": \"青椒肉丝盖饭\"\n    },\n    {\n      \"id\": \"d603\",\n      \"stallId\": \"c4s1\",\n      \"name\": \"西红柿鸡蛋盖饭\"\n    },\n    {\n      \"id\": \"d700\",\n      \"stallId\": \"c5s1\",\n      \"name\": \"珍珠奶茶\"\n    },\n    {\n      \"id\": \"d701\",\n      \"stallId\": \"c5s1\",\n      \"name\": \"杨枝甘露\"\n    },\n    {\n      \"id\": \"d702\",\n      \"stallId\": \"c5s1\",\n      \"name\": \"柠檬水\"\n    },\n    {\n      \"id\": \"d703\",\n      \"stallId\": \"c5s1\",\n      \"name\": \"烤肠\"\n    },\n    {\n      \"id\": \"d704\",\n      \"stallId\": \"c5s1\",\n      \"name\": \"鸡排\"\n    },\n    {\n      \"id\": \"d705\",\n      \"stallId\": \"c5s1\",\n      \"name\": \"关东煮\"\n    },\n    {\n      \"id\": \"c1d001\",\n      \"stallId\": \"c1s1\",\n      \"name\": \"拌鸡架\",\n      \"price\": 8\n    },\n    {\n      \"id\": \"c1d002\",\n      \"stallId\": \"c1s1\",\n      \"name\": \"鸡腿拌面\",\n      \"price\": 15\n    },\n    {\n      \"id\": \"c1d003\",\n      \"stallId\": \"c1s1\",\n      \"name\": \"煎蛋拌面\",\n      \"price\": 11\n    },\n    {\n      \"id\": \"c1d004\",\n      \"stallId\": \"c1s1\",\n      \"name\": \"鸡架拌面\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"c1d005\",\n      \"stallId\": \"c1s1\",\n      \"name\": \"拌鸡腿\",\n      \"price\": 10\n    },\n    {\n      \"id\": \"c1d006\",\n      \"stallId\": \"c1s1\",\n      \"name\": \"猪肉三鲜水饺\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d007\",\n      \"stallId\": \"c1s1\",\n      \"name\": \"猪肉酸菜水饺\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d008\",\n      \"stallId\": \"c1s1\",\n      \"name\": \"猪肉白菜水饺\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d009\",\n      \"stallId\": \"c1s1\",\n      \"name\": \"猪肉大葱水饺\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d010\",\n      \"stallId\": \"c1s1\",\n      \"name\": \"猪肉香菇水饺\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d011\",\n      \"stallId\": \"c1s1\",\n      \"name\": \"韭菜鸡蛋水饺\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d012\",\n      \"stallId\": \"c1s1\",\n      \"name\": \"金汤馄饨（大）\",\n      \"price\": 10.5\n    },\n    {\n      \"id\": \"c1d013\",\n      \"stallId\": \"c1s1\",\n      \"name\": \"金汤馄饨（小）\",\n      \"price\": 8.5\n    },\n    {\n      \"id\": \"c1d014\",\n      \"stallId\": \"c1s2\",\n      \"name\": \"招牌荔枝鸡饭\",\n      \"price\": 12.8\n    },\n    {\n      \"id\": \"c1d015\",\n      \"stallId\": \"c1s2\",\n      \"name\": \"劲霸炸翅饭\",\n      \"price\": 13.8\n    },\n    {\n      \"id\": \"c1d016\",\n      \"stallId\": \"c1s2\",\n      \"name\": \"香炸猪脆骨饭\",\n      \"price\": 12.8\n    },\n    {\n      \"id\": \"c1d017\",\n      \"stallId\": \"c1s2\",\n      \"name\": \"厚切脆鸡排饭\",\n      \"price\": 13.8\n    },\n    {\n      \"id\": \"c1d018\",\n      \"stallId\": \"c1s2\",\n      \"name\": \"嫩香大排饭\",\n      \"price\": 11.8\n    },\n    {\n      \"id\": \"c1d019\",\n      \"stallId\": \"c1s2\",\n      \"name\": \"麻辣酱骨饭\",\n      \"price\": 13.8\n    },\n    {\n      \"id\": \"c1d020\",\n      \"stallId\": \"c1s2\",\n      \"name\": \"日晒番茄牛肉饭\",\n      \"price\": 15.8\n    },\n    {\n      \"id\": \"c1d021\",\n      \"stallId\": \"c1s2\",\n      \"name\": \"可乐鸡翅饭\",\n      \"price\": 13.8\n    },\n    {\n      \"id\": \"c1d022\",\n      \"stallId\": \"c1s2\",\n      \"name\": \"椒麻鸡块饭\",\n      \"price\": 12.8\n    },\n    {\n      \"id\": \"c1d023\",\n      \"stallId\": \"c1s2\",\n      \"name\": \"香菇滑鸡饭\",\n      \"price\": 11.8\n    },\n    {\n      \"id\": \"c1d024\",\n      \"stallId\": \"c1s3\",\n      \"name\": \"爆炒卤猪肉\",\n      \"price\": 15\n    },\n    {\n      \"id\": \"c1d025\",\n      \"stallId\": \"c1s3\",\n      \"name\": \"香菇滑鸡\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"c1d026\",\n      \"stallId\": \"c1s3\",\n      \"name\": \"肉沫荷包蛋\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"c1d027\",\n      \"stallId\": \"c1s3\",\n      \"name\": \"瓦香小炒鸡\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"c1d028\",\n      \"stallId\": \"c1s3\",\n      \"name\": \"南昌拌粉\",\n      \"price\": 10\n    },\n    {\n      \"id\": \"c1d029\",\n      \"stallId\": \"c1s3\",\n      \"name\": \"瓦罐汤套餐\",\n      \"price\": 6,\n      \"unit\": \"元（6~8元）\"\n    },\n    {\n      \"id\": \"c1d030\",\n      \"stallId\": \"c1s3\",\n      \"name\": \"南昌拌粉+任选瓦罐汤\",\n      \"price\": 15\n    },\n    {\n      \"id\": \"c1d031\",\n      \"stallId\": \"c1s3\",\n      \"name\": \"酸豆角蛋炒饭\",\n      \"price\": 10\n    },\n    {\n      \"id\": \"c1d032\",\n      \"stallId\": \"c1s3\",\n      \"name\": \"甜玉米蛋炒饭\",\n      \"price\": 11\n    },\n    {\n      \"id\": \"c1d033\",\n      \"stallId\": \"c1s3\",\n      \"name\": \"鸡蛋火腿蛋炒饭\",\n      \"price\": 11\n    },\n    {\n      \"id\": \"c1d034\",\n      \"stallId\": \"c1s3\",\n      \"name\": \"广式腊肠蛋炒饭\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"c1d035\",\n      \"stallId\": \"c1s3\",\n      \"name\": \"肉肠蛋炒饭\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"c1d036\",\n      \"stallId\": \"c1s3\",\n      \"name\": \"里脊肉蛋炒饭\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"c1d037\",\n      \"stallId\": \"c1s3\",\n      \"name\": \"卤鸡腿蛋炒饭\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d038\",\n      \"stallId\": \"c1s3\",\n      \"name\": \"卤猪肘蛋炒饭\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d039\",\n      \"stallId\": \"c1s3\",\n      \"name\": \"鸭杂蛋炒饭\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d040\",\n      \"stallId\": \"c1s3\",\n      \"name\": \"虾仁蛋炒饭\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"c1d041\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"砂锅肉酱米线\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"c1d042\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"砂锅紫薯粉\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"c1d043\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"红烧排骨\",\n      \"price\": 15\n    },\n    {\n      \"id\": \"c1d044\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"糖醋排骨\",\n      \"price\": 15\n    },\n    {\n      \"id\": \"c1d045\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"糖醋肉段\",\n      \"price\": 15\n    },\n    {\n      \"id\": \"c1d046\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"溜肉段\",\n      \"price\": 15\n    },\n    {\n      \"id\": \"c1d047\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"菠萝古咾肉\",\n      \"price\": 15\n    },\n    {\n      \"id\": \"c1d048\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"咖喱鸡块\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"c1d049\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"鱼香鸡块\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"c1d050\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"回锅肉\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"c1d051\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"过油肉\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"c1d052\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"排骨烩酸菜\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d053\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"肉丝炒粉\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d054\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"鱼香茄条\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d055\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"鱼香鸡蛋\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d056\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"孜然肉片\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d057\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"尖椒肉丝\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d058\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"京酱肉丝\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d059\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"榨菜肉丝\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d060\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"肉末茄子\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d061\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"烧茄子\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d062\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"孜然鸡丁\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d063\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"鱼香肉丝\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d064\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"宫爆鸡丁\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d065\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"鱼香小滑肉\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d066\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"辣肺子\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d067\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"炒羊杂\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d068\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"木须肉\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d069\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"地三鲜\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d070\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"西红柿炒蛋\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d071\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"五花肉炒蛋\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d072\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"过油肉土豆片\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d073\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"有机菜花\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d074\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"麻婆豆腐\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d075\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"黄瓜炒鸡蛋\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d076\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"家常豆腐\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d077\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"肉炒腐竹\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d078\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"酱香鸡蛋\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d079\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"葱花鸡蛋\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d080\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"鸭肠炒饭\",\n      \"price\": 11\n    },\n    {\n      \"id\": \"c1d081\",\n      \"stallId\": \"c1s4\",\n      \"name\": \"扬州炒饭\",\n      \"price\": 11\n    },\n    {\n      \"id\": \"c1d082\",\n      \"stallId\": \"c1s5\",\n      \"name\": \"猪肉大葱\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d083\",\n      \"stallId\": \"c1s5\",\n      \"name\": \"猪肉土豆\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"c1d084\",\n      \"stallId\": \"c1s5\",\n      \"name\": \"猪肉玉米\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d085\",\n      \"stallId\": \"c1s5\",\n      \"name\": \"韭菜鸡蛋\",\n      \"price\": 11\n    },\n    {\n      \"id\": \"c1d086\",\n      \"stallId\": \"c1s5\",\n      \"name\": \"猪肉酸菜\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d087\",\n      \"stallId\": \"c1s6\",\n      \"name\": \"虎皮椒炒肉\",\n      \"price\": 13.9\n    },\n    {\n      \"id\": \"c1d088\",\n      \"stallId\": \"c1s6\",\n      \"name\": \"虎皮椒五花肉\",\n      \"price\": 14.9\n    },\n    {\n      \"id\": \"c1d089\",\n      \"stallId\": \"c1s6\",\n      \"name\": \"18秒鸡胗\",\n      \"price\": 14.9\n    },\n    {\n      \"id\": \"c1d090\",\n      \"stallId\": \"c1s6\",\n      \"name\": \"鱼香肉丝\",\n      \"price\": 13.9\n    },\n    {\n      \"id\": \"c1d091\",\n      \"stallId\": \"c1s6\",\n      \"name\": \"宫爆鸡丁\",\n      \"price\": 13.9\n    },\n    {\n      \"id\": \"c1d092\",\n      \"stallId\": \"c1s6\",\n      \"name\": \"肉炒鹿茸菇\",\n      \"price\": 13.9\n    },\n    {\n      \"id\": \"c1d093\",\n      \"stallId\": \"c1s6\",\n      \"name\": \"小炒牛肉\",\n      \"price\": 17.9\n    },\n    {\n      \"id\": \"c1d094\",\n      \"stallId\": \"c1s6\",\n      \"name\": \"山野真菌小炒\",\n      \"price\": 12.9\n    },\n    {\n      \"id\": \"c1d095\",\n      \"stallId\": \"c1s6\",\n      \"name\": \"肉沫土豆丝\",\n      \"price\": 9.9\n    },\n    {\n      \"id\": \"c1d096\",\n      \"stallId\": \"c1s6\",\n      \"name\": \"蜜汁酥糖鸡\",\n      \"price\": 14.9\n    },\n    {\n      \"id\": \"c1d097\",\n      \"stallId\": \"c1s6\",\n      \"name\": \"客家小炒肉\",\n      \"price\": 13.9\n    },\n    {\n      \"id\": \"c1d098\",\n      \"stallId\": \"c1s6\",\n      \"name\": \"腊肉豆干\",\n      \"price\": 13.9\n    },\n    {\n      \"id\": \"c1d099\",\n      \"stallId\": \"c1s6\",\n      \"name\": \"麻辣豆腐\",\n      \"price\": 9.9\n    },\n    {\n      \"id\": \"c1d100\",\n      \"stallId\": \"c1s6\",\n      \"name\": \"乡村一碗香\",\n      \"price\": 13.9\n    },\n    {\n      \"id\": \"c1d101\",\n      \"stallId\": \"c1s7\",\n      \"name\": \"农家一碗香\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"c1d102\",\n      \"stallId\": \"c1s7\",\n      \"name\": \"辣椒炒肉\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"c1d103\",\n      \"stallId\": \"c1s7\",\n      \"name\": \"双椒鸡丁\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d104\",\n      \"stallId\": \"c1s7\",\n      \"name\": \"鱼香肉丝\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"c1d105\",\n      \"stallId\": \"c1s7\",\n      \"name\": \"爆炒腰花\",\n      \"price\": 15\n    },\n    {\n      \"id\": \"c1d106\",\n      \"stallId\": \"c1s7\",\n      \"name\": \"爆炒猪肝\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d107\",\n      \"stallId\": \"c1s7\",\n      \"name\": \"爆炒鸡杂\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"c1d108\",\n      \"stallId\": \"c1s7\",\n      \"name\": \"肉沫茄子\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"c1d109\",\n      \"stallId\": \"c1s8\",\n      \"name\": \"牛肉汤\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"c1d110\",\n      \"stallId\": \"c1s8\",\n      \"name\": \"加肉牛肉汤\",\n      \"price\": 20\n    },\n    {\n      \"id\": \"c1d111\",\n      \"stallId\": \"c1s8\",\n      \"name\": \"牛肉丸子汤\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d112\",\n      \"stallId\": \"c1s8\",\n      \"name\": \"烧饼\",\n      \"price\": 2,\n      \"unit\": \"元（2/个）\"\n    },\n    {\n      \"id\": \"c1d113\",\n      \"stallId\": \"c1s8\",\n      \"name\": \"丸子\",\n      \"price\": 2,\n      \"unit\": \"元（2/个）\"\n    },\n    {\n      \"id\": \"c1d114\",\n      \"stallId\": \"c1s8\",\n      \"name\": \"炸蛋\",\n      \"price\": 3,\n      \"unit\": \"元（3/个）\"\n    },\n    {\n      \"id\": \"c1d115\",\n      \"stallId\": \"c1s9\",\n      \"name\": \"烤盘饭\",\n      \"price\": 9.9,\n      \"unit\": \"元/斤起\"\n    },\n    {\n      \"id\": \"c1d116\",\n      \"stallId\": \"c1s9\",\n      \"name\": \"米饭\",\n      \"price\": 1\n    },\n    {\n      \"id\": \"c1d117\",\n      \"stallId\": \"c1s10\",\n      \"name\": \"秘制把子肉饭\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"c1d118\",\n      \"stallId\": \"c1s10\",\n      \"name\": \"把子肉卤肉饭\",\n      \"price\": 15\n    },\n    {\n      \"id\": \"c1d119\",\n      \"stallId\": \"c1s10\",\n      \"name\": \"爆二爷把子肉饭\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"c1d120\",\n      \"stallId\": \"c1s10\",\n      \"name\": \"秘制卤肉饭\",\n      \"price\": 15\n    },\n    {\n      \"id\": \"c1d121\",\n      \"stallId\": \"c1s10\",\n      \"name\": \"酱香口水鸡\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"c1d122\",\n      \"stallId\": \"c1s10\",\n      \"name\": \"招牌手撕鸡\",\n      \"price\": 16\n    },\n    {\n      \"id\": \"c1d123\",\n      \"stallId\": \"c1s10\",\n      \"name\": \"酱卤鸡肉饭\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"c1d124\",\n      \"stallId\": \"c1s10\",\n      \"name\": \"秘制鸡腿饭\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"c1d125\",\n      \"stallId\": \"c1s10\",\n      \"name\": \"塔汁鸡元宝\",\n      \"price\": 10\n    },\n    {\n      \"id\": \"c1d126\",\n      \"stallId\": \"c1s10\",\n      \"name\": \"酱香卤鸡饭\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"c1d127\",\n      \"stallId\": \"c1s11\",\n      \"name\": \"麻辣烫\",\n      \"price\": 17.8,\n      \"unit\": \"元/斤\"\n    },\n    {\n      \"id\": \"c1d128\",\n      \"stallId\": \"c1s12\",\n      \"name\": \"大块牛肉焖面\",\n      \"price\": 16\n    },\n    {\n      \"id\": \"c1d129\",\n      \"stallId\": \"c1s12\",\n      \"name\": \"排骨焖面\",\n      \"price\": 15\n    },\n    {\n      \"id\": \"c1d130\",\n      \"stallId\": \"c1s12\",\n      \"name\": \"香菇肉臊焖面\",\n      \"price\": 15\n    },\n    {\n      \"id\": \"c1d131\",\n      \"stallId\": \"c1s12\",\n      \"name\": \"杂丸焖面\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"c1d132\",\n      \"stallId\": \"c1s12\",\n      \"name\": \"番茄煎蛋焖面\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"c1d133\",\n      \"stallId\": \"c1s12\",\n      \"name\": \"时蔬焖面\",\n      \"price\": 11\n    },\n    {\n      \"id\": \"c1d134\",\n      \"stallId\": \"c1s12\",\n      \"name\": \"鸡柳焖面\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d135\",\n      \"stallId\": \"c1s12\",\n      \"name\": \"小鲜肉焖面\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d136\",\n      \"stallId\": \"c1s12\",\n      \"name\": \"小酥肉焖面\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d137\",\n      \"stallId\": \"c1s12\",\n      \"name\": \"鹿茸菌腊肠焖面\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"c1d138\",\n      \"stallId\": \"c1s12\",\n      \"name\": \"黑猪肉酸菜焖面\",\n      \"price\": 15\n    },\n    {\n      \"id\": \"c1d139\",\n      \"stallId\": \"c1s12\",\n      \"name\": \"大盘鸡焖面\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d140\",\n      \"stallId\": \"c1s13\",\n      \"name\": \"大份烤鸭拌饭\",\n      \"price\": 15\n    },\n    {\n      \"id\": \"c1d141\",\n      \"stallId\": \"c1s13\",\n      \"name\": \"小份烤鸭拌饭\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"c1d142\",\n      \"stallId\": \"c1s14\",\n      \"name\": \"孜然火腿拌面\",\n      \"price\": 11\n    },\n    {\n      \"id\": \"c1d143\",\n      \"stallId\": \"c1s14\",\n      \"name\": \"火鸡拌面\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"c1d144\",\n      \"stallId\": \"c1s14\",\n      \"name\": \"麻酱鸡丝拌面\",\n      \"price\": 10\n    },\n    {\n      \"id\": \"c1d145\",\n      \"stallId\": \"c1s14\",\n      \"name\": \"秘制炸酱面\",\n      \"price\": 10\n    },\n    {\n      \"id\": \"c1d146\",\n      \"stallId\": \"c1s14\",\n      \"name\": \"西红柿鸡蛋拌面\",\n      \"price\": 10\n    },\n    {\n      \"id\": \"c1d147\",\n      \"stallId\": \"c1s14\",\n      \"name\": \"肉燥酸菜拌面\",\n      \"price\": 10\n    },\n    {\n      \"id\": \"c1d148\",\n      \"stallId\": \"c1s14\",\n      \"name\": \"麻酱拌面\",\n      \"price\": 9\n    },\n    {\n      \"id\": \"c1d149\",\n      \"stallId\": \"c1s14\",\n      \"name\": \"私房葱油面\",\n      \"price\": 9\n    },\n    {\n      \"id\": \"c1d150\",\n      \"stallId\": \"c1s14\",\n      \"name\": \"拌骨拌面\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d151\",\n      \"stallId\": \"c1s14\",\n      \"name\": \"孜然肉拌面\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"c1d152\",\n      \"stallId\": \"c1s14\",\n      \"name\": \"辣子鸡拌面\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"c1d153\",\n      \"stallId\": \"c1s14\",\n      \"name\": \"椒麻鸡丝拌面\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"c1d154\",\n      \"stallId\": \"c1s14\",\n      \"name\": \"馋嘴肉酱拌面\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"c1d155\",\n      \"stallId\": \"c1s14\",\n      \"name\": \"咸蛋黄肉酱拌面\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"c1d156\",\n      \"stallId\": \"c1s14\",\n      \"name\": \"咸鸡蛋茄丁拌面\",\n      \"price\": 10\n    },\n    {\n      \"id\": \"c1d157\",\n      \"stallId\": \"c1s14\",\n      \"name\": \"杏鲍菇茄丁拌面\",\n      \"price\": 10\n    },\n    {\n      \"id\": \"c1d158\",\n      \"stallId\": \"c1s14\",\n      \"name\": \"肉燥酸豆角拌面\",\n      \"price\": 10\n    },\n    {\n      \"id\": \"c1d159\",\n      \"stallId\": \"c1s14\",\n      \"name\": \"炸酱+西红柿鸡蛋/杏鲍菇茄丁\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"c1d160\",\n      \"stallId\": \"c1s14\",\n      \"name\": \"辣子鸡+西红柿鸡蛋/杏鲍菇茄丁\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"c1d161\",\n      \"stallId\": \"c1s14\",\n      \"name\": \"酸菜肉丝+西红柿鸡蛋/杏鲍菇茄丁\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"c1d162\",\n      \"stallId\": \"c1s14\",\n      \"name\": \"咸蛋黄+西红柿鸡蛋/杏鲍菇茄丁\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"c1d163\",\n      \"stallId\": \"c1s14\",\n      \"name\": \"双素拼+西红柿鸡蛋/杏鲍菇茄丁\",\n      \"price\": 10\n    },\n    {\n      \"id\": \"c1d164\",\n      \"stallId\": \"c1s14\",\n      \"name\": \"大块牛肉汤面\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"c1d165\",\n      \"stallId\": \"c1s14\",\n      \"name\": \"辣子鸡汤面\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"c1d166\",\n      \"stallId\": \"c1s14\",\n      \"name\": \"肉燥豆角汤面\",\n      \"price\": 10\n    },\n    {\n      \"id\": \"c1d167\",\n      \"stallId\": \"c1s14\",\n      \"name\": \"番茄鸡蛋汤面\",\n      \"price\": 9\n    },\n    {\n      \"id\": \"c1d168\",\n      \"stallId\": \"c1s14\",\n      \"name\": \"肉燥酸菜汤面\",\n      \"price\": 10\n    },\n    {\n      \"id\": \"c1d169\",\n      \"stallId\": \"c1s14\",\n      \"name\": \"肉燥酸豆角汤面\",\n      \"price\": 10\n    },\n    {\n      \"id\": \"c1d170\",\n      \"stallId\": \"c1s14\",\n      \"name\": \"杏鲍菇茄丁汤面\",\n      \"price\": 9\n    },\n    {\n      \"id\": \"c1d171\",\n      \"stallId\": \"c1s14\",\n      \"name\": \"杂骨汤面\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d172\",\n      \"stallId\": \"c1s14\",\n      \"name\": \"香菇牛肉面\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"c1d173\",\n      \"stallId\": \"c1s14\",\n      \"name\": \"香菇肉面\",\n      \"price\": 12\n    },\n    {\n      \"id\": \"c1d174\",\n      \"stallId\": \"c1s14\",\n      \"name\": \"肉沫汤面\",\n      \"price\": 10\n    },\n    {\n      \"id\": \"c1d175\",\n      \"stallId\": \"c1s14\",\n      \"name\": \"排骨汤面\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d176\",\n      \"stallId\": \"c1s14\",\n      \"name\": \"番茄牛肉面\",\n      \"price\": 14\n    },\n    {\n      \"id\": \"c1d177\",\n      \"stallId\": \"c1s14\",\n      \"name\": \"金汤肥牛面\",\n      \"price\": 13\n    },\n    {\n      \"id\": \"c1d178\",\n      \"stallId\": \"c1s15\",\n      \"name\": \"紫米饭团\",\n      \"price\": 8\n    },\n    {\n      \"id\": \"c1d179\",\n      \"stallId\": \"c1s15\",\n      \"name\": \"里脊肉饼\",\n      \"price\": 9\n    },\n    {\n      \"id\": \"c1d180\",\n      \"stallId\": \"c1s15\",\n      \"name\": \"里脊肉拌紫米饭\",\n      \"price\": 15\n    },\n    {\n      \"id\": \"c1d181\",\n      \"stallId\": \"c1s15\",\n      \"name\": \"芝士片（加料）\",\n      \"price\": 2,\n      \"unit\": \"元（加料）\"\n    },\n    {\n      \"id\": \"c1d182\",\n      \"stallId\": \"c1s15\",\n      \"name\": \"咸鸡蛋黄（加料）\",\n      \"price\": 2,\n      \"unit\": \"元（加料）\"\n    },\n    {\n      \"id\": \"c1d183\",\n      \"stallId\": \"c1s15\",\n      \"name\": \"火山石烤肠（加料）\",\n      \"price\": 3,\n      \"unit\": \"元（加料）\"\n    },\n    {\n      \"id\": \"c1d184\",\n      \"stallId\": \"c1s15\",\n      \"name\": \"咔滋鸡排（加料）\",\n      \"price\": 2,\n      \"unit\": \"元（加料）\"\n    },\n    {\n      \"id\": \"c1d185\",\n      \"stallId\": \"c1s15\",\n      \"name\": \"里脊肉（加料）\",\n      \"price\": 3,\n      \"unit\": \"元（加料）\"\n    },\n    {\n      \"id\": \"c1d186\",\n      \"stallId\": \"c1s15\",\n      \"name\": \"肉夹馍\",\n      \"price\": 9\n    },\n    {\n      \"id\": \"c1d187\",\n      \"stallId\": \"c1s15\",\n      \"name\": \"鸡蛋火腿夹馍\",\n      \"price\": 8\n    },\n    {\n      \"id\": \"c1d188\",\n      \"stallId\": \"c1s15\",\n      \"name\": \"小米粥\",\n      \"price\": 3\n    },\n    {\n      \"id\": \"c1d189\",\n      \"stallId\": \"c1s15\",\n      \"name\": \"裙带菜蛋花汤\",\n      \"price\": 3\n    },\n    {\n      \"id\": \"c1d190\",\n      \"stallId\": \"c1s15\",\n      \"name\": \"淀粉肠\",\n      \"price\": 3,\n      \"unit\": \"元（3/根 5/2根）\"\n    },\n    {\n      \"id\": \"c1d191\",\n      \"stallId\": \"c1s15\",\n      \"name\": \"红豆桂花小圆子\",\n      \"price\": 8,\n      \"unit\": \"元（8/大 5/小）\"\n    },\n    {\n      \"id\": \"c1d192\",\n      \"stallId\": \"c1s15\",\n      \"name\": \"银耳雪梨汤\",\n      \"price\": 8,\n      \"unit\": \"元（8/大 5/小）\"\n    }\n  ]\n}\n";

let MENU = null;
function menu() {
  if (!MENU) MENU = loadMenu();
  return MENU;
}

/** 把菜单建成若干查找表，供榜单补名字用 */
function menuIndex() {
  const m = menu();
  const stall = new Map();
  const canteen = new Map();
  const dish = new Map();
  m.stalls.forEach((s) => stall.set(s.id, s));
  m.canteens.forEach((c) => canteen.set(c.id, c));
  m.dishes.forEach((d) => dish.set(d.id, d));

  const stallName = (id) => (stall.get(id) || {}).name || '';
  const canteenName = (id) => (canteen.get(id) || {}).name || '';
  const dishName = (id) => (dish.get(id) || {}).name || '';

  // 名字 -> id 反查（飞书表里只存名字时用得上）
  const byStallName = new Map();
  m.stalls.forEach((s) => byStallName.set(s.name, s.id));
  const byCanteenName = new Map();
  m.canteens.forEach((c) => byCanteenName.set(c.name, c.id));
  const byNamePair = new Map();
  m.dishes.forEach((d) => {
    const s = stall.get(d.stallId);
    if (s) byNamePair.set(s.name + '||' + d.name, d.id);
  });

  return {
    stallName, canteenName, dishName,
    stallMetaOf: (id) => stall.get(id) || {},
    metaOf: (id) => {
      const d = dish.get(id) || {};
      return { price: d.price != null ? d.price : null, unit: d.unit || '元' };
    },
    byStallName, byCanteenName, byNamePair,
    stallById: stall, canteenById: canteen, dishById: dish
  };
}

/**
 * 把存储层返回的记录统一成榜单算法要的格式。
 * 关键作用：飞书表里可能有菜单里没有的菜（老数据/改名），这里兜底，
 * 保证"永远不会因为对不上菜单而导致榜单缺数据"。
 */
function normalizeRecords(records) {
  const idx = menuIndex();
  return records.map((r) => {
    let { dishId, stallId, canteenId } = r;

    if (!dishId || !idx.dishById.has(dishId)) {
      const guess = idx.byNamePair.get((r.stallName || '') + '||' + (r.dishName || ''));
      dishId = guess || dishId || ('x:' + (r.stallName || '') + '||' + (r.dishName || ''));
    }
    const d = idx.dishById.get(dishId);
    if (d) {
      stallId = d.stallId;
    } else if (!stallId) {
      stallId = idx.byStallName.get(r.stallName) || ('x:' + (r.stallName || '未知档口'));
    }
    const s = idx.stallById.get(stallId);
    if (s) canteenId = s.canteenId;
    else if (!canteenId) canteenId = idx.byCanteenName.get(r.canteenName) || ('x:' + (r.canteenName || '未知食堂'));

    return {
      dishId,
      dishName: r.dishName || idx.dishName(dishId),
      stallId,
      stallName: idx.stallName(stallId) || r.stallName || '未知档口',
      canteenId,
      canteenName: idx.canteenName(canteenId) || r.canteenName || '未知食堂',
      sum: Number(r.sum) || 0,
      votes: Number(r.votes) || 0
    };
  });
}

function boardContext() {
  const idx = menuIndex();
  const active = menu().campuses.find((c) => c.active) || menu().campuses[0] || {};
  return {
    stallNameOf: idx.stallName,
    canteenNameOf: idx.canteenName,
    dishNameOf: idx.dishName,
    metaOf: idx.metaOf,
    stallMetaOf: idx.stallMetaOf,
    campusName: active.name || '主校区'
  };
}

/* ============================ 防刷（IP + 菜品 + 日期） ============================ */
/**
 * 需求文档要求"同一个手机 IP，对同一个菜品一天只能提交一次"。
 * 现实问题：校园网很多同学共用一个出口 IP，死按 IP 会误伤室友。
 * 所以判定条件是 IP + 菜品 + 日期 三者全同 —— 同一天同一道菜才算重复，
 * 换一道菜、换一天都能正常打分。
 *
 * 局限（如实说明）：这份计数放在进程内存里，Serverless 冷启动会重置，
 * 且多实例之间不共享。真正的强约束靠飞书表里那条聚合记录的"人数"增长不可逆 +
 * 前端本地记录兜底。要 100% 严格请见落地方案附录的"明细表"升级方案。
 */
const rateLimit = {
  seen: new Map(),      // key: ip|date|dishId （已成功写入）
  inflight: new Map(),  // key: ip|date|dishId （正在写入，用于挡住并发重复提交）
  lastPrune: 0,
  prune() {
    const now = Date.now();
    if (now - this.lastPrune < 60 * 60 * 1000) return;
    this.lastPrune = now;
    for (const [k, ts] of this.seen) {
      if (now - ts > 48 * 3600 * 1000) this.seen.delete(k);
    }
    for (const [k, ts] of this.inflight) {
      if (now - ts > 60 * 1000) this.inflight.delete(k);   // 卡死的占坑自动释放
    }
  },
  key(ip, date, dishId) {
    return ip + '|' + date + '|' + dishId;
  },
  check(ip, date, dishId) {
    this.prune();
    const k = this.key(ip, date, dishId);
    return this.seen.has(k) || this.inflight.has(k);
  },
  /** 原子占坑：返回 true 表示抢到了，false 表示已存在/正在提交 */
  reserve(ip, date, dishId) {
    this.prune();
    const k = this.key(ip, date, dishId);
    if (this.seen.has(k) || this.inflight.has(k)) return false;
    this.inflight.set(k, Date.now());   // 同步写入，Node 单线程下不会被打断
    return true;
  },
  /** 写入成功：转为永久记录 */
  commit(ip, date, dishId) {
    const k = this.key(ip, date, dishId);
    this.inflight.delete(k);
    this.seen.set(k, Date.now());
  },
  /** 写入失败：释放占坑，允许用户重试 */
  release(ip, date, dishId) {
    this.inflight.delete(this.key(ip, date, dishId));
  }
};

/** 北京时间日期串（全校都在东八区，统一口径避免跨天判错） */
function beijingDate(ts = Date.now()) {
  const d = new Date(ts + 8 * 3600 * 1000);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return d.getUTCFullYear() + '-' + mm + '-' + dd;
}

function clientIp(headers, socketIp) {
  const xff = headers['x-forwarded-for'] || headers['x-real-ip'] || '';
  const first = String(xff).split(',')[0].trim();
  return first || socketIp || 'unknown';
}

function hashIp(ip) {
  return crypto.createHash('sha256').update(String(ip) + '|hongde').digest('hex').slice(0, 12);
}

/* ============================ 接口实现 ============================ */
/** 当前展示的是不是演示数据（真实数据文件为空时才会是 true） */
function isDemo() {
  // 注意用 FEISHU_OK 而不是 USE_FEISHU：飞书探测失败降级到本地后，
  // 就该按本地文件的情况判断是否在展示演示数据。
  return FEISHU_OK ? false : (typeof store.isShowingDemo === 'function' && store.isShowingDemo());
}

async function apiMenu() {
  const m = menu();
  const active = m.campuses.find((c) => c.active) || m.campuses[0];
  return {
    campuses: m.campuses,
    canteens: m.canteens.filter((c) => c.campusId === active.id),
    stalls: m.stalls,
    dishes: m.dishes,
    isDemoData: isDemo()
  };
}

async function apiRate(body, ctx) {
  const dishId = String(body.dishId || '').trim();
  const score = Number(body.score);
  const comment = String(body.comment || '').trim().slice(0, 30);

  if (!dishId) throw badRequest('缺少菜品');
  if (!Number.isInteger(score) || score < 1 || score > 5) throw badRequest('评分必须是 1~5 的整数');

  const idx = menuIndex();
  const dish = idx.dishById.get(dishId);
  if (!dish) throw badRequest('菜品不存在，请刷新页面重试');

  const stall = idx.stallById.get(dish.stallId) || {};
  const canteen = idx.canteenById.get(stall.canteenId) || {};
  const campus = menu().campuses.find((c) => c.id === canteen.campusId) || {};

  // 防刷：同 IP + 同菜品 + 同一天。reserve 是同步原子占坑，
  // 连点两下 / 并发请求也只会有一次进入写库流程。
  if (!rateLimit.reserve(ctx.ip, ctx.date, dishId)) {
    const e = new Error('你今天已经给这道菜打过分了，明天再来～');
    e.status = 409;
    throw e;
  }

  const input = {
    dishId,
    dishName: dish.name,
    stallId: stall.id,
    stallName: stall.name,
    canteenId: canteen.id,
    canteenName: canteen.name,
    campusName: campus.name || '主校区',
    score
  };

  let result;
  try {
    result = await store.applyRating(input);
  } catch (err) {
    rateLimit.release(ctx.ip, ctx.date, dishId);   // 写失败把坑还回去，否则用户当天再也提交不了
    throw err;
  }
  rateLimit.commit(ctx.ip, ctx.date, dishId);

  if (store.appendDetail) {
    store.appendDetail({
      at: new Date().toISOString(),
      date: ctx.date,
      ip: hashIp(ctx.ip),          // 只存哈希，不留原始 IP
      dishId,
      dishName: dish.name,
      stallName: stall.name,
      canteenName: canteen.name,
      score,
      comment
    }).catch(() => {});
  }

  const rec = result.record || {};
  const sum = Number(rec.sum) || score;
  const votes = Number(rec.votes) || 1;

  return {
    ok: true,
    isNewDish: !!result.isNew,
    dishName: dish.name,
    stallName: stall.name,
    canteenName: canteen.name,
    score,
    totalVotes: votes,
    dishAverage: rankings.rawAverage(sum, votes),
    qualified: votes >= rankings.MIN_VOTES,
    needMoreVotes: Math.max(0, rankings.MIN_VOTES - votes),
    message: votes >= rankings.MIN_VOTES
      ? '已计入榜单'
      : '再攒 ' + (rankings.MIN_VOTES - votes) + ' 人打分就能进榜了'
  };
}

async function apiRateStatus(query, ctx) {
  const dishId = String(query.dishId || '').trim();
  const rated = dishId ? rateLimit.check(ctx.ip, ctx.date, dishId) : false;
  const data = store.__peek ? store.__peek() : null;
  return { date: ctx.date, dishId, rated, localStoreSize: data ? data.size : undefined };
}

async function apiBoardCanteen(query) {
  const canteenId = String(query.canteenId || '').trim();
  const idx = menuIndex();
  const canteen = idx.canteenById.get(canteenId);
  if (!canteen) throw badRequest('食堂不存在');
  const records = normalizeRecords(await store.list());
  const board = rankings.canteenBoard(records, boardContext(), canteenId, canteen.name);
  board.isDemoData = isDemo();
  return board;
}

async function apiBoardAll(query) {
  const limit = Math.min(50, Math.max(1, Number(query.limit) || 20));
  const records = normalizeRecords(await store.list());
  const board = rankings.allBoard(records, boardContext(), limit);
  board.isDemoData = isDemo();
  return board;
}

async function apiStats() {
  const records = normalizeRecords(await store.list());
  const boards = rankings.computeBoards(records, boardContext());
  const totalVotes = records.reduce((a, r) => a + r.votes, 0);
  const demo = FEISHU_OK ? false : (typeof store.isShowingDemo === 'function' && store.isShowingDemo());
  // 降级时明确写出来，避免用户以为分数进了飞书表
  let dataSource;
  if (FEISHU_OK) dataSource = '飞书多维表格';
  else if (demo) dataSource = '演示数据（还没人真实打分）';
  else if (USE_FEISHU) dataSource = '本地文件（飞书暂时连不上，已自动降级）';
  else dataSource = '本地文件（未接飞书）';
  return {
    dataSource,
    isDemoData: demo,
    feishuDegraded: !!(USE_FEISHU && !FEISHU_OK),
    degradeReason: DEGRADE_REASON || undefined,
    dishes: records.length,
    totalVotes,
    qualifiedDishes: boards.dishes.length,
    activeStalls: boards.stalls.length,
    minVotes: rankings.MIN_VOTES
  };
}

/* ============================ 路由（框架无关） ============================ */
function badRequest(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

/**
 * 纯函数版路由：输入一个请求描述，返回一个响应对象。
 *
 * 为什么要做成纯函数：同一套接口要同时跑在三种地方 ——
 *   1. 本地 node:http 服务（手机同 WiFi 调试用）
 *   2. Netlify 云函数（Lambda 风格 event/context，不是 req/res！）
 *   3. Vercel 云函数
 * 如果直接写成 (req, res) 风格，云函数那边就套不上（我为此白折腾了好几轮部署）。
 *
 * @param {{method:string, path:string, headers:object, body:string}} request
 * @param {{ip:string, date:string}} ctx
 * @returns {Promise<{status:number, headers:object, body:string}>}
 */
async function route(request, ctx) {
  const url = new URL(request.path, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  const query = Object.fromEntries(url.searchParams.entries());
  const method = request.method || 'GET';

  const json = (code, obj) => ({
    status: code,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(obj)
  });

  try {
    if (pathname === '/api/menu' && method === 'GET') return json(200, await apiMenu());
    if (pathname === '/api/stats' && method === 'GET') return json(200, await apiStats());
    if (pathname === '/api/rate/status' && method === 'GET') return json(200, await apiRateStatus(query, ctx));
    if (pathname === '/api/board/canteen' && method === 'GET') return json(200, await apiBoardCanteen(query));
    if (pathname === '/api/board/all' && method === 'GET') return json(200, await apiBoardAll(query));

    if (pathname === '/api/rate') {
      if (method !== 'POST') return json(405, { error: '只支持 POST' });
      let body = {};
      const raw = request.body || '';
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch (e) {
          throw badRequest('请求格式不是合法 JSON');
        }
      }
      return json(200, await apiRate(body, ctx));
    }

    return json(404, { error: '接口不存在: ' + pathname });
  } catch (err) {
    const code = err.status || 500;
    if (code >= 500) console.error('[api error]', pathname, err);
    return json(code, { error: err.message || '服务器错误', code });
  }
}

/** 本地服务器用：把 node:http 的 req/res 接到 router 上 */
async function handleRequest(req, res) {
  const ctx = {
    ip: clientIp(req.headers, req.socket && req.socket.remoteAddress),
    date: beijingDate()
  };

  // 非 /api/ 的请求直接走静态文件（本地开发才需要）
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (!pathname.startsWith('/api/')) {
    return serveStatic(pathname, res);
  }

  const raw = await readRawBody(req);
  const out = await route(
    { method: req.method, path: req.url, headers: req.headers, body: raw },
    ctx
  );
  res.writeHead(out.status, Object.assign({}, out.headers, {
    'Content-Length': Buffer.byteLength(out.body)
  }));
  res.end(out.body);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) {                 // 1MB 上限，防止被塞爆
        reject(badRequest('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

/* ============================ 静态资源 ============================ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function serveStatic(pathname, res) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const target = path.normalize(path.join(PUBLIC_DIR, rel));
  // 防止 ../../ 穿越到 public 外面
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('403');
    return;
  }
  fs.readFile(target, (err, buf) => {
    if (err) {
      // 找不到就回首页（前端是单页，刷新子路径也不会白屏）
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(404).end('404'); return; }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        res.end(html);
      });
      return;
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'no-cache'
    });
    res.end(buf);
  });
}

/* ============================ 本地服务器入口 ============================ */
function lanAddresses(port) {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push('http://' + net.address + ':' + port);
    }
  }
  return out;
}

function startServer(port) {
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error('[fatal]', err);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '服务器内部错误' }));
    });
  });
  server.listen(port, () => {
    let source;
    if (FEISHU_OK) source = '飞书多维表格（同学们的打分会写进你的飞书表）';
    else if (isDemo()) source = '演示数据（还没有人真实打分，等你打第一个分）';
    else source = '本地文件 data/ratings.json';
    const lines = [
      '',
      '  ✅ 鸿德食堂打分工具 已启动',
      '  ─────────────────────────────────────────────',
      '  数据源：' + source,
    ];
    if (FEISHU_OK && ENV_FILE) {
      lines.push('  配置来自：' + path.relative(ROOT, ENV_FILE.file) + '（' + ENV_FILE.count + ' 项）');
      lines.push('  飞书表格：https://my.feishu.cn/base/' + FEISHU_CFG.appToken);
    } else if (!USE_FEISHU && ENV_FILE) {
      lines.push('  配置来自：' + path.relative(ROOT, ENV_FILE.file) + '（但飞书 4 个值没配齐，仍用本地文件）');
    }
    // 飞书配了但探测失败 → 明确警告，避免用户以为数据进了飞书
    if (USE_FEISHU && !FEISHU_OK) {
      lines.push('');
      lines.push('  ⚠️ 飞书暂时连不上，已经自动改用本地存储（网站能正常用，分数不会丢）');
      lines.push('     原因：' + DEGRADE_REASON);
      lines.push('     分数会存在 data\\ratings.json；飞书恢复后重启本服务即可切回飞书表。');
    }
    lines.push('  电脑打开：  http://localhost:' + port);
    const lan = lanAddresses(port);
    if (lan.length) {
      lines.push('  手机打开：  ' + lan.map((u) => u).join('\n              '));
      lines.push('              （手机连同一个 WiFi，扫上面这个地址的二维码即可）');
    }
    lines.push('  停止服务：  Ctrl + C', '');
    console.log(lines.join('\n'));
  });
  return server;
}

/** 启动入口：先探测飞书，再开服务（探测失败就降级本地存储） */
async function main(port) {
  if (USE_FEISHU) {
    const r = await probeFeishu();
    if (!r.ok) {
      FEISHU_OK = false;
      DEGRADE_REASON = r.reason;
      store = makeFileStore();
    }
  }
  return startServer(port);
}

/**
 * 部署平台（Netlify / Vercel）的入口。
 *
 * Netlify 走的是 **Lambda 风格**：函数签名是 (event, context)，返回值要是一个对象，
 * 不是 Node 的 (req, res) —— 这一点我一开始搞错了，函数部署上去一直 404。
 * Vercel 则更接近 Node 的 req/res，所以下面两种都兼容。
 */
module.exports = async function handler(event, context) {
  // —— Netlify / Lambda 风格：event 里带 httpMethod / path / headers / body ——
  if (event && typeof event === 'object' && (event.httpMethod || event.requestContext)) {
    const headers = event.headers || {};
    const ip = (headers['x-forwarded-for'] || headers['client-ip'] || '').split(',')[0].trim()
      || (event.requestContext && event.requestContext.identity && event.requestContext.identity.sourceIp)
      || 'unknown';
    // Netlify 的 event.path 不含 query，rawUrl 才含
    const path = event.rawUrl
      ? event.rawUrl.replace(/^https?:\/\/[^/]+/, '')
      : (event.path || '/') + (event.rawQuery ? '?' + event.rawQuery : '');
    const isBase64 = !!event.isBase64Encoded;
    const body = event.body
      ? (isBase64 ? Buffer.from(event.body, 'base64').toString('utf8') : event.body)
      : '';

    const out = await route({ method: event.httpMethod || 'GET', path, headers, body },
      { ip, date: beijingDate() });
    return {
      statusCode: out.status,
      headers: out.headers,
      body: out.body,
      isBase64Encoded: false
    };
  }

  // —— Vercel / Node 风格：有 res.writeHead ——
  if (event && typeof event.writeHead === 'function') {
    return handleRequest(event, context);
  }

  throw new Error('无法识别的函数调用方式');
};

module.exports.handleRequest = handleRequest;
module.exports.route = route;
module.exports.startServer = startServer;
module.exports.main = main;
module.exports.__internal = {
  beijingDate, clientIp, normalizeRecords, menuIndex, rateLimit,
  loadMenu, get MENU() { return MENU; }, set MENU(v) { MENU = v; },
  get FEISHU_OK() { return FEISHU_OK; }, get DEGRADE_REASON() { return DEGRADE_REASON; },
  probeFeishu
};

if (require.main === module) {
  const port = Number(process.env.PORT) || 5173;
  main(port).catch((err) => { console.error('[fatal] 启动失败：', err); process.exit(1); });
}

});


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
