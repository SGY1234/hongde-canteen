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

const store = USE_FEISHU
  ? new stores.FeishuStore(FEISHU_CFG)
  : new stores.FileStore({
      file: path.join(DATA_DIR, 'ratings.json'),
      detailsFile: path.join(DATA_DIR, 'details.json'),
      // 真实数据为空时展示这份演示数据，让第一次打开的人立刻看懂榜单长什么样
      fallbackFile: path.join(ROOT, 'demo', 'ratings.demo.json')
    });

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
const EMBEDDED_MENU_JSON = "{\n  \"_说明\": \"这是菜单数据源，你只需要改这个文件。改完刷新页面即可生效，不用重新部署。\",\n  \"_结构说明\": [\n    \"canteens 是食堂/店；每个 canteen 有一个 stallMode 标记它内部怎么卖：\",\n    \"  stallMode = single-menu  → 就一个菜单（页面自动跳过「选窗口」，同学少点一次）\",\n    \"  stallMode = multi-stall  → 里面有好几个窗口（页面让同学先选窗口）\",\n    \"stalls 是窗口；dishes 是菜品，用 stallId 挂到窗口上\",\n    \"stall 的 code 字段 = 现场挂的红圈窗口号（如 14号窗口），展示用\"\n  ],\n  \"_数据来源\": \"小张餐厅二楼实拍菜单照片（2026-10-14 晚上），逆时针从东北角起共 14 家。价格按照片录入，可随时修改。\",\n  \"_校对提示\": \"小张餐厅二楼 12 个窗口（290 道菜）已按实拍照片逐条录入并核对完毕。金冠、昕辉、民族餐厅、汤姆大叔的菜名和价格还是待拍状态。\",\n  \"campuses\": [\n    { \"id\": \"main\", \"name\": \"鸿德主校区\", \"active\": true },\n    { \"id\": \"east\", \"name\": \"东校区\", \"active\": false }\n  ],\n  \"canteens\": [\n    { \"id\": \"c1\", \"campusId\": \"main\", \"name\": \"金冠\", \"stallMode\": \"single-menu\" },\n    { \"id\": \"c2\", \"campusId\": \"main\", \"name\": \"小张餐厅二楼\", \"stallMode\": \"multi-stall\" },\n    { \"id\": \"c3\", \"campusId\": \"main\", \"name\": \"民族餐厅\", \"stallMode\": \"multi-stall\" },\n    { \"id\": \"c4\", \"campusId\": \"main\", \"name\": \"昕辉\", \"stallMode\": \"single-menu\" },\n    { \"id\": \"c5\", \"campusId\": \"main\", \"name\": \"汤姆大叔\", \"stallMode\": \"single-menu\" }\n  ],\n  \"stalls\": [\n    { \"id\": \"c1s1\", \"canteenId\": \"c1\", \"name\": \"金冠\" },\n\n    { \"id\": \"c2s1\", \"canteenId\": \"c2\", \"name\": \"花甲粉 · 螺蛳粉\", \"code\": \"14号窗口\" },\n    { \"id\": \"c2s2\", \"canteenId\": \"c2\", \"name\": \"手工鲜肉小笼包\", \"code\": \"13号窗口\" },\n    { \"id\": \"c2s3\", \"canteenId\": \"c2\", \"name\": \"小马哥焖肉饭\" },\n    { \"id\": \"c2s4\", \"canteenId\": \"c2\", \"name\": \"小爆炒荔枝鸡\", \"code\": \"2号窗口\" },\n    { \"id\": \"c2s5\", \"canteenId\": \"c2\", \"name\": \"品味韩餐\", \"code\": \"3号窗口\" },\n    { \"id\": \"c2s6\", \"canteenId\": \"c2\", \"name\": \"SAK 烤鸭饭 · 猪肘饭\", \"code\": \"4号窗口\" },\n    { \"id\": \"c2s7\", \"canteenId\": \"c2\", \"name\": \"抖喜新疆炒米粉\", \"code\": \"7号窗口\" },\n    { \"id\": \"c2s8\", \"canteenId\": \"c2\", \"name\": \"高师傅面食\", \"code\": \"8号窗口\" },\n    { \"id\": \"c2s9\", \"canteenId\": \"c2\", \"name\": \"米线肉夹馍\", \"code\": \"9号窗口\" },\n    { \"id\": \"c2s10\", \"canteenId\": \"c2\", \"name\": \"水吧（鲜饮小站）\", \"code\": \"10号窗口\" },\n    { \"id\": \"c2s11\", \"canteenId\": \"c2\", \"name\": \"川渝自选菜\" },\n    { \"id\": \"c2s12\", \"canteenId\": \"c2\", \"name\": \"食味轩特色饭\", \"code\": \"12号窗口\", \"note\": \"老武汉黑鸭煲 / 香约脆皮鸡饭 / 土豆泥煎肉饭 三块招牌其实是同一家，已合并\" },\n\n    { \"id\": \"c3s1\", \"canteenId\": \"c3\", \"name\": \"兰州拉面窗口\" },\n    { \"id\": \"c3s2\", \"canteenId\": \"c3\", \"name\": \"新疆炒饭 · 烤肉窗口\" },\n    { \"id\": \"c3s3\", \"canteenId\": \"c3\", \"name\": \"清真快餐窗口\" },\n\n    { \"id\": \"c4s1\", \"canteenId\": \"c4\", \"name\": \"昕辉\" },\n    { \"id\": \"c5s1\", \"canteenId\": \"c5\", \"name\": \"汤姆大叔\" }\n  ],\n  \"dishes\": [\n    { \"id\": \"d001\", \"stallId\": \"c1s1\", \"name\": \"牛肉拉面\" },\n    { \"id\": \"d002\", \"stallId\": \"c1s1\", \"name\": \"牛肉板面\" },\n    { \"id\": \"d003\", \"stallId\": \"c1s1\", \"name\": \"牛肉炒面\" },\n    { \"id\": \"d004\", \"stallId\": \"c1s1\", \"name\": \"红烧牛肉盖饭\" },\n\n    { \"id\": \"d100\", \"stallId\": \"c2s1\", \"name\": \"招牌花甲粉\", \"price\": 13.9 },\n    { \"id\": \"d101\", \"stallId\": \"c2s1\", \"name\": \"鲜花甲粉\", \"price\": 19.9 },\n    { \"id\": \"d102\", \"stallId\": \"c2s1\", \"name\": \"金汤花甲粉\", \"price\": 18.9 },\n    { \"id\": \"d103\", \"stallId\": \"c2s1\", \"name\": \"藤椒花甲粉\", \"price\": 17.9 },\n    { \"id\": \"d104\", \"stallId\": \"c2s1\", \"name\": \"黏糊麻酱螺蛳粉\", \"price\": 16.9 },\n    { \"id\": \"d105\", \"stallId\": \"c2s1\", \"name\": \"招牌螺蛳粉\", \"price\": 12.9 },\n    { \"id\": \"d106\", \"stallId\": \"c2s1\", \"name\": \"网红拉丝炸蛋螺蛳粉\", \"price\": 16.9 },\n    { \"id\": \"d107\", \"stallId\": \"c2s1\", \"name\": \"鲜在深山螺蛳粉\", \"price\": 16.9 },\n    { \"id\": \"d108\", \"stallId\": \"c2s1\", \"name\": \"虎皮鸡爪螺蛳粉\", \"price\": 16.9 },\n    { \"id\": \"d109\", \"stallId\": \"c2s1\", \"name\": \"油泼干拌螺蛳粉\", \"price\": 24.9 },\n    { \"id\": \"d110\", \"stallId\": \"c2s1\", \"name\": \"螺蛳粉（有肉）\", \"price\": 16.9 },\n    { \"id\": \"d111\", \"stallId\": \"c2s1\", \"name\": \"带皮鸭掌螺蛳粉\", \"price\": 16.9 },\n    { \"id\": \"d112\", \"stallId\": \"c2s1\", \"name\": \"番茄土豆泥螺蛳粉\", \"price\": 16.9 },\n    { \"id\": \"d113\", \"stallId\": \"c2s1\", \"name\": \"螺蛳粉 + 菌汤\", \"price\": 18.9 },\n    { \"id\": \"d114\", \"stallId\": \"c2s1\", \"name\": \"骨汤螺蛳粉\", \"price\": 14.9 },\n    { \"id\": \"d115\", \"stallId\": \"c2s1\", \"name\": \"三鲜螺蛳粉\", \"price\": 14.9 },\n    { \"id\": \"d116\", \"stallId\": \"c2s1\", \"name\": \"广东螺蛳粉\", \"price\": 14.9 },\n    { \"id\": \"d117\", \"stallId\": \"c2s1\", \"name\": \"干拌螺蛳粉\", \"price\": 16.9 },\n    { \"id\": \"d118\", \"stallId\": \"c2s1\", \"name\": \"香辣烤鱼螺蛳粉火锅（2-3人）\", \"price\": 69.9 },\n    { \"id\": \"d119\", \"stallId\": \"c2s1\", \"name\": \"豆腐螺蛳粉火锅\", \"price\": 69.9 },\n    { \"id\": \"d120\", \"stallId\": \"c2s1\", \"name\": \"双人肥肠螺蛳粉火锅\", \"price\": 89.9 },\n    { \"id\": \"d121\", \"stallId\": \"c2s1\", \"name\": \"人气套餐\", \"price\": 20.9 },\n    { \"id\": \"d122\", \"stallId\": \"c2s1\", \"name\": \"炸蛋螺蛳粉套餐\", \"price\": 19.9 },\n    { \"id\": \"d123\", \"stallId\": \"c2s1\", \"name\": \"兰花干螺蛳粉套餐\", \"price\": 19.9 },\n    { \"id\": \"d124\", \"stallId\": \"c2s1\", \"name\": \"鸡爪螺蛳粉套餐\", \"price\": 19.9 },\n\n    { \"id\": \"d130\", \"stallId\": \"c2s2\", \"name\": \"牛肉包\", \"price\": 2.5 },\n    { \"id\": \"d131\", \"stallId\": \"c2s2\", \"name\": \"酱肉包\", \"price\": 2.5 },\n    { \"id\": \"d132\", \"stallId\": \"c2s2\", \"name\": \"小猪奶黄包\", \"price\": 2.5 },\n    { \"id\": \"d133\", \"stallId\": \"c2s2\", \"name\": \"奥尔良鸡肉包\", \"price\": 2.5 },\n    { \"id\": \"d134\", \"stallId\": \"c2s2\", \"name\": \"鲜肉包\", \"price\": 2 },\n    { \"id\": \"d135\", \"stallId\": \"c2s2\", \"name\": \"梅干菜肉包\", \"price\": 2 },\n    { \"id\": \"d136\", \"stallId\": \"c2s2\", \"name\": \"肉沫酸豆角包\", \"price\": 2 },\n    { \"id\": \"d137\", \"stallId\": \"c2s2\", \"name\": \"豆沙包\", \"price\": 2 },\n    { \"id\": \"d138\", \"stallId\": \"c2s2\", \"name\": \"青椒茄子包\", \"price\": 2 },\n    { \"id\": \"d139\", \"stallId\": \"c2s2\", \"name\": \"韭菜鸡蛋包\", \"price\": 2 },\n    { \"id\": \"d140\", \"stallId\": \"c2s2\", \"name\": \"猪肉茴香包\", \"price\": 2 },\n    { \"id\": \"d141\", \"stallId\": \"c2s2\", \"name\": \"香菇油菜包\", \"price\": 2 },\n    { \"id\": \"d142\", \"stallId\": \"c2s2\", \"name\": \"牛肉小笼包\", \"price\": 12 },\n    { \"id\": \"d143\", \"stallId\": \"c2s2\", \"name\": \"酱肉小笼包\", \"price\": 12 },\n    { \"id\": \"d144\", \"stallId\": \"c2s2\", \"name\": \"鲜肉小笼包\", \"price\": 8 },\n    { \"id\": \"d145\", \"stallId\": \"c2s2\", \"name\": \"麻辣小龙虾小笼包\", \"price\": 15 },\n    { \"id\": \"d146\", \"stallId\": \"c2s2\", \"name\": \"韭菜鸡蛋小笼包\", \"price\": 7 },\n    { \"id\": \"d147\", \"stallId\": \"c2s2\", \"name\": \"香菇油菜小笼包\", \"price\": 7 },\n    { \"id\": \"d148\", \"stallId\": \"c2s2\", \"name\": \"生煎包\", \"price\": 12 },\n    { \"id\": \"d149\", \"stallId\": \"c2s2\", \"name\": \"黑米粥\", \"price\": 2 },\n    { \"id\": \"d150\", \"stallId\": \"c2s2\", \"name\": \"小米南瓜粥\", \"price\": 2 },\n    { \"id\": \"d151\", \"stallId\": \"c2s2\", \"name\": \"绿豆薏米粥\", \"price\": 2 },\n    { \"id\": \"d152\", \"stallId\": \"c2s2\", \"name\": \"红枣银耳粥\", \"price\": 2 },\n    { \"id\": \"d153\", \"stallId\": \"c2s2\", \"name\": \"皮蛋瘦肉粥\", \"price\": 3 },\n    { \"id\": \"d154\", \"stallId\": \"c2s2\", \"name\": \"现磨豆浆\", \"price\": 2.5 },\n    { \"id\": \"d155\", \"stallId\": \"c2s2\", \"name\": \"鲜肉馄饨\", \"price\": 8 },\n    { \"id\": \"d156\", \"stallId\": \"c2s2\", \"name\": \"紫菜鸡蛋汤\", \"price\": 2 },\n    { \"id\": \"d157\", \"stallId\": \"c2s2\", \"name\": \"水饺\", \"price\": 16 },\n\n    { \"id\": \"d160\", \"stallId\": \"c2s3\", \"name\": \"香辣大盘鸡拌面\", \"price\": 14 },\n    { \"id\": \"d161\", \"stallId\": \"c2s3\", \"name\": \"香辣大盘鸡拌饭\", \"price\": 14 },\n    { \"id\": \"d162\", \"stallId\": \"c2s3\", \"name\": \"酱香大盘鸡拌面\", \"price\": 14 },\n    { \"id\": \"d163\", \"stallId\": \"c2s3\", \"name\": \"酱香大盘鸡拌饭\", \"price\": 14 },\n    { \"id\": \"d164\", \"stallId\": \"c2s3\", \"name\": \"干锅土豆片\", \"price\": 11 },\n    { \"id\": \"d165\", \"stallId\": \"c2s3\", \"name\": \"干锅素什锦\", \"price\": 11 },\n    { \"id\": \"d166\", \"stallId\": \"c2s3\", \"name\": \"干锅方便面\", \"price\": 11 },\n    { \"id\": \"d167\", \"stallId\": \"c2s3\", \"name\": \"干锅千叶豆腐\", \"price\": 11 },\n    { \"id\": \"d168\", \"stallId\": \"c2s3\", \"name\": \"干锅脆骨肠\", \"price\": 12 },\n    { \"id\": \"d169\", \"stallId\": \"c2s3\", \"name\": \"干锅孜然肉\", \"price\": 14 },\n    { \"id\": \"d170\", \"stallId\": \"c2s3\", \"name\": \"干锅椒麻鸡\", \"price\": 13 },\n    { \"id\": \"d171\", \"stallId\": \"c2s3\", \"name\": \"干锅招牌鸡\", \"price\": 13 },\n    { \"id\": \"d172\", \"stallId\": \"c2s3\", \"name\": \"干锅小酥肉\", \"price\": 13 },\n    { \"id\": \"d173\", \"stallId\": \"c2s3\", \"name\": \"干锅酸菜五花肉\", \"price\": 13 },\n    { \"id\": \"d174\", \"stallId\": \"c2s3\", \"name\": \"干锅大鸡排\", \"price\": 12 },\n    { \"id\": \"d175\", \"stallId\": \"c2s3\", \"name\": \"干锅荷包蛋\", \"price\": 12 },\n    { \"id\": \"d176\", \"stallId\": \"c2s3\", \"name\": \"干锅腊肠\", \"price\": 13 },\n    { \"id\": \"d177\", \"stallId\": \"c2s3\", \"name\": \"干锅鸡翅中\", \"price\": 15 },\n    { \"id\": \"d178\", \"stallId\": \"c2s3\", \"name\": \"干锅雪花鸡柳\", \"price\": 12 },\n    { \"id\": \"d179\", \"stallId\": \"c2s3\", \"name\": \"干锅大虾\", \"price\": 15 },\n    { \"id\": \"d180\", \"stallId\": \"c2s3\", \"name\": \"干锅鸡翅根\", \"price\": 14 },\n    { \"id\": \"d181\", \"stallId\": \"c2s3\", \"name\": \"干锅翅中虾\", \"price\": 16 },\n    { \"id\": \"d182\", \"stallId\": \"c2s3\", \"name\": \"中式炸鸡馍\", \"price\": 8 },\n    { \"id\": \"d183\", \"stallId\": \"c2s3\", \"name\": \"芝士烤冷面\", \"price\": 10 },\n    { \"id\": \"d184\", \"stallId\": \"c2s3\", \"name\": \"手工大面筋\", \"price\": 3 },\n    { \"id\": \"d185\", \"stallId\": \"c2s3\", \"name\": \"蛋包芝士火鸡面\", \"price\": 12 },\n\n    { \"id\": \"d190\", \"stallId\": \"c2s4\", \"name\": \"川湘小炒肉\", \"price\": 15 },\n    { \"id\": \"d191\", \"stallId\": \"c2s4\", \"name\": \"腊肉炒烟笋\", \"price\": 15 },\n    { \"id\": \"d192\", \"stallId\": \"c2s4\", \"name\": \"十八秒猪肝\", \"price\": 16 },\n    { \"id\": \"d193\", \"stallId\": \"c2s4\", \"name\": \"辣椒炒肉\", \"price\": 14 },\n    { \"id\": \"d194\", \"stallId\": \"c2s4\", \"name\": \"孜然小炒肉\", \"price\": 15 },\n    { \"id\": \"d195\", \"stallId\": \"c2s4\", \"name\": \"酸辣藕带\", \"price\": 14 },\n    { \"id\": \"d196\", \"stallId\": \"c2s4\", \"name\": \"手撕包菜\", \"price\": 12 },\n    { \"id\": \"d197\", \"stallId\": \"c2s4\", \"name\": \"湘味下饭菜\", \"price\": 15 },\n    { \"id\": \"d198\", \"stallId\": \"c2s4\", \"name\": \"尖椒炒蛋\", \"price\": 13 },\n    { \"id\": \"d199\", \"stallId\": \"c2s4\", \"name\": \"肉沫蒸蛋\", \"price\": 12 },\n    { \"id\": \"d200\", \"stallId\": \"c2s4\", \"name\": \"酸辣土豆丝\", \"price\": 13 },\n    { \"id\": \"d201\", \"stallId\": \"c2s4\", \"name\": \"农家一碗香\", \"price\": 13 },\n    { \"id\": \"d202\", \"stallId\": \"c2s4\", \"name\": \"荔枝鸡咖喱双拼饭\", \"price\": 13 },\n    { \"id\": \"d203\", \"stallId\": \"c2s4\", \"name\": \"酱骨荔枝鸡双拼饭\", \"price\": 14 },\n    { \"id\": \"d204\", \"stallId\": \"c2s4\", \"name\": \"甜辣鸡卤肉双拼饭\", \"price\": 15 },\n    { \"id\": \"d205\", \"stallId\": \"c2s4\", \"name\": \"糖醋鸡贝贝咖喱饭\", \"price\": 13 },\n    { \"id\": \"d206\", \"stallId\": \"c2s4\", \"name\": \"酱骨甜辣鸡双拼饭\", \"price\": 14 },\n    { \"id\": \"d207\", \"stallId\": \"c2s4\", \"name\": \"卤肉糖醋鸡双拼饭\", \"price\": 15 },\n    { \"id\": \"d208\", \"stallId\": \"c2s4\", \"name\": \"酱骨焖茄子双拼饭\", \"price\": 13 },\n    { \"id\": \"d209\", \"stallId\": \"c2s4\", \"name\": \"卤肉茄子双拼饭\", \"price\": 13 },\n    { \"id\": \"d210\", \"stallId\": \"c2s4\", \"name\": \"咖喱鸡排双拼饭\", \"price\": 13 },\n    { \"id\": \"d211\", \"stallId\": \"c2s4\", \"name\": \"酱骨卤肉双拼饭\", \"price\": 15 },\n    { \"id\": \"d212\", \"stallId\": \"c2s4\", \"name\": \"可乐鸡咖喱双拼饭\", \"price\": 13 },\n\n    { \"id\": \"d220\", \"stallId\": \"c2s5\", \"name\": \"蔬菜沙拉减脂饭\", \"price\": 11 },\n    { \"id\": \"d221\", \"stallId\": \"c2s5\", \"name\": \"卫龙烤肉拌饭\", \"price\": 12 },\n    { \"id\": \"d222\", \"stallId\": \"c2s5\", \"name\": \"金针菇烤肉拌饭\", \"price\": 12 },\n    { \"id\": \"d223\", \"stallId\": \"c2s5\", \"name\": \"土豆丝烤肉拌饭\", \"price\": 12 },\n    { \"id\": \"d224\", \"stallId\": \"c2s5\", \"name\": \"辣白菜烤肉拌饭\", \"price\": 12 },\n    { \"id\": \"d225\", \"stallId\": \"c2s5\", \"name\": \"杏鲍菇烤肉拌饭\", \"price\": 12 },\n    { \"id\": \"d226\", \"stallId\": \"c2s5\", \"name\": \"奥尔良烤肉拌饭\", \"price\": 12 },\n    { \"id\": \"d227\", \"stallId\": \"c2s5\", \"name\": \"孜然烤肉拌饭\", \"price\": 12 },\n    { \"id\": \"d228\", \"stallId\": \"c2s5\", \"name\": \"火腿烤肉拌饭\", \"price\": 12 },\n    { \"id\": \"d229\", \"stallId\": \"c2s5\", \"name\": \"海苔烤肉拌饭\", \"price\": 13 },\n    { \"id\": \"d230\", \"stallId\": \"c2s5\", \"name\": \"肉松海苔拌饭\", \"price\": 13 },\n    { \"id\": \"d231\", \"stallId\": \"c2s5\", \"name\": \"照烧烤肉拌饭\", \"price\": 13 },\n    { \"id\": \"d232\", \"stallId\": \"c2s5\", \"name\": \"蜜汁烤肉拌饭\", \"price\": 13 },\n    { \"id\": \"d233\", \"stallId\": \"c2s5\", \"name\": \"黑椒烤肉拌饭\", \"price\": 13 },\n    { \"id\": \"d234\", \"stallId\": \"c2s5\", \"name\": \"蜂蜜芥末烤肉拌饭\", \"price\": 13 },\n    { \"id\": \"d235\", \"stallId\": \"c2s5\", \"name\": \"照烧鸡排拌饭\", \"price\": 14 },\n    { \"id\": \"d236\", \"stallId\": \"c2s5\", \"name\": \"蜜汁鸡排拌饭\", \"price\": 13 },\n    { \"id\": \"d237\", \"stallId\": \"c2s5\", \"name\": \"黑椒鸡排拌饭\", \"price\": 13 },\n    { \"id\": \"d238\", \"stallId\": \"c2s5\", \"name\": \"鸡排拼烤肉\", \"price\": 15 },\n    { \"id\": \"d239\", \"stallId\": \"c2s5\", \"name\": \"金针菇寿司\", \"price\": 9 },\n    { \"id\": \"d240\", \"stallId\": \"c2s5\", \"name\": \"酸萝卜寿司\", \"price\": 9 },\n    { \"id\": \"d241\", \"stallId\": \"c2s5\", \"name\": \"辣白菜寿司\", \"price\": 9 },\n    { \"id\": \"d242\", \"stallId\": \"c2s5\", \"name\": \"烤肉寿司\", \"price\": 10 },\n    { \"id\": \"d243\", \"stallId\": \"c2s5\", \"name\": \"牛肉松寿司\", \"price\": 10 },\n    { \"id\": \"d244\", \"stallId\": \"c2s5\", \"name\": \"蟹柳寿司\", \"price\": 10 },\n    { \"id\": \"d245\", \"stallId\": \"c2s5\", \"name\": \"招牌蛋炒饭\", \"price\": 11 },\n    { \"id\": \"d246\", \"stallId\": \"c2s5\", \"name\": \"腊肠蛋炒饭\", \"price\": 12 },\n    { \"id\": \"d247\", \"stallId\": \"c2s5\", \"name\": \"火腿蛋炒饭\", \"price\": 12 },\n    { \"id\": \"d248\", \"stallId\": \"c2s5\", \"name\": \"培根蛋炒饭\", \"price\": 12 },\n    { \"id\": \"d249\", \"stallId\": \"c2s5\", \"name\": \"鸭肠蛋炒饭\", \"price\": 12 },\n    { \"id\": \"d250\", \"stallId\": \"c2s5\", \"name\": \"泡菜鸡肉炒饭\", \"price\": 12 },\n    { \"id\": \"d251\", \"stallId\": \"c2s5\", \"name\": \"奥尔良小炒肉饭\", \"price\": 13 },\n    { \"id\": \"d252\", \"stallId\": \"c2s5\", \"name\": \"孜然小炒肉饭\", \"price\": 13 },\n    { \"id\": \"d253\", \"stallId\": \"c2s5\", \"name\": \"黑椒小炒肉饭\", \"price\": 13 },\n    { \"id\": \"d254\", \"stallId\": \"c2s5\", \"name\": \"多味鸡排炒饭\", \"price\": 13 },\n    { \"id\": \"d255\", \"stallId\": \"c2s5\", \"name\": \"大酱汤饭\", \"price\": 11 },\n    { \"id\": \"d256\", \"stallId\": \"c2s5\", \"name\": \"炒年糕\", \"price\": 12 },\n    { \"id\": \"d257\", \"stallId\": \"c2s5\", \"name\": \"素石锅拌饭\", \"price\": 12 },\n    { \"id\": \"d258\", \"stallId\": \"c2s5\", \"name\": \"鱼饼年糕饭\", \"price\": 12 },\n    { \"id\": \"d259\", \"stallId\": \"c2s5\", \"name\": \"鸡排石锅拌饭\", \"price\": 14 },\n    { \"id\": \"d260\", \"stallId\": \"c2s5\", \"name\": \"牛肉石锅拌饭\", \"price\": 15 },\n    { \"id\": \"d261\", \"stallId\": \"c2s5\", \"name\": \"奥尔良鸡肉石锅饭\", \"price\": 13 },\n    { \"id\": \"d262\", \"stallId\": \"c2s5\", \"name\": \"煎鸡蛋\", \"price\": 1.5 },\n\n    { \"id\": \"d270\", \"stallId\": \"c2s6\", \"name\": \"招牌烤鸭饭（小份）\", \"price\": 12 },\n    { \"id\": \"d271\", \"stallId\": \"c2s6\", \"name\": \"招牌烤鸭饭（大份）\", \"price\": 15 },\n    { \"id\": \"d272\", \"stallId\": \"c2s6\", \"name\": \"猪肘饭\", \"price\": 15.9 },\n    { \"id\": \"d273\", \"stallId\": \"c2s6\", \"name\": \"照烧鸡腿饭\", \"price\": 12.9 },\n    { \"id\": \"d274\", \"stallId\": \"c2s6\", \"name\": \"整只烤鸭\", \"price\": 19.9 },\n\n    { \"id\": \"d280\", \"stallId\": \"c2s7\", \"name\": \"招牌鸡肉炒米粉\", \"price\": 13 },\n    { \"id\": \"d281\", \"stallId\": \"c2s7\", \"name\": \"火腿肠炒米粉\", \"price\": 13 },\n    { \"id\": \"d282\", \"stallId\": \"c2s7\", \"name\": \"鱼排蟹排炒米粉\", \"price\": 13 },\n    { \"id\": \"d283\", \"stallId\": \"c2s7\", \"name\": \"纯素多菜炒米粉\", \"price\": 13 },\n    { \"id\": \"d284\", \"stallId\": \"c2s7\", \"name\": \"酸菜鸡肉炒米粉\", \"price\": 15 },\n    { \"id\": \"d285\", \"stallId\": \"c2s7\", \"name\": \"鸡肉多菜炒米粉\", \"price\": 16 },\n    { \"id\": \"d286\", \"stallId\": \"c2s7\", \"name\": \"酸菜牛肉炒米粉\", \"price\": 17 },\n    { \"id\": \"d287\", \"stallId\": \"c2s7\", \"name\": \"全家福炒米粉\", \"price\": 18 },\n    { \"id\": \"d288\", \"stallId\": \"c2s7\", \"name\": \"鸡肉+宽粉双拼炒米粉\", \"price\": 16 },\n    { \"id\": \"d289\", \"stallId\": \"c2s7\", \"name\": \"鸡肉+年糕双拼炒米粉\", \"price\": 16 },\n    { \"id\": \"d290\", \"stallId\": \"c2s7\", \"name\": \"鸡肉贡菜+馕双拼炒米粉\", \"price\": 18 },\n    { \"id\": \"d291\", \"stallId\": \"c2s7\", \"name\": \"牛肉+宽粉双拼炒米粉\", \"price\": 18 },\n    { \"id\": \"d292\", \"stallId\": \"c2s7\", \"name\": \"芝士鸡肉炒米粉\", \"price\": 17 },\n    { \"id\": \"d293\", \"stallId\": \"c2s7\", \"name\": \"鸡肉炒宽粉\", \"price\": 15 },\n    { \"id\": \"d294\", \"stallId\": \"c2s7\", \"name\": \"鸡肉多菜炒宽粉\", \"price\": 16 },\n    { \"id\": \"d295\", \"stallId\": \"c2s7\", \"name\": \"牛肉炒宽粉\", \"price\": 17 },\n    { \"id\": \"d296\", \"stallId\": \"c2s7\", \"name\": \"全家福炒宽粉\", \"price\": 18 },\n    { \"id\": \"d297\", \"stallId\": \"c2s7\", \"name\": \"鸡肉炒馕\", \"price\": 16 },\n    { \"id\": \"d298\", \"stallId\": \"c2s7\", \"name\": \"牛肉炒馕\", \"price\": 18 },\n    { \"id\": \"d299\", \"stallId\": \"c2s7\", \"name\": \"新疆炒五粉\", \"price\": 19 },\n    { \"id\": \"d300\", \"stallId\": \"c2s7\", \"name\": \"招牌牛肉炒米粉\", \"price\": 15 },\n    { \"id\": \"d301\", \"stallId\": \"c2s7\", \"name\": \"粉馕双拼牛肉炒米粉\", \"price\": 18 },\n\n    { \"id\": \"d310\", \"stallId\": \"c2s8\", \"name\": \"酸汤砂锅面\", \"price\": 11 },\n    { \"id\": \"d311\", \"stallId\": \"c2s8\", \"name\": \"招牌肉卤面\", \"price\": 11 },\n    { \"id\": \"d312\", \"stallId\": \"c2s8\", \"name\": \"原味鸡汤面\", \"price\": 11 },\n    { \"id\": \"d313\", \"stallId\": \"c2s8\", \"name\": \"酸辣鸡汤面\", \"price\": 11 },\n    { \"id\": \"d314\", \"stallId\": \"c2s8\", \"name\": \"什锦砂锅面\", \"price\": 13 },\n    { \"id\": \"d315\", \"stallId\": \"c2s8\", \"name\": \"椒麻鸭块面\", \"price\": 12 },\n    { \"id\": \"d316\", \"stallId\": \"c2s8\", \"name\": \"什锦酸汤面\", \"price\": 13 },\n    { \"id\": \"d317\", \"stallId\": \"c2s8\", \"name\": \"小酥肉番茄面\", \"price\": 13 },\n    { \"id\": \"d318\", \"stallId\": \"c2s8\", \"name\": \"小酥肉金汤面\", \"price\": 13 },\n    { \"id\": \"d319\", \"stallId\": \"c2s8\", \"name\": \"什锦麻酱面\", \"price\": 13 },\n    { \"id\": \"d320\", \"stallId\": \"c2s8\", \"name\": \"农家焖面\", \"price\": 9 },\n    { \"id\": \"d321\", \"stallId\": \"c2s8\", \"name\": \"鸡架拌面\", \"price\": 14 },\n    { \"id\": \"d322\", \"stallId\": \"c2s8\", \"name\": \"小酥肉拌面\", \"price\": 14 },\n    { \"id\": \"d323\", \"stallId\": \"c2s8\", \"name\": \"鸡腿拌面\", \"price\": 15 },\n    { \"id\": \"d324\", \"stallId\": \"c2s8\", \"name\": \"拌鸡架\", \"price\": 10 },\n    { \"id\": \"d325\", \"stallId\": \"c2s8\", \"name\": \"拌鸡腿\", \"price\": 12 },\n    { \"id\": \"d326\", \"stallId\": \"c2s8\", \"name\": \"鸡丝麻酱面\", \"price\": 12 },\n    { \"id\": \"d327\", \"stallId\": \"c2s8\", \"name\": \"招牌麻酱面\", \"price\": 11 },\n    { \"id\": \"d328\", \"stallId\": \"c2s8\", \"name\": \"油泼肉卤面\", \"price\": 13 },\n    { \"id\": \"d329\", \"stallId\": \"c2s8\", \"name\": \"方便面\", \"price\": 5 },\n    { \"id\": \"d330\", \"stallId\": \"c2s8\", \"name\": \"火腿肠\", \"price\": 1.5 },\n    { \"id\": \"d331\", \"stallId\": \"c2s8\", \"name\": \"鸡蛋\", \"price\": 1.5 },\n\n    { \"id\": \"d340\", \"stallId\": \"c2s9\", \"name\": \"酱肉米线\", \"price\": 12 },\n    { \"id\": \"d341\", \"stallId\": \"c2s9\", \"name\": \"酱肉米线 + 刀削面\", \"price\": 12 },\n    { \"id\": \"d342\", \"stallId\": \"c2s9\", \"name\": \"酱肉米线 + 方便面\", \"price\": 12 },\n    { \"id\": \"d343\", \"stallId\": \"c2s9\", \"name\": \"麻辣豆干米线\", \"price\": 12 },\n    { \"id\": \"d344\", \"stallId\": \"c2s9\", \"name\": \"麻辣豆干米线 + 刀削面\", \"price\": 12 },\n    { \"id\": \"d345\", \"stallId\": \"c2s9\", \"name\": \"原味清汤\", \"price\": 11 },\n    { \"id\": \"d346\", \"stallId\": \"c2s9\", \"name\": \"原味清汤 + 刀削面\", \"price\": 11 },\n    { \"id\": \"d347\", \"stallId\": \"c2s9\", \"name\": \"原味清汤 + 方便面\", \"price\": 11 },\n    { \"id\": \"d348\", \"stallId\": \"c2s9\", \"name\": \"麻辣米线\", \"price\": 11 },\n    { \"id\": \"d349\", \"stallId\": \"c2s9\", \"name\": \"麻辣米线 + 方便面\", \"price\": 11 },\n    { \"id\": \"d350\", \"stallId\": \"c2s9\", \"name\": \"麻辣米线 + 刀削面\", \"price\": 11 },\n    { \"id\": \"d351\", \"stallId\": \"c2s9\", \"name\": \"香辣米线\", \"price\": 11 },\n    { \"id\": \"d352\", \"stallId\": \"c2s9\", \"name\": \"香辣米线 + 刀削面\", \"price\": 11 },\n    { \"id\": \"d353\", \"stallId\": \"c2s9\", \"name\": \"香辣米线 + 方便面\", \"price\": 11 },\n    { \"id\": \"d354\", \"stallId\": \"c2s9\", \"name\": \"燕麦粥\", \"price\": 2 },\n    { \"id\": \"d355\", \"stallId\": \"c2s9\", \"name\": \"椰奶\", \"price\": 2 },\n    { \"id\": \"d356\", \"stallId\": \"c2s9\", \"name\": \"红枣豆浆\", \"price\": 2 },\n    { \"id\": \"d357\", \"stallId\": \"c2s9\", \"name\": \"椰奶燕麦粥\", \"price\": 2 },\n    { \"id\": \"d358\", \"stallId\": \"c2s9\", \"name\": \"鸡蛋火腿肉夹馍\", \"price\": 5 },\n    { \"id\": \"d359\", \"stallId\": \"c2s9\", \"name\": \"鸡蛋豆腐皮肉夹馍\", \"price\": 5 },\n    { \"id\": \"d360\", \"stallId\": \"c2s9\", \"name\": \"火腿豆腐皮肉夹馍\", \"price\": 5 },\n    { \"id\": \"d361\", \"stallId\": \"c2s9\", \"name\": \"火腿鸡蛋豆腐皮肉夹馍\", \"price\": 6 },\n    { \"id\": \"d362\", \"stallId\": \"c2s9\", \"name\": \"火腿豆皮加卫龙肉夹馍\", \"price\": 6 },\n    { \"id\": \"d363\", \"stallId\": \"c2s9\", \"name\": \"鸡蛋火腿加卫龙肉夹馍\", \"price\": 6 },\n    { \"id\": \"d364\", \"stallId\": \"c2s9\", \"name\": \"鸡蛋豆腐皮加卫龙肉夹馍\", \"price\": 6 },\n    { \"id\": \"d365\", \"stallId\": \"c2s9\", \"name\": \"鸡蛋火腿豆腐皮卫龙肉夹馍\", \"price\": 7 },\n    { \"id\": \"d366\", \"stallId\": \"c2s9\", \"name\": \"肉夹馍\", \"price\": 8 },\n    { \"id\": \"d367\", \"stallId\": \"c2s9\", \"name\": \"肉夹馍加火腿\", \"price\": 9 },\n    { \"id\": \"d368\", \"stallId\": \"c2s9\", \"name\": \"肉夹馍加鸡蛋\", \"price\": 9.5 },\n    { \"id\": \"d369\", \"stallId\": \"c2s9\", \"name\": \"肉夹馍加火腿卫龙\", \"price\": 10 },\n    { \"id\": \"d370\", \"stallId\": \"c2s9\", \"name\": \"肉夹馍加鸡蛋火腿\", \"price\": 10.5 },\n    { \"id\": \"d371\", \"stallId\": \"c2s9\", \"name\": \"肉夹馍加鸡蛋卫龙\", \"price\": 10.5 },\n\n    { \"id\": \"d380\", \"stallId\": \"c2s10\", \"name\": \"可乐\", \"price\": 3 },\n    { \"id\": \"d381\", \"stallId\": \"c2s10\", \"name\": \"雪碧\", \"price\": 3 },\n    { \"id\": \"d382\", \"stallId\": \"c2s10\", \"name\": \"芬达\", \"price\": 3 },\n    { \"id\": \"d383\", \"stallId\": \"c2s10\", \"name\": \"冰鲜柠檬水\", \"price\": 4 },\n    { \"id\": \"d384\", \"stallId\": \"c2s10\", \"name\": \"茉莉柠檬水\", \"price\": 5 },\n    { \"id\": \"d385\", \"stallId\": \"c2s10\", \"name\": \"柠檬红茶\", \"price\": 5 },\n    { \"id\": \"d386\", \"stallId\": \"c2s10\", \"name\": \"酸梅汁\", \"price\": 3 },\n    { \"id\": \"d387\", \"stallId\": \"c2s10\", \"name\": \"柳橙果汁\", \"price\": 3 },\n    { \"id\": \"d388\", \"stallId\": \"c2s10\", \"name\": \"芒果汁\", \"price\": 3 },\n    { \"id\": \"d389\", \"stallId\": \"c2s10\", \"name\": \"葡萄果汁\", \"price\": 3 },\n    { \"id\": \"d390\", \"stallId\": \"c2s10\", \"name\": \"荔枝果汁\", \"price\": 3 },\n    { \"id\": \"d391\", \"stallId\": \"c2s10\", \"name\": \"菠萝果汁\", \"price\": 3 },\n    { \"id\": \"d392\", \"stallId\": \"c2s10\", \"name\": \"茉莉花茶\", \"price\": 3 },\n    { \"id\": \"d393\", \"stallId\": \"c2s10\", \"name\": \"经典红茶\", \"price\": 3 },\n    { \"id\": \"d394\", \"stallId\": \"c2s10\", \"name\": \"经典绿茶\", \"price\": 3 },\n    { \"id\": \"d395\", \"stallId\": \"c2s10\", \"name\": \"白桃乌龙茶\", \"price\": 3 },\n\n    { \"id\": \"d400\", \"stallId\": \"c2s11\", \"name\": \"川渝自选菜（计重）\", \"price\": 1.78, \"unit\": \"元/50克\" },\n\n    { \"id\": \"d410\", \"stallId\": \"c2s12\", \"name\": \"招牌黑鸭煲\", \"price\": 13.8 },\n    { \"id\": \"d411\", \"stallId\": \"c2s12\", \"name\": \"金牌酱焖鸭\", \"price\": 13.8 },\n    { \"id\": \"d412\", \"stallId\": \"c2s12\", \"name\": \"黑鸭鸡腿煲\", \"price\": 14.8 },\n    { \"id\": \"d413\", \"stallId\": \"c2s12\", \"name\": \"黑鸭烧肉煲\", \"price\": 15.8 },\n    { \"id\": \"d414\", \"stallId\": \"c2s12\", \"name\": \"黑鸭海带煲\", \"price\": 12.8 },\n    { \"id\": \"d415\", \"stallId\": \"c2s12\", \"name\": \"黑鸭腐竹煲\", \"price\": 12.8 },\n    { \"id\": \"d416\", \"stallId\": \"c2s12\", \"name\": \"黑鸭金针菇煲\", \"price\": 12.8 },\n    { \"id\": \"d417\", \"stallId\": \"c2s12\", \"name\": \"黑鸭花菜煲\", \"price\": 12.8 },\n    { \"id\": \"d418\", \"stallId\": \"c2s12\", \"name\": \"黑鸭木耳煲\", \"price\": 12.8 },\n    { \"id\": \"d419\", \"stallId\": \"c2s12\", \"name\": \"黑鸭茄子煲\", \"price\": 12.8 },\n    { \"id\": \"d420\", \"stallId\": \"c2s12\", \"name\": \"馋嘴土豆片\", \"price\": 10.8 },\n    { \"id\": \"d421\", \"stallId\": \"c2s12\", \"name\": \"馋嘴千页豆腐\", \"price\": 11.8 },\n    { \"id\": \"d422\", \"stallId\": \"c2s12\", \"name\": \"馋嘴宽粉\", \"price\": 11.8 },\n    { \"id\": \"d423\", \"stallId\": \"c2s12\", \"name\": \"馋嘴金针菇\", \"price\": 12.8 },\n    { \"id\": \"d424\", \"stallId\": \"c2s12\", \"name\": \"馋嘴方便面\", \"price\": 12.8 },\n    { \"id\": \"d425\", \"stallId\": \"c2s12\", \"name\": \"馋嘴年糕\", \"price\": 12.8 },\n    { \"id\": \"d426\", \"stallId\": \"c2s12\", \"name\": \"馋嘴鸭血\", \"price\": 12.8 },\n    { \"id\": \"d427\", \"stallId\": \"c2s12\", \"name\": \"馋嘴乌冬面\", \"price\": 12.8 },\n    { \"id\": \"d428\", \"stallId\": \"c2s12\", \"name\": \"馋嘴苕粉\", \"price\": 13.6 },\n    { \"id\": \"d429\", \"stallId\": \"c2s12\", \"name\": \"馋嘴魔芋结\", \"price\": 13.6 },\n    { \"id\": \"d430\", \"stallId\": \"c2s12\", \"name\": \"馋嘴脆骨肠\", \"price\": 13.6 },\n    { \"id\": \"d431\", \"stallId\": \"c2s12\", \"name\": \"馋嘴培根\", \"price\": 13.6 },\n    { \"id\": \"d432\", \"stallId\": \"c2s12\", \"name\": \"金牌馋嘴鸡\", \"price\": 14.6 },\n    { \"id\": \"d433\", \"stallId\": \"c2s12\", \"name\": \"金牌馋嘴鸭\", \"price\": 14.6 },\n    { \"id\": \"d434\", \"stallId\": \"c2s12\", \"name\": \"馋嘴小酥肉\", \"price\": 14.6 },\n    { \"id\": \"d435\", \"stallId\": \"c2s12\", \"name\": \"招牌馋嘴鱼\", \"price\": 15.6 },\n    { \"id\": \"d436\", \"stallId\": \"c2s12\", \"name\": \"香约脆皮鸡饭（大份）\", \"price\": 12.5 },\n    { \"id\": \"d437\", \"stallId\": \"c2s12\", \"name\": \"香约脆皮鸡饭（小份）\", \"price\": 11.5 },\n    { \"id\": \"d438\", \"stallId\": \"c2s12\", \"name\": \"番茄脆皮鸡饭\", \"price\": 12.5 },\n    { \"id\": \"d439\", \"stallId\": \"c2s12\", \"name\": \"香辣脆皮鸡饭\", \"price\": 12.5 },\n    { \"id\": \"d440\", \"stallId\": \"c2s12\", \"name\": \"千岛脆皮鸡饭\", \"price\": 12.5 },\n    { \"id\": \"d441\", \"stallId\": \"c2s12\", \"name\": \"咖喱脆皮鸡饭\", \"price\": 12.5 },\n    { \"id\": \"d442\", \"stallId\": \"c2s12\", \"name\": \"蜜汁脆皮鸡饭\", \"price\": 12.5 },\n    { \"id\": \"d443\", \"stallId\": \"c2s12\", \"name\": \"沙拉脆皮鸡饭\", \"price\": 11.5 },\n    { \"id\": \"d444\", \"stallId\": \"c2s12\", \"name\": \"韩式脆皮鸡饭\", \"price\": 11.5 },\n    { \"id\": \"d445\", \"stallId\": \"c2s12\", \"name\": \"黑胡椒脆皮鸡饭\", \"price\": 11.5 },\n    { \"id\": \"d446\", \"stallId\": \"c2s12\", \"name\": \"蜂蜜芥末脆皮鸡饭\", \"price\": 11.5 },\n    { \"id\": \"d447\", \"stallId\": \"c2s12\", \"name\": \"黑椒鸡排煎肉饭\", \"price\": 13.5 },\n    { \"id\": \"d448\", \"stallId\": \"c2s12\", \"name\": \"照烧鸡排煎肉饭\", \"price\": 13.5 },\n    { \"id\": \"d449\", \"stallId\": \"c2s12\", \"name\": \"咖喱鸡排煎肉饭\", \"price\": 13.5 },\n    { \"id\": \"d450\", \"stallId\": \"c2s12\", \"name\": \"香辣鸡排煎肉饭\", \"price\": 13.5 },\n    { \"id\": \"d451\", \"stallId\": \"c2s12\", \"name\": \"沙拉鸡排煎肉饭\", \"price\": 13.5 },\n    { \"id\": \"d452\", \"stallId\": \"c2s12\", \"name\": \"黑椒猪排煎肉饭\", \"price\": 14.5 },\n    { \"id\": \"d453\", \"stallId\": \"c2s12\", \"name\": \"照烧猪排煎肉饭\", \"price\": 14.5 },\n    { \"id\": \"d454\", \"stallId\": \"c2s12\", \"name\": \"咖喱猪排煎肉饭\", \"price\": 14.5 },\n    { \"id\": \"d455\", \"stallId\": \"c2s12\", \"name\": \"香辣猪排煎肉饭\", \"price\": 14.5 },\n    { \"id\": \"d456\", \"stallId\": \"c2s12\", \"name\": \"沙拉猪排煎肉饭\", \"price\": 14.5 },\n\n    { \"id\": \"d500\", \"stallId\": \"c3s1\", \"name\": \"牛肉拉面\" },\n    { \"id\": \"d501\", \"stallId\": \"c3s1\", \"name\": \"毛细拉面\" },\n    { \"id\": \"d502\", \"stallId\": \"c3s1\", \"name\": \"牛肉炒面\" },\n    { \"id\": \"d510\", \"stallId\": \"c3s2\", \"name\": \"新疆炒饭\" },\n    { \"id\": \"d511\", \"stallId\": \"c3s2\", \"name\": \"羊肉串\" },\n    { \"id\": \"d512\", \"stallId\": \"c3s2\", \"name\": \"大盘鸡\" },\n    { \"id\": \"d513\", \"stallId\": \"c3s2\", \"name\": \"烤包子\" },\n    { \"id\": \"d520\", \"stallId\": \"c3s3\", \"name\": \"羊肉烧麦\" },\n    { \"id\": \"d521\", \"stallId\": \"c3s3\", \"name\": \"羊杂碎汤\" },\n    { \"id\": \"d522\", \"stallId\": \"c3s3\", \"name\": \"焙子夹肉\" },\n    { \"id\": \"d523\", \"stallId\": \"c3s3\", \"name\": \"手抓饭\" },\n\n    { \"id\": \"d600\", \"stallId\": \"c4s1\", \"name\": \"宫保鸡丁盖饭\" },\n    { \"id\": \"d601\", \"stallId\": \"c4s1\", \"name\": \"鱼香肉丝盖饭\" },\n    { \"id\": \"d602\", \"stallId\": \"c4s1\", \"name\": \"青椒肉丝盖饭\" },\n    { \"id\": \"d603\", \"stallId\": \"c4s1\", \"name\": \"西红柿鸡蛋盖饭\" },\n\n    { \"id\": \"d700\", \"stallId\": \"c5s1\", \"name\": \"珍珠奶茶\" },\n    { \"id\": \"d701\", \"stallId\": \"c5s1\", \"name\": \"杨枝甘露\" },\n    { \"id\": \"d702\", \"stallId\": \"c5s1\", \"name\": \"柠檬水\" },\n    { \"id\": \"d703\", \"stallId\": \"c5s1\", \"name\": \"烤肠\" },\n    { \"id\": \"d704\", \"stallId\": \"c5s1\", \"name\": \"鸡排\" },\n    { \"id\": \"d705\", \"stallId\": \"c5s1\", \"name\": \"关东煮\" }\n  ]\n}\n";

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
  return USE_FEISHU ? false : (typeof store.isShowingDemo === 'function' && store.isShowingDemo());
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
  const demo = USE_FEISHU ? false : (typeof store.isShowingDemo === 'function' && store.isShowingDemo());
  return {
    dataSource: USE_FEISHU ? '飞书多维表格' : (demo ? '演示数据（还没人真实打分）' : '本地文件（未接飞书）'),
    isDemoData: demo,
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
    if (USE_FEISHU) source = '飞书多维表格';
    else if (isDemo()) source = '演示数据（还没有人真实打分，等你打第一个分）';
    else source = '本地文件 data/ratings.json';
    const lines = [
      '',
      '  ✅ 鸿德食堂打分工具 已启动',
      '  ─────────────────────────────────────────────',
      '  数据源：' + source,
      '  电脑打开：  http://localhost:' + port,
    ];
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
module.exports.__internal = {
  beijingDate, clientIp, normalizeRecords, menuIndex, rateLimit,
  loadMenu, get MENU() { return MENU; }, set MENU(v) { MENU = v; }
};

if (require.main === module) {
  const port = Number(process.env.PORT) || 5173;
  startServer(port);
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
