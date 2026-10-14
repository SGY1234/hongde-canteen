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

const rankings = require('./rankings.js');
const stores = require('./store.js');

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
const EMBEDDED_MENU_JSON = '__HD_EMBEDDED_MENU__';

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
